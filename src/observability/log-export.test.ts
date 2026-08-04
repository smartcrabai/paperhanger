import { describe, expect, test } from "bun:test";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	type LogRecordExporter,
	type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ObservabilityConfig } from "../config/schema";
import { createLogExport } from "./log-export";
import { createLogger, type LogEntry } from "./logger";

// Registered once at module scope, mirroring the shared hermetic test
// pattern for this OTel instrumentation work (see
// src/observability/tracing.test.ts): `context.with(...)` below must reflect
// in `context.active()` for the trace-correlation tests.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

/**
 * Retaining in-memory exporter. The SDK's own `InMemoryLogRecordExporter`
 * calls `reset()` from `shutdown()`, which erases every record before the
 * assertions run -- and `createLogExport` only exposes `shutdown()`, so a
 * test can never observe a flushed batch through it. This keeps records past
 * shutdown so the mapping assertions have something to read.
 */
class CapturingLogRecordExporter implements LogRecordExporter {
	readonly records: ReadableLogRecord[] = [];
	private stopped = false;

	export(
		logs: ReadableLogRecord[],
		resultCallback: (result: ExportResult) => void,
	): void {
		if (!this.stopped) {
			this.records.push(...logs);
		}
		resultCallback({ code: ExportResultCode.SUCCESS });
	}

	async shutdown(): Promise<void> {
		this.stopped = true;
	}

	async forceFlush(): Promise<void> {}
}

function collectLines(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = [];
	return { lines, sink: (line: string) => lines.push(line) };
}

const enabledConfig: ObservabilityConfig = {
	endpoint: "http://127.0.0.1:4318/v1/traces",
	serviceName: "paperhanger-test",
	headers: {},
	logs: { endpoint: "http://127.0.0.1:4318/v1/logs" },
};

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		level: "info",
		ts: "2026-01-02T03:04:05.006Z",
		msg: "hello",
		...overrides,
	};
}

describe("createLogExport", () => {
	describe("disabled (config === undefined or logs subsection omitted)", () => {
		test("recordSink is a no-op that never throws", () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });

			for (const config of [
				undefined,
				{
					endpoint: "http://127.0.0.1:4318/v1/traces",
					serviceName: "paperhanger-test",
					headers: {},
				},
			]) {
				const logExport = createLogExport(config, logger);
				expect(() => logExport.recordSink(makeEntry())).not.toThrow();
			}
		});

		test("shutdown resolves without throwing and without a network call", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const logExport = createLogExport(undefined, logger);

			await expect(logExport.shutdown()).resolves.toBeUndefined();
		});
	});

	describe("enabled (entry -> OTel record mapping)", () => {
		test("maps level/ts/msg onto severity/timestamp/body and the remaining fields onto attributes", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const exporter = new CapturingLogRecordExporter();
			const logExport = createLogExport(enabledConfig, logger, { exporter });

			logExport.recordSink(
				makeEntry({
					level: "warn",
					component: "ingest",
					count: 3,
					traceId: "0af7651916cd43dd8448eb211c80319c",
					spanId: "b7ad6b7169203331",
				}),
			);
			await logExport.shutdown();

			const records = exporter.records;
			expect(records.length).toBe(1);
			const record = records[0];
			expect(record?.severityNumber).toBe(SeverityNumber.WARN);
			expect(record?.severityText).toBe("WARN");
			expect(record?.body).toBe("hello");
			// Timestamp: 2026-01-02T03:04:05.006Z as [seconds, nanoseconds].
			const ms = Date.parse("2026-01-02T03:04:05.006Z");
			expect(record?.hrTime).toEqual([
				Math.floor(ms / 1000),
				(ms % 1000) * 1_000_000,
			]);
			// The envelope/correlation keys are lifted onto the record itself and
			// must not be duplicated into attributes.
			expect(record?.attributes).toEqual({ component: "ingest", count: 3 });
			expect(record?.resource.attributes["service.name"]).toBe(
				"paperhanger-test",
			);
		});

		test("maps the active span's traceId/spanId onto the record's span context (end-to-end via the logger)", async () => {
			const exporter = new CapturingLogRecordExporter();
			const { sink } = collectLines();
			const internalLogger = createLogger({ sink });
			const logExport = createLogExport(enabledConfig, internalLogger, {
				exporter,
			});
			const logger = createLogger({ sink, recordSink: logExport.recordSink });

			const spanExporter = new InMemorySpanExporter();
			const tracerProvider = new BasicTracerProvider({
				spanProcessors: [new SimpleSpanProcessor(spanExporter)],
			});
			const tracer = tracerProvider.getTracer("log-export-correlation-test");
			const span = tracer.startSpan("test-span");
			const spanContext = span.spanContext();

			context.with(trace.setSpan(context.active(), span), () => {
				logger.info("inside span");
			});
			span.end();
			await logExport.shutdown();

			const records = exporter.records;
			expect(records.length).toBe(1);
			expect(records[0]?.spanContext?.traceId).toBe(spanContext.traceId);
			expect(records[0]?.spanContext?.spanId).toBe(spanContext.spanId);
			expect(records[0]?.spanContext?.traceFlags).toBe(spanContext.traceFlags);
		});

		test("honors a caller-overridden traceId/spanId, defaulting flags to SAMPLED", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const exporter = new CapturingLogRecordExporter();
			const logExport = createLogExport(enabledConfig, logger, { exporter });

			logExport.recordSink(
				makeEntry({
					traceId: "0af7651916cd43dd8448eb211c80319c",
					spanId: "b7ad6b7169203331",
				}),
			);
			await logExport.shutdown();

			const record = exporter.records[0];
			expect(record?.spanContext?.traceId).toBe(
				"0af7651916cd43dd8448eb211c80319c",
			);
			expect(record?.spanContext?.spanId).toBe("b7ad6b7169203331");
			expect(record?.spanContext?.traceFlags).toBe(TraceFlags.SAMPLED);
		});

		test("leaves the span context unset when the entry has no correlation fields", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const exporter = new CapturingLogRecordExporter();
			const logExport = createLogExport(enabledConfig, logger, { exporter });

			logExport.recordSink(makeEntry());
			await logExport.shutdown();

			expect(exporter.records.length).toBe(1);
			expect(exporter.records[0]?.spanContext).toBeUndefined();
		});
	});

	describe("enabled (OTLP/HTTP exporter wiring)", () => {
		test("inherits the section-level headers when logs.headers is omitted", async () => {
			const seenHeaders: Record<string, string> = {};
			const server = Bun.serve({
				port: 0,
				fetch: (req) => {
					req.headers.forEach((value, key) => {
						seenHeaders[key] = value;
					});
					// Empty body: a valid (all-default) ExportLogsServiceResponse.
					return new Response(new Uint8Array(0), { status: 200 });
				},
			});
			try {
				const { sink } = collectLines();
				const logger = createLogger({ sink });
				const config: ObservabilityConfig = {
					endpoint: "http://127.0.0.1:4318/v1/traces",
					serviceName: "paperhanger-test",
					headers: { "x-shared-auth": "shared-token" },
					logs: { endpoint: `http://127.0.0.1:${server.port}/v1/logs` },
				};
				const logExport = createLogExport(config, logger);

				logExport.recordSink(makeEntry());
				await logExport.shutdown();

				expect(seenHeaders["x-shared-auth"]).toBe("shared-token");
			} finally {
				await server.stop(true);
			}
		});

		test("logs.headers override the section-level headers", async () => {
			const seenHeaders: Record<string, string> = {};
			const server = Bun.serve({
				port: 0,
				fetch: (req) => {
					req.headers.forEach((value, key) => {
						seenHeaders[key] = value;
					});
					return new Response(new Uint8Array(0), { status: 200 });
				},
			});
			try {
				const { sink } = collectLines();
				const logger = createLogger({ sink });
				const config: ObservabilityConfig = {
					endpoint: "http://127.0.0.1:4318/v1/traces",
					serviceName: "paperhanger-test",
					headers: { "x-shared-auth": "shared-token" },
					logs: {
						endpoint: `http://127.0.0.1:${server.port}/v1/logs`,
						headers: { "x-logs-auth": "logs-token" },
					},
				};
				const logExport = createLogExport(config, logger);

				logExport.recordSink(makeEntry());
				await logExport.shutdown();

				expect(seenHeaders["x-logs-auth"]).toBe("logs-token");
				expect(seenHeaders["x-shared-auth"]).toBeUndefined();
			} finally {
				await server.stop(true);
			}
		});
	});

	describe("shutdown timeout/failure paths", () => {
		test("resolves without throwing, quickly, and logs log_export.shutdown_timeout when the endpoint never responds", async () => {
			// Accepts the connection but never resolves the fetch handler --
			// mirrors the hung-endpoint scenario in tracing.test.ts.
			const server = Bun.serve({
				port: 0,
				fetch: () => new Promise<Response>(() => {}),
			});
			try {
				const { lines, sink } = collectLines();
				const logger = createLogger({ sink });
				const config: ObservabilityConfig = {
					endpoint: "http://127.0.0.1:4318/v1/traces",
					serviceName: "paperhanger-test",
					headers: {},
					logs: { endpoint: `http://127.0.0.1:${server.port}/v1/logs` },
				};
				const logExport = createLogExport(config, logger, {
					shutdownTimeoutMs: 150,
				});

				// Give the batch processor something to flush.
				logExport.recordSink(makeEntry());

				const start = Date.now();
				await expect(logExport.shutdown()).resolves.toBeUndefined();
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(2_000);

				const entry = lines
					.map((l) => JSON.parse(l))
					.find((e) => e.msg === "log_export.shutdown_timeout");
				expect(entry).toBeDefined();
				expect(entry.level).toBe("warn");
				expect(entry.timeoutMs).toBe(150);
			} finally {
				await server.stop(true);
			}
		});

		test("resolves without throwing and logs log_export.shutdown_failed when the provider rejects", async () => {
			// An exporter whose shutdown rejects. Note this cannot be provoked
			// through a failing OTLP endpoint: the OTLP exporter reports export
			// failures on the diag channel and still resolves forceFlush/shutdown
			// (verified against @opentelemetry/exporter-logs-otlp-proto 0.220),
			// so a rejecting exporter is what actually reaches the try/catch in
			// `createLogExport`.
			class RejectingExporter extends CapturingLogRecordExporter {
				override async shutdown(): Promise<void> {
					throw new Error("exporter shutdown failed");
				}
			}
			const { lines, sink } = collectLines();
			const logger = createLogger({ sink });
			const logExport = createLogExport(enabledConfig, logger, {
				exporter: new RejectingExporter(),
				shutdownTimeoutMs: 2_000,
			});

			logExport.recordSink(makeEntry());

			await expect(logExport.shutdown()).resolves.toBeUndefined();

			const entries = lines.map((l) => JSON.parse(l));
			const entry = entries.find((e) => e.msg === "log_export.shutdown_failed");
			expect(entry).toBeDefined();
			expect(entry.level).toBe("error");
			expect(entries.some((e) => e.msg === "log_export.shutdown_timeout")).toBe(
				false,
			);
		});

		test("an OTLP endpoint rejecting the export still resolves shutdown", async () => {
			// The complementary real-endpoint case: a non-retryable 400 is
			// reported by the exporter on the diag channel (bridged into the
			// structured logger by tracing.ts) rather than by rejecting, so
			// shutdown completes cleanly with neither failure log.
			const server = Bun.serve({
				port: 0,
				fetch: () => new Response("bad request", { status: 400 }),
			});
			try {
				const { lines, sink } = collectLines();
				const logger = createLogger({ sink });
				const config: ObservabilityConfig = {
					endpoint: "http://127.0.0.1:4318/v1/traces",
					serviceName: "paperhanger-test",
					headers: {},
					logs: { endpoint: `http://127.0.0.1:${server.port}/v1/logs` },
				};
				const logExport = createLogExport(config, logger, {
					shutdownTimeoutMs: 2_000,
				});

				logExport.recordSink(makeEntry());

				await expect(logExport.shutdown()).resolves.toBeUndefined();

				const msgs = lines.map((l) => JSON.parse(l).msg);
				expect(msgs).not.toContain("log_export.shutdown_timeout");
			} finally {
				await server.stop(true);
			}
		});
	});

	describe("fail-soft behavior", () => {
		test("recordSink keeps accepting entries after shutdown (the SDK drops them)", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const exporter = new CapturingLogRecordExporter();
			const logExport = createLogExport(enabledConfig, logger, { exporter });

			logExport.recordSink(makeEntry({ msg: "before" }));
			await logExport.shutdown();

			expect(() =>
				logExport.recordSink(makeEntry({ msg: "after" })),
			).not.toThrow();
			expect(exporter.records.length).toBe(1);
		});

		test("an entry with a non-AnyValue field still exports, with that attribute dropped", async () => {
			const { sink } = collectLines();
			const logger = createLogger({ sink });
			const exporter = new CapturingLogRecordExporter();
			const logExport = createLogExport(enabledConfig, logger, { exporter });

			logExport.recordSink(
				makeEntry({ component: "x", error: new Error("boom") }),
			);
			await logExport.shutdown();

			const record = exporter.records[0];
			expect(record?.body).toBe("hello");
			expect(record?.attributes["component"]).toBe("x");
			// Raw Error instances are not valid OTel AnyValues; the SDK drops
			// them (with a diag warning) instead of failing the export.
			expect(record?.attributes["error"]).toBeUndefined();
		});
	});
});
