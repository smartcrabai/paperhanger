/**
 * HTTP client for the parent process's `POST /telemetry/query` callback
 * route (`src/telemetry/followup.ts` / `src/ingest/server.ts` in the parent
 * repo), used by the `query_telemetry` tool (`./tools.ts`) so the fix agent
 * can run follow-up log/trace/metric queries during diagnosis.
 *
 * This client is deliberately thin: it POSTs the request as-is and returns
 * the parsed response, or throws. It does NOT talk to any telemetry backend
 * directly -- agent-host is a separate, Node-only package
 * (docs/architecture.md "Flue agent host (Node sidecar)") that cannot
 * import the parent repo's `src/telemetry/*`, and the whole point of this
 * design is that the parent process itself dispatches to whichever
 * `TelemetrySource` it already constructed, reusing each source's existing
 * escaping/validation rather than reimplementing every backend's client a
 * second time here.
 */

export type QueryTelemetrySignal = "logs" | "traces" | "metrics";

export interface QueryTelemetryInput {
	signal: QueryTelemetrySignal;
	timeRange: { from: string; to: string };
	/** Structured label filter -- the conventional keys documented on the parent repo's `TelemetryQuery` (service aliases, severity, trace_id). */
	filter?: Record<string, string>;
	/** Narrow native-expression escape hatch -- see `./tools.ts`'s tool description for what this means per configured source. */
	expression?: string;
	limit?: number;
}

export interface QueryTelemetryResult {
	logs?: Record<string, unknown>[];
	traces?: Record<string, unknown>[];
	metrics?: Record<string, unknown>[];
	/** True when the result was capped (record count or rendered size) and more data may exist. */
	truncated: boolean;
	notes: string[];
}

export interface TelemetryCallbackConfig {
	/** This paperhanger deployment's own `POST /telemetry/query` URL. */
	url: string;
	/** Dedicated bearer token for that route -- never logged, never placed in a thrown Error message. */
	token: string;
	/** `config.telemetry.source`, used only to build the tool's description (`./tools.ts`). */
	source: string;
}

/**
 * POSTs `input` to the parent's telemetry-query callback and returns the
 * parsed response. Throws on a non-2xx response or a malformed body --
 * propagated unchanged by `./tools.ts`'s tool `run()`, which is exactly how
 * Flue surfaces a backend failure to the model for a retry-or-rephrase
 * decision (see that file's doc comment).
 *
 * The thrown Error's message never includes `config.token`: it's used only
 * as the `Authorization` header value, never interpolated into any string
 * this function builds.
 */
export async function queryTelemetry(
	config: TelemetryCallbackConfig,
	input: QueryTelemetryInput,
	fetchImpl: typeof fetch = fetch,
): Promise<QueryTelemetryResult> {
	const res = await fetchImpl(config.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.token}`,
		},
		body: JSON.stringify(input),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`telemetry follow-up query failed with HTTP status ${res.status}: ${text}`,
		);
	}
	try {
		return JSON.parse(text) as QueryTelemetryResult;
	} catch (err) {
		throw new Error(
			`Failed to parse telemetry follow-up query response as JSON: ${(err as Error).message}`,
		);
	}
}
