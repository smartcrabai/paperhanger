/**
 * Dispatches `config.telemetry` (the discriminated union in
 * `src/config/schema.ts`) to a concrete `TelemetrySource` implementation.
 *
 * This is the single place in the main Bun process that maps a telemetry
 * backend kind to its constructor. Adding a future backend (Loki, Tempo,
 * ...) means adding one more `TelemetrySchema` union member (schema.ts) and
 * one more `case` here -- `src/index.ts` itself never needs to change. The
 * agent-host sidecar has its own equivalent dispatch point; see the doc
 * comment on `createTelemetryTools()` in `agent-host/src/tools.ts`.
 */

import type { Tracer } from "@opentelemetry/api";
import type { TelemetryConfig } from "../config/schema";
import { GreptimeDbSource } from "./greptimedb";
import type { Logger } from "../observability/logger";
import type { TelemetrySource } from "./types";

export function createTelemetrySource(
	config: TelemetryConfig,
	logger: Logger,
	tracer?: Tracer,
): TelemetrySource {
	switch (config.source) {
		case "greptimedb":
			return new GreptimeDbSource(config, logger, undefined, tracer);
	}
}
