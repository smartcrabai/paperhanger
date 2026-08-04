/**
 * Tempo `TelemetrySource` implementation: TraceQL over Tempo's HTTP query
 * API, plus direct trace-by-id fetches.
 *
 * Traces only. `queryLogs`/`queryMetrics` gracefully log a warning and
 * return an empty result (never throw) -- a single Tempo instance carries no
 * log or metric data. This repo's Grafana OSS stack pairs Tempo with the
 * separate Loki (`loki.ts`) and Prometheus (`prometheus.ts`) sources; each
 * is its own `telemetry.source` config choice (see docs/spec.md section
 * 3.4), not a combined multi-backend source.
 *
 * Two request shapes, matching `GreptimeDbSource.queryTraces`'s split:
 * - `query.labels.trace_id` set: `GET /api/traces/{traceID}` per id (full
 *   fidelity -- returns a complete, OTLP-JSON-shaped trace).
 * - Otherwise: `GET /api/search` with a TraceQL query selecting error-or-slow
 *   spans for the resolved service (a "representative sample", mirroring
 *   greptimedb.ts's error-first-then-slowest strategy).
 *
 * API references (current as of 2026):
 * - `GET /api/search` (TraceQL) and `GET /api/traces/{traceID}`:
 *   https://grafana.com/docs/tempo/latest/api_docs/
 *
 * KNOWN LIMITATION: `/api/search` results carry only a minimal per-span
 * shape (`spanID`, `startTimeUnixNano`, `durationNanos`, `attributes`) --
 * no `name`, `kind`, `parentSpanId`, or dedicated status field, unlike
 * `/api/traces/{traceID}`'s full OTLP-JSON spans. `searchResultsToRecords`
 * below falls back to the trace-level `rootServiceName`/`rootTraceName` and
 * an `attributes.status` string (if present) for those fields, so the
 * "representative sample" branch is lower-fidelity than the by-id branch by
 * design, not by bug. This was built against public docs with no live Tempo
 * backend to verify against (see PR body).
 */

import type { Logger } from "../observability/logger";
import {
	type LogRecord,
	type MetricSeries,
	resolveServiceLabel,
	type TelemetryQuery,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

const DEFAULT_TRACE_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Spans slower than this are considered "slow" for the representative-span
 * query -- 50ms, matching greptimedb.ts's `SLOW_SPAN_THRESHOLD_NANO`, spelled
 * as a TraceQL/Go duration literal rather than a raw nanosecond count.
 */
const SLOW_SPAN_THRESHOLD_TRACEQL = "50ms";

/** Trace IDs are lowercase hex strings; validated before embedding in a request path/list (matches greptimedb.ts). */
const TRACE_ID_PATTERN = /^[0-9a-fA-F]+$/;

export interface TempoSourceConfig {
	url: string;
	/** `username:password`, unencoded; base64-encoded internally (Basic auth). */
	auth?: string;
	/** Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Thrown for any non-2xx Tempo HTTP response. */
export class TempoError extends Error {
	readonly httpStatus: number;

	constructor(message: string, httpStatus: number) {
		super(message);
		this.name = "TempoError";
		this.httpStatus = httpStatus;
	}
}

function validateTraceId(id: string): string {
	if (!TRACE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid trace id (length=${id.length})`);
	}
	return id;
}

/** Escapes a value for a double-quoted TraceQL string literal. */
function escapeTraceQlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function traceQlLiteral(value: string): string {
	return `"${escapeTraceQlString(value)}"`;
}

function isoToUnixSeconds(iso: string): number {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid ISO timestamp: ${iso}`);
	}
	return Math.floor(ms / 1000);
}

/** Converts a nanosecond-epoch value (string or number) into an ISO 8601 string; `undefined`/unparseable falls back to the epoch. */
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
	return new Date(0).toISOString();
}

function nanoDiff(startRaw: unknown, endRaw: unknown): number {
	try {
		const start = typeof startRaw === "string" ? BigInt(startRaw) : BigInt(0);
		const end = typeof endRaw === "string" ? BigInt(endRaw) : BigInt(0);
		const diff = end - start;
		return diff > 0n ? Number(diff) : 0;
	} catch {
		return 0;
	}
}

// --- OTLP/JSON parsing (GET /api/traces/{traceID}) ------------------------

interface OtlpAnyValue {
	stringValue?: string;
	intValue?: string | number;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values?: OtlpAnyValue[] };
	kvlistValue?: { values?: OtlpKeyValue[] };
}

interface OtlpKeyValue {
	key?: string;
	value?: OtlpAnyValue;
}

interface OtlpSpan {
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	name?: string;
	kind?: string | number;
	startTimeUnixNano?: string | number;
	endTimeUnixNano?: string | number;
	attributes?: OtlpKeyValue[];
	status?: { code?: string | number; message?: string };
}

interface OtlpScopeSpans {
	spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
	resource?: { attributes?: OtlpKeyValue[] };
	scopeSpans?: OtlpScopeSpans[];
}

interface OtlpTraceResponse {
	resourceSpans?: OtlpResourceSpans[];
}

function otlpValueToJs(value?: OtlpAnyValue): unknown {
	if (!value) {
		return undefined;
	}
	if (value.stringValue !== undefined) {
		return value.stringValue;
	}
	if (value.intValue !== undefined) {
		return typeof value.intValue === "string"
			? Number(value.intValue)
			: value.intValue;
	}
	if (value.doubleValue !== undefined) {
		return value.doubleValue;
	}
	if (value.boolValue !== undefined) {
		return value.boolValue;
	}
	if (value.arrayValue) {
		return (value.arrayValue.values ?? []).map(otlpValueToJs);
	}
	if (value.kvlistValue) {
		return attributesToRecord(value.kvlistValue.values ?? []);
	}
	return undefined;
}

function attributesToRecord(attrs: OtlpKeyValue[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const kv of attrs) {
		if (kv?.key) {
			out[kv.key] = otlpValueToJs(kv.value);
		}
	}
	return out;
}

const SPAN_KIND_NAMES = [
	"SPAN_KIND_UNSPECIFIED",
	"SPAN_KIND_INTERNAL",
	"SPAN_KIND_SERVER",
	"SPAN_KIND_CLIENT",
	"SPAN_KIND_PRODUCER",
	"SPAN_KIND_CONSUMER",
];

function normalizeSpanKind(kind: string | number | undefined): string {
	if (typeof kind === "number") {
		return SPAN_KIND_NAMES[kind] ?? "SPAN_KIND_UNSPECIFIED";
	}
	return kind ?? "SPAN_KIND_UNSPECIFIED";
}

const STATUS_CODE_NAMES = [
	"STATUS_CODE_UNSET",
	"STATUS_CODE_OK",
	"STATUS_CODE_ERROR",
];

function normalizeStatusCode(code: string | number | undefined): string {
	if (typeof code === "number") {
		return STATUS_CODE_NAMES[code] ?? "STATUS_CODE_UNSET";
	}
	return code ?? "STATUS_CODE_UNSET";
}

function otlpTraceToRecords(payload: OtlpTraceResponse): TraceRecord[] {
	const records: TraceRecord[] = [];
	for (const resourceSpans of payload.resourceSpans ?? []) {
		const resourceAttrs = attributesToRecord(
			resourceSpans.resource?.attributes ?? [],
		);
		const serviceNameAttr = resourceAttrs["service.name"];
		const serviceName =
			typeof serviceNameAttr === "string" ? serviceNameAttr : "";
		for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
			for (const span of scopeSpans.spans ?? []) {
				records.push({
					traceId: span.traceId ?? "",
					spanId: span.spanId ?? "",
					parentSpanId: span.parentSpanId ? span.parentSpanId : undefined,
					name: span.name ?? "",
					kind: normalizeSpanKind(span.kind),
					serviceName,
					startTime: nanoToIso(span.startTimeUnixNano),
					durationNano: nanoDiff(span.startTimeUnixNano, span.endTimeUnixNano),
					statusCode: normalizeStatusCode(span.status?.code),
					attributes: {
						statusMessage: span.status?.message ?? "",
						events: [],
						links: [],
						...attributesToRecord(span.attributes ?? []),
					},
				});
			}
		}
	}
	return records;
}

// --- Search (TraceQL) parsing (GET /api/search) ---------------------------

interface TempoSearchSpan {
	spanID?: string;
	startTimeUnixNano?: string | number;
	durationNanos?: string | number;
	attributes?: OtlpKeyValue[];
}

interface TempoSearchSpanSet {
	spans?: TempoSearchSpan[];
}

interface TempoSearchTrace {
	traceID: string;
	rootServiceName?: string;
	rootTraceName?: string;
	startTimeUnixNano?: string | number;
	durationMs?: number;
	spanSets?: TempoSearchSpanSet[];
	/** Older Tempo versions returned a single `spanSet` rather than `spanSets`. */
	spanSet?: TempoSearchSpanSet;
}

interface TempoSearchResponse {
	traces?: TempoSearchTrace[];
}

function searchResultsToRecords(traces: TempoSearchTrace[]): TraceRecord[] {
	const records: TraceRecord[] = [];
	for (const trace of traces) {
		const spanSets = trace.spanSets ?? (trace.spanSet ? [trace.spanSet] : []);
		for (const spanSet of spanSets) {
			for (const span of spanSet.spans ?? []) {
				const attrs = attributesToRecord(span.attributes ?? []);
				const nameAttr = attrs.name;
				const statusAttr = attrs.status;
				records.push({
					traceId: trace.traceID,
					spanId: span.spanID ?? "",
					parentSpanId: undefined,
					name:
						typeof nameAttr === "string"
							? nameAttr
							: (trace.rootTraceName ?? ""),
					// Search results don't carry a dedicated span-kind field
					// (see module doc comment) -- left unknown rather than guessed.
					kind: "",
					serviceName: trace.rootServiceName ?? "",
					startTime: nanoToIso(
						span.startTimeUnixNano ?? trace.startTimeUnixNano,
					),
					durationNano:
						typeof span.durationNanos === "string"
							? Number(span.durationNanos)
							: (span.durationNanos ?? 0),
					statusCode:
						typeof statusAttr === "string" &&
						statusAttr.toLowerCase() === "error"
							? "STATUS_CODE_ERROR"
							: "STATUS_CODE_UNSET",
					attributes: attrs,
				});
			}
		}
	}
	return records;
}

export class TempoSource implements TelemetrySource {
	readonly name = "tempo";

	private readonly url: string;
	private readonly authHeader?: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: Logger;

	constructor(
		config: TempoSourceConfig,
		logger: Logger,
		fetchImpl: typeof fetch = globalThis.fetch,
	) {
		this.url = config.url.replace(/\/+$/, "");
		this.authHeader = config.auth ? `Basic ${btoa(config.auth)}` : undefined;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
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
				throw new TempoError(
					`Tempo request timed out after ${this.timeoutMs}ms`,
					0,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	private async getJson<T>(url: string): Promise<T> {
		const response = await this.fetchWithTimeout(url);
		const text = await response.text();
		if (!response.ok) {
			throw new TempoError(
				text.length > 0
					? `Tempo request failed with HTTP status ${response.status}: ${truncateForError(text)}`
					: `Tempo request failed with HTTP status ${response.status}`,
				response.status,
			);
		}
		try {
			return JSON.parse(text) as T;
		} catch (err) {
			throw new TempoError(
				`Failed to parse Tempo response as JSON: ${(err as Error).message}`,
				response.status,
			);
		}
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		const traceIdsRaw = query.labels.trace_id;
		const limit = query.limit ?? DEFAULT_TRACE_LIMIT;

		if (traceIdsRaw) {
			const traceIds = traceIdsRaw
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id.length > 0)
				.map(validateTraceId);
			if (traceIds.length === 0) {
				return [];
			}
			const startSec = isoToUnixSeconds(query.timeRange.from);
			const endSec = isoToUnixSeconds(query.timeRange.to);
			const perTrace = await Promise.all(
				traceIds.map((id) =>
					this.getJson<OtlpTraceResponse>(
						`${this.url}/api/traces/${id}?start=${startSec}&end=${endSec}`,
					).then(otlpTraceToRecords),
				),
			);
			return perTrace
				.flat()
				.sort((a, b) => (a.startTime < b.startTime ? -1 : 1))
				.slice(0, limit);
		}

		const serviceValue = resolveServiceLabel(query.labels);
		const conditions: string[] = [];
		if (serviceValue) {
			conditions.push(`resource.service.name=${traceQlLiteral(serviceValue)}`);
		}
		// "Representative spans for a service/window": error spans or slow
		// spans, matching greptimedb.ts's error-first-then-slowest strategy
		// (TraceQL has no direct "order by" for search, so this is a filter
		// only; results come back most-recent-first per Tempo's default).
		conditions.push(
			`(status=error || duration>${SLOW_SPAN_THRESHOLD_TRACEQL})`,
		);
		const traceql = `{ ${conditions.join(" && ")} }`;

		const params = new URLSearchParams({
			q: traceql,
			start: String(isoToUnixSeconds(query.timeRange.from)),
			end: String(isoToUnixSeconds(query.timeRange.to)),
			limit: String(limit),
		});
		const payload = await this.getJson<TempoSearchResponse>(
			`${this.url}/api/search?${params.toString()}`,
		);
		return searchResultsToRecords(payload.traces ?? []).slice(0, limit);
	}

	async queryLogs(_query: TelemetryQuery): Promise<LogRecord[]> {
		this.logger.warn(
			"queryLogs called against the Tempo telemetry source; Tempo carries no log data -- returning no logs",
		);
		return [];
	}

	async queryMetrics(
		_query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		this.logger.warn(
			"queryMetrics called against the Tempo telemetry source; Tempo carries no metric data -- returning no series",
		);
		return [];
	}
}

/** Keeps a raw error body out of a thrown message beyond a reasonable length. */
function truncateForError(text: string, maxLen = 300): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}
