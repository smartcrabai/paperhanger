/**
 * New Relic `TelemetrySource` implementation: NRQL over NerdGraph (New
 * Relic's GraphQL API), querying the `Log`, `Span`, and `Metric` event types
 * for logs, traces, and metrics respectively.
 *
 * Verified against New Relic's public API docs (no live New Relic account
 * was available while building this -- see the "Testing note" in this PR):
 * - NerdGraph intro / endpoints: https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/
 *   -- `https://api.newrelic.com/graphql` (US), `https://api.eu.newrelic.com/graphql` (EU)
 * - NRQL query shape (`actor.account(id).nrql(query).results`):
 *   https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/
 * - Auth header: `Api-Key: <User API key>` (a `NRAK-...` key, not an ingest
 *   license key) -- same docs page's curl examples.
 * - Log/Span/Metric event types: https://docs.newrelic.com/docs/logs/log-management/ui-data/query-your-log-events-nrql/,
 *   https://docs.newrelic.com/docs/distributed-tracing/trace-api/introduction-trace-api/
 *
 * NRQL is a SQL-like text query language, and (like GreptimeDB's SQL client)
 * label values are string-interpolated into it -- they go through
 * `nrqlStringLiteral` below (single-quoted, backslash-escaped) rather than
 * being concatenated raw.
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
	type MetricPoint,
	type MetricSeries,
	resolveServiceLabel,
	SERVICE_LABEL_ALIASES,
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

const TRACER_NAME = "telemetry-newrelic";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TRACE_LIMIT = 100;
const SLOW_SPAN_THRESHOLD_SECONDS = 0.05; // 50ms; New Relic Span `duration` is reported in seconds.

const NERDGRAPH_ENDPOINTS = {
	US: "https://api.newrelic.com/graphql",
	EU: "https://api.eu.newrelic.com/graphql",
} as const;

export type NewRelicRegion = keyof typeof NERDGRAPH_ENDPOINTS;

/** OTel standard severity numbers (https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber). */
const OTEL_SEVERITY: Record<string, number> = {
	fatal: 21,
	critical: 21,
	emergency: 21,
	error: 17,
	err: 17,
	warn: 13,
	warning: 13,
	info: 9,
	notice: 9,
	debug: 5,
	trace: 1,
};

function levelToSeverityNumber(level: string): number {
	return OTEL_SEVERITY[level.toLowerCase()] ?? 0;
}

/** Escapes a value for embedding in an NRQL string literal (`'value'`). */
function nrqlStringLiteral(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	return `'${escaped}'`;
}

export interface NewRelicSourceConfig {
	/** User API key (`NRAK-...`), sent as the `Api-Key` header. */
	apiKey: string;
	/** New Relic account ID to query. */
	accountId: number;
	/** `US` (default) or `EU`, selecting the NerdGraph endpoint. */
	region?: NewRelicRegion;
	/** Per-request timeout in milliseconds. Defaults to 30s. */
	timeoutMs?: number;
}

/** Thrown for any non-2xx NerdGraph HTTP response, a GraphQL-level `errors[]`, or a client-side timeout. */
export class NewRelicError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "NewRelicError";
		this.httpStatus = httpStatus;
	}
}

interface NerdGraphErrorEntry {
	message?: string;
}

interface NerdGraphResponse<T> {
	data?: T;
	errors?: NerdGraphErrorEntry[];
}

interface NrqlResult {
	data?: {
		actor?: {
			account?: {
				nrql?: {
					results?: Record<string, unknown>[];
				};
			};
		};
	};
}

/** Builds the `WHERE` clause shared by the Log/Span NRQL queries from the flat `TelemetryQuery.labels` conventions. */
function buildWhereClause(
	labels: Record<string, string>,
	serviceField: string,
	extraClauses: string[] = [],
): string {
	const clauses = [...extraClauses];
	const serviceValue = resolveServiceLabel(labels);
	if (serviceValue) {
		clauses.push(`${serviceField} = ${nrqlStringLiteral(serviceValue)}`);
	}
	for (const [key, value] of Object.entries(labels)) {
		if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
			continue;
		}
		if (key === "severity") {
			clauses.push(
				value.toLowerCase() === "error"
					? "level = 'ERROR'"
					: `level = ${nrqlStringLiteral(value)}`,
			);
			continue;
		}
		if (key === "trace_id") {
			continue; // handled separately by callers that support it (spans only)
		}
		clauses.push(`${key} = ${nrqlStringLiteral(value)}`);
	}
	return clauses.length > 0 ? clauses.join(" AND ") : "";
}

function nrqlTimeBounds(from: string, to: string): string {
	const fromMs = new Date(from).getTime();
	const toMs = new Date(to).getTime();
	return `SINCE ${fromMs} UNTIL ${toMs}`;
}

export class NewRelicSource implements TelemetrySource {
	readonly name = "newrelic";

	private readonly endpoint: string;
	private readonly apiKey: string;
	private readonly accountId: number;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly tracer: Tracer;

	constructor(
		config: NewRelicSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.endpoint = NERDGRAPH_ENDPOINTS[config.region ?? "US"];
		this.apiKey = config.apiKey;
		this.accountId = config.accountId;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.tracer = tracer ?? trace.getTracer(TRACER_NAME);
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return withClientSpan(
			this.tracer,
			"newrelic.query_logs",
			{ "db.system.name": "newrelic", "paperhanger.query.kind": "logs" },
			async () => {
				const limit = query.limit ?? DEFAULT_LOG_LIMIT;
				const where = buildWhereClause(query.labels, "service.name");
				const nrql =
					`SELECT * FROM Log ${where ? `WHERE ${where} ` : ""}` +
					`${nrqlTimeBounds(query.timeRange.from, query.timeRange.to)} ` +
					`ORDER BY timestamp DESC LIMIT ${limit}`;
				const results = await this.runNrql(nrql);
				return results.map(rowToLogRecord);
			},
		);
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		return withClientSpan(
			this.tracer,
			"newrelic.query_traces",
			{ "db.system.name": "newrelic", "paperhanger.query.kind": "traces" },
			async () => {
				const limit = query.limit ?? DEFAULT_TRACE_LIMIT;
				const traceIdsRaw = query.labels.trace_id;
				let where: string;
				if (traceIdsRaw) {
					const traceIds = traceIdsRaw
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id.length > 0);
					if (traceIds.length === 0) {
						return [];
					}
					where = `trace.id IN (${traceIds.map(nrqlStringLiteral).join(", ")})`;
				} else {
					where = buildWhereClause(query.labels, "entity.name", [
						`(error is true OR duration > ${SLOW_SPAN_THRESHOLD_SECONDS})`,
					]);
				}
				const nrql =
					`SELECT * FROM Span ${where ? `WHERE ${where} ` : ""}` +
					`${nrqlTimeBounds(query.timeRange.from, query.timeRange.to)} ` +
					`ORDER BY timestamp DESC LIMIT ${limit}`;
				const results = await this.runNrql(nrql);
				return results.map(rowToTraceRecord);
			},
		);
	}

	/**
	 * `query.promql` is repurposed by convention (see `types.ts`'s doc comment
	 * on `TelemetryQuery`) to carry a raw NRQL query string against the
	 * `Metric` event type (e.g. `SELECT average(newrelic.timeslice.value) FROM
	 * Metric WHERE metricTimesliceName = 'Custom/Foo' TIMESERIES`), since NRQL
	 * -- not PromQL -- is New Relic's query language. No query hint -> no
	 * metrics collected, mirroring `GreptimeDbSource.queryMetrics`'s behavior.
	 *
	 * Best-effort response mapping: a `TIMESERIES` NRQL query returns one
	 * result row per time bucket shaped as `{ beginTimeSeconds, endTimeSeconds,
	 * <aggregation alias>: <value>, ... }` -- the aggregation's result key
	 * varies with the query (e.g. `average.newrelic.timeslice.value`), so this
	 * client takes the first numeric field that isn't a `*TimeSeconds` key as
	 * the point's value. Verify this against your actual NRQL query shape.
	 */
	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return withClientSpan(
			this.tracer,
			"newrelic.query_metrics",
			{ "db.system.name": "newrelic", "paperhanger.query.kind": "metrics" },
			async (span) => {
				if (!query.promql) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics called without an NRQL query string; returning no series",
					);
					return [];
				}
				const results = await this.runNrql(query.promql);
				const points: MetricPoint[] = [];
				for (const row of results) {
					const timeSeconds = row.beginTimeSeconds ?? row.endTimeSeconds;
					if (typeof timeSeconds !== "number") {
						continue;
					}
					const valueEntry = Object.entries(row).find(
						([key, value]) =>
							typeof value === "number" && !key.toLowerCase().includes("time"),
					);
					if (!valueEntry) {
						continue;
					}
					points.push({
						timestamp: new Date(timeSeconds * 1000).toISOString(),
						value: valueEntry[1] as number,
					});
				}
				const serviceValue = resolveServiceLabel(query.labels);
				const labels: Record<string, string> = serviceValue
					? { service: serviceValue }
					: {};
				const series: MetricSeries[] = [
					{ name: "newrelic_metric", labels, points },
				];
				return series;
			},
		);
	}

	private async runNrql(nrql: string): Promise<Record<string, unknown>[]> {
		const graphqlQuery =
			"query($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) " +
			"{ nrql(query: $nrql) { results } } } }";
		const payload = await this.post<
			NrqlResult & { errors?: NerdGraphErrorEntry[] }
		>({
			query: graphqlQuery,
			variables: { accountId: this.accountId, nrql },
		});
		if (payload.errors && payload.errors.length > 0) {
			throw new NewRelicError(
				payload.errors.map((e) => e.message ?? "unknown error").join("; "),
				200,
			);
		}
		return payload.data?.actor?.account?.nrql?.results ?? [];
	}

	private async post<T>(body: unknown): Promise<T> {
		const response = await fetchWithTimeout(
			this.fetchImpl,
			this.endpoint,
			{
				method: "POST",
				headers: {
					"Api-Key": this.apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
			this.timeoutMs,
			(ms) => new NewRelicError(`New Relic request timed out after ${ms}ms`, 0),
		);
		const payload = await parseJsonResponse<NerdGraphResponse<T>>(
			response,
			(message) =>
				new NewRelicError(
					`Failed to parse New Relic response as JSON: ${message}`,
					response.status,
				),
		);
		if (!response.ok) {
			throw new NewRelicError(
				payload.errors && payload.errors.length > 0
					? payload.errors.map((e) => e.message ?? "unknown error").join("; ")
					: `New Relic request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		return payload as unknown as T;
	}
}

function rowToLogRecord(row: Record<string, unknown>): LogRecord {
	const timestamp = row.timestamp;
	const level = typeof row.level === "string" ? row.level : "";
	const traceId = row["trace.id"];
	const spanId = row["span.id"];
	const serviceName = row["service.name"];
	return {
		timestamp:
			typeof timestamp === "number"
				? new Date(timestamp).toISOString()
				: new Date(0).toISOString(),
		severityText: level,
		severityNumber: levelToSeverityNumber(level),
		body: typeof row.message === "string" ? row.message : "",
		traceId: typeof traceId === "string" ? traceId : undefined,
		spanId: typeof spanId === "string" ? spanId : undefined,
		serviceName: typeof serviceName === "string" ? serviceName : undefined,
		attributes: row,
		resourceAttributes:
			typeof serviceName === "string" ? { "service.name": serviceName } : {},
	};
}

/**
 * New Relic Span *events* aren't OTel-status-coded (no `STATUS_CODE_OK`/
 * `_ERROR`), and `duration` is reported in seconds -- converted to
 * nanoseconds here since `TraceRecord.durationNano` expects that unit.
 */
function rowToTraceRecord(row: Record<string, unknown>): TraceRecord {
	const traceId = row["trace.id"];
	const spanId = row.id;
	const parentId = row["parent.id"];
	const serviceName = row["entity.name"];
	const timestamp = row.timestamp;
	const duration = row.duration;
	return {
		traceId: typeof traceId === "string" ? traceId : "",
		spanId: typeof spanId === "string" ? spanId : "",
		parentSpanId: typeof parentId === "string" ? parentId : undefined,
		name: typeof row.name === "string" ? row.name : "",
		kind: typeof row.category === "string" ? row.category : "",
		serviceName: typeof serviceName === "string" ? serviceName : "",
		startTime:
			typeof timestamp === "number"
				? new Date(timestamp).toISOString()
				: new Date(0).toISOString(),
		durationNano: typeof duration === "number" ? Math.round(duration * 1e9) : 0,
		statusCode: row.error === true ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
		attributes: row,
	};
}
