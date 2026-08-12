/**
 * Dispatches `config.telemetry` (the discriminated union in
 * `src/config/schema.ts`) to a concrete `TelemetrySource` implementation.
 *
 * This is the single place in the main Bun process that maps a telemetry
 * backend kind to its constructor. Adding a future backend means adding one
 * more `TelemetrySchema` union member (schema.ts) and one more `case` here
 * -- `src/index.ts` itself never needs to change. `loki`/`tempo`/`prometheus`
 * are single-signal sources (see their respective files); only `greptimedb`
 * is wired into the agent-host sidecar's follow-up query tool so far -- see
 * the doc comment on `createTelemetryTools()` in `agent-host/src/tools.ts`.
 *
 * `composite` recurses: it calls this same function once per configured
 * slot (`logs`/`traces`/`metrics`) to build that slot's child, then wraps
 * them in a `CompositeTelemetrySource` (see `composite.ts`). The schema
 * stops this from recursing more than one level deep -- a composite slot's
 * type (`SignalSourceSchema` in `src/config/schema.ts`) excludes `composite`
 * itself, so no `case "composite"` can ever appear in a recursive call here.
 */

import type { Tracer } from "@opentelemetry/api";
import type { TelemetryConfig } from "../config/schema";
import { ClickStackSource } from "./clickstack";
import {
	CompositeTelemetrySource,
	type CompositeTelemetrySourceSlots,
} from "./composite";
import { DatadogSource } from "./datadog";
import { GrafanaSource } from "./grafana";
import { GreptimeDbSource } from "./greptimedb";
import { LokiSource } from "./loki";
import { MackerelSource } from "./mackerel";
import { NewRelicSource } from "./newrelic";
import type { Logger } from "../observability/logger";
import { OpenObserveSource } from "./openobserve";
import { PrometheusSource } from "./prometheus";
import { SigNozSource } from "./signoz";
import { TempoSource } from "./tempo";
import type { TelemetrySource } from "./types";
import { ZabbixSource } from "./zabbix";

export function createTelemetrySource(
	config: TelemetryConfig,
	logger: Logger,
	tracer?: Tracer,
): TelemetrySource {
	switch (config.source) {
		case "greptimedb":
			return new GreptimeDbSource(config, logger, undefined, tracer);
		case "loki":
			return new LokiSource(config, logger);
		case "tempo":
			return new TempoSource(config, logger);
		case "prometheus":
			return new PrometheusSource(config, logger);
		case "clickstack":
			return new ClickStackSource(config, logger, undefined, tracer);
		case "signoz":
			return new SigNozSource(config, logger, undefined, tracer);
		case "openobserve":
			return new OpenObserveSource(config, logger, undefined, tracer);
		case "datadog":
			return new DatadogSource(config, logger, undefined, tracer);
		case "newrelic":
			return new NewRelicSource(config, logger, undefined, tracer);
		case "grafana":
			return new GrafanaSource(config, logger, undefined, tracer);
		case "zabbix":
			return new ZabbixSource(config, logger, undefined, tracer);
		case "mackerel":
			return new MackerelSource(config, logger, undefined, tracer);
		case "composite": {
			const slots: CompositeTelemetrySourceSlots = {};
			if (config.logs) {
				slots.logs = createTelemetrySource(
					config.logs,
					logger.child({ slot: "logs" }),
					tracer,
				);
			}
			if (config.traces) {
				slots.traces = createTelemetrySource(
					config.traces,
					logger.child({ slot: "traces" }),
					tracer,
				);
			}
			if (config.metrics) {
				slots.metrics = createTelemetrySource(
					config.metrics,
					logger.child({ slot: "metrics" }),
					tracer,
				);
			}
			return new CompositeTelemetrySource(config, slots, logger);
		}
	}
}
