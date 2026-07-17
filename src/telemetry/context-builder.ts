/**
 * Builds an `IncidentContext` from an incident + alert, following the
 * collection strategy in docs/spec.md section 3.4:
 *
 *   1. Resolve the alert window (before/after the alert time).
 *   2. Fetch error logs for the resolved service (or a window-only fallback).
 *   3. Collect distinct trace_ids from those logs and fetch their spans,
 *      plus a representative error/slowest-span sample for the service.
 *   4. Fetch metrics only if the alert carries a query hint.
 *   5. Enforce a total rendered-size budget, dropping lowest-priority
 *      telemetry first and recording what was dropped in `notes`.
 *
 * Also exports `renderContextMarkdown`, the deterministic Markdown rendering
 * the fix agent (M4) embeds in its prompt.
 */

import type { Incident, IncidentEvent } from "../core/types";
import type { Logger } from "../observability/logger";
import {
	type IncidentContext,
	type LogRecord,
	type MetricPoint,
	type MetricSeries,
	resolveServiceLabel,
	type TelemetrySource,
	type TraceRecord,
} from "./types";

export interface CollectWindowConfig {
	windowBeforeMinutes: number;
	windowAfterMinutes: number;
}

/** Minimal config shape this module needs; structurally compatible with `Config["collect"]`. */
export interface ContextBuilderConfig {
	collect: CollectWindowConfig;
}

export interface BuildIncidentContextDeps {
	source: TelemetrySource;
	logger: Logger;
	config: ContextBuilderConfig;
}

const DEFAULT_MAX_CONTEXT_CHARS = 60_000;
const ERROR_LOG_LIMIT = 50;
/** Tight limit used when no service label could be resolved from the alert. */
const NO_SERVICE_LOG_LIMIT = 20;
const MAX_TRACE_IDS = 5;
const REPRESENTATIVE_SPAN_LIMIT = 20;

/** Alert annotation keys that opt the incident into metrics collection. */
const METRIC_HINT_ANNOTATIONS = ["promql", "metric"];

/** Body patterns suggesting a log carries an exception/stack trace. */
const EXCEPTION_BODY_PATTERN =
	/\bTraceback\b|\bException\b|\bpanic:|\bstack ?trace\b|\n\s*at\s+\S+/i;

function looksLikeException(body: string): boolean {
	return EXCEPTION_BODY_PATTERN.test(body);
}

function hasQueryHint(alert: IncidentEvent): string | undefined {
	for (const key of METRIC_HINT_ANNOTATIONS) {
		const value = alert.annotations[key];
		if (value) {
			return value;
		}
	}
	return undefined;
}

/** Whether `alert.startsAt` parses to a valid `Date`. */
export function hasValidStartsAt(alert: IncidentEvent): boolean {
	return !Number.isNaN(new Date(alert.startsAt).getTime());
}

/**
 * Computes the alert time window (exported for reuse by `src/core/pipeline.ts`,
 * which needs an identical window when synthesizing a degraded, empty-telemetry
 * `IncidentContext` after a telemetry failure or absent telemetry config).
 *
 * Never throws: `alert.startsAt` normally comes straight from an upstream
 * alert payload, and a malformed value (e.g. `"N/A"`) used to surface as an
 * uncaught `RangeError` from `Date#toISOString()` on an `Invalid Date` --
 * from *both* this function's normal call site (`buildIncidentContext` below)
 * and the degraded-context call site in `pipeline.ts` -- turning what should
 * be the documented empty-telemetry degradation into a generic unexpected
 * failure. When `startsAt` doesn't parse, the window is anchored at `now`
 * instead; callers that maintain a `notes` array (see `buildIncidentContext`)
 * should record that fallback explicitly via `hasValidStartsAt`.
 */
export function computeWindow(
	alert: IncidentEvent,
	collect: CollectWindowConfig,
	now: Date,
): { from: string; to: string } {
	const parsedStart = new Date(alert.startsAt);
	const alertStart = Number.isNaN(parsedStart.getTime()) ? now : parsedStart;
	const from = new Date(
		alertStart.getTime() - collect.windowBeforeMinutes * 60_000,
	);
	let to = new Date(alertStart.getTime() + collect.windowAfterMinutes * 60_000);
	if (to.getTime() > now.getTime()) {
		to = now;
	}
	if (to.getTime() < from.getTime()) {
		to = from;
	}
	return { from: from.toISOString(), to: to.toISOString() };
}

function dedupeTraces(traces: TraceRecord[]): TraceRecord[] {
	const seen = new Set<string>();
	const result: TraceRecord[] = [];
	for (const trace of traces) {
		const key = `${trace.traceId}:${trace.spanId}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(trace);
	}
	return result;
}

export async function buildIncidentContext(
	deps: BuildIncidentContextDeps,
	incident: Incident,
	alert: IncidentEvent,
	maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
): Promise<IncidentContext> {
	const { source, logger, config } = deps;
	const notes: string[] = [];
	if (!hasValidStartsAt(alert)) {
		notes.push(
			`Alert startsAt (${JSON.stringify(alert.startsAt)}) is not a valid timestamp; ` +
				"anchored the collection window at the current time instead.",
		);
	}
	const window = computeWindow(alert, config.collect, new Date());
	const serviceLabel = resolveServiceLabel(alert.labels);

	// Step 2: error logs for the resolved service, or a window-only fallback.
	let errorLogs: LogRecord[];
	if (serviceLabel) {
		errorLogs = await source.queryLogs({
			timeRange: window,
			labels: { service: serviceLabel, severity: "error" },
			limit: ERROR_LOG_LIMIT,
		});
	} else {
		notes.push(
			"No service label resolved from the alert (checked service, service_name, " +
				"service.name, job); fetched error logs by time window only with a tight limit.",
		);
		errorLogs = await source.queryLogs({
			timeRange: window,
			labels: { severity: "error" },
			limit: NO_SERVICE_LOG_LIMIT,
		});
	}

	// Step 3: distinct trace_ids from those logs, plus a representative sample.
	const traceIds = [
		...new Set(
			errorLogs
				.map((log) => log.traceId)
				.filter((id): id is string => Boolean(id)),
		),
	].slice(0, MAX_TRACE_IDS);

	const tracesById =
		traceIds.length > 0
			? await source.queryTraces({
					timeRange: window,
					labels: { trace_id: traceIds.join(",") },
				})
			: [];

	let representativeSpans: TraceRecord[] = [];
	if (serviceLabel) {
		representativeSpans = await source.queryTraces({
			timeRange: window,
			labels: { service: serviceLabel },
			limit: REPRESENTATIVE_SPAN_LIMIT,
		});
	} else {
		notes.push(
			"Skipped representative error/slowest span query: no service resolved from the alert.",
		);
	}

	const traces = dedupeTraces([...tracesById, ...representativeSpans]);

	// Step 4: metrics only if the alert carries a query hint.
	let metrics: MetricSeries[] = [];
	const promqlHint = hasQueryHint(alert);
	if (promqlHint) {
		metrics = await source.queryMetrics({
			timeRange: window,
			labels: serviceLabel ? { service: serviceLabel } : {},
			promql: promqlHint,
		});
	} else {
		notes.push(
			'Metrics skipped: no query hint (alert annotation "promql" or "metric") was present.',
		);
	}

	const context: IncidentContext = {
		incident,
		alert,
		window,
		telemetry: { logs: errorLogs, traces, metrics },
		notes,
	};

	return applyBudget(context, maxContextChars, logger);
}

/**
 * Enforces `maxChars` on the rendered Markdown, dropping telemetry in
 * ascending priority order (metrics, then traces, then non-exception error
 * logs, then — only as a last resort — exception/stack-trace-bearing logs)
 * and recording what was dropped in `notes`.
 */
function applyBudget(
	context: IncidentContext,
	maxChars: number,
	logger: Logger,
): IncidentContext {
	if (renderContextMarkdown(context).length <= maxChars) {
		return context;
	}

	const notes = [...context.notes];
	let metrics = context.telemetry.metrics;
	let traces = context.telemetry.traces;
	let logs = context.telemetry.logs;

	const build = (): IncidentContext => ({
		...context,
		telemetry: { logs, traces, metrics },
		notes,
	});
	const fits = () => renderContextMarkdown(build()).length <= maxChars;

	if (!fits() && metrics.length > 0) {
		notes.push(
			`Dropped ${metrics.length} metric series to stay within the ${maxChars}-char context budget.`,
		);
		metrics = [];
	}

	let droppedTraces = 0;
	while (!fits() && traces.length > 0) {
		traces = traces.slice(0, -1);
		droppedTraces++;
	}
	if (droppedTraces > 0) {
		notes.push(
			`Dropped ${droppedTraces} trace span(s) to stay within the context budget.`,
		);
	}

	const exceptionLogs = logs.filter((log) => looksLikeException(log.body));
	let otherLogs = logs.filter((log) => !looksLikeException(log.body));
	let droppedOtherLogs = 0;
	while (!fits() && otherLogs.length > 0) {
		otherLogs = otherLogs.slice(0, -1);
		logs = [...exceptionLogs, ...otherLogs];
		droppedOtherLogs++;
	}
	if (droppedOtherLogs > 0) {
		notes.push(
			`Dropped ${droppedOtherLogs} non-exception error log(s) to stay within the context budget.`,
		);
	}

	let remainingExceptions = exceptionLogs;
	let droppedExceptionLogs = 0;
	while (!fits() && remainingExceptions.length > 1) {
		remainingExceptions = remainingExceptions.slice(0, -1);
		logs = [...remainingExceptions, ...otherLogs];
		droppedExceptionLogs++;
	}
	if (droppedExceptionLogs > 0) {
		notes.push(
			`Dropped ${droppedExceptionLogs} exception/stack-trace log(s) (lowest priority to drop) to stay within the context budget.`,
		);
	}

	const finalContext = build();
	const finalLength = renderContextMarkdown(finalContext).length;
	if (finalLength > maxChars) {
		logger.warn(
			"IncidentContext still exceeds the configured budget after maximal truncation",
			{ maxChars, renderedLength: finalLength },
		);
		notes.push(
			`Context still exceeds the ${maxChars}-char budget after maximal truncation; consider lowering collection limits.`,
		);
	}

	return { ...finalContext, notes };
}

function formatKeyValues(record: Record<string, string>): string {
	return Object.keys(record)
		.sort()
		.map((key) => `${key}=${record[key]}`)
		.join(", ");
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function groupTracesByTraceId(
	traces: TraceRecord[],
): [string, TraceRecord[]][] {
	const map = new Map<string, TraceRecord[]>();
	for (const span of traces) {
		const list = map.get(span.traceId) ?? [];
		list.push(span);
		map.set(span.traceId, list);
	}
	for (const list of map.values()) {
		list.sort((a, b) =>
			a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0,
		);
	}
	return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function computeMetricStats(points: MetricPoint[]): {
	min: string;
	max: string;
	avg: string;
	last: string;
} {
	if (points.length === 0) {
		return { min: "n/a", max: "n/a", avg: "n/a", last: "n/a" };
	}
	const values = points.map((p) => p.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
	const last = points[points.length - 1]?.value ?? Number.NaN;
	return {
		min: min.toFixed(3),
		max: max.toFixed(3),
		avg: avg.toFixed(3),
		last: last.toFixed(3),
	};
}

/**
 * Renders a compact, sectioned Markdown summary of the context for embedding
 * in the fix agent's prompt. Ordering is fully deterministic (sorted keys,
 * chronological logs/spans, alphabetic trace/metric grouping) so the output
 * is stable across calls for the same input, which keeps it testable.
 */
export function renderContextMarkdown(context: IncidentContext): string {
	const { incident, alert, window, telemetry, notes } = context;
	const lines: string[] = [];

	lines.push(`# Incident: ${incident.title} (${incident.id})`);
	lines.push("");
	lines.push(`- Status: ${incident.status}`);
	lines.push(`- Severity: ${alert.severity}`);
	lines.push(`- Source: ${alert.source}`);
	lines.push(`- Fingerprint: ${incident.fingerprint}`);
	lines.push(`- Window: ${window.from} .. ${window.to}`);
	lines.push(`- Labels: ${formatKeyValues(alert.labels)}`);
	if (Object.keys(alert.annotations).length > 0) {
		lines.push(`- Annotations: ${formatKeyValues(alert.annotations)}`);
	}
	lines.push("");

	if (notes.length > 0) {
		lines.push("## Notes");
		for (const note of notes) {
			lines.push(`- ${note}`);
		}
		lines.push("");
	}

	lines.push(`## Error logs (${telemetry.logs.length})`);
	if (telemetry.logs.length === 0) {
		lines.push("_No error logs collected._");
	} else {
		const sortedLogs = [...telemetry.logs].sort((a, b) =>
			a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
		);
		for (const log of sortedLogs) {
			const excerpt = truncate(log.body.replace(/\s+/g, " ").trim(), 300);
			const correlation = log.traceId
				? ` (trace=${log.traceId}${log.spanId ? ` span=${log.spanId}` : ""})`
				: "";
			lines.push(
				`- [${log.timestamp}] ${log.severityText}: ${excerpt}${correlation}`,
			);
		}
	}
	lines.push("");

	lines.push(`## Traces (${telemetry.traces.length} spans)`);
	if (telemetry.traces.length === 0) {
		lines.push("_No trace spans collected._");
	} else {
		const groups = groupTracesByTraceId(telemetry.traces);
		for (const [traceId, spans] of groups) {
			lines.push(`### trace ${traceId} (${spans.length} span(s))`);
			for (const span of spans) {
				const durationMs = (span.durationNano / 1_000_000).toFixed(1);
				const parent = span.parentSpanId ? ` parent=${span.parentSpanId}` : "";
				lines.push(
					`- [${span.startTime}] ${span.name} (${span.kind}) service=${span.serviceName} duration=${durationMs}ms status=${span.statusCode}${parent}`,
				);
			}
		}
	}
	lines.push("");

	lines.push(`## Metrics (${telemetry.metrics.length} series)`);
	if (telemetry.metrics.length === 0) {
		lines.push("_No metrics collected._");
	} else {
		const sortedMetrics = [...telemetry.metrics].sort((a, b) => {
			const nameCompare = a.name.localeCompare(b.name);
			return nameCompare !== 0
				? nameCompare
				: formatKeyValues(a.labels).localeCompare(formatKeyValues(b.labels));
		});
		for (const series of sortedMetrics) {
			const stats = computeMetricStats(series.points);
			lines.push(
				`- ${series.name}{${formatKeyValues(series.labels)}}: n=${series.points.length} min=${stats.min} max=${stats.max} avg=${stats.avg} last=${stats.last}`,
			);
		}
	}

	return lines.join("\n");
}
