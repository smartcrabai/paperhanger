/**
 * `CompositeTelemetrySource`: routes each signal (logs/traces/metrics) to
 * its own single-backend `TelemetrySource` child, for stacks with no single
 * multi-signal store -- the standard Grafana OSS setup (Loki + Tempo +
 * Prometheus) is the motivating case (see docs/spec.md section 3.4). Built
 * by `src/telemetry/factory.ts`, which recursively constructs one child per
 * configured slot from `CompositeTelemetryConfig` (`src/config/schema.ts`);
 * this class itself never constructs a child, only routes to the ones it is
 * given.
 *
 * Routing is strict and one-directional: `queryLogs` only ever calls the
 * `logs` slot's child, `queryTraces` only `traces`, `queryMetrics` only
 * `metrics`. A source placed in a slot never has its other query methods
 * called, even when it implements them -- e.g. a Datadog source configured
 * under `logs:` never has `queryTraces`/`queryMetrics` invoked, because the
 * config is an explicit declaration of which backend owns which signal, not
 * a hint. An unset slot returns `[]` immediately, with no child to call.
 *
 * **Per-signal error isolation**: unlike a single (non-composite) telemetry
 * source, where `src/core/pipeline.ts` degrades an ENTIRE incident to
 * empty telemetry when a query throws, a composite catches each slot's
 * query independently -- a Tempo outage only empties `traces`, and still
 * leaves `logs`/`metrics` from their own (healthy) backends intact. This is
 * a deliberate behavior difference from the single-source path, which is
 * unchanged.
 *
 * **Out of scope**: the agent-host follow-up `query_telemetry` tool stays
 * scoped to `source: "greptimedb"` (see the doc comment on `TelemetrySchema`
 * in `src/config/schema.ts`). `src/agent/sidecar.ts` and
 * `src/agent/runner.ts` narrow on `config.telemetry?.source === "greptimedb"`,
 * so `source: "composite"` always falls through to that tool being omitted
 * -- even when one of its slots happens to be greptimedb. This class plays
 * no part in that decision and does not attempt to special-case it.
 *
 * **Operational caveat -- cross-backend trace correlation**:
 * `context-builder.ts` pulls `trace_id` out of collected logs and uses it to
 * fetch traces (`source.queryTraces({ labels: { trace_id: ... } })`). For a
 * loki+tempo pair that only works if both sides carry a *consistent*
 * trace_id for the same request -- the operator's OTel pipeline is
 * responsible for that, this class does nothing to reconcile IDs across
 * backends. Pairing a pseudo-log source (`zabbix`/`mackerel`) in the `logs:`
 * slot with a real trace backend in `traces:` makes that linkage useless:
 * problem/alert history carries no `trace_id` field at all, so
 * `context-builder.ts` never derives any trace_id to look up.
 */

import type {
	CompositeTelemetryConfig,
	SignalSourceConfig,
} from "../config/schema";
import type { Logger } from "../observability/logger";
import type {
	LogRecord,
	MetricSeries,
	TelemetryQuery,
	TelemetrySource,
	TraceRecord,
} from "./types";

type Signal = "logs" | "traces" | "metrics";

const SIGNALS: readonly Signal[] = ["logs", "traces", "metrics"];

/** The already-constructed child `TelemetrySource` for each configured slot. */
export interface CompositeTelemetrySourceSlots {
	logs?: TelemetrySource;
	traces?: TelemetrySource;
	metrics?: TelemetrySource;
}

/**
 * Capability table: whether a given single-backend source can return
 * non-empty results for a given signal, from its resolved slot config alone
 * (no live call). Used only to decide whether to log a startup WARNING when
 * a slot is misconfigured -- never to block construction or a query, since
 * the project philosophy (see the `telemetry` doc comment in
 * `src/config/schema.ts`) is that telemetry degrades rather than blocks.
 *
 * OBLIGATION: this table is read from each collector file, not from its doc
 * comments, and MUST be kept in sync with them as they evolve --
 * `loki.ts`, `tempo.ts`, `prometheus.ts`, `clickstack.ts`, `signoz.ts`,
 * `openobserve.ts`, `grafana.ts`, `zabbix.ts`, `mackerel.ts`,
 * `greptimedb.ts`, `datadog.ts`, `newrelic.ts`. Re-verify against the actual
 * `queryLogs`/`queryTraces`/`queryMetrics` implementations (not just their
 * module doc comments) whenever one of those files changes.
 *
 * - `loki`: logs only.
 * - `tempo`: traces only.
 * - `prometheus`: metrics only.
 * - `clickstack`, `signoz`: logs + traces; `queryMetrics` always returns
 *   `[]` (ClickHouse has no PromQL-compatible query endpoint; SigNoz's
 *   `query_range` builder API takes a metric name + aggregation spec, not a
 *   raw PromQL expression) -- verified in both files' `queryMetrics`.
 * - `openobserve`, `greptimedb`, `datadog`, `newrelic`: all three signals.
 *   `openobserve`'s metrics read path (`/prometheus/api/v1/query_range`) is
 *   unverified against a live backend (see `openobserve.ts`'s module doc
 *   comment) but is a per-call concern, not a structural one -- not treated
 *   as a capability gap here.
 * - `grafana`: each signal only when its corresponding datasource UID is
 *   configured (`lokiDatasourceUid`/`tempoDatasourceUid`/
 *   `prometheusDatasourceUid`) -- statically checkable from config, unlike
 *   every other row here.
 * - `zabbix`, `mackerel`: pseudo-logs (problem/alert history, not real
 *   logs); traces never (no distributed tracing concept at all); metrics
 *   only when the query ALSO carries a resolvable host/service label and a
 *   metric-name hint -- a per-query condition this construction-time table
 *   cannot see, so `metrics` is treated as supported (no warning) here
 *   rather than guessing. This is the intermediate case the module doc
 *   comment on `zabbix.ts`/`mackerel.ts` describes, and the reason slot
 *   misplacement is a warning rather than a hard error in the first place.
 */
function supportsSignal(config: SignalSourceConfig, signal: Signal): boolean {
	switch (config.source) {
		case "loki":
			return signal === "logs";
		case "tempo":
			return signal === "traces";
		case "prometheus":
			return signal === "metrics";
		case "clickstack":
		case "signoz":
			return signal !== "metrics";
		case "openobserve":
		case "greptimedb":
		case "datadog":
		case "newrelic":
			return true;
		case "grafana":
			if (signal === "logs") {
				return Boolean(config.lokiDatasourceUid);
			}
			if (signal === "traces") {
				return Boolean(config.tempoDatasourceUid);
			}
			return Boolean(config.prometheusDatasourceUid);
		case "zabbix":
		case "mackerel":
			return signal !== "traces";
	}
}

export class CompositeTelemetrySource implements TelemetrySource {
	readonly name = "composite";

	/**
	 * The child `TelemetrySource` given for each configured slot. Public (not
	 * part of the `TelemetrySource` interface itself) so callers -- and
	 * `src/telemetry/factory.test.ts` -- can confirm which concrete backend
	 * ended up routing a given signal.
	 */
	readonly slots: CompositeTelemetrySourceSlots;
	private readonly logger: Logger;

	constructor(
		config: CompositeTelemetryConfig,
		slots: CompositeTelemetrySourceSlots,
		logger: Logger,
	) {
		this.slots = slots;
		this.logger = logger;
		this.warnMisplacedSlots(config);
		this.logUnconfiguredSlots(config);
	}

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		const child = this.slots.logs;
		if (!child) {
			return [];
		}
		try {
			return await child.queryLogs(query);
		} catch (err) {
			this.logQueryFailure("logs", child, err);
			return [];
		}
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		const child = this.slots.traces;
		if (!child) {
			return [];
		}
		try {
			return await child.queryTraces(query);
		} catch (err) {
			this.logQueryFailure("traces", child, err);
			return [];
		}
	}

	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		const child = this.slots.metrics;
		if (!child) {
			return [];
		}
		try {
			return await child.queryMetrics(query);
		} catch (err) {
			this.logQueryFailure("metrics", child, err);
			return [];
		}
	}

	/**
	 * Logs (never rethrows) a slot child's query failure so it isolates to
	 * that signal only -- this is the per-signal error isolation described in
	 * the module doc comment, in contrast to a single (non-composite) source
	 * whose thrown errors degrade the whole `IncidentContext`
	 * (`src/core/pipeline.ts`).
	 */
	private logQueryFailure(
		signal: Signal,
		child: TelemetrySource,
		err: unknown,
	): void {
		this.logger.error("composite.slot_query_failed", {
			signal,
			childSource: child.name,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	/**
	 * Startup-only WARNING (never an error -- see `supportsSignal`'s doc
	 * comment) for a slot whose backend cannot return non-empty data for that
	 * signal. Logged once per misplaced slot at construction, not per query,
	 * to avoid per-incident warn spam.
	 */
	private warnMisplacedSlots(config: CompositeTelemetryConfig): void {
		for (const signal of SIGNALS) {
			const slotConfig = config[signal];
			if (slotConfig && !supportsSignal(slotConfig, signal)) {
				this.logger.warn("composite.slot_misplacement", {
					signal,
					source: slotConfig.source,
					message:
						`Composite telemetry "${signal}" slot is configured with ` +
						`source "${slotConfig.source}", which does not return ${signal} ` +
						"data; this slot's queries will always return no results.",
				});
			}
		}
	}

	/**
	 * One INFO line at construction listing every unconfigured signal (if
	 * any), so an unset slot's silent `[]` at query time doesn't go entirely
	 * unremarked. Emits nothing when every signal is configured.
	 */
	private logUnconfiguredSlots(config: CompositeTelemetryConfig): void {
		const unconfigured = SIGNALS.filter((signal) => !config[signal]);
		if (unconfigured.length > 0) {
			this.logger.info("composite.unconfigured_signals", {
				signals: unconfigured,
			});
		}
	}
}
