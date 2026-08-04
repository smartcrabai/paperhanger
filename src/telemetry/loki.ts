/**
 * Loki `TelemetrySource` implementation: LogQL over Loki's HTTP query API.
 *
 * Logs only. `queryTraces`/`queryMetrics` gracefully log a warning and return
 * an empty result (never throw) -- a single Loki instance carries no trace
 * or metric data. This repo's Grafana OSS stack pairs Loki with the separate
 * Tempo (`tempo.ts`) and Prometheus (`prometheus.ts`) sources; each is its
 * own `telemetry.source` config choice (see docs/spec.md section 3.4), not a
 * combined multi-backend source.
 *
 * API references (current as of 2026):
 * - `GET /loki/api/v1/query_range` request/response shape:
 *   https://grafana.com/docs/loki/latest/reference/loki-http-api/
 * - OTLP ingestion: which resource attributes become indexed labels
 *   (`service.name` -> `service_name`, dots -> underscores) vs. structured
 *   metadata: https://grafana.com/docs/loki/latest/send-data/otel/
 * - Structured metadata query syntax (`| trace_id="..."`, `| severity_text=...`):
 *   https://grafana.com/docs/loki/latest/get-started/labels/structured-metadata/
 *
 * KNOWN LIMITATION: Loki's docs do not pin down the exact JSON shape used to
 * carry per-line structured metadata in `query_range` responses (whether
 * `values` entries are `[ts, line]` or `[ts, line, metadata]` tuples, and
 * whether `metadata` is an array of `{name,value}` pairs or a plain object).
 * `metadataToRecord` below tolerates both shapes and defaults to an empty
 * record on anything else, so a mismatch degrades to missing
 * trace/severity correlation rather than a crash. This was built against
 * public docs with no live Loki backend to verify against (see PR body).
 */

import type { Logger } from "../observability/logger";
import {
	type LogRecord,
	type MetricSeries,
	resolveServiceLabel,
	SERVICE_LABEL_ALIASES,
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
/** OTel standard severity number for ERROR (matches greptimedb.ts's convention). */
const ERROR_SEVERITY_NUMBER = 17;

/** Loki label carrying the OTel `service.name` resource attribute (dots -> underscores on OTLP ingest; see send-data/otel above). */
const SERVICE_LABEL_NAME = "service_name";

/** LogQL label/structured-metadata identifier grammar: `[a-zA-Z_][a-zA-Z0-9_]*`. */
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface LokiSourceConfig {
	url: string;
	/** `username:password`, unencoded; base64-encoded internally (Basic auth). */
	auth?: string;
	/** `X-Scope-OrgID` tenant header, for multi-tenant Loki deployments. */
	orgId?: string;
	/** Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Thrown for any non-2xx / non-"success" Loki HTTP response. */
export class LokiError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "LokiError";
		this.httpStatus = httpStatus;
	}
}

function validateIdentifier(name: string): string {
	if (!IDENTIFIER_PATTERN.test(name)) {
		throw new Error(
			`Invalid LogQL label/metadata name (length=${name.length})`,
		);
	}
	return name;
}

/** Escapes a value for a double-quoted LogQL string literal. */
function escapeLogQlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function logQlLiteral(value: string): string {
	return `"${escapeLogQlString(value)}"`;
}

function isoToNanoString(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid ISO timestamp: ${iso}`);
	}
	return (BigInt(ms) * 1_000_000n).toString();
}

/**
 * Converts a Loki nanosecond-epoch timestamp (returned as a numeric string,
 * per the reference above) into an ISO 8601 string. Tolerant of a bare
 * number too, for robustness against a non-conforming backend.
 */
function nanoToIso(raw: unknown): string {
	if (typeof raw === "string" && raw.trim() !== "") {
		try {
			return new Date(Number(BigInt(raw) / 1_000_000n)).toISOString();
		} catch {
			const asNumber = Number(raw);
			if (!Number.isNaN(asNumber)) {
				return new Date(asNumber / 1_000_000).toISOString();
			}
		}
	}
	if (typeof raw === "number") {
		return new Date(raw / 1_000_000).toISOString();
	}
	throw new Error(`Unexpected timestamp value from Loki: ${String(raw)}`);
}

/**
 * Rough OTel severity-number floor per `severity_text`, used only as a
 * fallback when Loki's `severity_number` structured metadata field is
 * absent. See the OTel logs data model's SeverityNumber field:
 * https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 */
const SEVERITY_TEXT_FLOOR: Record<string, number> = {
	TRACE: 1,
	DEBUG: 5,
	INFO: 9,
	WARN: 13,
	WARNING: 13,
	ERROR: 17,
	FATAL: 21,
};

function severityNumberFromText(text: string): number {
	return SEVERITY_TEXT_FLOOR[text.toUpperCase()] ?? 0;
}

/**
 * Loki structured metadata may be returned per-line as an array of
 * `{name, value}` pairs (protobuf-JSON style) or as a plain object; the
 * exact shape isn't pinned down by public docs (see module doc comment), so
 * this tolerates both and returns `{}` for anything else.
 */
function metadataToRecord(raw: unknown): Record<string, string> {
	if (Array.isArray(raw)) {
		const out: Record<string, string> = {};
		for (const entry of raw) {
			if (entry && typeof entry === "object") {
				const { name, value } = entry as { name?: unknown; value?: unknown };
				if (typeof name === "string") {
					out[name] = String(value ?? "");
				}
			}
		}
		return out;
	}
	if (raw && typeof raw === "object") {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			out[k] = String(v);
		}
		return out;
	}
	return {};
}

interface LokiStreamResult {
	stream?: Record<string, string>;
	/** `[nanoTimestamp, line]` or `[nanoTimestamp, line, structuredMetadata]`. */
	values?: unknown[][];
}

interface LokiQueryRangeResponse {
	status: string;
	data?: { resultType: string; result?: LokiStreamResult[] };
	error?: string;
	errorType?: string;
}

function streamsToLogRecords(streams: LokiStreamResult[]): LogRecord[] {
	const records: LogRecord[] = [];
	for (const stream of streams) {
		const streamLabels = stream.stream ?? {};
		const serviceName = streamLabels[SERVICE_LABEL_NAME];
		for (const value of stream.values ?? []) {
			const ts = value[0];
			const line = value[1];
			const metadata = metadataToRecord(value[2]);
			const severityText = metadata.severity_text ?? "";
			const severityNumber = metadata.severity_number
				? Number(metadata.severity_number)
				: severityText
					? severityNumberFromText(severityText)
					: 0;
			const traceId = metadata.trace_id;
			const spanId = metadata.span_id;
			const attributes: Record<string, unknown> = { ...metadata };
			delete attributes.severity_text;
			delete attributes.severity_number;
			delete attributes.trace_id;
			delete attributes.span_id;

			records.push({
				timestamp: nanoToIso(ts),
				severityText,
				severityNumber,
				body: typeof line === "string" ? line : String(line ?? ""),
				traceId: traceId ? traceId : undefined,
				spanId: spanId ? spanId : undefined,
				serviceName,
				attributes,
				resourceAttributes: streamLabels,
			});
		}
	}
	return records;
}

export class LokiSource implements TelemetrySource {
	readonly name = "loki";

	private readonly url: string;
	private readonly authHeader?: string;
	private readonly orgId?: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;

	constructor(
		config: LokiSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.authHeader = config.auth ? `Basic ${btoa(config.auth)}` : undefined;
		this.orgId = config.orgId;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}
		if (this.orgId) {
			headers["X-Scope-OrgID"] = this.orgId;
		}
		return headers;
	}

	/** Mirrors greptimedb.ts's `fetchWithTimeout`: aborts a hung request with a typed error instead of hanging the pipeline forever. */
	private async fetchWithTimeout(url: string): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);

		try {
			return await this.fetchImpl(url, {
				method: "GET",
				headers: this.headers(),
				signal: controller.signal,
			});
		} catch (err) {
			if (timedOut || controller.signal.aborted) {
				throw new LokiError(
					`Loki request timed out after ${this.timeoutMs}ms`,
					0,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Builds a LogQL query from `query.labels`, following the same
	 * conventions as `GreptimeDbSource.queryLogs` (see types.ts): service
	 * aliases resolve to a stream selector, `severity: "error"` maps to the
	 * OTel ERROR threshold, and any other key becomes a structured-metadata
	 * equality filter.
	 */
	private buildLogQl(query: TelemetryQuery): string {
		const serviceValue = resolveServiceLabel(query.labels);
		// A LogQL stream selector needs at least one matcher. `service_name`
		// is close to universal for OTel-ingested logs (a near-mandatory
		// resource attribute), so match any value when no service was
		// resolved from the alert -- mirrors greptimedb.ts's
		// "time-window-only, tight limit" fallback for the same case.
		const selector = serviceValue
			? `${SERVICE_LABEL_NAME}=${logQlLiteral(serviceValue)}`
			: `${SERVICE_LABEL_NAME}=~".+"`;

		const stages: string[] = [];
		for (const [key, value] of Object.entries(query.labels)) {
			if ((SERVICE_LABEL_ALIASES as readonly string[]).includes(key)) {
				continue;
			}
			if (key === "severity") {
				if (value.toLowerCase() === "error") {
					stages.push(`severity_number >= ${ERROR_SEVERITY_NUMBER}`);
				} else {
					stages.push(`severity_text=${logQlLiteral(value)}`);
				}
				continue;
			}
			const metadataKey = validateIdentifier(key);
			stages.push(`${metadataKey}=${logQlLiteral(value)}`);
		}

		const pipeline = stages.map((stage) => `| ${stage}`).join(" ");
		return pipeline ? `{${selector}} ${pipeline}` : `{${selector}}`;
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		const logql = this.buildLogQl(query);
		const params = new URLSearchParams({
			query: logql,
			start: isoToNanoString(query.timeRange.from),
			end: isoToNanoString(query.timeRange.to),
			limit: String(query.limit ?? DEFAULT_LOG_LIMIT),
			direction: "backward",
		});

		const response = await this.fetchWithTimeout(
			`${this.url}/loki/api/v1/query_range?${params.toString()}`,
		);
		const text = await response.text();
		let json: LokiQueryRangeResponse;
		try {
			json = JSON.parse(text) as LokiQueryRangeResponse;
		} catch (err) {
			throw new LokiError(
				`Failed to parse Loki response as JSON: ${(err as Error).message}`,
				response.status,
			);
		}
		if (!response.ok || json.status !== "success") {
			throw new LokiError(
				json.error ??
					`Loki query_range failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		return streamsToLogRecords(json.data?.result ?? []);
	}

	async queryTraces(_query: TelemetryQuery): Promise<TraceRecord[]> {
		this.logger.warn(
			"queryTraces called against the Loki telemetry source; Loki carries no trace data -- returning no spans",
		);
		return [];
	}

	async queryMetrics(
		_query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		this.logger.warn(
			"queryMetrics called against the Loki telemetry source; Loki carries no metric data -- returning no series",
		);
		return [];
	}
}
