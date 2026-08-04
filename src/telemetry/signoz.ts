/**
 * SigNoz `TelemetrySource` implementation: the unified `query_range` HTTP API
 * (v5), OTel-native. See:
 *   - https://signoz.io/docs/metrics-management/query-range-api/ (endpoint,
 *     auth header, composite-query envelope)
 *   - https://signoz.io/docs/logs-management/logs-api/overview/ and
 *     .../payload-model/ (logs `filter.expression` syntax, `start`/`end` in
 *     epoch ms, `limit`/`offset`)
 *   - https://signoz.io/docs/traces-management/trace-api/search-traces/
 *     (`has_error = true` / `parent_span_id = ''` filter conventions)
 *
 * SigNoz's own storage is ClickHouse-based, so this client makes the same
 * assumption greptimedb.ts and clickstack.ts make about OTel-shaped data
 * (nanosecond-epoch timestamps, `service.name` as the canonical service
 * label), but goes through SigNoz's query-builder JSON instead of raw SQL --
 * SigNoz has no public raw-SQL passthrough.
 *
 * IMPORTANT CAVEAT (see this PR's "Testing note"): the public docs above
 * document *request* shapes in detail but not the exact `list` item response
 * shape for `requestType: "raw"` results (row mapping to `data.<key>` field
 * names). This client's row mapping is deliberately tolerant of a few
 * plausible key-naming variants per field rather than assuming one exact
 * shape, and has not been verified against a live SigNoz instance.
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

const TRACER_NAME = "telemetry-signoz";

const QUERY_RANGE_PATH = "/api/v5/query_range";
const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
const DEFAULT_SIGNOZ_TIMEOUT_MS = 30_000;
/** OTel standard severity number for ERROR (matches greptimedb.ts/clickstack.ts). */
const ERROR_SEVERITY_NUMBER = 17;
/** Spans slower than this are considered "slow" for the representative-span query. */
const SLOW_SPAN_THRESHOLD_NANO = 50_000_000; // 50ms

const SERVICE_ATTRIBUTE_KEY = "service.name";

/** Filter-expression/attribute keys we interpolate as bare identifiers must match this. */
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** Trace IDs are lowercase hex strings; validated before embedding in an IN [...] list. */
const TRACE_ID_PATTERN = /^[0-9a-fA-F]+$/;

export interface SigNozSourceConfig {
	/** SigNoz instance base URL, e.g. `https://<tenant>.signoz.cloud` or a self-hosted URL. */
	url: string;
	/** Sent as the `SIGNOZ-API-KEY` header (see "Ingestion Keys"/"Service Accounts" docs). */
	apiKey: string;
	/** Per-request timeout in milliseconds for all HTTP calls. Defaults to `DEFAULT_SIGNOZ_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Thrown for any non-2xx `query_range` response, or a `status: "error"` success-status body. */
export class SigNozError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "SigNozError";
		this.httpStatus = httpStatus;
	}
}

// See greptimedb.ts's identical note: validators never embed the raw
// offending value (upstream-tainted) into their Error message, since that
// message can end up recorded verbatim onto an exported span.

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

/**
 * Escapes a value for embedding in a SigNoz filter-expression single-quoted
 * string literal (the DSL shown in the docs above is SQL-like: `key = 'value'`).
 * Same discipline as greptimedb.ts's `escapeSqlString`/`sqlLiteral`.
 */
function escapeFilterString(value: string): string {
	return value.replace(/'/g, "''");
}

function filterLiteral(value: string): string {
	return `'${escapeFilterString(value)}'`;
}

function isoToEpochMs(iso: string): number {
	const ms = new Date(iso).getTime();
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid ISO timestamp: ${iso}`);
	}
	return ms;
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

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return undefined;
}

function firstDefined(
	row: Record<string, unknown>,
	...keys: string[]
): unknown {
	for (const key of keys) {
		if (row[key] !== undefined && row[key] !== null) {
			return row[key];
		}
	}
	return undefined;
}

/**
 * SigNoz's ClickHouse-backed storage uses nanosecond-epoch integers for
 * timestamps (same convention as greptimedb.ts's `nanosecondsToIso`); this
 * tolerates both a bare number and a numeric string.
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
			const asNum = Number(raw);
			if (!Number.isNaN(asNum)) {
				return new Date(asNum / 1_000_000).toISOString();
			}
		}
	}
	throw new Error("Unexpected timestamp value from SigNoz");
}

interface QueryRangeListItem {
	timestamp?: unknown;
	data?: Record<string, unknown>;
}

interface QueryRangeResult {
	queryName?: string;
	list?: QueryRangeListItem[] | null;
}

interface QueryRangeSuccess {
	status?: string;
	error?: string;
	data?: {
		resultType?: string;
		result?: QueryRangeResult[];
	};
}

/** Extracts the `list` array from the first query result, tolerating `null`/missing fields. */
function extractList(payload: QueryRangeSuccess): Record<string, unknown>[] {
	const result = payload.data?.result;
	if (!Array.isArray(result) || result.length === 0) {
		return [];
	}
	const list = result[0]?.list;
	if (!Array.isArray(list)) {
		return [];
	}
	return list.map((item) => ({
		...item.data,
		// Prefer the list item's own `timestamp` sibling field over one nested
		// under `data` (docs show both shapes across examples), but don't let
		// an explicit `undefined` here clobber a `data.timestamp` that IS
		// present when the sibling field is absent.
		timestamp: item.timestamp ?? item.data?.timestamp,
	}));
}

function rowToLogRecord(row: Record<string, unknown>): LogRecord {
	const traceId = asString(firstDefined(row, "trace_id", "traceId"));
	const spanId = asString(firstDefined(row, "span_id", "spanId"));
	const serviceName = asString(
		firstDefined(row, SERVICE_ATTRIBUTE_KEY, "serviceName", "service_name"),
	);
	return {
		timestamp: nanosecondsToIso(firstDefined(row, "timestamp")),
		severityText: asString(firstDefined(row, "severity_text", "severityText")),
		severityNumber: asNumber(
			firstDefined(row, "severity_number", "severityNumber"),
		),
		body: asString(firstDefined(row, "body", "Body")),
		traceId: traceId ? traceId : undefined,
		spanId: spanId ? spanId : undefined,
		serviceName: serviceName ? serviceName : undefined,
		// SigNoz's raw list response doesn't cleanly separate "resource" vs
		// "log" attributes the way GreptimeDB/ClickStack's schemas do (see the
		// caveat at the top of this file); everything else observed on the row
		// besides the fields already mapped above is surfaced here as a
		// best-effort attribute bag.
		attributes: omit(row, [
			"timestamp",
			"trace_id",
			"traceId",
			"span_id",
			"spanId",
			SERVICE_ATTRIBUTE_KEY,
			"serviceName",
			"service_name",
			"severity_text",
			"severityText",
			"severity_number",
			"severityNumber",
			"body",
			"Body",
		]),
		resourceAttributes: serviceName
			? { [SERVICE_ATTRIBUTE_KEY]: serviceName }
			: {},
	};
}

function omit(
	row: Record<string, unknown>,
	keys: string[],
): Record<string, unknown> {
	const excluded = new Set(keys);
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (!excluded.has(key)) {
			result[key] = value;
		}
	}
	return result;
}

function rowToTraceRecord(row: Record<string, unknown>): TraceRecord {
	const parentSpanId = asString(
		firstDefined(row, "parent_span_id", "parentSpanId"),
	);
	const hasError = asBoolean(firstDefined(row, "has_error", "hasError"));
	const explicitStatus = firstDefined(row, "status_code", "statusCode");
	const statusCode = explicitStatus
		? asString(explicitStatus)
		: hasError === undefined
			? ""
			: hasError
				? "STATUS_CODE_ERROR"
				: "STATUS_CODE_OK";
	return {
		traceId: asString(firstDefined(row, "trace_id", "traceId")),
		spanId: asString(firstDefined(row, "span_id", "spanId")),
		parentSpanId: parentSpanId ? parentSpanId : undefined,
		name: asString(firstDefined(row, "name", "span_name", "spanName")),
		kind: asString(firstDefined(row, "kind", "span_kind", "spanKind")),
		serviceName: asString(
			firstDefined(row, SERVICE_ATTRIBUTE_KEY, "serviceName", "service_name"),
		),
		startTime: nanosecondsToIso(firstDefined(row, "timestamp")),
		durationNano: asNumber(firstDefined(row, "duration_nano", "durationNano")),
		statusCode,
		attributes: {
			statusMessage: asString(
				firstDefined(row, "status_message", "statusMessage"),
			),
		},
	};
}

function buildLogFilterExpression(query: TelemetryQuery): string {
	const clauses: string[] = [];
	for (const [key, value] of Object.entries(query.labels)) {
		if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
			clauses.push(`${SERVICE_ATTRIBUTE_KEY} = ${filterLiteral(value)}`);
			continue;
		}
		if (key === "severity") {
			if (value.toLowerCase() === "error") {
				clauses.push(`severity_number >= ${ERROR_SEVERITY_NUMBER}`);
			} else {
				clauses.push(`severity_text = ${filterLiteral(value)}`);
			}
			continue;
		}
		const attributeKey = validateAttributeKey(key);
		clauses.push(`${attributeKey} = ${filterLiteral(value)}`);
	}
	return clauses.join(" AND ");
}

export class SigNozSource implements TelemetrySource {
	readonly name = "signoz";

	private readonly url: string;
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly timeoutMs: number;
	private readonly tracer: Tracer;

	constructor(
		config: SigNozSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_SIGNOZ_TIMEOUT_MS;
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
				"db.system.name": "signoz",
				"paperhanger.query.kind": kind,
				...attributes,
			},
		});
		try {
			return await context.with(trace.setSpan(context.active(), span), () =>
				fn(span),
			);
		} catch (err) {
			if (err instanceof SigNozError) {
				span.setAttribute("http.response.status_code", err.httpStatus);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `SigNoz query_range failed (http_status=${err.httpStatus})`,
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
				throw new SigNozError(
					`SigNoz request timed out after ${this.timeoutMs}ms`,
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
			"signoz.query_logs",
			"logs",
			{ "db.collection.name": "logs" },
			async () => {
				const limit = validateLimit(query.limit ?? DEFAULT_LOG_LIMIT);
				const body = {
					start: isoToEpochMs(query.timeRange.from),
					end: isoToEpochMs(query.timeRange.to),
					requestType: "raw",
					compositeQuery: {
						queries: [
							{
								type: "builder_query",
								spec: {
									name: "A",
									signal: "logs",
									filter: { expression: buildLogFilterExpression(query) },
									order: [{ key: { name: "timestamp" }, direction: "desc" }],
									offset: 0,
									limit,
								},
							},
						],
					},
				};
				const payload = await this.runQueryRange(body);
				return extractList(payload).map(rowToLogRecord);
			},
		);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		const strategy = query.labels.trace_id ? "trace_ids" : "representative";
		return this.withQuerySpan(
			"signoz.query_traces",
			"traces",
			{
				"db.collection.name": "traces",
				"paperhanger.query.strategy": strategy,
			},
			async () => {
				const limit = validateLimit(query.limit ?? DEFAULT_TRACE_LIMIT);

				const traceIdsRaw = query.labels.trace_id;
				let filterExpression: string;
				let direction: "asc" | "desc";
				if (traceIdsRaw) {
					const traceIds = traceIdsRaw
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id.length > 0)
						.map(validateTraceId);
					if (traceIds.length === 0) {
						return [];
					}
					const idList = traceIds.map(filterLiteral).join(", ");
					filterExpression = `trace_id IN [${idList}]`;
					direction = "asc";
				} else {
					const clauses: string[] = [];
					const serviceValue = resolveServiceLabel(query.labels);
					if (serviceValue) {
						clauses.push(
							`${SERVICE_ATTRIBUTE_KEY} = ${filterLiteral(serviceValue)}`,
						);
					}
					// SigNoz's builder-query `order` only sorts by a single field, so
					// (unlike greptimedb.ts/clickstack.ts's SQL `CASE WHEN ... END`
					// error-first tie-break) this can't express "errors first, then
					// slowest" in one order-by. Filtering on
					// `has_error OR duration_nano > threshold` still surfaces both,
					// just ordered by duration alone.
					clauses.push(
						`(has_error = true OR duration_nano > ${SLOW_SPAN_THRESHOLD_NANO})`,
					);
					filterExpression = clauses.join(" AND ");
					direction = "desc";
				}

				const body = {
					start: isoToEpochMs(query.timeRange.from),
					end: isoToEpochMs(query.timeRange.to),
					requestType: "raw",
					compositeQuery: {
						queries: [
							{
								type: "builder_query",
								spec: {
									name: "A",
									signal: "traces",
									filter: { expression: filterExpression },
									order: traceIdsRaw
										? [{ key: { name: "timestamp" }, direction }]
										: [{ key: { name: "duration_nano" }, direction }],
									offset: 0,
									limit,
								},
							},
						],
					},
				};
				const payload = await this.runQueryRange(body);
				return extractList(payload).map(rowToTraceRecord);
			},
		);
	}

	async queryMetrics(
		_query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return this.withQuerySpan(
			"signoz.query_metrics",
			"metrics",
			{},
			async (span) => {
				span.setAttribute("paperhanger.query.skipped", true);
				this.logger.warn(
					"SigNoz's query_range builder API takes a metric name + aggregation spec, not a raw PromQL expression; metrics collection is not supported for this backend",
				);
				return [];
			},
		);
	}

	private async runQueryRange(body: unknown): Promise<QueryRangeSuccess> {
		const response = await this.fetchWithTimeout(
			`${this.url}${QUERY_RANGE_PATH}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"SIGNOZ-API-KEY": this.apiKey,
				},
				body: JSON.stringify(body),
			},
		);
		const text = await response.text();
		let json: QueryRangeSuccess;
		try {
			json = JSON.parse(text) as QueryRangeSuccess;
		} catch (err) {
			throw new SigNozError(
				`Failed to parse SigNoz response as JSON: ${(err as Error).message}`,
				response.status,
			);
		}
		if (!response.ok || json.status === "error") {
			throw new SigNozError(
				json.error ??
					`SigNoz query_range request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		return json;
	}
}
