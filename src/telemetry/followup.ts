/**
 * Dispatcher behind `POST /telemetry/query` (`src/ingest/server.ts`), the
 * callback route the agent-host sidecar's `query_telemetry` tool calls back
 * into during diagnosis (see docs/spec.md section 3.4 and
 * `agent-host/README.md`'s "query_telemetry" section).
 *
 * This is the parent-side half of the follow-up-query proxy design: the fix
 * agent runs in a separate Node process (`agent-host/`) that cannot import
 * `src/telemetry/*` directly, so it POSTs a structured request here and this
 * module dispatches it to whichever `TelemetrySource` `src/index.ts` already
 * constructed for `config.telemetry` -- reusing every source's existing
 * escaping/validation (`quoteFacetValue`, `logQlLiteral`, identifier
 * validation, structured JSON-RPC params, ...) rather than opening a second,
 * bespoke injection surface per backend.
 *
 * Structured filters (`filter`, mapped onto `TelemetryQuery.labels`) are the
 * main path. `expression` is a narrow escape hatch:
 * - `signal: "metrics"` repurposes it as the backend-specific metric query
 *   (PromQL, a Datadog metrics query string, a Zabbix item key, ...),
 *   generalizing the `promql`/`metric` alert-annotation hint every
 *   `TelemetrySource.queryMetrics` already accepts.
 * - `signal: "logs" | "traces"` only accepts it when the configured source
 *   implements `TelemetrySource.runRawSql` (GreptimeDB alone, today): a
 *   single read-only SQL statement, guarded by
 *   `agent-host/src/lib/sql-guard.ts` imported from here as the single
 *   canonical guard (dependency-free pure TS, already unit-tested by the
 *   root `bun test`) rather than a duplicated copy. `limit` (clamped the
 *   same way as the structured path) is enforced here too -- a `SELECT`
 *   without its own trailing `LIMIT` gets one appended, and an explicit
 *   `LIMIT` larger than the clamped value is replaced, before the SQL ever
 *   reaches `runRawSql` -- so this escape hatch can't run fully unbounded
 *   against the backend (see `applyExpressionLimit` below).
 *
 * Failure semantics (see docs/spec.md section 3.4 and the PR description for
 * the full rationale) are deliberately asymmetric:
 * - **Structurally unsupported** (a missing required hint, or `expression`
 *   against a source without `runRawSql`) resolves normally with an empty
 *   array and an explanatory `notes` entry, mirroring the tone of
 *   `context-builder.ts`'s own collection-time notes -- the model can read
 *   the note and rephrase.
 * - **Invalid `expression`** (rejected by the SQL guard) throws
 *   `FollowUpTelemetryQueryValidationError`, which `server.ts` maps to a 400
 *   -- a caller mistake, not a backend failure.
 * - **Backend failure/timeout/HTTP error** (whatever `TelemetrySource`
 *   itself throws) propagates unchanged; `server.ts` maps it to a 502. This
 *   must never be swallowed into an empty result: telemetry follow-up is
 *   enrichment, and the model needs to see the failure to decide whether to
 *   retry or rephrase (see `agent-host/src/tools.ts`'s tool-error comment).
 */

import { z } from "zod";
import { assertReadOnlySingleStatement } from "../../agent-host/src/lib/sql-guard";
import type { TelemetryQuery, TelemetrySource } from "./types";

/** Caller mistake (invalid `expression`), distinct from a downstream backend failure -- see the module doc comment's failure-semantics note. */
export class FollowUpTelemetryQueryValidationError extends Error {}

export const FollowUpTelemetryQuerySignalSchema = z.enum([
	"logs",
	"traces",
	"metrics",
]);

export const FollowUpTelemetryQueryRequestSchema = z.object({
	signal: FollowUpTelemetryQuerySignalSchema,
	timeRange: z.object({
		from: z.string().min(1),
		to: z.string().min(1),
	}),
	/** Structured label filter, mapped onto `TelemetryQuery.labels` -- see the conventions documented on that type. */
	filter: z.record(z.string(), z.string()).optional(),
	/** Narrow native-expression escape hatch -- see the module doc comment. */
	expression: z.string().min(1).optional(),
	limit: z.number().int().positive().optional(),
});

export type FollowUpTelemetryQuerySignal = z.infer<
	typeof FollowUpTelemetryQuerySignalSchema
>;
export type FollowUpTelemetryQueryRequest = z.infer<
	typeof FollowUpTelemetryQueryRequestSchema
>;

export interface FollowUpTelemetryQueryResponse {
	logs?: Record<string, unknown>[];
	traces?: Record<string, unknown>[];
	metrics?: Record<string, unknown>[];
	/** True when the result was capped (record count or rendered size) and more data may exist. */
	truncated: boolean;
	notes: string[];
}

/** Default `limit` when the caller omits one, matching the other telemetry clients' conventions. */
const DEFAULT_LIMIT = 100;
/** Hard cap on returned records per signal, regardless of what the caller asks for. */
const MAX_RECORDS = 200;
/** Hard cap on the rendered (`JSON.stringify`) size of the returned records; a follow-up query is meant to be narrow, unlike the broader initial `IncidentContext` budget (`context-builder.ts`'s 60,000-char default). */
const MAX_RENDERED_CHARS = 40_000;

function clampLimit(limit: number | undefined): number {
	const requested = limit ?? DEFAULT_LIMIT;
	return Math.min(Math.max(1, Math.trunc(requested)), MAX_RECORDS);
}

/**
 * Caps `records` at `MAX_RECORDS`, then drops trailing records (like
 * `context-builder.ts`'s `applyBudget`) until the rendered size fits
 * `MAX_RENDERED_CHARS`. `truncated` is set whenever either cap actually
 * dropped something.
 */
function clampRecords(records: Record<string, unknown>[]): {
	records: Record<string, unknown>[];
	truncated: boolean;
} {
	let capped = records;
	let truncated = false;
	if (capped.length > MAX_RECORDS) {
		capped = capped.slice(0, MAX_RECORDS);
		truncated = true;
	}
	while (
		capped.length > 0 &&
		JSON.stringify(capped).length > MAX_RENDERED_CHARS
	) {
		capped = capped.slice(0, -1);
		truncated = true;
	}
	return { records: capped, truncated };
}

/** Builds the final response, applying the shared record/size clamp for whichever signal key `records` belongs under. */
function buildResponse(
	signal: FollowUpTelemetryQuerySignal,
	records: Record<string, unknown>[],
	notes: string[],
): FollowUpTelemetryQueryResponse {
	const { records: capped, truncated } = clampRecords(records);
	return {
		[signal]: capped,
		truncated,
		notes,
	} as FollowUpTelemetryQueryResponse;
}

/** `LogRecord[]`/`TraceRecord[]`/`MetricSeries[]` are plain-data interfaces at runtime; this documents the (safe) reinterpretation as generic records for the wire response. */
function toRecords<T extends object>(items: T[]): Record<string, unknown>[] {
	return items as unknown as Record<string, unknown>[];
}

/**
 * Matches a trailing `LIMIT <n>` (optionally followed by `OFFSET <m>`) at
 * the very end of a statement -- i.e. the *outer* statement's own row cap,
 * not one belonging to a nested subquery (which could never be the last
 * token of the whole statement). Used by {@link applyExpressionLimit}.
 */
const TRAILING_LIMIT_RE = /\blimit\s+(\d+)(?:\s+offset\s+\d+)?\s*$/i;

/**
 * Bounds the raw-SQL `expression` escape hatch's row count the same way the
 * structured `queryLogs`/`queryTraces` builders already do (each injects a
 * `LIMIT ${limit}` into the SQL it generates -- see
 * `src/telemetry/greptimedb.ts`), so this path can't run fully unbounded
 * against the backend just because the caller wrote raw SQL instead of
 * using `filter`.
 *
 * Only a bare `SELECT` gets a `LIMIT` appended: `SHOW`/`DESC`/`DESCRIBE`
 * (the other statements `assertReadOnlySingleStatement` allows) return
 * bounded metadata already, and appending `LIMIT` to them is not valid SQL.
 * A `SELECT` that already ends in its own trailing `LIMIT` clause is left
 * untouched as long as it doesn't exceed `limit` -- the caller's explicit
 * (smaller) bound is honored rather than overridden. An explicit `LIMIT`
 * larger than `limit` is replaced (dropping any trailing `OFFSET` along
 * with it) so this can only ever narrow, never widen, the effective cap.
 */
function applyExpressionLimit(expression: string, limit: number): string {
	const trimmed = expression.trim();
	const withoutSemicolon = trimmed.endsWith(";")
		? trimmed.slice(0, -1).trimEnd()
		: trimmed;
	const firstWord = (withoutSemicolon.split(/\s+/)[0] ?? "").toLowerCase();
	if (firstWord !== "select") {
		return withoutSemicolon;
	}
	const match = withoutSemicolon.match(TRAILING_LIMIT_RE);
	if (!match) {
		return `${withoutSemicolon} LIMIT ${limit}`;
	}
	const [, limitText] = match;
	const existingLimit = Number.parseInt(limitText ?? "", 10);
	if (Number.isFinite(existingLimit) && existingLimit <= limit) {
		return withoutSemicolon;
	}
	return `${withoutSemicolon.slice(0, match.index)}LIMIT ${limit}`;
}

/**
 * Dispatches a validated follow-up query to `source`. See the module doc
 * comment for the full structured-filter-vs-expression and failure-semantics
 * design.
 */
export async function runFollowUpTelemetryQuery(
	source: TelemetrySource,
	request: FollowUpTelemetryQueryRequest,
): Promise<FollowUpTelemetryQueryResponse> {
	const notes: string[] = [];
	const limit = clampLimit(request.limit);
	const query: TelemetryQuery = {
		timeRange: request.timeRange,
		labels: request.filter ?? {},
		limit,
	};

	if (request.signal === "metrics") {
		if (!request.expression) {
			notes.push(
				"Metrics require an `expression` (the backend-specific metric query -- e.g. a PromQL expression, a Datadog metrics query string, or a Zabbix/Mackerel item/metric name); none was provided, so no metrics query was run. Retry with `expression` set.",
			);
			return buildResponse("metrics", [], notes);
		}
		const series = await source.queryMetrics({
			...query,
			promql: request.expression,
		});
		return buildResponse("metrics", toRecords(series), notes);
	}

	if (request.expression !== undefined) {
		if (typeof source.runRawSql !== "function") {
			notes.push(
				`The \`expression\` escape hatch for ${request.signal} follow-up queries is only available when the configured telemetry source is GreptimeDB; this deployment's source is "${source.name}". Retry using \`filter\` instead.`,
			);
			return buildResponse(request.signal, [], notes);
		}
		try {
			assertReadOnlySingleStatement(request.expression);
		} catch (err) {
			throw new FollowUpTelemetryQueryValidationError(
				err instanceof Error ? err.message : String(err),
			);
		}
		const rows = await source.runRawSql(
			applyExpressionLimit(request.expression, limit),
		);
		return buildResponse(request.signal, rows, notes);
	}

	if (request.signal === "logs") {
		const logs = await source.queryLogs(query);
		return buildResponse("logs", toRecords(logs), notes);
	}

	const traces = await source.queryTraces(query);
	return buildResponse("traces", toRecords(traces), notes);
}
