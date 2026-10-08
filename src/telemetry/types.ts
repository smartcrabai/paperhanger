/**
 * Telemetry collection types shared across `TelemetrySource` implementations
 * and the `IncidentContext` builder. Canonical field definitions live in
 * docs/spec.md section 3.4; this file must stay in sync with that contract.
 */

import type { Incident, IncidentEvent } from "../core/types";

/**
 * A time-bounded, label-filtered query against a telemetry backend.
 *
 * `labels` is intentionally a flat `Record<string, string>` (matching
 * docs/spec.md section 3.4 exactly) rather than a richer per-method options
 * bag, so that `TelemetrySource` stays implementable by future backends
 * (Loki/Tempo/Prometheus, per spec section 3.4) without widening the
 * interface. To keep query intent expressible within that flat shape,
 * implementations interpret a small set of *conventional* label keys:
 *
 * - `service` / `service_name` / `service.name` / `job`: aliases for "filter
 *   to this service", resolved via `resolveServiceLabel` below. Backends map
 *   this to whatever column/label actually carries the service name.
 * - `severity` (queryLogs only): `"error"` means "severity_number >= ERROR
 *   (17)"; any other value is matched against the log's severity text
 *   verbatim.
 * - `trace_id` (queryTraces only): a comma-separated list of trace IDs to
 *   fetch spans for, instead of scanning a service/time window.
 *
 * Any other key is treated by `GreptimeDbSource` as a generic resource
 * attribute equality filter (logs only; see greptimedb.ts).
 */
export interface TelemetryQuery {
	/** Inclusive time window, both bounds ISO 8601. */
	timeRange: { from: string; to: string };
	/** Label filters, e.g. service.name. See the conventions documented above. */
	labels: Record<string, string>;
	limit?: number;
}

/** Label keys treated as equivalent aliases for "service name" by convention. */
export const SERVICE_LABEL_ALIASES = [
	"service",
	"service_name",
	"service.name",
	"job",
] as const;

/** Resolves the first recognized service-name alias present in `labels`, if any. */
export function resolveServiceLabel(
	labels: Record<string, string>,
): string | undefined {
	for (const key of SERVICE_LABEL_ALIASES) {
		const value = labels[key];
		if (value) {
			return value;
		}
	}
	return undefined;
}

/** A single normalized log record. */
export interface LogRecord {
	/** ISO 8601 timestamp. */
	timestamp: string;
	severityText: string;
	severityNumber: number;
	body: string;
	traceId?: string;
	spanId?: string;
	serviceName?: string;
	attributes: Record<string, unknown>;
	resourceAttributes: Record<string, unknown>;
}

/** A single span. One row per span; callers assemble trace trees themselves. */
export interface TraceRecord {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: string;
	serviceName: string;
	/** ISO 8601 timestamp; span start time. */
	startTime: string;
	durationNano: number;
	statusCode: string;
	attributes: Record<string, unknown>;
}

export interface MetricPoint {
	/** ISO 8601 timestamp. */
	timestamp: string;
	value: number;
}

export interface MetricSeries {
	name: string;
	labels: Record<string, string>;
	points: MetricPoint[];
}

/** Table/column identifiers interpolated into SQL must match this grammar. */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Resource/log attribute keys (JSON path segments), e.g. OTel dotted keys. */
export const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** Trace IDs are hexadecimal strings validated before embedding in queries. */
export const TRACE_ID_PATTERN = /^[0-9a-fA-F]+$/;

// Validators never embed raw upstream-tainted values in error messages, which
// can otherwise be recorded verbatim onto an exported span.
export function validateIdentifier(name: string): string {
	if (!IDENTIFIER_PATTERN.test(name)) {
		throw new Error(`Invalid SQL identifier (length=${name.length})`);
	}
	return name;
}

export function validateAttributeKey(key: string): string {
	if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
		throw new Error(`Invalid attribute/label key (length=${key.length})`);
	}
	return key;
}

export function validateTraceId(id: string): string {
	if (!TRACE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid trace id (length=${id.length})`);
	}
	return id;
}

export function validateLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error("Invalid limit: must be a positive integer");
	}
	return limit;
}

export function asString(value: unknown, fallback = ""): string {
	if (value === null || value === undefined) {
		return fallback;
	}
	return String(value);
}

export function asNumber(value: unknown, fallback = 0): number {
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

interface PromSample {
	metric?: Record<string, string>;
	value?: [number, string];
	values?: [number, string][];
}

export interface PromQueryRangeResponse {
	status: string;
	data?: { resultType: string; result: PromSample[] };
	error?: string;
	errorType?: string;
}

const METRIC_MAX_POINTS = 200;

export function computeStepSeconds(
	fromSec: number,
	toSec: number,
	maxPoints = METRIC_MAX_POINTS,
): number {
	const span = Math.max(1, toSec - fromSec);
	return Math.max(1, Math.ceil(span / maxPoints));
}

export function parsePrometheusResponse(
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

export function firstDefined(
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

export function omit(
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

/**
 * Abstraction over a telemetry backend (docs/spec.md section 3.4). Initial
 * (and, as of M2, only) implementation is GreptimeDB direct query
 * (`greptimedb.ts`); Loki/Tempo/Prometheus implementations are future work.
 */
export interface TelemetrySource {
	readonly name: string;
	queryLogs(query: TelemetryQuery): Promise<LogRecord[]>;
	queryTraces(query: TelemetryQuery): Promise<TraceRecord[]>;
	queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]>;
	/**
	 * Optional native-expression escape hatch for the `query_telemetry`
	 * follow-up tool's logs/traces `expression` field (see
	 * `src/telemetry/followup.ts` and docs/spec.md section 3.4). Runs a single
	 * read-only statement and returns raw rows -- unlike `queryLogs`/
	 * `queryTraces`, the result shape is whatever the statement projects, not
	 * a normalized `LogRecord`/`TraceRecord`.
	 *
	 * Only `GreptimeDbSource` implements this today: its SQL text carries real
	 * expressive power beyond the flat `TelemetryQuery` label-filter shape,
	 * and `agent-host/src/lib/sql-guard.ts` already guards single-statement,
	 * read-only SQL for it. Sources that don't implement this leave it
	 * `undefined`; `followup.ts` degrades to a "structurally unsupported"
	 * note rather than crashing or asserting on that absence -- this also
	 * covers a future `composite` source transparently, whether or not it
	 * chooses to implement raw SQL itself.
	 */
	runRawSql?(sql: string): Promise<Record<string, unknown>[]>;
}

/** Collected telemetry for a single incident/alert. */
export interface IncidentContextTelemetry {
	logs: LogRecord[];
	traces: TraceRecord[];
	metrics: MetricSeries[];
}

/**
 * The shared contract consumed by the fix agent (M4). Built by
 * `buildIncidentContext` in `context-builder.ts`.
 */
export interface IncidentContext {
	incident: Incident;
	alert: IncidentEvent;
	window: { from: string; to: string };
	telemetry: IncidentContextTelemetry;
	/** Collection caveats, e.g. "metrics skipped: no query hint". */
	notes: string[];
}
