/**
 * Minimal, read-only HTTP client for GreptimeDB, used by the `query_telemetry`
 * tool (src/tools.ts) so the fix agent can run follow-up queries during
 * diagnosis. This is intentionally a small hand-rolled client rather than a
 * reuse of the parent repo's `src/telemetry/greptimedb.ts` — agent-host is a
 * separate, Node-only package (docs/architecture.md "Flue agent host (Node
 * sidecar)") and cannot import from the parent repo's `src/`.
 */

import { assertReadOnlySingleStatement } from "./lib/sql-guard.ts";

/**
 * `source`-discriminated telemetry backend config, mirroring
 * `../contract.ts`'s `TelemetryConfigSchema`. `greptimedb` is the only
 * member today; a future source is added here as another union member (see
 * the dispatch note on `createTelemetryTools()` in `./tools.ts`).
 */
export interface GreptimeDbTelemetryConfig {
	source: "greptimedb";
	url: string;
	database: string;
	auth?: string;
}

export type TelemetryConfig = GreptimeDbTelemetryConfig;

export type QueryTelemetryKind = "sql" | "promql";

export interface QueryTelemetryInput {
	kind: QueryTelemetryKind;
	query: string;
	/** PromQL only: range-query start (unix seconds or RFC3339). Omit for an instant query. */
	start?: string;
	/** PromQL only: range-query end. */
	end?: string;
	/** PromQL only: range-query step, e.g. "60s". Defaults to "60s" when `start`/`end` are set. */
	step?: string;
}

export interface QueryTelemetrySeries {
	metric: Record<string, string>;
	values: [number, string][];
}

export interface QueryTelemetryResult {
	kind: QueryTelemetryKind;
	rows?: Record<string, unknown>[];
	series?: QueryTelemetrySeries[];
	/** True when the result was capped at `MAX_RESULT_ITEMS` and more data existed. */
	truncated: boolean;
}

const MAX_RESULT_ITEMS = 200;

interface GreptimeColumnSchema {
	name: string;
	data_type: string;
}
interface GreptimeRecords {
	schema: { column_schemas: GreptimeColumnSchema[] };
	rows: unknown[][];
}
interface GreptimeOutputEntry {
	records?: GreptimeRecords;
}
interface GreptimeSqlResponse {
	output?: GreptimeOutputEntry[];
	error?: string;
	code?: number;
}

function parseSqlRows(payload: GreptimeSqlResponse): Record<string, unknown>[] {
	const entry = payload.output?.[0];
	if (!entry?.records) {
		return [];
	}
	const columns = entry.records.schema.column_schemas.map((c) => c.name);
	return entry.records.rows.map((row) => {
		const obj: Record<string, unknown> = {};
		columns.forEach((name, i) => {
			obj[name] = row[i];
		});
		return obj;
	});
}

interface PromSample {
	metric?: Record<string, string>;
	value?: [number, string];
	values?: [number, string][];
}
interface PromResponse {
	status: string;
	data?: { result: PromSample[] };
	error?: string;
}

function authHeaderFor(auth: string | undefined): string | undefined {
	return auth
		? `Basic ${Buffer.from(auth, "utf-8").toString("base64")}`
		: undefined;
}

async function runSqlQuery(
	config: TelemetryConfig,
	query: string,
	fetchImpl: typeof fetch,
): Promise<QueryTelemetryResult> {
	assertReadOnlySingleStatement(query);
	const baseUrl = config.url.replace(/\/+$/, "");
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
	};
	const auth = authHeaderFor(config.auth);
	if (auth) {
		headers.Authorization = auth;
	}

	const res = await fetchImpl(
		`${baseUrl}/v1/sql?db=${encodeURIComponent(config.database)}`,
		{
			method: "POST",
			headers,
			body: new URLSearchParams({ sql: query }).toString(),
		},
	);
	const text = await res.text();
	const json = JSON.parse(text) as GreptimeSqlResponse;
	if (!res.ok) {
		throw new Error(
			json.error ??
				`GreptimeDB SQL query failed with HTTP status ${res.status}`,
		);
	}

	const allRows = parseSqlRows(json);
	const truncated = allRows.length > MAX_RESULT_ITEMS;
	return { kind: "sql", rows: allRows.slice(0, MAX_RESULT_ITEMS), truncated };
}

async function runPromqlQuery(
	config: TelemetryConfig,
	input: QueryTelemetryInput,
	fetchImpl: typeof fetch,
): Promise<QueryTelemetryResult> {
	const baseUrl = config.url.replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	const auth = authHeaderFor(config.auth);
	if (auth) {
		headers.Authorization = auth;
	}

	let path = "/v1/prometheus/api/v1/query";
	const params = new URLSearchParams({
		query: input.query,
		db: config.database,
	});
	if (input.start && input.end) {
		path = "/v1/prometheus/api/v1/query_range";
		params.set("start", input.start);
		params.set("end", input.end);
		params.set("step", input.step ?? "60s");
	}

	const res = await fetchImpl(`${baseUrl}${path}?${params.toString()}`, {
		method: "GET",
		headers,
	});
	const text = await res.text();
	const json = JSON.parse(text) as PromResponse;
	if (!res.ok || json.status !== "success") {
		throw new Error(
			json.error ?? `PromQL query failed with HTTP status ${res.status}`,
		);
	}

	const allSeries: QueryTelemetrySeries[] = (json.data?.result ?? []).map(
		(sample) => ({
			metric: sample.metric ?? {},
			values: sample.values ?? (sample.value ? [sample.value] : []),
		}),
	);
	const truncated = allSeries.length > MAX_RESULT_ITEMS;
	return {
		kind: "promql",
		series: allSeries.slice(0, MAX_RESULT_ITEMS),
		truncated,
	};
}

export async function queryTelemetry(
	config: TelemetryConfig,
	input: QueryTelemetryInput,
	fetchImpl: typeof fetch = fetch,
): Promise<QueryTelemetryResult> {
	return input.kind === "sql"
		? runSqlQuery(config, input.query, fetchImpl)
		: runPromqlQuery(config, input, fetchImpl);
}
