/**
 * Grafana `TelemetrySource` implementation. Grafana is a *query front-end*,
 * not a store: it proxies queries to whatever datasources are provisioned
 * behind it (typically Loki for logs, Tempo for traces, Prometheus for
 * metrics), so this client always speaks the single generic
 * `POST /api/ds/query` endpoint
 * (https://grafana.com/docs/grafana/latest/developers/http_api/data_source/#query-a-data-source),
 * addressing each backend datasource by its provisioned UID, rather than a
 * signal-specific endpoint per backend.
 *
 * **Chosen over Grafana Cloud's separate per-signal APIs** (e.g. the Loki/
 * Tempo/Mimir HTTP APIs directly) because `/api/ds/query` is the one
 * endpoint that works identically for both self-hosted Grafana and Grafana
 * Cloud, requires only a single service-account token instead of per-backend
 * credentials, and is what Grafana's own Explore/dashboards use internally
 * (so it stays current with whatever datasource version is provisioned).
 * The tradeoff: per-datasource query bodies (the `expr`/`queryType`/`query`
 * fields below) are defined by each datasource *plugin*, not by this HTTP
 * API itself, so their exact shape is less centrally documented than a
 * REST API with a fixed schema -- see the field-name caveats in each method
 * below.
 *
 * **Required service-account token permissions**
 * (https://grafana.com/docs/grafana/latest/administration/service-accounts/):
 * a Viewer-role service account with query access to each provisioned
 * datasource used here (Loki/Tempo/Prometheus) is sufficient; no admin
 * scopes are needed since this client only ever reads.
 *
 * **Testing note**: no live Grafana + Loki/Tempo/Prometheus stack was
 * available while building this (see this PR's "Testing note"). The
 * Time/Value dataframe shape for Prometheus range queries
 * (https://grafana.com/docs/grafana/latest/developers/http_api/data_source/#query-a-data-source)
 * is well-documented and stable; the exact field names Loki and Tempo place
 * in their dataframes are NOT centrally documented and can vary by
 * datasource version and query type -- `genericFrameRows` below is a
 * best-effort, defensive parser for those two signals. Verify against your
 * actual deployment before relying on log/trace collection in production.
 */

import { trace, type Tracer } from "@opentelemetry/api";
import type { Logger } from "../observability/logger";
import {
	fetchWithTimeout,
	parseJsonResponse,
	withClientSpan,
} from "./http-client";
import {
	type LogRecord,
	type MetricSeries,
	resolveServiceLabel,
	SERVICE_LABEL_ALIASES,
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

const TRACER_NAME = "telemetry-grafana";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
const METRIC_MAX_POINTS = 200;
const SLOW_SPAN_TRACEQL = "50ms"; // TraceQL duration literal, matching greptimedb.ts's 50ms slow-span threshold.

/** Escapes a value for embedding in a LogQL/TraceQL string-matcher (`{label="value"}`). */
function quoteMatcherValue(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

export interface GrafanaSourceConfig {
	/** Grafana base URL, e.g. `https://myorg.grafana.net` or `http://localhost:3000`. */
	url: string;
	/** Service account token, sent as `Authorization: Bearer <token>`. */
	serviceAccountToken: string;
	/** UID of the provisioned Loki datasource. Omit to skip log collection. */
	lokiDatasourceUid?: string;
	/** UID of the provisioned Tempo datasource. Omit to skip trace collection. */
	tempoDatasourceUid?: string;
	/** UID of the provisioned Prometheus datasource. Omit to skip metric collection. */
	prometheusDatasourceUid?: string;
	/** Per-request timeout in milliseconds. Defaults to 30s. */
	timeoutMs?: number;
}

/** Thrown for any non-2xx `/api/ds/query` response, a per-query `error` field, or a client-side timeout. */
export class GrafanaError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "GrafanaError";
		this.httpStatus = httpStatus;
	}
}

interface DataFrameField {
	name: string;
	type?: string;
	labels?: Record<string, string>;
}

interface DataFrame {
	schema?: { name?: string; refId?: string; fields?: DataFrameField[] };
	data?: { values?: unknown[][] };
}

interface QueryResult {
	frames?: DataFrame[];
	error?: string;
}

interface DsQueryResponse {
	results?: Record<string, QueryResult>;
	message?: string;
}

/**
 * Zips a dataframe's columnar `data.values` back into one plain object per
 * row, keyed by field name, plus that field's `labels` (if any) surfaced
 * under `__labels__`. Defensive against missing/short columns since the
 * exact field set returned varies by datasource (see module doc comment).
 */
function genericFrameRows(frame: DataFrame): Record<string, unknown>[] {
	const fields = frame.schema?.fields ?? [];
	const values = frame.data?.values ?? [];
	const rowCount = Math.max(0, ...values.map((col) => col.length));
	const rows: Record<string, unknown>[] = [];
	for (let i = 0; i < rowCount; i++) {
		const row: Record<string, unknown> = {};
		fields.forEach((field, colIndex) => {
			row[field.name] = values[colIndex]?.[i];
			if (field.labels) {
				row.__labels__ = { ...(row.__labels__ as object), ...field.labels };
			}
		});
		rows.push(row);
	}
	return rows;
}

function findField(
	frame: DataFrame,
	predicate: (field: DataFrameField) => boolean,
): string | undefined {
	return frame.schema?.fields?.find(predicate)?.name;
}

/** Builds a LogQL stream selector (`{label="value", ...}`) from the flat `TelemetryQuery.labels` conventions. */
function buildLogQlSelector(labels: Record<string, string>): string {
	const matchers: string[] = [];
	const serviceValue = resolveServiceLabel(labels);
	if (serviceValue) {
		matchers.push(`service_name=${quoteMatcherValue(serviceValue)}`);
	}
	for (const [key, value] of Object.entries(labels)) {
		if (
			(SERVICE_LABEL_ALIASES as readonly string[]).includes(key) ||
			key === "severity"
		) {
			continue;
		}
		matchers.push(`${key}=${quoteMatcherValue(value)}`);
	}
	// Loki requires at least one stream matcher; fall back to a broad
	// catch-all when nothing else was resolved, matching this codebase's
	// existing "no service label -> tight, window-only fallback" convention
	// (see context-builder.ts) at the query-construction level too.
	return matchers.length > 0 ? `{${matchers.join(", ")}}` : '{job=~".+"}';
}

/** Builds a TraceQL search expression from the flat `TelemetryQuery.labels` conventions. */
function buildTraceQlSearch(labels: Record<string, string>): string {
	const conditions: string[] = [];
	const serviceValue = resolveServiceLabel(labels);
	if (serviceValue) {
		conditions.push(
			`resource.service.name = ${quoteMatcherValue(serviceValue)}`,
		);
	}
	conditions.push(`(status = error || duration > ${SLOW_SPAN_TRACEQL})`);
	return `{ ${conditions.join(" && ")} }`;
}

function epochMs(iso: string): string {
	return String(new Date(iso).getTime());
}

export class GrafanaSource implements TelemetrySource {
	readonly name = "grafana";

	private readonly baseUrl: string;
	private readonly token: string;
	private readonly lokiUid?: string;
	private readonly tempoUid?: string;
	private readonly prometheusUid?: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly tracer: Tracer;

	constructor(
		config: GrafanaSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.baseUrl = config.url.replace(/\/+$/, "");
		this.token = config.serviceAccountToken;
		this.lokiUid = config.lokiDatasourceUid;
		this.tempoUid = config.tempoDatasourceUid;
		this.prometheusUid = config.prometheusDatasourceUid;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.tracer = tracer ?? trace.getTracer(TRACER_NAME);
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return withClientSpan(
			this.tracer,
			"grafana.query_logs",
			{ "db.system.name": "grafana", "paperhanger.query.kind": "logs" },
			async (span) => {
				if (!this.lokiUid) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryLogs called with no Loki datasource configured; returning no logs",
					);
					return [];
				}
				const limit = query.limit ?? DEFAULT_LOG_LIMIT;
				const expr = buildLogQlSelector(query.labels);
				const payload = await this.dsQuery({
					refId: "A",
					datasource: { uid: this.lokiUid, type: "loki" },
					expr,
					queryType: "range",
					maxLines: limit,
					from: query.timeRange.from,
					to: query.timeRange.to,
				});
				const frames = payload.results?.A?.frames ?? [];
				return frames.flatMap((frame) => frameToLogRecords(frame));
			},
		);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		return withClientSpan(
			this.tracer,
			"grafana.query_traces",
			{ "db.system.name": "grafana", "paperhanger.query.kind": "traces" },
			async (span) => {
				if (!this.tempoUid) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryTraces called with no Tempo datasource configured; returning no spans",
					);
					return [];
				}
				const limit = query.limit ?? DEFAULT_TRACE_LIMIT;
				const traceIdsRaw = query.labels.trace_id;
				if (traceIdsRaw) {
					const traceIds = traceIdsRaw
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id.length > 0);
					if (traceIds.length === 0) {
						return [];
					}
					// One /api/ds/query call, one sub-query (refId = trace id) per
					// trace: Tempo's Grafana datasource treats a bare trace ID in
					// `query` (with `queryType: "traceql"`) as "fetch this trace".
					const payload = await this.dsQueryMulti(
						traceIds.map((id) => ({
							refId: id,
							datasource: { uid: this.tempoUid as string, type: "tempo" },
							queryType: "traceql",
							query: id,
						})),
						query.timeRange,
					);
					return traceIds.flatMap((id) =>
						(payload.results?.[id]?.frames ?? []).flatMap((frame) =>
							frameToTraceRecords(frame),
						),
					);
				}
				// Representative sample: TraceQL search returns one row per
				// matching TRACE (a summary), not one row per span -- see the
				// module doc comment's Testing note.
				const payload = await this.dsQuery({
					refId: "search",
					datasource: { uid: this.tempoUid, type: "tempo" },
					queryType: "traceql",
					query: buildTraceQlSearch(query.labels),
					limit,
					from: query.timeRange.from,
					to: query.timeRange.to,
				});
				const frames = payload.results?.search?.frames ?? [];
				return frames.flatMap((frame) => frameToTraceRecords(frame));
			},
		);
	}

	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return withClientSpan(
			this.tracer,
			"grafana.query_metrics",
			{ "db.system.name": "grafana", "paperhanger.query.kind": "metrics" },
			async (span) => {
				if (!this.prometheusUid) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics called with no Prometheus datasource configured; returning no series",
					);
					return [];
				}
				if (!query.promql) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics called without a PromQL expression; returning no series",
					);
					return [];
				}
				const payload = await this.dsQuery({
					refId: "A",
					datasource: { uid: this.prometheusUid, type: "prometheus" },
					expr: query.promql,
					range: true,
					instant: false,
					maxDataPoints: METRIC_MAX_POINTS,
					from: query.timeRange.from,
					to: query.timeRange.to,
				});
				const frames = payload.results?.A?.frames ?? [];
				return frames.map((frame) => frameToMetricSeries(frame));
			},
		);
	}

	private async dsQuery(
		queryFields: Record<string, unknown> & {
			refId: string;
			from: string;
			to: string;
		},
	): Promise<DsQueryResponse> {
		const { from, to, ...rest } = queryFields;
		return this.dsQueryMulti([rest], { from, to });
	}

	private async dsQueryMulti(
		queries: (Record<string, unknown> & { refId: string })[],
		timeRange: { from: string; to: string },
	): Promise<DsQueryResponse> {
		const body = {
			from: epochMs(timeRange.from),
			to: epochMs(timeRange.to),
			queries,
		};
		const response = await fetchWithTimeout(
			this.fetchImpl,
			`${this.baseUrl}/api/ds/query`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			},
			this.timeoutMs,
			(ms) => new GrafanaError(`Grafana request timed out after ${ms}ms`, 0),
		);
		const payload = await parseJsonResponse<DsQueryResponse>(
			response,
			(message) =>
				new GrafanaError(
					`Failed to parse Grafana response as JSON: ${message}`,
					response.status,
				),
		);
		if (!response.ok) {
			throw new GrafanaError(
				payload.message ??
					`Grafana /api/ds/query request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		for (const [refId, result] of Object.entries(payload.results ?? {})) {
			if (result.error) {
				throw new GrafanaError(
					`Grafana query "${refId}" failed: ${result.error}`,
					response.status,
				);
			}
		}
		return payload;
	}
}

function frameToLogRecords(frame: DataFrame): LogRecord[] {
	const timeField =
		findField(frame, (f) => f.type === "time") ??
		findField(frame, (f) => f.name === "Time");
	const lineField =
		findField(frame, (f) => f.name === "Line") ??
		findField(frame, (f) => f.type === "string" && f.name !== timeField);
	if (!timeField || !lineField) {
		return [];
	}
	return genericFrameRows(frame).map((row) => {
		const rawTime = row[timeField];
		const labels = (row.__labels__ as Record<string, string> | undefined) ?? {};
		const serviceName = labels.service_name ?? labels.service;
		return {
			timestamp:
				typeof rawTime === "number"
					? new Date(rawTime).toISOString()
					: new Date(0).toISOString(),
			severityText: labels.level ?? labels.detected_level ?? "",
			severityNumber: 0,
			body: String(row[lineField] ?? ""),
			serviceName,
			attributes: {},
			resourceAttributes: labels,
		};
	});
}

/**
 * Maps a Tempo dataframe row into a `TraceRecord`. Handles both the
 * trace-by-ID shape (one row per span, ~OTel-shaped field names) and the
 * TraceQL search shape (one row per matching trace, summary fields only --
 * see the module doc comment). Field names are matched case-insensitively
 * against common aliases to be resilient to the exact casing/nesting Tempo
 * returns, which is not centrally documented.
 */
function frameToTraceRecords(frame: DataFrame): TraceRecord[] {
	return genericFrameRows(frame).map((row) => {
		const get = (...keys: string[]): unknown => {
			for (const key of keys) {
				if (row[key] !== undefined) return row[key];
			}
			return undefined;
		};
		const traceId = get("traceID", "traceId", "trace_id");
		const spanId = get("spanID", "spanId", "span_id");
		const startTime = get("startTime", "startTimeUnixNano", "Time");
		const durationMs = get("duration", "durationMs");
		return {
			traceId: typeof traceId === "string" ? traceId : "",
			// TraceQL search returns one row per trace, not per span -- there is
			// no real span ID for that shape, so this falls back to the trace ID
			// itself (a synthetic "root span" placeholder; see module doc comment).
			spanId: typeof spanId === "string" ? spanId : String(traceId ?? ""),
			name: String(get("operationName", "name", "rootTraceName") ?? ""),
			kind: "",
			serviceName: String(get("serviceName", "rootServiceName") ?? ""),
			startTime:
				typeof startTime === "number"
					? new Date(startTime).toISOString()
					: new Date(0).toISOString(),
			durationNano:
				typeof durationMs === "number" ? Math.round(durationMs * 1e6) : 0,
			statusCode: "STATUS_CODE_UNSET",
			attributes: row,
		};
	});
}

function frameToMetricSeries(frame: DataFrame): MetricSeries {
	const timeField =
		findField(frame, (f) => f.type === "time") ??
		findField(frame, (f) => f.name === "Time");
	const valueField =
		findField(frame, (f) => f.name === "Value") ??
		findField(frame, (f) => f.type === "number" && f.name !== timeField);
	const valueFieldDef = frame.schema?.fields?.find(
		(f) => f.name === valueField,
	);
	const labels = valueFieldDef?.labels ?? {};
	const { __name__, ...restLabels } = labels;
	if (!timeField || !valueField) {
		return {
			name: __name__ ?? frame.schema?.refId ?? "",
			labels: restLabels,
			points: [],
		};
	}
	const points = genericFrameRows(frame)
		.map((row) => ({
			timestamp:
				typeof row[timeField] === "number"
					? new Date(row[timeField] as number).toISOString()
					: undefined,
			value:
				typeof row[valueField] === "number"
					? (row[valueField] as number)
					: undefined,
		}))
		.filter(
			(p): p is { timestamp: string; value: number } =>
				p.timestamp !== undefined && p.value !== undefined,
		);
	return {
		name: __name__ ?? frame.schema?.refId ?? "",
		labels: restLabels,
		points,
	};
}
