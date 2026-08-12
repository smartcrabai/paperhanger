/**
 * Flue tool definitions for the fix agent. Currently just `query_telemetry`,
 * the follow-up telemetry query tool described in docs/spec.md section 3.4
 * ("further Tool ... additional queries during diagnosis").
 *
 * Unlike the tool's original GreptimeDB-only design, this version works
 * against whatever telemetry backend the parent paperhanger deployment has
 * configured (`config.telemetry.source` in the parent repo): the parent
 * process itself proxies every follow-up query over its own
 * `POST /telemetry/query` route, dispatching to the already-constructed
 * `TelemetrySource` (`src/telemetry/followup.ts` in the parent repo) --
 * agent-host never talks to a telemetry backend directly, and (crucially)
 * never receives that backend's URL/database/auth at all. This removes
 * agent-host's ONLY previous need to hold telemetry backend credentials.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { describeTelemetrySource } from "./lib/telemetry-descriptions.ts";
import {
	queryTelemetry,
	type TelemetryCallbackConfig,
} from "./telemetry-client.ts";

const QueryTelemetryInputSchema = v.object({
	signal: v.picklist(["logs", "traces", "metrics"]),
	timeRange: v.object({
		from: v.string(),
		to: v.string(),
	}),
	filter: v.optional(v.record(v.string(), v.string())),
	expression: v.optional(v.string()),
	limit: v.optional(v.number()),
});

const QueryTelemetryOutputSchema = v.object({
	logs: v.optional(v.array(v.record(v.string(), v.unknown()))),
	traces: v.optional(v.array(v.record(v.string(), v.unknown()))),
	metrics: v.optional(v.array(v.record(v.string(), v.unknown()))),
	truncated: v.boolean(),
	notes: v.array(v.string()),
});

/**
 * Reads the telemetry callback config the sidecar passes through as three
 * separate env vars when it spawns this process (see `buildSpawnEnv` in the
 * parent repo's `src/agent/sidecar.ts`): the parent's own callback URL, a
 * dedicated bearer token for it (never the same grant as the parent's
 * dashboard/incident-CRUD `server.apiToken`), and the configured source name
 * (used only to build this tool's description below). Tool registration in
 * `./fix-agent.ts` is skipped entirely when any of the three is absent --
 * mirroring the old single-env-var design's "no telemetry configured -> no
 * tool" behavior, now also covering external agent-host mode with no
 * `agent.telemetryCallbackToken` configured (see that config field's doc
 * comment in the parent repo's `src/config/schema.ts`).
 */
function telemetryCallbackConfigFromEnv(): TelemetryCallbackConfig | undefined {
	const url = process.env.PAPERHANGER_TELEMETRY_CALLBACK_URL;
	const token = process.env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN;
	const source = process.env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE;
	if (!url || !token || !source) {
		return undefined;
	}
	return { url, token, source };
}

/**
 * Returns `[query_telemetry]`, or `[]` when no telemetry callback is
 * configured for this deployment. Unlike the previous design, there is no
 * `switch` on backend kind here at all -- every source speaks the same
 * request/response shape through the parent's callback route, so the only
 * per-source variation left on this side is the tool's own `description`
 * (`describeTelemetrySource`, `./lib/telemetry-descriptions.ts`), which
 * degrades safely for a source name it doesn't specifically recognize.
 */
export function createTelemetryTools() {
	const config = telemetryCallbackConfigFromEnv();
	if (!config) {
		return [];
	}

	return [
		defineTool({
			name: "query_telemetry",
			description: describeTelemetrySource(config.source),
			input: QueryTelemetryInputSchema,
			output: QueryTelemetryOutputSchema,
			async run({ data }) {
				// Propagates unchanged on a backend failure/timeout/HTTP error --
				// this is a tool error, which Flue surfaces to the model for a
				// retry-or-rephrase decision. Telemetry follow-up is enrichment,
				// not a hard requirement, so this must never fail the whole agent
				// run (see `../fix-agent.ts`'s and this file's own callers).
				return { output: await queryTelemetry(config, data) };
			},
		}),
	];
}
