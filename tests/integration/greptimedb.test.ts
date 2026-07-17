/**
 * Integration test for the GreptimeDB `TelemetrySource` implementation.
 * Starts a real `greptime/greptimedb:v1.1.2` standalone container
 * (testcontainers), seeds it with realistic OTLP data via the official OTel
 * SDKs (see helpers/otlp-seed.ts), and exercises GreptimeDbSource +
 * buildIncidentContext against it end-to-end.
 *
 * Requires Docker. Skips gracefully (with a clear console message) when
 * Docker is not available, per docs/architecture.md's testing conventions.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import type { Incident, IncidentEvent } from "../../src/core/types";
import { createLogger } from "../../src/observability/logger";
import {
	buildIncidentContext,
	renderContextMarkdown,
} from "../../src/telemetry/context-builder";
import { GreptimeDbSource } from "../../src/telemetry/greptimedb";
import {
	seedMetricTable,
	seedTelemetry,
	type SeedResult,
} from "./helpers/otlp-seed";

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
		"[greptimedb.test] Docker is not available; skipping GreptimeDB integration tests. " +
			"Start Docker and re-run `bun run test:integration` to execute this suite.",
	);
}

function recentWindow(minutesBack = 30): { from: string; to: string } {
	return {
		from: new Date(Date.now() - minutesBack * 60_000).toISOString(),
		to: new Date().toISOString(),
	};
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
	return {
		id: "incident-integration-1",
		fingerprint: "fp-integration-1",
		source: "grafana",
		status: "collecting",
		severity: "critical",
		title: "Checkout error rate spike",
		labels: { service: "checkout" },
		annotations: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeAlert(overrides: Partial<IncidentEvent> = {}): IncidentEvent {
	return {
		fingerprint: "fp-integration-1",
		source: "grafana",
		status: "firing",
		severity: "critical",
		title: "Checkout error rate spike",
		labels: { service: "checkout" },
		annotations: {},
		// A minute in the past so the default 30min-before/5min-after window
		// (capped at "now") comfortably covers everything seeded just now.
		startsAt: new Date(Date.now() - 60_000).toISOString(),
		raw: {},
		...overrides,
	};
}

describe.skipIf(!dockerAvailable)("GreptimeDbSource (testcontainers)", () => {
	let container: StartedTestContainer;
	let baseUrl: string;
	let source: GreptimeDbSource;
	let seeded: SeedResult;
	const logger = createLogger({ sink: () => {} });

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
		source = new GreptimeDbSource({ url: baseUrl, database: "public" }, logger);

		seeded = await seedTelemetry(baseUrl, "checkout");
		await seedMetricTable(baseUrl, "paperhanger_test_metric", "checkout");
	}, 180_000);

	afterAll(async () => {
		await container?.stop();
	});

	test("queryLogs returns the seeded error logs with parsed fields", async () => {
		const logs = await source.queryLogs({
			timeRange: recentWindow(),
			labels: { service: "checkout", severity: "error" },
			limit: 50,
		});

		expect(logs.length).toBeGreaterThanOrEqual(3);
		const timeoutLog = logs.find((l) =>
			l.body.includes("database connection timeout"),
		);
		expect(timeoutLog).toBeDefined();
		expect(timeoutLog?.severityText).toBe("ERROR");
		expect(timeoutLog?.severityNumber).toBe(17);
		expect(timeoutLog?.traceId).toBe(seeded.traceId);
		expect(timeoutLog?.spanId).toBe(seeded.errorSpanId);
		expect(timeoutLog?.serviceName).toBe("checkout");
	});

	test("queryTraces by trace_id returns the seeded spans", async () => {
		const spans = await source.queryTraces({
			timeRange: recentWindow(),
			labels: { trace_id: seeded.traceId },
		});

		expect(spans.length).toBe(2);
		const errorSpan = spans.find((s) => s.spanId === seeded.errorSpanId);
		const rootSpan = spans.find((s) => s.spanId === seeded.rootSpanId);
		expect(errorSpan).toBeDefined();
		expect(errorSpan?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(errorSpan?.name).toBe("db.query orders");
		expect(errorSpan?.parentSpanId).toBe(seeded.rootSpanId);
		expect(rootSpan?.statusCode).toBe("STATUS_CODE_OK");
		expect(rootSpan?.parentSpanId).toBeUndefined();
	});

	test("queryTraces error/slowest spans for a service returns the error span first", async () => {
		const spans = await source.queryTraces({
			timeRange: recentWindow(),
			labels: { service: "checkout" },
			limit: 10,
		});

		expect(spans.length).toBeGreaterThan(0);
		expect(spans[0]?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(spans.some((s) => s.spanId === seeded.errorSpanId)).toBe(true);
	});

	test("queryMetrics returns points from a manually seeded metric table via PromQL", async () => {
		const series = await source.queryMetrics({
			timeRange: recentWindow(),
			labels: { service: "checkout" },
			promql: 'paperhanger_test_metric{service_name="checkout"}',
		});

		expect(series.length).toBeGreaterThan(0);
		expect(series[0]?.points.length).toBeGreaterThan(0);
		expect(series[0]?.points.every((p) => Number.isFinite(p.value))).toBe(true);
	});

	test("buildIncidentContext end-to-end yields a context whose markdown mentions the seeded error", async () => {
		const incident = makeIncident();
		const alert = makeAlert({
			annotations: {
				promql: 'paperhanger_test_metric{service_name="checkout"}',
			},
		});

		const context = await buildIncidentContext(
			{
				source,
				logger,
				config: { collect: { windowBeforeMinutes: 30, windowAfterMinutes: 5 } },
			},
			incident,
			alert,
		);

		expect(context.telemetry.logs.length).toBeGreaterThan(0);
		expect(context.telemetry.traces.length).toBeGreaterThan(0);
		expect(context.telemetry.metrics.length).toBeGreaterThan(0);

		const markdown = renderContextMarkdown(context);
		expect(markdown).toContain("database connection timeout");
		expect(markdown).toContain(seeded.traceId);
		expect(markdown).toContain("Checkout error rate spike");
	});
});
