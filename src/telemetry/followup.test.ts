import { describe, expect, test } from "bun:test";
import {
	FollowUpTelemetryQueryValidationError,
	runFollowUpTelemetryQuery,
} from "./followup";
import type { TelemetrySource } from "./types";

const TIME_RANGE = { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:05:00Z" };

interface FakeSourceOptions {
	name?: string;
	logs?: unknown[];
	traces?: unknown[];
	metrics?: unknown[];
	runRawSql?(sql: string): Promise<Record<string, unknown>[]>;
	queryLogsImpl?: TelemetrySource["queryLogs"];
	queryTracesImpl?: TelemetrySource["queryTraces"];
	queryMetricsImpl?: TelemetrySource["queryMetrics"];
}

/** Records every call made to it, for assertions on what the dispatcher actually invoked. */
function fakeSource(options: FakeSourceOptions = {}): TelemetrySource & {
	calls: { method: string; args: unknown }[];
} {
	const calls: { method: string; args: unknown }[] = [];
	const source: TelemetrySource & { calls: typeof calls } = {
		name: options.name ?? "fake",
		calls,
		queryLogs:
			options.queryLogsImpl ??
			(async (query) => {
				calls.push({ method: "queryLogs", args: query });
				return (options.logs ?? []) as never;
			}),
		queryTraces:
			options.queryTracesImpl ??
			(async (query) => {
				calls.push({ method: "queryTraces", args: query });
				return (options.traces ?? []) as never;
			}),
		queryMetrics:
			options.queryMetricsImpl ??
			(async (query) => {
				calls.push({ method: "queryMetrics", args: query });
				return (options.metrics ?? []) as never;
			}),
	};
	if (options.runRawSql) {
		source.runRawSql = async (sql) => {
			calls.push({ method: "runRawSql", args: sql });
			return options.runRawSql?.(sql) as never;
		};
	}
	return source;
}

describe("runFollowUpTelemetryQuery - structured filter dispatch", () => {
	test("dispatches signal: logs to queryLogs with the filter mapped onto labels", async () => {
		const source = fakeSource({ logs: [{ body: "boom" }] });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			filter: { service: "checkout" },
		});
		expect(result).toEqual({
			logs: [{ body: "boom" }],
			truncated: false,
			notes: [],
		});
		expect(source.calls).toEqual([
			{
				method: "queryLogs",
				args: {
					timeRange: TIME_RANGE,
					labels: { service: "checkout" },
					limit: 100,
				},
			},
		]);
	});

	test("dispatches signal: traces to queryTraces", async () => {
		const source = fakeSource({ traces: [{ traceId: "abc" }] });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "traces",
			timeRange: TIME_RANGE,
		});
		expect(result.traces).toEqual([{ traceId: "abc" }]);
		expect(source.calls[0]?.method).toBe("queryTraces");
	});

	test("dispatches signal: metrics with `expression` forwarded as `promql`", async () => {
		const source = fakeSource({ metrics: [{ name: "cpu" }] });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "metrics",
			timeRange: TIME_RANGE,
			expression: "rate(http_requests_total[5m])",
		});
		expect(result.metrics).toEqual([{ name: "cpu" }]);
		expect(source.calls[0]?.args).toMatchObject({
			promql: "rate(http_requests_total[5m])",
		});
	});
});

describe("runFollowUpTelemetryQuery - clamping", () => {
	test("clamps a requested limit above 200 down to 200", async () => {
		const source = fakeSource();
		await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			limit: 10_000,
		});
		expect(source.calls[0]?.args).toMatchObject({ limit: 200 });
	});

	test("caps returned records at 200 and sets truncated: true", async () => {
		const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
		const source = fakeSource({ logs: rows });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
		});
		expect(result.logs).toHaveLength(200);
		expect(result.truncated).toBe(true);
	});

	test("drops trailing records to stay within the rendered-size budget", async () => {
		const bigBody = "x".repeat(1000);
		const rows = Array.from({ length: 100 }, (_, i) => ({ i, body: bigBody }));
		const source = fakeSource({ logs: rows });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
		});
		expect(result.logs?.length).toBeLessThan(100);
		expect(result.truncated).toBe(true);
		expect(JSON.stringify(result.logs).length).toBeLessThanOrEqual(40_000);
	});

	test("does not truncate a small result", async () => {
		const source = fakeSource({ logs: [{ body: "small" }] });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
		});
		expect(result.truncated).toBe(false);
	});
});

describe("runFollowUpTelemetryQuery - the `expression` escape hatch (GreptimeDB-only, sql-guard applied)", () => {
	test("runs a valid single-statement SELECT through runRawSql and returns its rows under the requested signal", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [{ body: "raw row" }],
		});
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM opentelemetry_logs LIMIT 1",
		});
		expect(result).toEqual({
			logs: [{ body: "raw row" }],
			truncated: false,
			notes: [],
		});
	});

	test("rejects a multi-statement expression with a validation error, without calling runRawSql", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [{ body: "should not run" }],
		});
		await expect(
			runFollowUpTelemetryQuery(source, {
				signal: "logs",
				timeRange: TIME_RANGE,
				expression: "SELECT 1; DROP TABLE opentelemetry_logs;",
			}),
		).rejects.toBeInstanceOf(FollowUpTelemetryQueryValidationError);
		expect(source.calls).toEqual([]);
	});

	// Regression: `assertReadOnlySingleStatement` only rejects a comment that PRECEDES
	// the verb, so a trailing comment used to reach `applyExpressionLimit` and defeat it
	// in both directions -- a sub-cap value inside the comment made the expression look
	// "already bounded", and an over-cap value made the injected `LIMIT` land inside the
	// comment. Either way the statement reached the backend with no row cap at all.
	test.each([
		[
			"a sub-cap limit inside a trailing line comment",
			"SELECT * FROM opentelemetry_logs -- limit 5",
		],
		[
			"an over-cap limit inside a trailing line comment",
			"SELECT * FROM opentelemetry_logs -- limit 9999",
		],
		[
			"a trailing block comment",
			"SELECT * FROM opentelemetry_logs /* limit 5 */",
		],
		[
			"a comment in the middle of the statement",
			"SELECT * -- all\nFROM opentelemetry_logs",
		],
	])(
		"rejects %s with a validation error, without calling runRawSql",
		async (_name, expression) => {
			const source = fakeSource({
				name: "greptimedb",
				runRawSql: async () => [{ body: "should not run" }],
			});
			await expect(
				runFollowUpTelemetryQuery(source, {
					signal: "logs",
					timeRange: TIME_RANGE,
					expression,
				}),
			).rejects.toBeInstanceOf(FollowUpTelemetryQueryValidationError);
			expect(source.calls).toEqual([]);
		},
	);

	test("rejects a write statement with a validation error", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [{ body: "should not run" }],
		});
		await expect(
			runFollowUpTelemetryQuery(source, {
				signal: "traces",
				timeRange: TIME_RANGE,
				expression: "DELETE FROM opentelemetry_traces",
			}),
		).rejects.toBeInstanceOf(FollowUpTelemetryQueryValidationError);
	});

	test("appends the default LIMIT to a SELECT with no LIMIT clause of its own", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [],
		});
		await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM opentelemetry_logs",
		});
		expect(source.calls).toEqual([
			{
				method: "runRawSql",
				args: "SELECT * FROM opentelemetry_logs LIMIT 100",
			},
		]);
	});

	test("appends the caller's requested (clamped) LIMIT, not just the default", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [],
		});
		await runFollowUpTelemetryQuery(source, {
			signal: "traces",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM opentelemetry_traces",
			limit: 10_000,
		});
		expect(source.calls[0]?.args).toBe(
			"SELECT * FROM opentelemetry_traces LIMIT 200",
		);
	});

	test("replaces an explicit LIMIT that exceeds the clamped cap, rather than leaving it unbounded", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [],
		});
		await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM opentelemetry_logs LIMIT 999999",
		});
		expect(source.calls[0]?.args).toBe(
			"SELECT * FROM opentelemetry_logs LIMIT 100",
		);
	});

	test("leaves an explicit LIMIT already within the cap untouched", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [],
		});
		await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM opentelemetry_logs LIMIT 5",
		});
		expect(source.calls[0]?.args).toBe(
			"SELECT * FROM opentelemetry_logs LIMIT 5",
		);
	});

	test("does not append a LIMIT to a non-SELECT statement (e.g. SHOW TABLES)", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [],
		});
		await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SHOW TABLES",
		});
		expect(source.calls[0]?.args).toBe("SHOW TABLES");
	});

	test("strips a trailing semicolon before deciding whether to append LIMIT", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => [],
		});
		await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM opentelemetry_logs;",
		});
		expect(source.calls[0]?.args).toBe(
			"SELECT * FROM opentelemetry_logs LIMIT 100",
		);
	});
});

describe("runFollowUpTelemetryQuery - structurally unsupported (resolves normally with notes)", () => {
	test("signal: metrics without `expression` resolves with an empty array and an explanatory note, without calling queryMetrics", async () => {
		const source = fakeSource();
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "metrics",
			timeRange: TIME_RANGE,
		});
		expect(result.metrics).toEqual([]);
		expect(result.truncated).toBe(false);
		expect(result.notes).toHaveLength(1);
		expect(result.notes[0]).toContain("expression");
		expect(source.calls).toEqual([]);
	});

	test("`expression` for signal: logs against a source without runRawSql resolves with an empty array and a note naming the source", async () => {
		const source = fakeSource({ name: "loki" });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "logs",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM anything",
		});
		expect(result.logs).toEqual([]);
		expect(result.notes[0]).toContain("loki");
		expect(source.calls).toEqual([]);
	});

	test("`expression` for signal: traces against a source without runRawSql resolves with an empty array and a note", async () => {
		const source = fakeSource({ name: "tempo" });
		const result = await runFollowUpTelemetryQuery(source, {
			signal: "traces",
			timeRange: TIME_RANGE,
			expression: "SELECT * FROM anything",
		});
		expect(result.traces).toEqual([]);
		expect(result.notes.length).toBeGreaterThan(0);
	});
});

describe("runFollowUpTelemetryQuery - backend failure (thrown, never swallowed)", () => {
	test("propagates a queryLogs rejection unchanged", async () => {
		const source = fakeSource({
			queryLogsImpl: async () => {
				throw new Error("upstream timed out after 30000ms");
			},
		});
		await expect(
			runFollowUpTelemetryQuery(source, {
				signal: "logs",
				timeRange: TIME_RANGE,
			}),
		).rejects.toThrow("upstream timed out after 30000ms");
	});

	test("propagates a runRawSql rejection unchanged", async () => {
		const source = fakeSource({
			name: "greptimedb",
			runRawSql: async () => {
				throw new Error("HTTP 502 from GreptimeDB");
			},
		});
		await expect(
			runFollowUpTelemetryQuery(source, {
				signal: "logs",
				timeRange: TIME_RANGE,
				expression: "SELECT 1",
			}),
		).rejects.toThrow("HTTP 502 from GreptimeDB");
	});

	test("propagates a queryMetrics rejection unchanged", async () => {
		const source = fakeSource({
			queryMetricsImpl: async () => {
				throw new Error("metrics backend unreachable");
			},
		});
		await expect(
			runFollowUpTelemetryQuery(source, {
				signal: "metrics",
				timeRange: TIME_RANGE,
				expression: "up",
			}),
		).rejects.toThrow("metrics backend unreachable");
	});
});
