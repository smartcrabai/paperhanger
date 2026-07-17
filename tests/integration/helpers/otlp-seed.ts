/**
 * Seeds a real GreptimeDB instance with realistic telemetry, for the
 * greptimedb.test.ts integration suite. paperhanger itself never ingests
 * telemetry (see docs/research/greptimedb.md), so this helper exists purely
 * to produce test fixtures via the official OTel SDKs.
 *
 * GreptimeDB's OTLP/HTTP endpoints only accept protobuf-encoded payloads
 * (JSON is rejected), so a hand-rolled `fetch` body will not work here — the
 * OTel SDK + `-otlp-proto` exporters are required.
 */

import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	LoggerProvider,
	SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
	BasicTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface SeedResult {
	traceId: string;
	errorSpanId: string;
	rootSpanId: string;
}

/**
 * Emits ~10 log records (3 ERROR incl. one stack-trace-bearing, 7 INFO) and
 * two correlated spans (one root OK span, one child ERROR span) for
 * `serviceName`, then flushes everything via OTLP/HTTP protobuf to
 * `baseUrl` (a GreptimeDB HTTP endpoint, e.g. `http://localhost:4000`).
 */
export async function seedTelemetry(
	baseUrl: string,
	serviceName = "checkout",
): Promise<SeedResult> {
	// Required for context.active() to reflect context.with(...) — without a
	// registered context manager, emitted logs would carry empty trace/span
	// ids even inside a context.with block (see docs/research/greptimedb.md).
	context.setGlobalContextManager(new AsyncHooksContextManager().enable());

	const resource = resourceFromAttributes({
		"service.name": serviceName,
		"deployment.environment": "test",
	});

	const traceExporter = new OTLPTraceExporter({
		url: `${baseUrl}/v1/otlp/v1/traces`,
		headers: {
			"x-greptime-pipeline-name": "greptime_trace_v1",
			"x-greptime-db-name": "public",
		},
	});
	const tracerProvider = new BasicTracerProvider({
		resource,
		// Note: @opentelemetry/sdk-trace-base@2.x's SimpleSpanProcessor is a
		// compat shim over the new @opentelemetry/sdk-trace package and keeps
		// the old positional-exporter constructor (unlike sdk-logs's
		// SimpleLogRecordProcessor below, which takes an options object).
		spanProcessors: [new SimpleSpanProcessor(traceExporter)],
	});
	const tracer = tracerProvider.getTracer("paperhanger-integration-seed");

	const logExporter = new OTLPLogExporter({
		url: `${baseUrl}/v1/otlp/v1/logs`,
		headers: { "x-greptime-db-name": "public" },
	});
	const loggerProvider = new LoggerProvider({
		resource,
		processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
	});
	const logger = loggerProvider.getLogger("paperhanger-integration-seed");

	const rootSpan = tracer.startSpan("POST /checkout", {
		kind: SpanKind.SERVER,
	});
	rootSpan.setStatus({ code: SpanStatusCode.OK });
	const rootCtx = trace.setSpan(context.active(), rootSpan);

	const errorSpan = tracer.startSpan(
		"db.query orders",
		{ kind: SpanKind.CLIENT },
		rootCtx,
	);
	errorSpan.setStatus({
		code: SpanStatusCode.ERROR,
		message: "connection timeout",
	});
	const errorCtx = trace.setSpan(rootCtx, errorSpan);

	const traceId = errorSpan.spanContext().traceId;
	const errorSpanId = errorSpan.spanContext().spanId;
	const rootSpanId = rootSpan.spanContext().spanId;

	context.with(errorCtx, () => {
		logger.emit({
			severityNumber: SeverityNumber.ERROR,
			severityText: "ERROR",
			body:
				"database connection timeout after 30s while querying orders_table\n" +
				"    at OrdersRepository.query (/app/src/orders-repository.ts:42:11)\n" +
				"    at async CheckoutService.createOrder (/app/src/checkout-service.ts:18:5)",
			attributes: { "exception.type": "ConnectionTimeoutError" },
		});
		logger.emit({
			severityNumber: SeverityNumber.ERROR,
			severityText: "ERROR",
			body: "failed to reserve inventory for order 8842",
		});
		logger.emit({
			severityNumber: SeverityNumber.ERROR,
			severityText: "ERROR",
			body: "payment gateway returned 503 for order 8842",
		});
	});

	errorSpan.end();

	context.with(rootCtx, () => {
		const infoBodies = [
			"checkout request received",
			"validating cart contents",
			"cart validated successfully",
			"reserving inventory",
			"charging payment method",
			"order confirmation email queued",
			"checkout request completed",
		];
		for (const body of infoBodies) {
			logger.emit({
				severityNumber: SeverityNumber.INFO,
				severityText: "INFO",
				body,
			});
		}
	});

	rootSpan.end();

	await tracerProvider.forceFlush();
	await loggerProvider.forceFlush();
	await tracerProvider.shutdown();
	await loggerProvider.shutdown();

	return { traceId, errorSpanId, rootSpanId };
}

/** Runs a raw SQL statement against GreptimeDB's HTTP SQL API (test setup only). */
async function execSql(baseUrl: string, sql: string): Promise<void> {
	const response = await fetch(`${baseUrl}/v1/sql?db=public`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ sql }).toString(),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Seed SQL failed (HTTP ${response.status}): ${text}`);
	}
}

/**
 * Creates and populates a small metrics table by hand via SQL, then queried
 * via PromQL. This sidesteps OTLP metrics ingestion (protobuf Histogram/Sum
 * encoding is significant extra ceremony for one test) — GreptimeDB's PromQL
 * engine treats any table with a time-index column, tag columns, and a
 * numeric field column as a queryable metric named after the table (verified
 * against docs.greptime.com's `host_val` example), so a plain `CREATE TABLE`
 * + `INSERT` is sufficient and realistic for this test.
 */
export async function seedMetricTable(
	baseUrl: string,
	tableName = "paperhanger_test_metric",
	serviceName = "checkout",
): Promise<void> {
	await execSql(
		baseUrl,
		`CREATE TABLE IF NOT EXISTS ${tableName} (
			ts TIMESTAMP TIME INDEX,
			service_name STRING,
			val DOUBLE,
			PRIMARY KEY (service_name)
		)`,
	);

	const now = Date.now();
	const rows: string[] = [];
	for (let i = 0; i < 6; i++) {
		const ts = new Date(now - i * 60_000)
			.toISOString()
			.replace("T", " ")
			.replace("Z", "");
		rows.push(`('${ts}', '${serviceName}', ${10 + i})`);
	}
	await execSql(baseUrl, `INSERT INTO ${tableName} VALUES ${rows.join(", ")}`);
}
