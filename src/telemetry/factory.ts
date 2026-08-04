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
 */

import type { Tracer } from "@opentelemetry/api";
import type { TelemetryConfig } from "../config/schema";
import { ClickStackSource } from "./clickstack";
import { GreptimeDbSource } from "./greptimedb";
import { LokiSource } from "./loki";
import type { Logger } from "../observability/logger";
import { OpenObserveSource } from "./openobserve";
import { PrometheusSource } from "./prometheus";
import { SigNozSource } from "./signoz";
import { TempoSource } from "./tempo";
import type { TelemetrySource } from "./types";

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
	}
}
