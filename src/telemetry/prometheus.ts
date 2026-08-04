/**
 * Prometheus `TelemetrySource` implementation: PromQL over Prometheus's HTTP
 * query API.
 *
 * Metrics only. `queryLogs`/`queryTraces` gracefully log a warning and
 * return an empty result (never throw) -- a single Prometheus instance
 * carries no log or trace data. This repo's Grafana OSS stack pairs
 * Prometheus with the separate Loki (`loki.ts`) and Tempo (`tempo.ts`)
 * sources; each is its own `telemetry.source` config choice (see
 * docs/spec.md section 3.4), not a combined multi-backend source.
 *
 * `queryMetrics` follows `GreptimeDbSource.queryMetrics`'s exact contract:
 * it only runs a query when the caller supplies a PromQL expression
 * (`query.promql`); `context-builder.ts` only sets that when the alert's
 * annotations carry a `promql` or `metric` key (docs/spec.md section 3.4
 * step 3). Without it, this logs a warning and returns no series -- it does
 * not invent a query from `query.labels`.
 *
 * API reference (current as of 2026):
 * - `GET /api/v1/query_range` request/response shape:
 *   https://prometheus.io/docs/prometheus/latest/querying/api/
 */

import type { Logger } from "../observability/logger";
import type {
	LogRecord,
	MetricSeries,
	TelemetryQuery,
	TelemetrySource,
	TraceRecord,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on points returned by a single PromQL range query (matches greptimedb.ts). */
const METRIC_MAX_POINTS = 200;

export interface PrometheusSourceConfig {
	url: string;
	/** `username:password`, unencoded; base64-encoded internally (Basic auth). */
	auth?: string;
	/** Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Thrown for any non-2xx / non-"success" Prometheus HTTP response. */
export class PrometheusError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "PrometheusError";
		this.httpStatus = httpStatus;
	}
}

function computeStepSeconds(
	fromSec: number,
	toSec: number,
	maxPoints = METRIC_MAX_POINTS,
): number {
	const span = Math.max(1, toSec - fromSec);
	return Math.max(1, Math.ceil(span / maxPoints));
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

export class PrometheusSource implements TelemetrySource {
	readonly name = "prometheus";

	private readonly url: string;
	private readonly authHeader?: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;

	constructor(
		config: PrometheusSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.authHeader = config.auth ? `Basic ${btoa(config.auth)}` : undefined;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
	}

	/** Mirrors greptimedb.ts's `fetchWithTimeout`: aborts a hung request with a typed error instead of hanging the pipeline forever. */
	private async fetchWithTimeout(url: string): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);

		const headers: Record<string, string> = {};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}

		try {
			return await this.fetchImpl(url, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
		} catch (err) {
			if (timedOut || controller.signal.aborted) {
				throw new PrometheusError(
					`Prometheus request timed out after ${this.timeoutMs}ms`,
					0,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
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
		});

		const response = await this.fetchWithTimeout(
			`${this.url}/api/v1/query_range?${params.toString()}`,
		);
		const text = await response.text();
		let json: PromQueryRangeResponse;
		try {
			json = JSON.parse(text) as PromQueryRangeResponse;
		} catch (err) {
			throw new PrometheusError(
				`Failed to parse Prometheus response as JSON: ${(err as Error).message}`,
				response.status,
			);
		}
		if (!response.ok || json.status !== "success") {
			throw new PrometheusError(
				json.error ??
					`PromQL range query failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		return parsePrometheusResponse(json);
	}

	async queryLogs(_query: TelemetryQuery): Promise<LogRecord[]> {
		this.logger.warn(
			"queryLogs called against the Prometheus telemetry source; Prometheus carries no log data -- returning no logs",
		);
		return [];
	}

	async queryTraces(_query: TelemetryQuery): Promise<TraceRecord[]> {
		this.logger.warn(
			"queryTraces called against the Prometheus telemetry source; Prometheus carries no trace data -- returning no spans",
		);
		return [];
	}
}
