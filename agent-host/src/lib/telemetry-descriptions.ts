/**
 * Per-source `query_telemetry` tool descriptions (see `../tools.ts`). The
 * parent repo's `src/telemetry/*` sources each carry real, source-specific
 * capability limits (Zabbix/Mackerel have no tracing concept at all; several
 * sources need an explicit metric-name hint before `signal: "metrics"` does
 * anything; only GreptimeDB accepts the raw-SQL `expression` escape hatch
 * for logs/traces) -- telling the model this up front, in the tool's own
 * `description`, lets it ask a query that can actually succeed instead of
 * discovering the limitation only after a "structurally unsupported" note
 * comes back (see `src/telemetry/followup.ts` in the parent repo for that
 * distinction).
 *
 * This module has no `@flue/*` import, so it is unit-testable directly by
 * the main paperhanger repo's `bun test` (root `package.json` "test"
 * script), like every other `../lib/*.ts` module.
 */

const GENERIC_CAPABILITIES_NOTE =
	"Structured `filter` (label equality, e.g. service/severity/trace_id) is always available for logs/traces. " +
	'`expression` for `signal: "metrics"` is required and is this backend\'s own metric-query syntax. ' +
	"A query outside this source's capabilities returns an empty result with an explanatory note instead of failing -- read the note and rephrase.";

/**
 * One capability blurb per configured-source name (`TelemetrySource.name`,
 * mirroring `src/telemetry/factory.ts` in the parent repo). Keep this in
 * sync when a new source is added there -- but an entry here is a
 * *description improvement only*: a name missing from this map still gets a
 * safe, generic tool description via `describeTelemetrySource`'s fallback
 * below, so an out-of-sync map degrades gracefully rather than breaking
 * anything. This is also why an unrecognized name (e.g. a future
 * `composite` source from a parallel change this file does not implement
 * support for) is handled the same safe way, not asserted against.
 */
const SOURCE_DESCRIPTIONS: Record<string, string> = {
	greptimedb:
		'Backend: GreptimeDB. Supports logs, traces, and metrics. For `signal: "metrics"`, `expression` is a PromQL expression. ' +
		'For `signal: "logs"` or `"traces"`, `expression` may instead carry a single read-only SQL statement (SELECT/SHOW/DESC only) as a native escape hatch beyond structured `filter`.',
	loki: 'Backend: Loki. Logs only -- `signal: "traces"` or `"metrics"` always return empty (Loki carries no trace or metric data). `expression` is not supported for logs; use structured `filter` (LogQL is built from it internally).',
	tempo:
		'Backend: Tempo. Traces only -- `signal: "logs"` or `"metrics"` always return empty (Tempo carries no log or metric data). Use `filter.trace_id` for a specific trace, or `filter.service` for a representative sample.',
	prometheus:
		'Backend: Prometheus. Metrics only -- `signal: "logs"` or `"traces"` always return empty (Prometheus carries no log or trace data). For `signal: "metrics"`, `expression` is a PromQL expression.',
	clickstack:
		'Backend: ClickStack (ClickHouse-based OTel stack). Supports logs and traces. Metrics are NOT supported (no PromQL-compatible query API) -- `signal: "metrics"` always returns empty.',
	signoz:
		'Backend: SigNoz. Supports logs and traces via its unified query_range API. Metrics are NOT supported here (SigNoz\'s builder-query metrics API does not accept a raw PromQL expression) -- `signal: "metrics"` always returns empty.',
	openobserve:
		'Backend: OpenObserve. Supports logs and traces via its SQL-like _search API. Metrics support is unverified against a live deployment; `signal: "metrics"` may return empty if unsupported.',
	datadog:
		'Backend: Datadog. Supports logs, traces, and metrics. For `signal: "metrics"`, `expression` is a Datadog metrics query string (e.g. `avg:trace.express.request.duration{service:checkout}`), not PromQL.',
	newrelic:
		'Backend: New Relic. Supports logs, traces, and metrics via NRQL. For `signal: "metrics"`, `expression` is an NRQL query (e.g. a `TIMESERIES` query against the `Metric` event type), not PromQL.',
	grafana:
		'Backend: Grafana (a query front-end, not a store) -- proxies to whatever Loki/Tempo/Prometheus datasources this deployment provisioned. A signal whose datasource UID was not configured always returns empty. For `signal: "metrics"`, `expression` is a PromQL expression.',
	zabbix:
		'Backend: Zabbix (a monitoring system, not a log/trace store). `signal: "logs"` returns problem/event history as a best-effort substitute for error logs. `signal: "traces"` always returns empty (Zabbix has no tracing concept). For `signal: "metrics"`, `expression` must be an exact Zabbix item key, AND `filter` must resolve a host (e.g. `filter.service`) -- both are required, or the result is empty.',
	mackerel:
		'Backend: Mackerel (a monitoring system, not a log/trace store). `signal: "logs"` returns alert history as a best-effort substitute for error logs. `signal: "traces"` always returns empty (Mackerel has no tracing concept). For `signal: "metrics"`, `expression` must be an exact Mackerel metric name, AND `filter` must resolve a service (e.g. `filter.service`) -- both are required, or the result is empty.',
};

/**
 * Builds the `query_telemetry` tool description for the configured source
 * `sourceName` (the parent repo's `config.telemetry.source`, forwarded
 * verbatim via `PAPERHANGER_TELEMETRY_CALLBACK_SOURCE`; see `../tools.ts`).
 * Falls back to a generic, capability-agnostic description for a name not
 * in `SOURCE_DESCRIPTIONS` -- covering both a simple map/parent drift and a
 * genuinely new source (e.g. a parallel change's `composite` source this
 * file does not special-case) -- so an unrecognized name degrades to a
 * slightly less specific tool description, never a crash or an assertion.
 */
export function describeTelemetrySource(sourceName: string): string {
	const specific = SOURCE_DESCRIPTIONS[sourceName];
	const capabilities = specific ?? `Backend: "${sourceName}".`;
	return `Run a read-only follow-up telemetry query beyond what was already collected into the incident context. ${capabilities} ${GENERIC_CAPABILITIES_NOTE}`;
}
