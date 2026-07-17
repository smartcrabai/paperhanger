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
