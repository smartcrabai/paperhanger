/**
 * ClickStack `TelemetrySource` implementation.
 *
 * ClickStack is ClickHouse's open-source observability stack (logs/traces/
 * metrics/session replay), launched May 2025 after ClickHouse acquired
 * HyperDX (March 2025) and folded it in as the stack's bundled UI:
 * https://clickhouse.com/clickstack . The HyperDX UI itself has no separate
 * query API of its own to talk to here -- per
 * https://clickhouse.com/docs/cloud/manage/hyperdx and
 * https://github.com/ClickHouse/clickstack, it queries ClickHouse directly.
 * This client therefore speaks ClickHouse's native HTTP interface
 * (https://clickhouse.com/docs/interfaces/http, default port 8123) with SQL
 * against the OTel schema ClickStack's bundled collector creates -- the same
 * schema documented at
 * https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/schemas
 * (tables `otel_logs`/`otel_traces` in the `default` database by default;
 * `ResourceAttributes`/`LogAttributes` are `Map(String, String)` columns,
 * not JSON). Any ClickHouse deployment using that same OTel exporter schema
 * works here too, whether or not it's actually running the HyperDX/ClickStack
 * UI -- there is nothing HyperDX-specific in the query path itself.
 *
 * Unlike GreptimeDB, ClickHouse has no PromQL-compatible query endpoint for
 * arbitrary stored metrics (its own `/metrics` Prometheus exposition surface
 * is for ClickHouse's OWN internal metrics, not a general query engine --
 * see https://clickhouse.com/docs/interfaces/prometheus). `queryMetrics`
 * therefore always returns an empty result with an explanatory log, the same
 * degradation greptimedb.ts uses when no query hint is present (see
 * docs/spec.md section 3.4); mapping an alert's `promql`/`metric` hint onto a
 * hand-written SQL query against `otel_metrics_gauge`/`_sum`/`_histogram` is
 * future work.
 */

import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Logger } from "../observability/logger";
import {
	type LogRecord,
	resolveServiceLabel,
	SERVICE_LABEL_ALIASES,
	type MetricSeries,
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

const TRACER_NAME = "telemetry-clickstack";

export const DEFAULT_LOGS_TABLE = "otel_logs";
export const DEFAULT_TRACES_TABLE = "otel_traces";

const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
const DEFAULT_CLICKSTACK_TIMEOUT_MS = 30_000;
/** OTel standard severity number for ERROR (matches greptimedb.ts). */
const ERROR_SEVERITY_NUMBER = 17;
/** Spans slower than this are considered "slow" for the representative-span query. */
const SLOW_SPAN_THRESHOLD_NANO = 50_000_000; // 50ms

const SERVICE_ATTRIBUTE_KEY = "service.name";

/** Table/database identifiers we interpolate must match this to be safe to embed in SQL. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Resource/log attribute keys (OTel dotted keys), used as Map(...) access keys. */
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** Trace IDs are lowercase hex strings; validated before embedding in an IN (...) list. */
const TRACE_ID_PATTERN = /^[0-9a-fA-F]+$/;

const LOG_COLUMNS = [
	"Timestamp",
	"SeverityText",
	"SeverityNumber",
	"Body",
	"TraceId",
	"SpanId",
	"ServiceName",
	"LogAttributes",
	"ResourceAttributes",
];

// Events/Links are ClickHouse Nested columns (parallel arrays per
// subcolumn, e.g. `Events.Name`/`Events.Attributes`), not a single JSON
// blob -- selecting the bare `Events`/`Links` column name isn't valid SQL.
// Reconstructing them into TraceRecord.attributes would need per-subcolumn
// projection and zipping that can't be verified without a live ClickStack
// instance (see the "Testing note" in this PR), so this client surfaces
// only `statusMessage` and leaves events/links as future work.
const TRACE_COLUMNS = [
	"Timestamp",
	"Duration",
	"ParentSpanId",
	"TraceId",
	"SpanId",
	"SpanKind",
	"SpanName",
	"StatusCode",
	"StatusMessage",
	"ServiceName",
];

export interface ClickStackSourceConfig {
	/** ClickHouse HTTP interface base URL, e.g. `http://localhost:8123`. */
	url: string;
	database: string;
	/** `username:password`, unencoded; the client base64-encodes it itself. */
	auth?: string;
	/** Overrides for OTLP-ingested table names (deployments can rename them). */
	logsTable?: string;
	tracesTable?: string;
	/** Per-request timeout in milliseconds for all HTTP calls. Defaults to `DEFAULT_CLICKSTACK_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Thrown for any non-2xx ClickHouse HTTP response. ClickHouse's error bodies are plain text, not JSON. */
export class ClickStackError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "ClickStackError";
		this.httpStatus = httpStatus;
	}
}

// See greptimedb.ts's identical note: validators never embed the raw
// offending value (upstream-tainted) into their Error message, since that
// message can end up recorded verbatim onto an exported span.

function validateIdentifier(name: string): string {
	if (!IDENTIFIER_PATTERN.test(name)) {
		throw new Error(`Invalid SQL identifier (length=${name.length})`);
	}
	return name;
}

function validateAttributeKey(key: string): string {
	if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
		throw new Error(`Invalid attribute/label key (length=${key.length})`);
	}
	return key;
}

function validateTraceId(id: string): string {
	if (!TRACE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid trace id (length=${id.length})`);
	}
	return id;
}

function validateLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error("Invalid limit: must be a positive integer");
	}
	return limit;
}

function escapeSqlString(value: string): string {
	return value.replace(/'/g, "''");
}

function sqlLiteral(value: string): string {
	return `'${escapeSqlString(value)}'`;
}

/** `Map(...)`-typed column access, e.g. `ResourceAttributes['service.name']`. */
function mapAccess(column: string, key: string): string {
	return `${column}[${sqlLiteral(key)}]`;
}

/** ClickHouse's DateTime64 columns accept a plain string literal, auto-parsed as UTC. */
function isoToClickHouseTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid ISO timestamp: ${iso}`);
	}
	return date.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Converts a ClickHouse `DateTime64` JSON-output value (a
 * "YYYY-MM-DD HH:MM:SS[.fraction]" string, no timezone suffix -- ClickStack
 * stores OTel timestamps in UTC) into an ISO 8601 string.
 *
 * Known limitation: `Date` can't parse more than 3 fractional digits, so
 * any sub-millisecond precision (ClickStack's default schema uses
 * DateTime64(9), nanosecond precision) is truncated. Mirrors the documented
 * precision loss in greptimedb.ts's `nanosecondsToIso`.
 */
function clickhouseTimestampToIso(raw: unknown): string {
	const text = asString(raw);
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(
		text,
	);
	if (!match) {
		throw new Error("Unexpected timestamp value from ClickHouse");
	}
	const datePart = match[1];
	const timePart = match[2];
	const fraction = match[3] ?? "";
	const millis = fraction.padEnd(3, "0").slice(0, 3);
	const date = new Date(`${datePart}T${timePart}.${millis}Z`);
	if (Number.isNaN(date.getTime())) {
		throw new Error("Unexpected timestamp value from ClickHouse");
	}
	return date.toISOString();
}

function asString(value: unknown, fallback = ""): string {
	if (value === null || value === undefined) {
		return fallback;
	}
	return String(value);
}

/**
 * ClickHouse's JSON output format quotes UInt64/Int64 values as strings to
 * avoid JS float precision loss, so numeric columns (e.g. `Duration`,
 * `SeverityNumber`) may arrive as either a JSON number or a numeric string.
 */
function asNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}
	return fallback;
}

function asStringRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

interface ClickHouseJsonMeta {
	name: string;
	type: string;
}

interface ClickHouseJsonSuccess {
	meta?: ClickHouseJsonMeta[];
	data?: Record<string, unknown>[];
	rows?: number;
}

function rowToLogRecord(row: Record<string, unknown>): LogRecord {
	const resourceAttributes = asStringRecord(row.ResourceAttributes);
	const traceId = asString(row.TraceId);
	const spanId = asString(row.SpanId);
	const serviceName = asString(row.ServiceName);
	return {
		timestamp: clickhouseTimestampToIso(row.Timestamp),
		severityText: asString(row.SeverityText),
		severityNumber: asNumber(row.SeverityNumber),
		body: asString(row.Body),
		traceId: traceId ? traceId : undefined,
		spanId: spanId ? spanId : undefined,
		serviceName: serviceName ? serviceName : undefined,
		attributes: asStringRecord(row.LogAttributes),
		resourceAttributes: {
			...resourceAttributes,
			...(serviceName ? { [SERVICE_ATTRIBUTE_KEY]: serviceName } : {}),
		},
	};
}

function rowToTraceRecord(row: Record<string, unknown>): TraceRecord {
	const parentSpanId = asString(row.ParentSpanId);
	return {
		traceId: asString(row.TraceId),
		spanId: asString(row.SpanId),
		parentSpanId: parentSpanId ? parentSpanId : undefined,
		name: asString(row.SpanName),
		kind: asString(row.SpanKind),
		serviceName: asString(row.ServiceName),
		startTime: clickhouseTimestampToIso(row.Timestamp),
		durationNano: asNumber(row.Duration),
		statusCode: asString(row.StatusCode),
		attributes: {
			statusMessage: asString(row.StatusMessage),
		},
	};
}

function parseJsonResponseBody(text: string, httpStatus: number): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new ClickStackError(
			`Failed to parse ClickHouse response as JSON: ${(err as Error).message}`,
			httpStatus,
		);
	}
}

export class ClickStackSource implements TelemetrySource {
	readonly name = "clickstack";

	private readonly url: string;
	private readonly database: string;
	private readonly authHeader?: string;
	private readonly logsTable: string;
	private readonly tracesTable: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly timeoutMs: number;
	private readonly tracer: Tracer;

	constructor(
		config: ClickStackSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.database = validateIdentifier(config.database);
		this.authHeader = config.auth ? `Basic ${btoa(config.auth)}` : undefined;
		this.logsTable = validateIdentifier(config.logsTable ?? DEFAULT_LOGS_TABLE);
		this.tracesTable = validateIdentifier(
			config.tracesTable ?? DEFAULT_TRACES_TABLE,
		);
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_CLICKSTACK_TIMEOUT_MS;
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
				"db.system.name": "clickhouse",
				"paperhanger.query.kind": kind,
				...attributes,
			},
		});
		try {
			return await context.with(trace.setSpan(context.active(), span), () =>
				fn(span),
			);
		} catch (err) {
			if (err instanceof ClickStackError) {
				span.setAttribute("http.response.status_code", err.httpStatus);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `ClickHouse query failed (http_status=${err.httpStatus})`,
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
				throw new ClickStackError(
					`ClickHouse request timed out after ${this.timeoutMs}ms`,
					0,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return this.withQuerySpan(
			"clickstack.query_logs",
			"logs",
			{ "db.collection.name": this.logsTable },
			async () => {
				const conditions: string[] = [
					`Timestamp >= ${sqlLiteral(isoToClickHouseTimestamp(query.timeRange.from))}`,
					`Timestamp <= ${sqlLiteral(isoToClickHouseTimestamp(query.timeRange.to))}`,
				];

				for (const [key, value] of Object.entries(query.labels)) {
					if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
						conditions.push(`ServiceName = ${sqlLiteral(value)}`);
						continue;
					}
					if (key === "severity") {
						if (value.toLowerCase() === "error") {
							conditions.push(`SeverityNumber >= ${ERROR_SEVERITY_NUMBER}`);
						} else {
							conditions.push(`SeverityText = ${sqlLiteral(value)}`);
						}
						continue;
					}
					const attributeKey = validateAttributeKey(key);
					conditions.push(
						`${mapAccess("ResourceAttributes", attributeKey)} = ${sqlLiteral(value)}`,
					);
				}

				const limit = validateLimit(query.limit ?? DEFAULT_LOG_LIMIT);
				const sql = `SELECT ${LOG_COLUMNS.join(", ")} FROM ${this.logsTable} WHERE ${conditions.join(" AND ")} ORDER BY Timestamp DESC LIMIT ${limit} FORMAT JSON`;
				const rows = await this.runSql(sql);
				return rows.map(rowToLogRecord);
			},
		);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		const strategy = query.labels.trace_id ? "trace_ids" : "representative";
		return this.withQuerySpan(
			"clickstack.query_traces",
			"traces",
			{
				"db.collection.name": this.tracesTable,
				"paperhanger.query.strategy": strategy,
			},
			async () => {
				const limit = validateLimit(query.limit ?? DEFAULT_TRACE_LIMIT);
				const columns = TRACE_COLUMNS.join(", ");

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
					const sql = `SELECT ${columns} FROM ${this.tracesTable} WHERE TraceId IN (${idList}) ORDER BY Timestamp ASC LIMIT ${limit} FORMAT JSON`;
					const rows = await this.runSql(sql);
					return rows.map(rowToTraceRecord);
				}

				const conditions: string[] = [
					`Timestamp >= ${sqlLiteral(isoToClickHouseTimestamp(query.timeRange.from))}`,
					`Timestamp <= ${sqlLiteral(isoToClickHouseTimestamp(query.timeRange.to))}`,
				];
				const serviceValue = resolveServiceLabel(query.labels);
				if (serviceValue) {
					conditions.push(`ServiceName = ${sqlLiteral(serviceValue)}`);
				}
				conditions.push(
					`(StatusCode = 'STATUS_CODE_ERROR' OR Duration > ${SLOW_SPAN_THRESHOLD_NANO})`,
				);
				const orderBy =
					"CASE WHEN StatusCode = 'STATUS_CODE_ERROR' THEN 0 ELSE 1 END, Duration DESC";

				const sql = `SELECT ${columns} FROM ${this.tracesTable} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT ${limit} FORMAT JSON`;
				const rows = await this.runSql(sql);
				return rows.map(rowToTraceRecord);
			},
		);
	}

	async queryMetrics(
		_query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return this.withQuerySpan(
			"clickstack.query_metrics",
			"metrics",
			{},
			async (span) => {
				span.setAttribute("paperhanger.query.skipped", true);
				this.logger.warn(
					"ClickStack (ClickHouse) has no PromQL-compatible query API; metrics collection is not supported for this backend",
				);
				return [];
			},
		);
	}

	private async runSql(sql: string): Promise<Record<string, unknown>[]> {
		const headers: Record<string, string> = {
			"Content-Type": "text/plain",
		};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}

		const response = await this.fetchWithTimeout(
			`${this.url}/?database=${encodeURIComponent(this.database)}`,
			{ method: "POST", headers, body: sql },
		);
		const text = await response.text();
		if (!response.ok) {
			throw new ClickStackError(
				text.trim() ||
					`ClickHouse request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		const json = parseJsonResponseBody(
			text,
			response.status,
		) as ClickHouseJsonSuccess;
		return json.data ?? [];
	}
}
