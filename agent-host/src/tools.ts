/**
 * Flue tool definitions for the fix agent. Currently just `query_telemetry`,
 * the follow-up telemetry query tool described in docs/spec.md section 3.4
 * ("further Tool ... additional queries during diagnosis").
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { queryTelemetry, type TelemetryConfig } from "./telemetry-client.ts";

const QueryTelemetryInputSchema = v.object({
	kind: v.picklist(["sql", "promql"]),
	query: v.string(),
	start: v.optional(v.string()),
	end: v.optional(v.string()),
	step: v.optional(v.string()),
});

const QueryTelemetryOutputSchema = v.object({
	kind: v.picklist(["sql", "promql"]),
	rows: v.optional(v.array(v.record(v.string(), v.unknown()))),
	series: v.optional(
		v.array(
			v.object({
				metric: v.record(v.string(), v.string()),
				values: v.array(v.tuple([v.number(), v.string()])),
			}),
		),
	),
	truncated: v.boolean(),
});

/**
 * Reads the telemetry backend config the sidecar passes through as a single
 * serialized JSON env var when it spawns this process (see `buildSpawnEnv`
 * in the parent repo's `src/agent/sidecar.ts`). Tool registration in
 * `../src/fix-agent.ts` is skipped entirely when this returns `undefined`.
 *
 * Note: the per-invocation workflow input also carries an optional
 * `telemetry` field (see `contract.ts`) mirroring this same shape. The env
 * var is used here instead of that per-invocation value because Flue's
 * `defineAgent()` initializer (where `tools` is assigned) only receives
 * `{ id, env }` — it has no access to the workflow's `input`, so a tool list
 * cannot be conditioned on a specific invocation's payload. Since the sidecar
 * always spawns one agent-host process per paperhanger deployment with a
 * fixed telemetry backend, env-var presence is an equivalent, always-correct
 * signal for "is telemetry configured for this deployment".
 */
function telemetryConfigFromEnv(): TelemetryConfig | undefined {
	const raw = process.env.PAPERHANGER_TELEMETRY;
	if (!raw) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as TelemetryConfig;
	} catch {
		// Malformed env var should never happen (the sidecar always emits
		// valid JSON, see `buildSpawnEnv`); fail safe by disabling telemetry
		// tools rather than crashing the whole agent-host process over a tool
		// that's an enrichment, not a hard requirement, for diagnosis.
		return undefined;
	}
}

/**
 * Returns `[query_telemetry]`, or `[]` when no telemetry backend is
 * configured. The `switch` below is the only place agent-host dispatches on
 * telemetry backend kind: a future source (e.g. Loki, Tempo) registers its
 * own query kinds by adding a `case` here, mirroring
 * `src/telemetry/factory.ts` in the parent repo.
 */
export function createTelemetryTools() {
	const config = telemetryConfigFromEnv();
	if (!config) {
		return [];
	}

	switch (config.source) {
		case "greptimedb":
			return [
				defineTool({
					name: "query_telemetry",
					description:
						'Run a read-only follow-up query against the telemetry backend (GreptimeDB). For kind "sql", ' +
						"only a single SELECT/SHOW/DESC statement is allowed (no writes, no multiple statements). " +
						'For kind "promql", provide a PromQL expression; pass start/end (unix seconds) and step ' +
						"for a range query, or omit them for an instant query. Use this to confirm or refute a " +
						"root-cause hypothesis with additional evidence beyond what was already collected.",
					input: QueryTelemetryInputSchema,
					output: QueryTelemetryOutputSchema,
					async run({ input }) {
						return queryTelemetry(config, input);
					},
				}),
			];
		default:
			// Defensive only: `config.source` is typed as the literal
			// "greptimedb" today, so this is unreachable through normal
			// TypeScript-checked code paths. It's still reachable at runtime
			// because `config` comes from `JSON.parse()`-ing an env var (a
			// process boundary, not a type-checked in-memory value) -- fail
			// safe with no tools rather than crashing the agent-host process.
			return [];
	}
}
