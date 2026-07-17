/**
 * GreptimeDB `TelemetrySource` implementation: HTTP SQL API for logs/traces,
 * PromQL-compatible HTTP API for metrics. See docs/research/greptimedb.md for
 * the empirically verified request/response shapes this client relies on.
 *
 * paperhanger only ever reads from GreptimeDB in production; data arrives via
 * OTLP from other services. This client never ingests data itself (the
 * integration-test suite seeds data separately via the official OTel SDKs).
 */

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

export const DEFAULT_LOGS_TABLE = "opentelemetry_logs";
export const DEFAULT_TRACES_TABLE = "opentelemetry_traces";

const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
/** Default per-request timeout for all GreptimeDB HTTP calls; overridable via `GreptimeDbSourceConfig.timeoutMs`. */
const DEFAULT_GREPTIMEDB_TIMEOUT_MS = 30_000;
/** OTel standard severity number for ERROR (see docs/research/greptimedb.md section 4.2). */
const ERROR_SEVERITY_NUMBER = 17;
/** Spans slower than this are considered "slow" for the representative-span query. */
const SLOW_SPAN_THRESHOLD_NANO = 50_000_000; // 50ms
/** Cap on points returned by a single PromQL range query (see spec section 3.4). */
const METRIC_MAX_POINTS = 200;

const SERVICE_ATTRIBUTE_JSON_KEY = "service.name";

/** Table/column identifiers we interpolate must match this to be safe to embed in SQL. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Resource/log attribute keys (JSON path segments), e.g. OTel dotted keys. */
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** Trace IDs are lowercase hex strings; validated before embedding in an IN (...) list. */
const TRACE_ID_PATTERN = /^[0-9a-fA-F]+$/;

const LOG_COLUMNS = [
	"timestamp",
	"severity_text",
	"severity_number",
	"body",
	"trace_id",
	"span_id",
	"log_attributes",
	"resource_attributes",
];

const TRACE_COLUMNS = [
	"timestamp",
	"timestamp_end",
	"duration_nano",
	"parent_span_id",
	"trace_id",
	"span_id",
	"span_kind",
	"span_name",
	"span_status_code",
	"span_status_message",
	"service_name",
	"span_events",
	"span_links",
];

export interface GreptimeDbSourceConfig {
	url: string;
	database: string;
	/** `username:password`, unencoded; the client base64-encodes it itself. */
	auth?: string;
	/** Overrides for OTLP-ingested table names (deployments can rename them). */
	logsTable?: string;
	tracesTable?: string;
	/** Per-request timeout in milliseconds for all HTTP calls. Defaults to `DEFAULT_GREPTIMEDB_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Thrown for any non-2xx GreptimeDB HTTP response, carrying its `code`/`error`. */
export class GreptimeDbError extends Error {
	readonly code: number;
	readonly httpStatus: number;

	constructor(message: string, code: number, httpStatus: number) {
		super(message);
		this.name = "GreptimeDbError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

function validateIdentifier(name: string): string {
	if (!IDENTIFIER_PATTERN.test(name)) {
		throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
	}
	return name;
}

function validateAttributeKey(key: string): string {
	if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
		throw new Error(`Invalid attribute/label key: ${JSON.stringify(key)}`);
	}
	return key;
}

function validateTraceId(id: string): string {
	if (!TRACE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid trace id: ${JSON.stringify(id)}`);
	}
	return id;
}

function validateLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error(`Invalid limit: ${limit}`);
	}
	return limit;
}

function escapeSqlString(value: string): string {
	return value.replace(/'/g, "''");
}

function sqlLiteral(value: string): string {
	return `'${escapeSqlString(value)}'`;
}

/** JSON path for a dotted resource-attribute key, e.g. `service.name` -> `$."service.name"`. */
function jsonPathFor(key: string): string {
	return `$."${key}"`;
}

function isoToSqlTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid ISO timestamp: ${iso}`);
	}
	return date.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Converts a GreptimeDB `TimestampNanosecond` column value (returned as a raw
 * epoch-nanosecond number or numeric string) into an ISO 8601 string.
 *
 * Known limitation: when GreptimeDB returns the value as a bare JSON number,
 * `JSON.parse` (which already ran before this function sees the value) loses
 * precision beyond `Number.MAX_SAFE_INTEGER` for nanosecond-since-epoch
 * magnitudes (~1e18). The rounding error is at most a few hundred
 * nanoseconds, far below the millisecond resolution this client exposes, so
 * it is accepted rather than worked around with a custom JSON parser.
 */
function nanosecondsToIso(raw: unknown): string {
	if (typeof raw === "number") {
		return new Date(raw / 1_000_000).toISOString();
	}
	if (typeof raw === "string" && raw.trim() !== "") {
		try {
			const ms = Number(BigInt(raw) / 1_000_000n);
			return new Date(ms).toISOString();
		} catch {
			const asNumber = Number(raw);
			if (!Number.isNaN(asNumber)) {
				return new Date(asNumber / 1_000_000).toISOString();
			}
		}
	}
	throw new Error(`Unexpected timestamp value from GreptimeDB: ${String(raw)}`);
}

function asString(value: unknown, fallback = ""): string {
	if (value === null || value === undefined) {
		return fallback;
	}
	return String(value);
}

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

/** Parses a GreptimeDB `Json` column value, which may arrive as a native object or a JSON string. */
function parseJsonValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	const parsed = parseJsonValue(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

interface GreptimeColumnSchema {
	name: string;
	data_type: string;
}

interface GreptimeRecords {
	schema: { column_schemas: GreptimeColumnSchema[] };
	rows: unknown[][];
	total_rows?: number;
}

interface GreptimeOutputEntry {
	records?: GreptimeRecords;
	affectedrows?: number;
}

interface GreptimeSqlSuccess {
	output: GreptimeOutputEntry[];
	execution_time_ms?: number;
}

interface GreptimeErrorBody {
	code?: number;
	error?: string;
}

function parseSqlRows(payload: GreptimeSqlSuccess): Record<string, unknown>[] {
	const entry = payload.output?.[0];
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

function rowToLogRecord(row: Record<string, unknown>): LogRecord {
	const resourceAttributes = parseJsonObject(row.resource_attributes);
	const traceId = asString(row.trace_id);
	const spanId = asString(row.span_id);
	const serviceName = resourceAttributes[SERVICE_ATTRIBUTE_JSON_KEY];
	return {
		timestamp: nanosecondsToIso(row.timestamp),
		severityText: asString(row.severity_text),
		severityNumber: asNumber(row.severity_number),
		body: asString(row.body),
		traceId: traceId ? traceId : undefined,
		spanId: spanId ? spanId : undefined,
		serviceName: typeof serviceName === "string" ? serviceName : undefined,
		attributes: parseJsonObject(row.log_attributes),
		resourceAttributes,
	};
}

function rowToTraceRecord(row: Record<string, unknown>): TraceRecord {
	const parentSpanId = row.parent_span_id;
	return {
		traceId: asString(row.trace_id),
		spanId: asString(row.span_id),
		parentSpanId: parentSpanId ? asString(parentSpanId) : undefined,
		name: asString(row.span_name),
		kind: asString(row.span_kind),
		serviceName: asString(row.service_name),
		startTime: nanosecondsToIso(row.timestamp),
		durationNano: asNumber(row.duration_nano),
		statusCode: asString(row.span_status_code),
		// The traces table flattens resource/span attributes into one physical
		// column per distinct key (see docs/research/greptimedb.md section 4.3),
		// which makes `SELECT *`-style generic attribute extraction schema-fragile.
		// span_events/span_links remain JSON and carry the richest diagnostic
		// signal (e.g. exception stack traces), so they're surfaced here instead.
		attributes: {
			statusMessage: asString(row.span_status_message),
			events: parseJsonValue(row.span_events) ?? [],
			links: parseJsonValue(row.span_links) ?? [],
		},
	};
}

interface PromSample {
	metric?: Record<string, string>;
	value?: [number, string];
	values?: [number, string][];
}

interface PromQueryRangeResponse {
	status: string;
	data?: { resultType: string; result: PromSample[] };
	error?: string;
	errorType?: string;
}

function computeStepSeconds(
	fromSec: number,
	toSec: number,
	maxPoints = METRIC_MAX_POINTS,
): number {
	const span = Math.max(1, toSec - fromSec);
	return Math.max(1, Math.ceil(span / maxPoints));
}

function parsePrometheusResponse(
	payload: PromQueryRangeResponse,
): MetricSeries[] {
	const result = payload.data?.result ?? [];
	return result.map((sample) => {
		const { __name__, ...labels } = sample.metric ?? {};
		const raw = sample.values ?? (sample.value ? [sample.value] : []);
		const points = raw.map(([ts, value]) => ({
			timestamp: new Date(ts * 1000).toISOString(),
			value: Number(value),
		}));
		return { name: __name__ ?? "", labels, points };
	});
}

function parseJsonResponseBody(text: string, httpStatus: number): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new GreptimeDbError(
			`Failed to parse GreptimeDB response as JSON: ${(err as Error).message}`,
			-1,
			httpStatus,
		);
	}
}

export class GreptimeDbSource implements TelemetrySource {
	readonly name = "greptimedb";

	private readonly url: string;
	private readonly database: string;
	private readonly authHeader?: string;
	private readonly logsTable: string;
	private readonly tracesTable: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly timeoutMs: number;

	constructor(
		config: GreptimeDbSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.database = config.database;
		this.authHeader = config.auth ? `Basic ${btoa(config.auth)}` : undefined;
		this.logsTable = validateIdentifier(config.logsTable ?? DEFAULT_LOGS_TABLE);
		this.tracesTable = validateIdentifier(
			config.tracesTable ?? DEFAULT_TRACES_TABLE,
		);
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_GREPTIMEDB_TIMEOUT_MS;
	}

	/**
	 * Wraps `this.fetchImpl` with an `AbortController`-based timeout, so a
	 * hung GreptimeDB endpoint fails fast with a typed error instead of
	 * leaving the caller (ultimately `IncidentPipeline`) waiting forever.
	 * Aborts caused by the timeout are mapped to `GreptimeDbError`; any other
	 * rejection propagates unchanged.
	 */
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
				throw new GreptimeDbError(
					`GreptimeDB request timed out after ${this.timeoutMs}ms`,
					-1,
					0,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		const conditions: string[] = [
			`timestamp >= ${sqlLiteral(isoToSqlTimestamp(query.timeRange.from))}`,
			`timestamp <= ${sqlLiteral(isoToSqlTimestamp(query.timeRange.to))}`,
		];

		for (const [key, value] of Object.entries(query.labels)) {
			if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
				conditions.push(
					`json_get_string(resource_attributes, ${sqlLiteral(jsonPathFor(SERVICE_ATTRIBUTE_JSON_KEY))}) = ${sqlLiteral(value)}`,
				);
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
			const attributeKey = validateAttributeKey(key);
			conditions.push(
				`json_get_string(resource_attributes, ${sqlLiteral(jsonPathFor(attributeKey))}) = ${sqlLiteral(value)}`,
			);
		}

		const limit = validateLimit(query.limit ?? DEFAULT_LOG_LIMIT);
		const sql = `SELECT ${LOG_COLUMNS.join(", ")} FROM ${this.logsTable} WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ${limit}`;
		const rows = await this.runSql(sql);
		return rows.map(rowToLogRecord);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
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
			const sql = `SELECT ${columns} FROM ${this.tracesTable} WHERE trace_id IN (${idList}) ORDER BY timestamp ASC LIMIT ${limit}`;
			const rows = await this.runSql(sql);
			return rows.map(rowToTraceRecord);
		}

		// "Representative spans for a service/window": error spans first,
		// then slowest, matching docs/research/greptimedb.md section 5(c).
		const conditions: string[] = [
			`timestamp >= ${sqlLiteral(isoToSqlTimestamp(query.timeRange.from))}`,
			`timestamp <= ${sqlLiteral(isoToSqlTimestamp(query.timeRange.to))}`,
		];
		const serviceValue = resolveServiceLabel(query.labels);
		if (serviceValue) {
			conditions.push(`service_name = ${sqlLiteral(serviceValue)}`);
		}
		conditions.push(
			`(span_status_code = 'STATUS_CODE_ERROR' OR duration_nano > ${SLOW_SPAN_THRESHOLD_NANO})`,
		);
		const orderBy =
			"CASE WHEN span_status_code = 'STATUS_CODE_ERROR' THEN 0 ELSE 1 END, duration_nano DESC";

		const sql = `SELECT ${columns} FROM ${this.tracesTable} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT ${limit}`;
		const rows = await this.runSql(sql);
		return rows.map(rowToTraceRecord);
	}

	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		if (!query.promql) {
			this.logger.warn(
				"queryMetrics called without a PromQL expression; returning no series",
			);
			return [];
		}

		const fromSec = Math.floor(new Date(query.timeRange.from).getTime() / 1000);
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
			db: this.database,
		});

		const headers: Record<string, string> = {};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}

		const response = await this.fetchWithTimeout(
			`${this.url}/v1/prometheus/api/v1/query_range?${params.toString()}`,
			{ method: "GET", headers },
		);
		const text = await response.text();
		const json = parseJsonResponseBody(text, response.status);
		const parsed = json as PromQueryRangeResponse;
		if (!response.ok || parsed.status !== "success") {
			throw new GreptimeDbError(
				parsed.error ??
					`PromQL range query failed with HTTP status ${response.status}`,
				-1,
				response.status,
			);
		}
		return parsePrometheusResponse(parsed);
	}

	private async runSql(sql: string): Promise<Record<string, unknown>[]> {
		const headers: Record<string, string> = {
			"Content-Type": "application/x-www-form-urlencoded",
		};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}

		const response = await this.fetchWithTimeout(
			`${this.url}/v1/sql?db=${encodeURIComponent(this.database)}`,
			{
				method: "POST",
				headers,
				body: new URLSearchParams({ sql }).toString(),
			},
		);
		const text = await response.text();
		const json = parseJsonResponseBody(text, response.status);
		if (!response.ok) {
			const body = json as GreptimeErrorBody;
			throw new GreptimeDbError(
				body.error ??
					`GreptimeDB SQL request failed with HTTP status ${response.status}`,
				body.code ?? -1,
				response.status,
			);
		}
		return parseSqlRows(json as GreptimeSqlSuccess);
	}
}
