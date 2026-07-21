/**
 * End-to-end integration test for `createTracing` (see
 * `src/observability/tracing.ts`): proves that, under Bun, an enabled
 * `Tracing` actually exports a real span tree via OTLP/HTTP to a live
 * GreptimeDB instance, and that parent/child linkage survives the trip.
 *
 * Reuses the GreptimeDB container-lifecycle pattern and the OTLP trace
 * endpoint path / required headers exactly as
 * `tests/integration/greptimedb.test.ts` and `tests/integration/helpers/otlp-seed.ts`
 * do (both read before writing this file). Unlike the seed helper (which
 * never awaits inside `context.with`), this test drives the actual production
 * path: `createTracing` registers `AsyncLocalStorageContextManager`, and the
 * child span here is started only after an awaited real macrotask, exercising
 * the exact propagation behavior `src/observability/tracing.ts` depends on.
 * Note: context-manager registration is first-wins per process, and on Bun
 * versions where `bun test` shares globals across files the seed helper may
 * register first — it uses the same AsyncLocalStorageContextManager class, so
 * propagation holds regardless of which registrant wins.
 *
 * Requires Docker. Skips gracefully (with a clear console message) when
 * Docker is not available, per docs/architecture.md's testing conventions.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { context, SpanKind, trace } from "@opentelemetry/api";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import type { ObservabilityConfig } from "../../src/config/schema";
import { createLogger } from "../../src/observability/logger";
import { createTracing } from "../../src/observability/tracing";

async function isDockerAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["docker", "info"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
	console.warn(
		"[otel-export.test] Docker is not available; skipping OTel export integration test. " +
			"Start Docker and re-run `bun run test:integration` to execute this suite.",
	);
}

interface GreptimeColumnSchema {
	name: string;
	data_type: string;
}

interface GreptimeRecords {
	schema: { column_schemas: GreptimeColumnSchema[] };
	rows: unknown[][];
}

interface GreptimeSqlSuccess {
	output?: { records?: GreptimeRecords }[];
}

/**
 * Runs a raw SQL statement against GreptimeDB's HTTP SQL API and returns the
 * result rows as plain objects keyed by column name. Mirrors
 * `tests/integration/helpers/otlp-seed.ts`'s `execSql` plus
 * `src/telemetry/greptimedb.ts`'s `parseSqlRows` (both intentionally not
 * imported: this test only reads production code's `Tracing`, not its
 * GreptimeDB query client, to keep the assertion path independent of it).
 */
async function querySql(
	baseUrl: string,
	sql: string,
): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${baseUrl}/v1/sql?db=public`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ sql }).toString(),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Query SQL failed (HTTP ${response.status}): ${text}`);
	}
	const json = JSON.parse(text) as GreptimeSqlSuccess;
	const entry = json.output?.[0];
	if (!entry?.records) {
		return [];
	}
	const columns = entry.records.schema.column_schemas.map((c) => c.name);
	return entry.records.rows.map((row) => {
		const obj: Record<string, unknown> = {};
		columns.forEach((name, i) => {
			obj[name] = row[i];
		});
		return obj;
	});
}

/**
 * Polls `opentelemetry_traces` for rows matching `traceId` until either the
 * expected span count arrives or `timeoutMs` elapses. GreptimeDB's standalone
 * OTLP ingest is normally synchronous with the HTTP response (the sibling
 * `greptimedb.test.ts` suite queries immediately after its seed helper's
 * `forceFlush`/`shutdown` with no polling), but this test also races
 * `Tracing.shutdown()`'s own 5s flush timeout, so a short poll absorbs any
 * incidental scheduling jitter without weakening the assertions below.
 */
async function waitForTraceRows(
	baseUrl: string,
	traceId: string,
	expectedCount: number,
	timeoutMs = 10_000,
): Promise<Record<string, unknown>[]> {
	const deadline = Date.now() + timeoutMs;
	let rows: Record<string, unknown>[] = [];
	while (Date.now() < deadline) {
		rows = await querySql(
			baseUrl,
			`SELECT span_name, span_id, parent_span_id, trace_id, service_name FROM opentelemetry_traces WHERE trace_id = '${traceId}' ORDER BY timestamp ASC`,
		);
		if (rows.length >= expectedCount) {
			return rows;
		}
		await Bun.sleep(300);
	}
	return rows;
}

describe.skipIf(!dockerAvailable)(
	"createTracing OTLP export (testcontainers)",
	() => {
		let container: StartedTestContainer;
		let baseUrl: string;

		beforeAll(async () => {
			container = await new GenericContainer("greptime/greptimedb:v1.1.2")
				.withExposedPorts(4000, 4001, 4002, 4003)
				.withCommand([
					"standalone",
					"start",
					"--http-addr",
					"0.0.0.0:4000",
					"--rpc-bind-addr",
					"0.0.0.0:4001",
					"--mysql-addr",
					"0.0.0.0:4002",
					"--postgres-addr",
					"0.0.0.0:4003",
				])
				.withWaitStrategy(Wait.forHttp("/health", 4000))
				.withStartupTimeout(120_000)
				.start();

			baseUrl = `http://${container.getHost()}:${container.getMappedPort(4000)}`;
		}, 180_000);

		afterAll(async () => {
			await container?.stop();
		}, 30_000);

		test("emits a root+child span tree that lands in opentelemetry_traces with correct linkage", async () => {
			// Default bun:test per-test timeout (5s) is too tight once the OTLP
			// export round-trip, `Tracing.shutdown()`'s own flush, and the
			// `waitForTraceRows` poll are all in the critical path.
			const config: ObservabilityConfig = {
				endpoint: `${baseUrl}/v1/otlp/v1/traces`,
				serviceName: "paperhanger-otel-itest",
				headers: {
					"x-greptime-pipeline-name": "greptime_trace_v1",
					"x-greptime-db-name": "public",
				},
			};
			const logger = createLogger({ sink: () => {} });
			const tracing = createTracing(config, logger);
			const tracer = tracing.getTracer("otel-export-test");

			const rootSpan = tracer.startSpan("otel-itest.root", {
				kind: SpanKind.INTERNAL,
			});
			const rootSpanContext = rootSpan.spanContext();

			await context.with(
				trace.setSpan(context.active(), rootSpan),
				async () => {
					// Cross a real macrotask before starting the child span: this is
					// the exact scenario in which the deprecated
					// AsyncHooksContextManager silently loses the active context on
					// Bun (see src/observability/tracing.ts's module doc), so
					// exercising it here proves the production wiring -- not just the
					// unit-tested manager class in isolation -- propagates correctly
					// end to end, including through the real OTLP export path.
					await Bun.sleep(5);
					const childSpan = tracer.startSpan("otel-itest.child");
					expect(childSpan.spanContext().traceId).toBe(rootSpanContext.traceId);
					childSpan.end();
				},
			);
			rootSpan.end();

			await tracing.shutdown();

			const rows = await waitForTraceRows(baseUrl, rootSpanContext.traceId, 2);

			expect(rows.length).toBe(2);
			const root = rows.find((r) => r.span_name === "otel-itest.root");
			const child = rows.find((r) => r.span_name === "otel-itest.child");
			expect(root).toBeDefined();
			expect(child).toBeDefined();

			expect(root?.trace_id).toBe(rootSpanContext.traceId);
			expect(child?.trace_id).toBe(rootSpanContext.traceId);
			expect(root?.parent_span_id).toBeFalsy();
			expect(child?.parent_span_id).toBe(rootSpanContext.spanId);
			expect(root?.service_name).toBe(config.serviceName);
			expect(child?.service_name).toBe(config.serviceName);
		}, 30_000);
	},
);
