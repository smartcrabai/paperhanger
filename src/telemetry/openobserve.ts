/**
 * OpenObserve `TelemetrySource` implementation: the `_search` HTTP API
 * (SQL-style, per-stream). See:
 *   - https://openobserve.ai/docs/reference/api/search/search/ --
 *     `POST /api/{organization}/_search`, body `{ query: { sql, start_time,
 *     end_time, from, size }, search_type }`, response `{ hits, total, took,
 *     scan_size }`. `start_time`/`end_time` are **microseconds** since epoch,
 *     matching OpenObserve's internal `_timestamp` column.
 *   - https://openobserve.ai/docs/reference/api/ -- "Authorization header
 *     can be created using base64 encoded values of user id and password"
 *     (HTTP Basic auth), same convention as greptimedb.ts's `auth` field.
 *
 * Traces use the same general `_search` SQL endpoint against the traces
 * stream rather than the dedicated `GET /{stream}/traces/latest` API
 * (https://openobserve.ai/docs/reference/api/traces/trace-search-api/):
 * that endpoint returns one summarized row per *trace* (with only a
 * `first_event` span), not one row per *span*, so it can't satisfy this
 * client's `TraceRecord[]` (one row per span) contract or fetch every span
 * of a specific trace_id. Plain SQL against the trace stream fetches full
 * per-span data the same way queryLogs does.
 *
 * IMPORTANT CAVEATS (see this PR's "Testing note" -- none of the below was
 * verified against a live instance):
 *   - Metrics: the public docs above only document the `/prometheus/api/v1/
 *     write` remote-write (ingestion) path. This client assumes a mirrored
 *     `/prometheus/api/v1/query_range` *read* path under the same
 *     `/api/{organization}/prometheus/...` prefix, inferred from that
 *     confirmed write-path naming and OpenObserve's documented "PromQL and
 *     SQL" metrics-explorer/Grafana-Prometheus-datasource compatibility --
 *     not confirmed directly in fetched docs.
 *   - Row field names: OpenObserve's OTLP log/trace ingestion is documented
 *     to flatten resource/span attributes into top-level stream columns
 *     (dots in OTel attribute keys become underscores, since column names
 *     can't contain dots), but the exact flattened column names for e.g.
 *     `service.name` or span duration/status aren't documented in detail.
 *     Row mapping below is deliberately tolerant of a few plausible
 *     key-naming variants per field.
 */

import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { OpenObserveTelemetryConfig } from "../config/schema";
import type { Logger } from "../observability/logger";
import {
	asNumber,
	asString,
	computeStepSeconds,
	firstDefined,
	omit,
	parsePrometheusResponse,
	type LogRecord,
	resolveServiceLabel,
	SERVICE_LABEL_ALIASES,
	type MetricSeries,
	type PromQueryRangeResponse,
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
	validateAttributeKey,
	validateIdentifier,
	validateLimit,
	validateTraceId,
} from "./types";

const TRACER_NAME = "telemetry-openobserve";

export const DEFAULT_LOGS_STREAM = "default";
export const DEFAULT_TRACES_STREAM = "default";

const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
const DEFAULT_OPENOBSERVE_TIMEOUT_MS = 30_000;
/** OTel standard severity number for ERROR (matches greptimedb.ts/clickstack.ts/signoz.ts). */
const ERROR_SEVERITY_NUMBER = 17;
/** Spans slower than this are considered "slow" for the representative-span query (nanoseconds). */
const SLOW_SPAN_THRESHOLD_NANO = 50_000_000; // 50ms

const SERVICE_ATTRIBUTE_KEY = "service.name";
const SERVICE_COLUMN = "service_name";

export type OpenObserveSourceConfig = Omit<
	OpenObserveTelemetryConfig,
	"source"
>;

/** Thrown for any non-2xx `_search`/`query_range` response. */
export class OpenObserveError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "OpenObserveError";
		this.httpStatus = httpStatus;
	}
}

/** Converts a dotted OTel attribute key to OpenObserve's flattened column-name convention. */
function attributeKeyToColumn(key: string): string {
	validateAttributeKey(key);
	return validateIdentifier(key.replace(/\./g, "_"));
}

function escapeSqlString(value: string): string {
	return value.replace(/'/g, "''");
}

function sqlLiteral(value: string): string {
	return `'${escapeSqlString(value)}'`;
}

function isoToMicros(iso: string): number {
	const ms = new Date(iso).getTime();
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid ISO timestamp: ${iso}`);
	}
	return ms * 1000;
}

/** OpenObserve's own `_timestamp` column is microseconds since epoch. */
function microsToIso(raw: unknown): string {
	const micros = asNumber(raw, Number.NaN);
	if (Number.isNaN(micros)) {
		throw new Error("Unexpected timestamp value from OpenObserve");
	}
	return new Date(micros / 1000).toISOString();
}

/** Trace start_time is documented (trace-search-api) as nanoseconds since epoch. */
function nanosToIso(raw: unknown): string {
	const nanos = asNumber(raw, Number.NaN);
	if (Number.isNaN(nanos)) {
		throw new Error("Unexpected timestamp value from OpenObserve");
	}
	return new Date(nanos / 1_000_000).toISOString();
}

interface SearchResponse {
	took?: number;
	hits?: Record<string, unknown>[];
	total?: number;
	error?: string;
	message?: string;
}

function rowToLogRecord(row: Record<string, unknown>): LogRecord {
	const traceId = asString(firstDefined(row, "trace_id"));
	const spanId = asString(firstDefined(row, "span_id"));
	const serviceName = asString(firstDefined(row, SERVICE_COLUMN, "service"));
	return {
		timestamp: microsToIso(firstDefined(row, "_timestamp")),
		severityText: asString(firstDefined(row, "severity_text", "level")),
		severityNumber: asNumber(firstDefined(row, "severity_number")),
		body: asString(firstDefined(row, "body", "log", "message")),
		traceId: traceId ? traceId : undefined,
		spanId: spanId ? spanId : undefined,
		serviceName: serviceName ? serviceName : undefined,
		// OpenObserve flattens ingested records into top-level stream columns
		// (see the caveat at the top of this file), so there's no separate
		// "resource attributes" sub-object to read -- everything not already
		// mapped above is surfaced as a generic attribute.
		attributes: omit(row, [
			"_timestamp",
			"trace_id",
			"span_id",
			SERVICE_COLUMN,
			"service",
			"severity_text",
			"level",
			"severity_number",
			"body",
			"log",
			"message",
		]),
		resourceAttributes: serviceName
			? { [SERVICE_ATTRIBUTE_KEY]: serviceName }
			: {},
	};
}

function rowToTraceRecord(row: Record<string, unknown>): TraceRecord {
	const parentSpanId = asString(
		firstDefined(row, "parent_span_id", "reference_parent_span_id"),
	);
	// `duration` is documented as microseconds by OpenObserve's trace-summary
	// API (traces/latest); assumed to hold for the raw stream too since no
	// nanosecond-duration column name is documented anywhere.
	const durationMicros = asNumber(firstDefined(row, "duration"));
	return {
		traceId: asString(firstDefined(row, "trace_id")),
		spanId: asString(firstDefined(row, "span_id")),
		parentSpanId: parentSpanId ? parentSpanId : undefined,
		name: asString(firstDefined(row, "operation_name", "span_name", "name")),
		kind: asString(firstDefined(row, "span_kind", "kind")),
		serviceName: asString(firstDefined(row, SERVICE_COLUMN, "service")),
		startTime: nanosToIso(firstDefined(row, "start_time")),
		durationNano: durationMicros * 1000,
		statusCode: asString(firstDefined(row, "span_status", "status_code")),
		attributes: {
			statusMessage: asString(firstDefined(row, "status_message")),
		},
	};
}

function buildLogConditions(query: TelemetryQuery): string[] {
	const conditions: string[] = [
		`_timestamp >= ${isoToMicros(query.timeRange.from)}`,
		`_timestamp <= ${isoToMicros(query.timeRange.to)}`,
	];
	for (const [key, value] of Object.entries(query.labels)) {
		if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
			conditions.push(`${SERVICE_COLUMN} = ${sqlLiteral(value)}`);
			continue;
		}
		if (key === "severity") {
			if (value.toLowerCase() === "error") {
				conditions.push(`severity_number >= ${ERROR_SEVERITY_NUMBER}`);
			} else {
				conditions.push(`severity_text = ${sqlLiteral(value)}`);
			}
			continue;
		}
		conditions.push(`${attributeKeyToColumn(key)} = ${sqlLiteral(value)}`);
	}
	return conditions;
}

export class OpenObserveSource implements TelemetrySource {
	readonly name = "openobserve";

	private readonly url: string;
	private readonly organization: string;
	private readonly authHeader?: string;
	private readonly logsStream: string;
	private readonly tracesStream: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly timeoutMs: number;
	private readonly tracer: Tracer;

	constructor(
		config: OpenObserveSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.organization = config.organization;
		this.authHeader = config.auth ? `Basic ${btoa(config.auth)}` : undefined;
		this.logsStream = validateIdentifier(
			config.logsStream ?? DEFAULT_LOGS_STREAM,
		);
		this.tracesStream = validateIdentifier(
			config.tracesStream ?? DEFAULT_TRACES_STREAM,
		);
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_OPENOBSERVE_TIMEOUT_MS;
		this.tracer = tracer ?? trace.getTracer(TRACER_NAME);
	}

	/** Mirrors greptimedb.ts's `withQuerySpan` -- see its doc comment for the redaction rationale. */
	private async withQuerySpan<T>(
		spanName: string,
		kind: "logs" | "traces" | "metrics",
		attributes: Attributes,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		const span = this.tracer.startSpan(spanName, {
			kind: SpanKind.CLIENT,
			attributes: {
				"db.system.name": "openobserve",
				"paperhanger.query.kind": kind,
				...attributes,
			},
		});
		try {
			return await context.with(trace.setSpan(context.active(), span), () =>
				fn(span),
			);
		} catch (err) {
			if (err instanceof OpenObserveError) {
				span.setAttribute("http.response.status_code", err.httpStatus);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `OpenObserve query failed (http_status=${err.httpStatus})`,
				});
			} else {
				span.recordException(err as Error);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
			}
			throw err;
		} finally {
			span.end();
		}
	}

	private async fetchWithTimeout(
		url: string,
		init: RequestInit,
	): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);

		try {
			return await this.fetchImpl(url, { ...init, signal: controller.signal });
		} catch (err) {
			if (timedOut || controller.signal.aborted) {
				throw new OpenObserveError(
					`OpenObserve request timed out after ${this.timeoutMs}ms`,
					0,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	private authHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}
		return headers;
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return this.withQuerySpan(
			"openobserve.query_logs",
			"logs",
			{ "db.collection.name": this.logsStream },
			async () => {
				const limit = validateLimit(query.limit ?? DEFAULT_LOG_LIMIT);
				const conditions = buildLogConditions(query);
				const sql = `SELECT * FROM ${this.logsStream} WHERE ${conditions.join(" AND ")} ORDER BY _timestamp DESC LIMIT ${limit}`;
				const hits = await this.runSearch(sql, query.timeRange, limit);
				return hits.map(rowToLogRecord);
			},
		);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		const strategy = query.labels.trace_id ? "trace_ids" : "representative";
		return this.withQuerySpan(
			"openobserve.query_traces",
			"traces",
			{
				"db.collection.name": this.tracesStream,
				"paperhanger.query.strategy": strategy,
			},
			async () => {
				const limit = validateLimit(query.limit ?? DEFAULT_TRACE_LIMIT);

				const traceIdsRaw = query.labels.trace_id;
				if (traceIdsRaw) {
					const traceIds = traceIdsRaw
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id.length > 0)
						.map(validateTraceId);
					if (traceIds.length === 0) {
						return [];
					}
					const idList = traceIds.map(sqlLiteral).join(", ");
					const sql = `SELECT * FROM ${this.tracesStream} WHERE trace_id IN (${idList}) ORDER BY start_time ASC LIMIT ${limit}`;
					const hits = await this.runSearch(sql, query.timeRange, limit);
					return hits.map(rowToTraceRecord);
				}

				const conditions: string[] = [
					`_timestamp >= ${isoToMicros(query.timeRange.from)}`,
					`_timestamp <= ${isoToMicros(query.timeRange.to)}`,
				];
				const serviceValue = resolveServiceLabel(query.labels);
				if (serviceValue) {
					conditions.push(`${SERVICE_COLUMN} = ${sqlLiteral(serviceValue)}`);
				}
				conditions.push(
					// `duration` is documented as microseconds (see rowToTraceRecord);
					// the slow-span threshold is converted from nanoseconds accordingly.
					`(UPPER(span_status) = 'ERROR' OR duration > ${SLOW_SPAN_THRESHOLD_NANO / 1000})`,
				);
				const orderBy =
					"CASE WHEN UPPER(span_status) = 'ERROR' THEN 0 ELSE 1 END, duration DESC";
				const sql = `SELECT * FROM ${this.tracesStream} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT ${limit}`;
				const hits = await this.runSearch(sql, query.timeRange, limit);
				return hits.map(rowToTraceRecord);
			},
		);
	}

	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return this.withQuerySpan(
			"openobserve.query_metrics",
			"metrics",
			{},
			async (span) => {
				if (!query.promql) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics called without a PromQL expression; returning no series",
					);
					return [];
				}

				const fromSec = Math.floor(
					new Date(query.timeRange.from).getTime() / 1000,
				);
				const toSec = Math.floor(new Date(query.timeRange.to).getTime() / 1000);
				if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
					throw new Error(
						`Invalid time range for metrics query: ${query.timeRange.from} .. ${query.timeRange.to}`,
					);
				}
				const step = computeStepSeconds(fromSec, toSec);

				const params = new URLSearchParams({
					query: query.promql,
					start: String(fromSec),
					end: String(toSec),
					step: `${step}s`,
				});
				// Read-path inferred from the confirmed write path
				// (`/api/{org}/prometheus/api/v1/write`); see the caveat at the top
				// of this file -- not verified against a live instance.
				const response = await this.fetchWithTimeout(
					`${this.url}/api/${encodeURIComponent(this.organization)}/prometheus/api/v1/query_range?${params.toString()}`,
					{ method: "GET", headers: this.authHeaders() },
				);
				const text = await response.text();
				const json = this.parseJson(
					text,
					response.status,
				) as PromQueryRangeResponse;
				if (!response.ok || json.status !== "success") {
					throw new OpenObserveError(
						json.error ??
							`PromQL range query failed with HTTP status ${response.status}`,
						response.status,
					);
				}
				return parsePrometheusResponse(json);
			},
		);
	}

	private parseJson(text: string, httpStatus: number): unknown {
		try {
			return JSON.parse(text);
		} catch (err) {
			throw new OpenObserveError(
				`Failed to parse OpenObserve response as JSON: ${(err as Error).message}`,
				httpStatus,
			);
		}
	}

	private async runSearch(
		sql: string,
		timeRange: { from: string; to: string },
		limit: number,
	): Promise<Record<string, unknown>[]> {
		const response = await this.fetchWithTimeout(
			`${this.url}/api/${encodeURIComponent(this.organization)}/_search`,
			{
				method: "POST",
				headers: this.authHeaders(),
				body: JSON.stringify({
					query: {
						sql,
						start_time: isoToMicros(timeRange.from),
						end_time: isoToMicros(timeRange.to),
						from: 0,
						size: limit,
					},
					search_type: "ui",
				}),
			},
		);
		const text = await response.text();
		const json = this.parseJson(text, response.status) as SearchResponse;
		if (!response.ok) {
			throw new OpenObserveError(
				json.error ??
					json.message ??
					`OpenObserve _search request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		return json.hits ?? [];
	}
}
