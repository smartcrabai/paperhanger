import { describe, expect, test } from "bun:test";
import { context, diag, isSpanContextValid, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ObservabilityConfig } from "../config/schema";
import { createLogger } from "./logger";
import { createTracing } from "./tracing";

// Registered once at module scope, mirroring the shared hermetic test
// pattern for this OTel instrumentation work: AsyncLocalStorageContextManager
// is exactly what `createTracing()` registers in its enabled path, and the
// macrotask-propagation regression test below needs it live for the whole
// file. Every enabled-mode `createTracing()` call in this file therefore
// finds a context manager already registered (see the dedicated test for
// that path) -- harmless, since it is the same manager class either way.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

function collectLines(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = [];
	return { lines, sink: (line: string) => lines.push(line) };
}

const enabledConfig: ObservabilityConfig = {
	endpoint: "http://127.0.0.1:4318/v1/traces",
	serviceName: "paperhanger-test",
	headers: {},
};

describe("createTracing", () => {
	describe("disabled (config === undefined)", () => {
		test("getTracer returns a working no-op tracer", () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const tracing = createTracing(undefined, logger);

			const tracer = tracing.getTracer("some-component");
			const span = tracer.startSpan("some-op");
			// No global provider is registered in the disabled path, so the API
			// falls back to its no-op tracer: spans it produces carry an
			// invalid (all-zero) span context.
			expect(isSpanContextValid(span.spanContext())).toBe(false);
			span.end();
		});

		test("shutdown resolves without throwing and without a network call", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const tracing = createTracing(undefined, logger);

			await expect(tracing.shutdown()).resolves.toBeUndefined();
		});

		test("does not register a context manager", () => {
			const { lines, sink } = collectLines();
			const logger = createLogger({ sink });

			createTracing(undefined, logger);

			// The disabled path must never touch the global context manager --
			// asserted here by confirming the "already registered" warning
			// (logged by the enabled path when one is already installed, see
			// the enabled-mode test below) never fires.
			expect(
				lines.some((l) =>
					l.includes("tracing.context_manager_already_registered"),
				),
			).toBe(false);
		});
	});

	describe("enabled", () => {
		test("getTracer returns a tracer that produces real, valid spans", () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const tracing = createTracing(enabledConfig, logger);

			const tracer = tracing.getTracer("some-component");
			const span = tracer.startSpan("some-op");
			const spanContext = span.spanContext();

			expect(isSpanContextValid(spanContext)).toBe(true);
			expect(spanContext.traceId).toMatch(/^[0-9a-f]{32}$/);
			expect(spanContext.spanId).toMatch(/^[0-9a-f]{16}$/);
			span.end();
		});

		test("logs a warning when a context manager is already registered", () => {
			const { lines, sink } = collectLines();
			const logger = createLogger({ sink });

			// The module-scope `context.setGlobalContextManager` call above has
			// already claimed the global slot, so this call must find
			// `registered === false` and log rather than silently no-op.
			createTracing(enabledConfig, logger);

			const entry = lines
				.map((l) => JSON.parse(l))
				.find((e) => e.msg === "tracing.context_manager_already_registered");
			expect(entry).toBeDefined();
			expect(entry.level).toBe("warn");
		});

		test("bridges OTel's diag logger to the injected Logger", () => {
			const { lines, sink } = collectLines();
			const logger = createLogger({ sink });
			createTracing(enabledConfig, logger);

			diag.warn("otel internal warning", { detail: "queue drop" });

			const entry = lines
				.map((l) => JSON.parse(l))
				.find((e) => e.msg === "otel internal warning");
			expect(entry).toBeDefined();
			expect(entry.level).toBe("warn");
		});
	});

	describe("shutdown timeout/failure paths", () => {
		test("resolves without throwing, quickly, and logs tracing.shutdown_timeout when the endpoint never responds", async () => {
			// Accepts the connection but never resolves the fetch handler, so the
			// exporter's HTTP request gets no response at all -- exactly the
			// "accepting-but-unresponsive endpoint" scenario the 5s (here,
			// shortened) shutdown deadline exists to bound.
			const server = Bun.serve({
				port: 0,
				fetch: () => new Promise<Response>(() => {}),
			});
			try {
				const { lines, sink } = collectLines();
				const logger = createLogger({ sink });
				const config: ObservabilityConfig = {
					endpoint: `http://127.0.0.1:${server.port}/v1/traces`,
					serviceName: "paperhanger-test",
					headers: {},
				};
				const tracing = createTracing(config, logger, {
					shutdownTimeoutMs: 150,
				});

				// Give the batch processor something to flush.
				tracing.getTracer("shutdown-timeout-test").startSpan("some-op").end();

				const start = Date.now();
				await expect(tracing.shutdown()).resolves.toBeUndefined();
				const elapsed = Date.now() - start;

				// Well under the un-shortened 5s default: proves the race actually
				// bailed out at shutdownTimeoutMs instead of waiting on the hung
				// request.
				expect(elapsed).toBeLessThan(2_000);

				const entry = lines
					.map((l) => JSON.parse(l))
					.find((e) => e.msg === "tracing.shutdown_timeout");
				expect(entry).toBeDefined();
				expect(entry.level).toBe("warn");
				expect(entry.timeoutMs).toBe(150);
			} finally {
				await server.stop(true);
			}
		});

		test("resolves without throwing and logs tracing.shutdown_failed when the exporter rejects", async () => {
			// A synchronous, non-retryable HTTP error response (400) is the
			// fastest deterministic way to force the OTLP exporter to reject.
			// A closed/refused port was considered instead, but
			// @opentelemetry/otlp-exporter-base's RetryingTransport treats
			// ECONNREFUSED (and request timeouts) as retryable and backs off
			// across several attempts before giving up, which would make the
			// test both slow (multiple seconds) and timing-dependent on the
			// retry/jitter schedule. A 4xx response outside the retryable set
			// (429/502/503/504, see isExportHTTPErrorRetryable) short-circuits
			// straight to a rejected export instead.
			const server = Bun.serve({
				port: 0,
				fetch: () => new Response("bad request", { status: 400 }),
			});
			try {
				const { lines, sink } = collectLines();
				const logger = createLogger({ sink });
				const config: ObservabilityConfig = {
					endpoint: `http://127.0.0.1:${server.port}/v1/traces`,
					serviceName: "paperhanger-test",
					headers: {},
				};
				const tracing = createTracing(config, logger, {
					shutdownTimeoutMs: 2_000,
				});

				tracing.getTracer("shutdown-failed-test").startSpan("some-op").end();

				await expect(tracing.shutdown()).resolves.toBeUndefined();

				const entries = lines.map((l) => JSON.parse(l));
				const entry = entries.find((e) => e.msg === "tracing.shutdown_failed");
				expect(entry).toBeDefined();
				expect(entry.level).toBe("error");
				// Confirms the exporter settled (rejected) on its own well inside
				// the shutdown budget, rather than the race timing out instead.
				expect(entries.some((e) => e.msg === "tracing.shutdown_timeout")).toBe(
					false,
				);
			} finally {
				await server.stop(true);
			}
		});
	});

	describe("context propagation across a real macrotask (AsyncLocalStorageContextManager)", () => {
		// MANDATORY regression test (see design doc section 10): this is the
		// exact scenario in which the deprecated AsyncHooksContextManager
		// silently loses the active context on Bun -- a child span started
		// after an awaited macrotask must still land under the parent's trace.
		test("a child span started after `await Bun.sleep(...)` inherits the parent's traceId", async () => {
			const exporter = new InMemorySpanExporter();
			const provider = new BasicTracerProvider({
				spanProcessors: [new SimpleSpanProcessor(exporter)],
			});
			const tracer = provider.getTracer("macrotask-propagation-test");

			const parentSpan = tracer.startSpan("parent");
			const parentSpanContext = parentSpan.spanContext();

			await context.with(
				trace.setSpan(context.active(), parentSpan),
				async () => {
					await Bun.sleep(5);
					const childSpan = tracer.startSpan("child");
					childSpan.end();
				},
			);
			parentSpan.end();

			const spans = exporter.getFinishedSpans();
			const child = spans.find((s) => s.name === "child");
			expect(child).toBeDefined();
			expect(child?.spanContext().traceId).toBe(parentSpanContext.traceId);
			expect(child?.parentSpanContext?.spanId).toBe(parentSpanContext.spanId);
		});
	});
});
