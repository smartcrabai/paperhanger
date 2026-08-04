/**
 * Self-instrumentation: OpenTelemetry log export for paperhanger's OWN logs.
 * Distinct from `src/telemetry/*`, which is where paperhanger READS other
 * services' telemetry from (GreptimeDB).
 *
 * Bridges the structured JSON-lines logger (`src/observability/logger.ts`)
 * into an OTel `LoggerProvider` with a `BatchLogRecordProcessor` and an
 * OTLP/HTTP proto exporter. The stdout JSON-lines sink remains the primary
 * sink; OTel export is an additional sink attached via the root logger's
 * `recordSink` option (wired in `src/index.ts`). Entries that carry
 * `traceId`/`spanId` (added by the logger when a span is active) have them
 * mapped onto the OTel log record's span context, so logs and traces
 * correlate in the backend.
 *
 * Fail-soft: exporter errors surface through the injected logger (shutdown
 * paths) or OTel's diag channel (export-time paths; bridged into the
 * structured logger by `src/observability/tracing.ts`), never crash the
 * process, and never block logging. Attribute values that are not valid OTel
 * AnyValues (e.g. raw `Error` instances) are dropped by the SDK with a diag
 * warning; the stdout line is unaffected.
 */

import { context, type Context, trace, TraceFlags } from "@opentelemetry/api";
import { type LogAttributes, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
	type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import type { ObservabilityConfig } from "../config/schema";
import type { LogEntry, Logger, LogLevel } from "./logger";
import { withTimeout } from "./timeout";

/** Same bounded-shutdown rationale as tracing.ts: keeps process shutdown bounded against an unreachable OTLP endpoint. */
const LOG_EXPORT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Same per-request timeout rationale as tracing.ts: the exporter must give up on its own inside the shutdown budget. */
const OTLP_LOG_EXPORTER_TIMEOUT_MS = 4_000;

export interface LogExport {
	/**
	 * Receives each structured entry from the root logger and forwards it to
	 * the OTLP exporter. Pass as `recordSink` to `createLogger`. The logger
	 * guards this call with a try/catch (see `LoggerOptions.recordSink`), so
	 * a failure here can never break the primary stdout sink.
	 */
	recordSink: (entry: LogEntry) => void;
	/** Flushes pending log records and shuts the provider down. Never rejects. */
	shutdown(): Promise<void>;
}

const SEVERITY_NUMBERS: Record<LogLevel, SeverityNumber> = {
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
};

/**
 * Builds the OTel `Context` carrying the entry's `traceId`/`spanId` so the
 * exported log record correlates with the trace. Returns `undefined` when the
 * entry has no correlation fields (the SDK then falls back to the active
 * context, which holds no valid span either).
 *
 * Trace flags are preserved from the active span when it matches the entry
 * (the common case: the logger copied them from that same span). For the
 * rare override case (a caller passing its own `traceId` field) the flags
 * are unknown and default to SAMPLED: a log line explicitly correlated to a
 * trace belongs to a trace worth sampling, matching paperhanger's always-on
 * tracer sampler.
 */
function logRecordContext(entry: LogEntry): Context | undefined {
	const { traceId, spanId } = entry;
	if (typeof traceId !== "string" || typeof spanId !== "string") {
		return undefined;
	}
	const activeSpanContext = trace.getActiveSpan()?.spanContext();
	const traceFlags =
		activeSpanContext !== undefined &&
		activeSpanContext.traceId === traceId &&
		activeSpanContext.spanId === spanId
			? activeSpanContext.traceFlags
			: TraceFlags.SAMPLED;
	return trace.setSpanContext(context.active(), {
		traceId,
		spanId,
		traceFlags,
		isRemote: true,
	});
}

/**
 * Builds paperhanger's self-instrumentation logger provider.
 *
 * Enabled only when `config.observability.logs` is present (the tracing
 * config shape: presence of the section is the enable flag). In the disabled
 * path `recordSink` is a no-op and `shutdown` resolves immediately, so the
 * root logger can wire the sink unconditionally.
 *
 * @param options.shutdownTimeoutMs Overrides `LOG_EXPORT_SHUTDOWN_TIMEOUT_MS`.
 * Primarily for tests that need to observe the timeout/failure paths of
 * `shutdown()` deterministically without waiting out the real 5s deadline.
 * @param options.exporter Overrides the OTLP/HTTP proto exporter. Primarily
 * for tests that capture records with an in-memory exporter instead of
 * standing up an OTLP endpoint.
 */
export function createLogExport(
	config: ObservabilityConfig | undefined,
	logger: Logger,
	options?: { shutdownTimeoutMs?: number; exporter?: LogRecordExporter },
): LogExport {
	const logsConfig = config?.logs;
	if (config === undefined || logsConfig === undefined) {
		return {
			recordSink: () => {},
			shutdown: async () => {},
		};
	}

	const exporter =
		options?.exporter ??
		new OTLPLogExporter({
			url: logsConfig.endpoint,
			// Log exports share the section's headers (typical collectors share
			// auth across signals) unless the logs subsection overrides them.
			headers: logsConfig.headers ?? config.headers,
			// See OTLP_LOG_EXPORTER_TIMEOUT_MS above: keeps the exporter's own
			// per-export timeout inside the shutdown budget.
			timeoutMillis: OTLP_LOG_EXPORTER_TIMEOUT_MS,
		});
	const provider = new LoggerProvider({
		resource: resourceFromAttributes({ "service.name": config.serviceName }),
		processors: [new BatchLogRecordProcessor({ exporter })],
	});
	const otelLogger = provider.getLogger("paperhanger");

	const shutdownTimeoutMs =
		options?.shutdownTimeoutMs ?? LOG_EXPORT_SHUTDOWN_TIMEOUT_MS;

	return {
		recordSink: (entry) => {
			// traceId/spanId are destructured only to keep them out of `rest`;
			// they reach the record through `logRecordContext(entry)` below.
			const {
				level,
				ts,
				msg,
				traceId: _traceId,
				spanId: _spanId,
				...rest
			} = entry;
			otelLogger.emit({
				timestamp: new Date(ts),
				severityNumber: SEVERITY_NUMBERS[level],
				severityText: level.toUpperCase(),
				body: msg,
				// `LogEntry` fields are `unknown` at the type level; values that
				// are not valid OTel AnyValues (e.g. raw Error instances) are
				// dropped by the SDK's attribute validation with a diag warning
				// (fail-soft), leaving the stdout line unaffected.
				attributes: rest as LogAttributes,
				context: logRecordContext(entry),
			});
		},
		shutdown: async () => {
			await withTimeout(
				(async () => {
					try {
						await provider.forceFlush();
					} catch (error) {
						logger.error("log_export.shutdown_failed", { error });
					}
					try {
						await provider.shutdown();
					} catch (error) {
						logger.error("log_export.shutdown_failed", { error });
					}
				})(),
				shutdownTimeoutMs,
				() => {
					logger.warn("log_export.shutdown_timeout", {
						timeoutMs: shutdownTimeoutMs,
					});
				},
			);
		},
	};
}
