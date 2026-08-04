/**
 * Datadog `TelemetrySource` implementation: Log Search API v2 for logs, Spans
 * Search API v2 for traces, and the classic (v1) timeseries Metrics Query
 * API for metrics.
 *
 * Verified against Datadog's public API docs (no live Datadog org was
 * available while building this -- see the "Testing note" in this PR):
 * - Logs search: https://docs.datadoghq.com/api/latest/logs/#search-logs
 *   (`POST /api/v2/logs/events/search`)
 * - Spans search: https://docs.datadoghq.com/api/latest/spans/#search-spans
 *   (`POST /api/v2/spans/events/search`)
 * - Metrics query: https://docs.datadoghq.com/api/latest/metrics/#query-timeseries-points
 *   (`GET /api/v1/query`)
 * - Auth: https://docs.datadoghq.com/api/latest/#authentication (`DD-API-KEY`
 *   + `DD-APPLICATION-KEY` headers; query/search endpoints require both, not
 *   just the API key)
 * - Sites (`site` config field): https://docs.datadoghq.com/getting_started/site/
 *   -- e.g. `datadoghq.com` (US1, default), `datadoghq.eu` (EU), `us3.datadoghq.com`,
 *   `us5.datadoghq.com`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`
 *
 * Datadog's log/span search query syntax (https://docs.datadoghq.com/logs/explorer/search_syntax/,
 * https://docs.datadoghq.com/tracing/trace_explorer/query_syntax/) is a
 * faceted `key:value` string, not parameterized JSON -- label values are
 * string-interpolated into it the same way GreptimeDB's SQL client
 * interpolates values into SQL text, so they go through `quoteFacetValue`
 * below (wrap in double quotes, escape embedded quotes/backslashes) rather
 * than being concatenated raw.
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

const TRACER_NAME = "telemetry-datadog";

const DEFAULT_SITE = "datadoghq.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
/** Spans slower than this are considered "slow" for the representative-span query, matching greptimedb.ts's threshold. */
const SLOW_SPAN_THRESHOLD_NANO = 50_000_000; // 50ms, expressed as `@duration:>50000000` (Datadog span duration facet is nanoseconds).

/** OTel standard severity numbers (https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber). */
const OTEL_SEVERITY: Record<string, number> = {
	emergency: 21,
	alert: 21,
	critical: 21,
	error: 17,
	warning: 13,
	warn: 13,
	notice: 9,
	info: 9,
	debug: 5,
	ok: 9,
};

function statusToSeverityNumber(status: string): number {
	return OTEL_SEVERITY[status.toLowerCase()] ?? 0;
}

/** Escapes a value for embedding in a Datadog log/span search facet (`key:"value"`). */
function quoteFacetValue(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

export interface DatadogSourceConfig {
	/** `DD-API-KEY`. */
	apiKey: string;
	/** `DD-APPLICATION-KEY`; required by the search/query endpoints this client uses. */
	appKey: string;
	/** Datadog site, e.g. `datadoghq.com` (default), `datadoghq.eu`, `us3.datadoghq.com`. */
	site?: string;
	/** Per-request timeout in milliseconds. Defaults to 30s. */
	timeoutMs?: number;
}

/** Thrown for any non-2xx Datadog HTTP response, or a client-side timeout. */
export class DatadogError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "DatadogError";
		this.httpStatus = httpStatus;
	}
}

interface DatadogErrorBody {
	errors?: string[];
}

interface DatadogLogAttributes {
	timestamp?: string;
	status?: string;
	message?: string;
	service?: string;
	tags?: string[];
	attributes?: Record<string, unknown>;
}

interface DatadogLogEvent {
	id?: string;
	attributes?: DatadogLogAttributes;
}

interface DatadogLogsSearchResponse {
	data?: DatadogLogEvent[];
}

interface DatadogSpanAttributes {
	trace_id?: string;
	span_id?: string;
	parent_id?: string;
	service?: string;
	resource_name?: string;
	type?: string;
	start_timestamp?: string;
	duration?: number;
	custom?: Record<string, unknown>;
}

interface DatadogSpanEvent {
	id?: string;
	attributes?: DatadogSpanAttributes;
}

interface DatadogSpansSearchResponse {
	data?: DatadogSpanEvent[];
}

interface DatadogMetricSeriesPoint {
	metric?: string;
	scope?: string;
	pointlist?: [number, number][];
	tag_set?: string[];
}

interface DatadogQueryTimeseriesResponse {
	status?: string;
	error?: string;
	series?: DatadogMetricSeriesPoint[];
}

function parseDatadogScope(scope: string | undefined): Record<string, string> {
	if (!scope) {
		return {};
	}
	const labels: Record<string, string> = {};
	for (const pair of scope.split(",")) {
		const [key, value] = pair.split(":", 2);
		if (key && value !== undefined) {
			labels[key] = value;
		}
	}
	return labels;
}

/** Builds a Datadog faceted search query string from the flat `TelemetryQuery.labels` conventions. */
function buildFacetQuery(
	labels: Record<string, string>,
	extraClauses: string[] = [],
): string {
	const clauses = [...extraClauses];
	const serviceValue = resolveServiceLabel(labels);
	if (serviceValue) {
		clauses.push(`service:${quoteFacetValue(serviceValue)}`);
	}
	for (const [key, value] of Object.entries(labels)) {
		if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
			continue;
		}
		if (key === "severity") {
			clauses.push(
				value.toLowerCase() === "error"
					? "status:error"
					: `status:${quoteFacetValue(value)}`,
			);
			continue;
		}
		if (key === "trace_id") {
			continue; // handled separately by callers that support it (spans only)
		}
		// Non-conventional keys map to Datadog's non-indexed "@attribute" facet syntax.
		clauses.push(`@${key}:${quoteFacetValue(value)}`);
	}
	return clauses.length > 0 ? clauses.join(" ") : "*";
}

export class DatadogSource implements TelemetrySource {
	readonly name = "datadog";

	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly appKey: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly tracer: Tracer;

	constructor(
		config: DatadogSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.baseUrl = `https://api.${config.site ?? DEFAULT_SITE}`;
		this.apiKey = config.apiKey;
		this.appKey = config.appKey;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.tracer = tracer ?? trace.getTracer(TRACER_NAME);
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return withClientSpan(
			this.tracer,
			"datadog.query_logs",
			{ "db.system.name": "datadog", "paperhanger.query.kind": "logs" },
			async () => {
				const limit = query.limit ?? DEFAULT_LOG_LIMIT;
				const body = {
					filter: {
						query: buildFacetQuery(query.labels),
						from: query.timeRange.from,
						to: query.timeRange.to,
					},
					sort: "-timestamp",
					page: { limit },
				};
				const payload = await this.post<DatadogLogsSearchResponse>(
					"/api/v2/logs/events/search",
					body,
				);
				return (payload.data ?? []).map(rowToLogRecord);
			},
		);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		return withClientSpan(
			this.tracer,
			"datadog.query_traces",
			{ "db.system.name": "datadog", "paperhanger.query.kind": "traces" },
			async () => {
				const limit = query.limit ?? DEFAULT_TRACE_LIMIT;
				const traceIdsRaw = query.labels.trace_id;
				let searchQuery: string;
				if (traceIdsRaw) {
					const traceIds = traceIdsRaw
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id.length > 0);
					if (traceIds.length === 0) {
						return [];
					}
					searchQuery = traceIds
						.map((id) => `trace_id:${quoteFacetValue(id)}`)
						.join(" OR ");
				} else {
					searchQuery = buildFacetQuery(query.labels, [
						`(status:error OR @duration:>${SLOW_SPAN_THRESHOLD_NANO})`,
					]);
				}
				const body = {
					filter: {
						query: searchQuery,
						from: query.timeRange.from,
						to: query.timeRange.to,
					},
					sort: "-timestamp",
					page: { limit },
				};
				const payload = await this.post<DatadogSpansSearchResponse>(
					"/api/v2/spans/events/search",
					body,
				);
				return (payload.data ?? []).map(rowToTraceRecord);
			},
		);
	}

	/**
	 * `query.promql` is repurposed by convention (see `types.ts`'s doc comment
	 * on `TelemetryQuery`) to carry a raw Datadog metrics query string (e.g.
	 * `avg:trace.express.request.duration{service:checkout}`), since Datadog's
	 * metrics query language isn't PromQL. No query hint -> no metrics
	 * collected, mirroring `GreptimeDbSource.queryMetrics`'s behavior exactly.
	 */
	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return withClientSpan(
			this.tracer,
			"datadog.query_metrics",
			{ "db.system.name": "datadog", "paperhanger.query.kind": "metrics" },
			async (span) => {
				if (!query.promql) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics called without a metrics query string; returning no series",
					);
					return [];
				}
				const fromSec = Math.floor(
					new Date(query.timeRange.from).getTime() / 1000,
				);
				const toSec = Math.floor(new Date(query.timeRange.to).getTime() / 1000);
				const params = new URLSearchParams({
					query: query.promql,
					from: String(fromSec),
					to: String(toSec),
				});
				const payload = await this.get<DatadogQueryTimeseriesResponse>(
					`/api/v1/query?${params.toString()}`,
				);
				if (payload.status !== "ok") {
					throw new DatadogError(
						payload.error ?? "Datadog metrics query failed",
						200,
					);
				}
				return (payload.series ?? []).map((series) => ({
					name: series.metric ?? "",
					labels: parseDatadogScope(series.scope),
					points: (series.pointlist ?? []).map(([ts, value]) => ({
						timestamp: new Date(ts).toISOString(),
						value,
					})),
				}));
			},
		);
	}

	private authHeaders(): Record<string, string> {
		return {
			"DD-API-KEY": this.apiKey,
			"DD-APPLICATION-KEY": this.appKey,
			"Content-Type": "application/json",
		};
	}

	private async get<T>(path: string): Promise<T> {
		const response = await fetchWithTimeout(
			this.fetchImpl,
			`${this.baseUrl}${path}`,
			{ method: "GET", headers: this.authHeaders() },
			this.timeoutMs,
			(ms) => new DatadogError(`Datadog request timed out after ${ms}ms`, 0),
		);
		return this.handleResponse<T>(response);
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const response = await fetchWithTimeout(
			this.fetchImpl,
			`${this.baseUrl}${path}`,
			{
				method: "POST",
				headers: this.authHeaders(),
				body: JSON.stringify(body),
			},
			this.timeoutMs,
			(ms) => new DatadogError(`Datadog request timed out after ${ms}ms`, 0),
		);
		return this.handleResponse<T>(response);
	}

	private async handleResponse<T>(response: Response): Promise<T> {
		const payload = await parseJsonResponse<T & DatadogErrorBody>(
			response,
			(message) =>
				new DatadogError(
					`Failed to parse Datadog response as JSON: ${message}`,
					response.status,
				),
		);
		if (!response.ok) {
			const errors = (payload as DatadogErrorBody).errors;
			throw new DatadogError(
				errors && errors.length > 0
					? errors.join("; ")
					: `Datadog request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		return payload;
	}
}

function rowToLogRecord(event: DatadogLogEvent): LogRecord {
	const attrs = event.attributes ?? {};
	const nested = attrs.attributes ?? {};
	const traceId = nested["dd.trace_id"];
	const spanId = nested["dd.span_id"];
	const service = attrs.service;
	return {
		timestamp: attrs.timestamp ?? new Date(0).toISOString(),
		severityText: attrs.status ?? "",
		severityNumber: statusToSeverityNumber(attrs.status ?? ""),
		body: attrs.message ?? "",
		traceId: typeof traceId === "string" ? traceId : undefined,
		spanId: typeof spanId === "string" ? spanId : undefined,
		serviceName: service,
		attributes: nested,
		resourceAttributes: service ? { "service.name": service } : {},
	};
}

/**
 * Datadog spans aren't OTel-status-coded (no `STATUS_CODE_OK`/`_ERROR`); this
 * maps its `error` custom-attribute convention onto the OTel-shaped
 * `TraceRecord.statusCode` field as a best-effort approximation.
 */
function rowToTraceRecord(event: DatadogSpanEvent): TraceRecord {
	const attrs = event.attributes ?? {};
	const custom = attrs.custom ?? {};
	const hasError = Boolean(custom.error || custom["error.message"]);
	return {
		traceId: attrs.trace_id ?? "",
		spanId: attrs.span_id ?? "",
		parentSpanId: attrs.parent_id,
		name: attrs.resource_name ?? "",
		kind: attrs.type ?? "",
		serviceName: attrs.service ?? "",
		startTime: attrs.start_timestamp ?? new Date(0).toISOString(),
		// Datadog spans report `duration` in nanoseconds already (same unit `TraceRecord.durationNano` expects).
		durationNano: attrs.duration ?? 0,
		statusCode: hasError ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
		attributes: custom,
	};
}
