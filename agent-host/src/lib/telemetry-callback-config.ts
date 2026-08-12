/**
 * Reads the telemetry callback config the sidecar passes through as three
 * separate env vars when it spawns this process (see `buildSpawnEnv` in the
 * parent repo's `src/agent/sidecar.ts`): the parent's own callback URL, a
 * dedicated bearer token for it (never the same grant as the parent's
 * dashboard/incident-CRUD `server.apiToken`), and the configured source name
 * (used only to build the tool's description -- see
 * `./telemetry-descriptions.ts`).
 *
 * Lives in `lib/` because it is a security gate, not just plumbing: returning
 * `undefined` is what stops `../tools.ts` from registering `query_telemetry`
 * at all, so a deployment with no callback token can never expose a live
 * telemetry tool to the model. Every other security-relevant deterministic
 * decision in this package (`./sql-guard.ts`, `./redaction.ts`,
 * `./output-sanitizer.ts`, `./tamper-check.ts`) sits in this same
 * dependency-free tier so the main repo's `bun test` can cover it without
 * agent-host's Node-only install -- see agent-host/README.md.
 */

import type { TelemetryCallbackConfig } from "./telemetry-client.ts";

/** Env var names carrying the callback config, in the order `buildSpawnEnv` sets them. */
export const TELEMETRY_CALLBACK_ENV_KEYS = [
	"PAPERHANGER_TELEMETRY_CALLBACK_URL",
	"PAPERHANGER_TELEMETRY_CALLBACK_TOKEN",
	"PAPERHANGER_TELEMETRY_CALLBACK_SOURCE",
] as const;

/**
 * Returns the callback config, or `undefined` when ANY of the three env vars
 * is missing or empty -- partial configuration is treated as no configuration
 * rather than as a half-usable callback. This is the "no telemetry configured
 * -> no tool" behavior, which now also covers external agent-host mode with
 * no `agent.telemetryCallbackToken` set (see that config field's doc comment
 * in the parent repo's `src/config/schema.ts`).
 *
 * @param env Defaults to `process.env`; injectable so tests need not mutate
 * global process state.
 */
export function telemetryCallbackConfigFromEnv(
	env: Record<string, string | undefined> = process.env,
): TelemetryCallbackConfig | undefined {
	const url = env.PAPERHANGER_TELEMETRY_CALLBACK_URL;
	const token = env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN;
	const source = env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE;
	if (!url || !token || !source) {
		return undefined;
	}
	return { url, token, source };
}
