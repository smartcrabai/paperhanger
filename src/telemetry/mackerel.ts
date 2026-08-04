/**
 * Mackerel `TelemetrySource` implementation. Mackerel is a monitoring
 * system, not a log/trace store, so this client is shaped as best-effort
 * context enrichment rather than a full log/trace backend (see docs/spec.md
 * section 3.4 and README.md's config reference for the plain statement of
 * this limitation) -- the same posture as `zabbix.ts`:
 *
 * - `queryLogs` returns Mackerel **alerts** (`GET /api/v0/alerts`) as
 *   pseudo-`LogRecord`s -- the closest Mackerel concept to an "error log"
 *   for an incident window.
 * - `queryTraces` always returns `[]`: Mackerel has no distributed tracing
 *   concept at all. This is a structural limitation, not a per-call failure.
 * - `queryMetrics` returns a single named metric's history for the resolved
 *   Mackerel **service** (`GET /api/v0/services/<name>/metrics`) when the
 *   caller supplies both a resolvable service label and a metric-name hint
 *   (see the doc comment on `queryMetrics` below for the `promql`-field
 *   convention this repurposes).
 *
 * Verified against Mackerel's public API docs (no live Mackerel
 * organization was available while building this -- see this PR's "Testing
 * note"): https://mackerel.io/api-docs/
 * - Alerts: https://mackerel.io/api-docs/entry/alerts (`GET /api/v0/alerts`)
 * - Hosts (used to resolve a service's member host IDs, since alerts carry
 *   `hostId` but not a service name):
 *   https://mackerel.io/api-docs/entry/hosts (`GET /api/v0/hosts?service=<name>`)
 * - Service metrics: https://mackerel.io/api-docs/entry/service-metrics
 *   (`GET /api/v0/services/<name>/metrics`)
 * - Auth: `X-Api-Key: <API key>` header (all of the above docs pages)
 *
 * All requests are plain GETs with `URLSearchParams`-encoded query params
 * (not a string-concatenated query language), so -- like `zabbix.ts` -- no
 * separate value-escaping helper is needed here.
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
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

const TRACER_NAME = "telemetry-mackerel";

const DEFAULT_BASE_URL = "https://api.mackerelio.com";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * `GET /api/v0/alerts` has no server-side time-range or host filter (see
 * module doc comment); this caps how many pages of (newest-first) alerts
 * this client will walk client-side looking for matches within the window
 * before giving up, so a very old/narrow incident window can't turn into an
 * unbounded number of requests.
 */
const MAX_ALERT_PAGES = 5;
const ALERTS_PAGE_LIMIT = 100;

/** OTel standard severity numbers (https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber). */
const MACKEREL_STATUS_TO_OTEL: Record<string, number> = {
	CRITICAL: 21,
	WARNING: 13,
	UNKNOWN: 13,
	OK: 9,
};

export interface MackerelSourceConfig {
	/** Sent as the `X-Api-Key` header. */
	apiKey: string;
	/** Override for testing / non-default regions. Defaults to `https://api.mackerelio.com`. */
	baseUrl?: string;
	/** Per-request timeout in milliseconds. Defaults to 30s. */
	timeoutMs?: number;
}

/** Thrown for any non-2xx Mackerel HTTP response, or a client-side timeout. */
export class MackerelError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "MackerelError";
		this.httpStatus = httpStatus;
	}
}

interface MackerelErrorBody {
	error?: string | { message?: string };
}

interface MackerelHost {
	id: string;
}

interface MackerelHostsResponse {
	hosts?: MackerelHost[];
}

interface MackerelAlert {
	id: string;
	status?: string;
	monitorId?: string;
	type?: string;
	hostId?: string;
	value?: number;
	message?: string;
	reason?: string;
	openedAt?: number;
	closedAt?: number;
}

interface MackerelAlertsResponse {
	alerts?: MackerelAlert[];
	nextId?: string;
}

interface MackerelMetricPoint {
	time: number;
	value: number | null;
}

interface MackerelMetricsResponse {
	metrics?: MackerelMetricPoint[];
}

export class MackerelSource implements TelemetrySource {
	readonly name = "mackerel";

	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly tracer: Tracer;

	constructor(
		config: MackerelSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.tracer = tracer ?? trace.getTracer(TRACER_NAME);
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return withClientSpan(
			this.tracer,
			"mackerel.query_logs",
			{ "db.system.name": "mackerel", "paperhanger.query.kind": "logs" },
			async () => {
				const limit = query.limit ?? ALERTS_PAGE_LIMIT;
				const serviceValue = resolveServiceLabel(query.labels);
				const hostIds = serviceValue
					? new Set(await this.resolveServiceHostIds(serviceValue))
					: undefined;
				const fromSec = toUnixSeconds(query.timeRange.from);
				const toSec = toUnixSeconds(query.timeRange.to);

				const matched: MackerelAlert[] = [];
				let nextId: string | undefined;
				let pastWindowStart = false;
				for (
					let page = 0;
					page < MAX_ALERT_PAGES && matched.length < limit && !pastWindowStart;
					page++
				) {
					const params = new URLSearchParams({ withClosed: "true" });
					if (nextId) {
						params.set("nextId", nextId);
					}
					const payload = await this.get<MackerelAlertsResponse>(
						`/api/v0/alerts?${params.toString()}`,
					);
					const alerts = payload.alerts ?? [];
					for (const alert of alerts) {
						if (alert.openedAt === undefined) {
							continue;
						}
						if (alert.openedAt < fromSec) {
							// Alerts are returned newest-first; once we're past the window
							// start, older pages can only get older still.
							pastWindowStart = true;
							break;
						}
						if (alert.openedAt > toSec) {
							continue;
						}
						// Only keep host-scoped alerts we can confirm belong to the
						// resolved service; keep host-less alerts (service/external/
						// expression monitors) only when no service filter was requested,
						// mirroring context-builder.ts's "no service -> tight fallback" spirit.
						if (hostIds) {
							if (alert.hostId && hostIds.has(alert.hostId)) {
								matched.push(alert);
							}
						} else {
							matched.push(alert);
						}
					}
					nextId = payload.nextId;
					if (!nextId) {
						break;
					}
				}
				return matched.slice(0, limit).map(rowToLogRecord);
			},
		);
	}

	/** Mackerel has no distributed tracing concept; always empty (see module doc comment). */
	async queryTraces(_query: TelemetryQuery): Promise<TraceRecord[]> {
		return [];
	}

	/**
	 * `query.promql` is repurposed by convention (see `types.ts`'s doc comment
	 * on `TelemetryQuery`) to carry the target Mackerel metric name (e.g.
	 * `loadavg5`, `custom.foo.bar`), since Mackerel has no PromQL equivalent.
	 * Requires BOTH a resolvable service label AND this metric-name hint;
	 * either missing -> no metrics collected, mirroring
	 * `GreptimeDbSource.queryMetrics`'s "no hint -> skip" behavior.
	 */
	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return withClientSpan(
			this.tracer,
			"mackerel.query_metrics",
			{ "db.system.name": "mackerel", "paperhanger.query.kind": "metrics" },
			async (span) => {
				const serviceValue = resolveServiceLabel(query.labels);
				const metricName = query.promql;
				if (!serviceValue || !metricName) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics requires both a resolvable service label and a metric-name hint; returning no series",
						{
							hasServiceLabel: Boolean(serviceValue),
							hasMetricNameHint: Boolean(metricName),
						},
					);
					return [];
				}
				const params = new URLSearchParams({
					name: metricName,
					from: String(toUnixSeconds(query.timeRange.from)),
					to: String(toUnixSeconds(query.timeRange.to)),
				});
				const payload = await this.get<MackerelMetricsResponse>(
					`/api/v0/services/${encodeURIComponent(serviceValue)}/metrics?${params.toString()}`,
				);
				const points = (payload.metrics ?? [])
					.filter(
						(p): p is MackerelMetricPoint & { value: number } =>
							p.value !== null,
					)
					.map((p) => ({
						timestamp: new Date(p.time * 1000).toISOString(),
						value: p.value,
					}));
				return [
					{ name: metricName, labels: { service: serviceValue }, points },
				];
			},
		);
	}

	private async resolveServiceHostIds(serviceName: string): Promise<string[]> {
		const params = new URLSearchParams({ service: serviceName });
		const payload = await this.get<MackerelHostsResponse>(
			`/api/v0/hosts?${params.toString()}`,
		);
		return (payload.hosts ?? []).map((h) => h.id);
	}

	private async get<T>(path: string): Promise<T> {
		const response = await fetchWithTimeout(
			this.fetchImpl,
			`${this.baseUrl}${path}`,
			{ method: "GET", headers: { "X-Api-Key": this.apiKey } },
			this.timeoutMs,
			(ms) => new MackerelError(`Mackerel request timed out after ${ms}ms`, 0),
		);
		const payload = await parseJsonResponse<T & MackerelErrorBody>(
			response,
			(message) =>
				new MackerelError(
					`Failed to parse Mackerel response as JSON: ${message}`,
					response.status,
				),
		);
		if (!response.ok) {
			const errorField = (payload as MackerelErrorBody).error;
			const message =
				typeof errorField === "string"
					? errorField
					: (errorField?.message ??
						`Mackerel request failed with HTTP status ${response.status}`);
			throw new MackerelError(message, response.status);
		}
		return payload;
	}
}

function toUnixSeconds(iso: string): number {
	return Math.floor(new Date(iso).getTime() / 1000);
}

function rowToLogRecord(alert: MackerelAlert): LogRecord {
	const status = alert.status ?? "UNKNOWN";
	return {
		timestamp: new Date((alert.openedAt ?? 0) * 1000).toISOString(),
		severityText: status,
		severityNumber: MACKEREL_STATUS_TO_OTEL[status] ?? 0,
		body:
			alert.message ??
			alert.reason ??
			`${alert.type ?? "unknown"} alert (monitor ${alert.monitorId ?? "unknown"})`,
		attributes: {
			monitorId: alert.monitorId,
			type: alert.type,
			value: alert.value,
		},
		resourceAttributes: alert.hostId ? { "host.id": alert.hostId } : {},
	};
}
