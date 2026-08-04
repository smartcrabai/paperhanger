/**
 * Zabbix `TelemetrySource` implementation. Zabbix is a monitoring system,
 * not a log/trace store, so this client is shaped as best-effort context
 * enrichment rather than a full log/trace backend (see docs/spec.md section
 * 3.4 and README.md's config reference for the plain statement of this
 * limitation):
 *
 * - `queryLogs` returns Zabbix **problem/event history** (`event.get`) as
 *   pseudo-`LogRecord`s -- the closest Zabbix concept to an "error log" for
 *   an incident window.
 * - `queryTraces` always returns `[]`: Zabbix has no distributed tracing
 *   concept at all. This is a structural limitation, not a per-call failure.
 * - `queryMetrics` returns a single numeric item's history (`history.get`)
 *   when the caller supplies both a resolvable service/host label and an
 *   item-key hint (see the doc comment on `queryMetrics` below for the
 *   `promql`-field convention this repurposes).
 *
 * Verified against Zabbix's public API docs (no live Zabbix server was
 * available while building this -- see this PR's "Testing note"):
 * https://www.zabbix.com/documentation/current/en/manual/api
 *
 * **Version assumption**: this client assumes **Zabbix >= 6.4**, which
 * accepts the API token via an `Authorization: Bearer <token>` HTTP header
 * (https://www.zabbix.com/documentation/current/en/manual/api -- "API
 * tokens" section). Older Zabbix versions (API tokens were introduced in
 * 5.4) only accept the token via the legacy `auth` field inside every
 * JSON-RPC request body; this client does not implement that fallback, so
 * it will not authenticate against Zabbix < 6.4.
 *
 * All JSON-RPC params below are passed as structured JSON fields (not a
 * string-concatenated query language), so unlike GreptimeDB's SQL client or
 * Datadog/New Relic's query-string clients, no separate value-escaping
 * helper is needed here -- `JSON.stringify` already encodes them safely.
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

const TRACER_NAME = "telemetry-zabbix";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LIMIT = 100;
const METRIC_MAX_POINTS = 500;
/** Zabbix severities >= this (3 = "Average") are treated as the "error" convention (see types.ts). */
const ERROR_SEVERITY_THRESHOLD = 3;

const ZABBIX_SEVERITY_NAMES = [
	"Not classified",
	"Information",
	"Warning",
	"Average",
	"High",
	"Disaster",
];

/** OTel standard severity numbers (https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber). */
const ZABBIX_SEVERITY_TO_OTEL = [9, 9, 13, 17, 17, 21];

/** Zabbix `history.get`'s `history` param: numeric value types this client treats as "metric-shaped". */
const NUMERIC_VALUE_TYPES = new Set([0, 3]); // 0 = float, 3 = unsigned int

export interface ZabbixSourceConfig {
	/** Zabbix frontend base URL, e.g. `https://zabbix.example.com/zabbix` (without `/api_jsonrpc.php`). */
	url: string;
	/** API token, sent as `Authorization: Bearer <token>` (see the module doc comment's version assumption). */
	apiToken: string;
	/** Per-request timeout in milliseconds. Defaults to 30s. */
	timeoutMs?: number;
}

/** Thrown for any non-2xx response, a JSON-RPC `error` field, or a client-side timeout. */
export class ZabbixError extends Error {
	readonly httpStatus: number;
	readonly code?: number;

	constructor(message: string, httpStatus: number, code?: number) {
		super(message);
		this.name = "ZabbixError";
		this.httpStatus = httpStatus;
		this.code = code;
	}
}

interface JsonRpcError {
	code: number;
	message: string;
	data?: string;
}

interface JsonRpcResponse<T> {
	jsonrpc: string;
	result?: T;
	error?: JsonRpcError;
	id: number;
}

interface ZabbixHost {
	hostid: string;
	host?: string;
	name?: string;
}

interface ZabbixEvent {
	eventid?: string;
	clock?: string;
	name?: string;
	severity?: string;
	value?: string;
	objectid?: string;
	hosts?: ZabbixHost[];
}

interface ZabbixItem {
	itemid: string;
	key_?: string;
	name?: string;
	value_type?: string;
}

interface ZabbixHistoryPoint {
	itemid: string;
	clock: string;
	value: string;
}

export class ZabbixSource implements TelemetrySource {
	readonly name = "zabbix";

	private readonly endpoint: string;
	private readonly apiToken: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;
	private readonly tracer: Tracer;
	private nextId = 1;

	constructor(
		config: ZabbixSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
		tracer?: Tracer,
	) {
		this.endpoint = `${config.url.replace(/\/+$/, "")}/api_jsonrpc.php`;
		this.apiToken = config.apiToken;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.tracer = tracer ?? trace.getTracer(TRACER_NAME);
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		return withClientSpan(
			this.tracer,
			"zabbix.query_logs",
			{ "db.system.name": "zabbix", "paperhanger.query.kind": "logs" },
			async (span) => {
				const limit = query.limit ?? DEFAULT_LOG_LIMIT;
				const serviceValue = resolveServiceLabel(query.labels);
				const hostids = serviceValue
					? await this.resolveHostIds(serviceValue)
					: undefined;
				if (serviceValue && (!hostids || hostids.length === 0)) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryLogs found no Zabbix host matching the resolved service label; returning no events",
					);
					return [];
				}
				const params: Record<string, unknown> = {
					output: "extend",
					selectHosts: ["hostid", "host", "name"],
					time_from: toUnixSeconds(query.timeRange.from),
					time_till: toUnixSeconds(query.timeRange.to),
					sortfield: ["clock", "eventid"],
					sortorder: "DESC",
					limit,
				};
				if (hostids) {
					params.hostids = hostids;
				}
				if (query.labels.severity?.toLowerCase() === "error") {
					params.severities = [
						ERROR_SEVERITY_THRESHOLD,
						ERROR_SEVERITY_THRESHOLD + 1,
						ERROR_SEVERITY_THRESHOLD + 2,
					];
				}
				const events = await this.call<ZabbixEvent[]>("event.get", params);
				return events.map(rowToLogRecord);
			},
		);
	}

	/** Zabbix has no distributed tracing concept; always empty (see module doc comment). */
	async queryTraces(_query: TelemetryQuery): Promise<TraceRecord[]> {
		return [];
	}

	/**
	 * `query.promql` is repurposed by convention (see `types.ts`'s doc comment
	 * on `TelemetryQuery`) to carry the target Zabbix item's `key_` (Zabbix has
	 * no PromQL equivalent). Requires BOTH a resolvable service/host label AND
	 * this item-key hint; either missing -> no metrics collected (with a note
	 * explaining which piece was missing), mirroring
	 * `GreptimeDbSource.queryMetrics`'s "no hint -> skip" behavior.
	 *
	 * Only numeric items (Zabbix value types `float`/`unsigned`) are
	 * "metric-shaped"; character/log/text items are skipped with a warning
	 * rather than coerced, since `MetricSeries.points[].value` is a `number`.
	 */
	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		return withClientSpan(
			this.tracer,
			"zabbix.query_metrics",
			{ "db.system.name": "zabbix", "paperhanger.query.kind": "metrics" },
			async (span) => {
				const serviceValue = resolveServiceLabel(query.labels);
				const itemKey = query.promql;
				if (!serviceValue || !itemKey) {
					span.setAttribute("paperhanger.query.skipped", true);
					this.logger.warn(
						"queryMetrics requires both a resolvable service/host label and an item-key hint; returning no series",
						{
							hasServiceLabel: Boolean(serviceValue),
							hasItemKeyHint: Boolean(itemKey),
						},
					);
					return [];
				}
				const hostids = await this.resolveHostIds(serviceValue);
				if (hostids.length === 0) {
					this.logger.warn(
						"queryMetrics found no Zabbix host matching the resolved service label; returning no series",
					);
					return [];
				}
				const items = await this.call<ZabbixItem[]>("item.get", {
					output: ["itemid", "key_", "name", "value_type"],
					hostids,
					filter: { key_: [itemKey] },
				});
				const item = items[0];
				if (!item) {
					this.logger.warn(
						"queryMetrics found no Zabbix item for the given key on the resolved host",
					);
					return [];
				}
				const valueType = Number(item.value_type ?? "-1");
				if (!NUMERIC_VALUE_TYPES.has(valueType)) {
					this.logger.warn(
						"queryMetrics found a Zabbix item but its value type is not numeric; returning no series",
						{ itemKey, valueType },
					);
					return [];
				}
				const history = await this.call<ZabbixHistoryPoint[]>("history.get", {
					output: "extend",
					itemids: [item.itemid],
					history: valueType,
					time_from: toUnixSeconds(query.timeRange.from),
					time_till: toUnixSeconds(query.timeRange.to),
					sortfield: "clock",
					sortorder: "ASC",
					limit: METRIC_MAX_POINTS,
				});
				return [
					{
						name: item.name ?? item.key_ ?? itemKey,
						labels: { host: serviceValue },
						points: history.map((point) => ({
							timestamp: new Date(Number(point.clock) * 1000).toISOString(),
							value: Number(point.value),
						})),
					},
				];
			},
		);
	}

	private async resolveHostIds(hostName: string): Promise<string[]> {
		const hosts = await this.call<ZabbixHost[]>("host.get", {
			output: ["hostid"],
			filter: { host: [hostName] },
		});
		return hosts.map((h) => h.hostid);
	}

	private async call<T>(method: string, params: unknown): Promise<T> {
		const body = {
			jsonrpc: "2.0",
			method,
			params,
			id: this.nextId++,
		};
		const response = await fetchWithTimeout(
			this.fetchImpl,
			this.endpoint,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
					"Content-Type": "application/json-rpc",
				},
				body: JSON.stringify(body),
			},
			this.timeoutMs,
			(ms) => new ZabbixError(`Zabbix request timed out after ${ms}ms`, 0),
		);
		const payload = await parseJsonResponse<JsonRpcResponse<T>>(
			response,
			(message) =>
				new ZabbixError(
					`Failed to parse Zabbix response as JSON: ${message}`,
					response.status,
				),
		);
		if (!response.ok || payload.error) {
			const err = payload.error;
			throw new ZabbixError(
				err
					? `${err.message}${err.data ? `: ${err.data}` : ""}`
					: `Zabbix request failed with HTTP status ${response.status}`,
				response.status,
				err?.code,
			);
		}
		return payload.result as T;
	}
}

function toUnixSeconds(iso: string): number {
	return Math.floor(new Date(iso).getTime() / 1000);
}

function rowToLogRecord(event: ZabbixEvent): LogRecord {
	const severity = Number(event.severity ?? "0");
	const clock = Number(event.clock ?? "0");
	const host = event.hosts?.[0];
	return {
		timestamp: new Date(clock * 1000).toISOString(),
		severityText: ZABBIX_SEVERITY_NAMES[severity] ?? "Not classified",
		severityNumber: ZABBIX_SEVERITY_TO_OTEL[severity] ?? 0,
		body: event.name ?? "",
		serviceName: host?.name ?? host?.host,
		attributes: {
			eventid: event.eventid,
			objectid: event.objectid,
			value: event.value,
		},
		resourceAttributes: host?.name ? { "host.name": host.name } : {},
	};
}
