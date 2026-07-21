import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import {
	DEFAULT_LOGS_TABLE,
	DEFAULT_TRACES_TABLE,
	GreptimeDbError,
	GreptimeDbSource,
} from "./greptimedb";

// Registered once at module scope so context propagates across `await`s for
// every test in this file (design doc section 10). A second registration in
// the same bun process would return `false` and keep this one -- harmless,
// since it's the same manager class; no other file in `bun test src/telemetry`
// registers a context manager.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

/** Hermetic span-recording tracer for assertions (see design doc section 10). */
function setupTracing() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	return { tracer: provider.getTracer("test"), exporter };
}

function silentLogger() {
	return createLogger({ sink: () => {} });
}

/** A logger whose sink captures each emitted JSON line for correlation assertions. */
function capturingLogger() {
	const lines: string[] = [];
	const logger = createLogger({ sink: (line) => lines.push(line) });
	return { logger, lines };
}

interface RecordedRequest {
	url: string;
	method: string;
	body?: string;
	headers: Record<string, string>;
}

/** A stub `fetch` that records requests and replays a canned response. */
function stubFetch(responder: (req: RecordedRequest) => Response) {
	const calls: RecordedRequest[] = [];
	const fetchImpl = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const headers: Record<string, string> = {};
		if (init?.headers) {
			for (const [k, v] of Object.entries(
				init.headers as Record<string, string>,
			)) {
				headers[k] = v;
			}
		}
		const req: RecordedRequest = {
			url,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? init.body : undefined,
			headers,
		};
		calls.push(req);
		return responder(req);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function sqlSuccessResponse(
	columns: { name: string; data_type: string }[],
	rows: unknown[][],
): Response {
	return new Response(
		JSON.stringify({
			output: [{ records: { schema: { column_schemas: columns }, rows } }],
			execution_time_ms: 1,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("GreptimeDbSource - SQL building and escaping", () => {
	test("queryLogs escapes single quotes in a malicious label value", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			sqlSuccessResponse(
				[
					{ name: "timestamp", data_type: "TimestampNanosecond" },
					{ name: "severity_text", data_type: "String" },
					{ name: "severity_number", data_type: "Int32" },
					{ name: "body", data_type: "String" },
					{ name: "trace_id", data_type: "String" },
					{ name: "span_id", data_type: "String" },
					{ name: "log_attributes", data_type: "Json" },
					{ name: "resource_attributes", data_type: "Json" },
				],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "evil'; DROP TABLE opentelemetry_logs; --" },
		});

		expect(calls.length).toBe(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe("http://greptime.test/v1/sql?db=public");
		const body = call?.body ?? "";
		const decoded = decodeURIComponent(
			body.replace(/^sql=/, "").replace(/\+/g, " "),
		);
		// The single quote must be doubled (SQL-escaped), never passed through raw.
		expect(decoded).toContain("evil''; DROP TABLE opentelemetry_logs; --");
		// And the literal must still be closed correctly (no unescaped quote breaks out).
		expect(decoded).toContain("json_get_string(resource_attributes");
		expect(decoded).toContain('$."service.name"');
	});

	test("queryLogs applies the ERROR severity threshold via the 'severity' convention", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout", severity: "error" },
		});

		const decoded = decodeURIComponent(
			(calls[0]?.body ?? "").replace(/^sql=/, "").replace(/\+/g, " "),
		);
		expect(decoded).toContain("severity_number >= 17");
	});

	test("queryLogs rejects an invalid (non-whitelisted) attribute key", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: { 'bad"key`; --': "x" },
			}),
		).rejects.toThrow(/Invalid attribute\/label key/);
	});

	test("rejects an invalid logsTable/tracesTable identifier at construction", () => {
		expect(
			() =>
				new GreptimeDbSource(
					{
						url: "http://greptime.test",
						database: "public",
						logsTable: "logs; DROP TABLE x",
					},
					silentLogger(),
				),
		).toThrow(/Invalid SQL identifier/);
	});

	test("uses configurable table names in the generated SQL", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{
				url: "http://greptime.test",
				database: "public",
				logsTable: "custom_logs",
				tracesTable: "custom_traces",
			},
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		const logsSql = decodeURIComponent(
			(calls[0]?.body ?? "").replace(/^sql=/, "").replace(/\+/g, " "),
		);
		const tracesSql = decodeURIComponent(
			(calls[1]?.body ?? "").replace(/^sql=/, "").replace(/\+/g, " "),
		);
		expect(logsSql).toContain("FROM custom_logs");
		expect(tracesSql).toContain("FROM custom_traces");
	});

	test("defaults to the documented OTLP table names", () => {
		expect(DEFAULT_LOGS_TABLE).toBe("opentelemetry_logs");
		expect(DEFAULT_TRACES_TABLE).toBe("opentelemetry_traces");
	});

	test("queryTraces builds an IN (...) clause with escaped trace ids and no time filter", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { trace_id: "abc123,def456" },
		});

		const sql = decodeURIComponent(
			(calls[0]?.body ?? "").replace(/^sql=/, "").replace(/\+/g, " "),
		);
		expect(sql).toContain("trace_id IN ('abc123', 'def456')");
		expect(sql).not.toContain("timestamp >=");
	});

	test("queryTraces rejects a malformed trace id", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryTraces({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: { trace_id: "not-hex!'; DROP TABLE x; --" },
			}),
		).rejects.toThrow(/Invalid trace id/);
	});

	test("queryTraces without a trace_id filters by service and orders error-first-then-slowest", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
			limit: 10,
		});

		const sql = decodeURIComponent(
			(calls[0]?.body ?? "").replace(/^sql=/, "").replace(/\+/g, " "),
		);
		expect(sql).toContain("service_name = 'checkout'");
		expect(sql).toContain("STATUS_CODE_ERROR");
		expect(sql).toContain(
			"ORDER BY CASE WHEN span_status_code = 'STATUS_CODE_ERROR' THEN 0 ELSE 1 END, duration_nano DESC",
		);
		expect(sql).toContain("LIMIT 10");
	});

	test("basic auth header is set only when auth is configured", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const withAuth = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public", auth: "user:pass" },
			silentLogger(),
			fetchImpl,
		);
		await withAuth.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa("user:pass")}`);

		const { fetchImpl: fetchImpl2, calls: calls2 } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const withoutAuth = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl2,
		);
		await withoutAuth.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(calls2[0]?.headers.Authorization).toBeUndefined();
	});
});

describe("GreptimeDbSource - response parsing", () => {
	test("queryLogs parses a realistic response into LogRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[
					{ name: "timestamp", data_type: "TimestampNanosecond" },
					{ name: "severity_text", data_type: "String" },
					{ name: "severity_number", data_type: "Int32" },
					{ name: "body", data_type: "String" },
					{ name: "trace_id", data_type: "String" },
					{ name: "span_id", data_type: "String" },
					{ name: "log_attributes", data_type: "Json" },
					{ name: "resource_attributes", data_type: "Json" },
				],
				[
					[
						1784258863219000000,
						"ERROR",
						17,
						"database connection timeout after 30s",
						"3d4b2df34204eb410b75a498e9a53090",
						"effaab75e5a7621a",
						{ "log.type": "custom" },
						{
							"service.name": "paperhanger-test-svc",
							"deployment.environment": "test",
						},
					],
					[
						1784258000000000000,
						"INFO",
						9,
						"startup complete",
						"",
						"",
						{},
						{
							"service.name": "paperhanger-test-svc",
						},
					],
				],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		const logs = await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "paperhanger-test-svc" },
		});

		expect(logs.length).toBe(2);
		expect(logs[0]?.severityText).toBe("ERROR");
		expect(logs[0]?.severityNumber).toBe(17);
		expect(logs[0]?.body).toBe("database connection timeout after 30s");
		expect(logs[0]?.traceId).toBe("3d4b2df34204eb410b75a498e9a53090");
		expect(logs[0]?.spanId).toBe("effaab75e5a7621a");
		expect(logs[0]?.serviceName).toBe("paperhanger-test-svc");
		expect(logs[0]?.attributes).toEqual({ "log.type": "custom" });
		expect(logs[0]?.resourceAttributes["service.name"]).toBe(
			"paperhanger-test-svc",
		);
		expect(typeof logs[0]?.timestamp).toBe("string");
		expect(new Date(logs[0]?.timestamp as string).toString()).not.toBe(
			"Invalid Date",
		);

		// Empty-string trace_id/span_id (no active span) must map to undefined, not "".
		expect(logs[1]?.traceId).toBeUndefined();
		expect(logs[1]?.spanId).toBeUndefined();
	});

	test("queryLogs parses resource_attributes/log_attributes given as JSON-encoded strings", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[
					{ name: "timestamp", data_type: "TimestampNanosecond" },
					{ name: "severity_text", data_type: "String" },
					{ name: "severity_number", data_type: "Int32" },
					{ name: "body", data_type: "String" },
					{ name: "trace_id", data_type: "String" },
					{ name: "span_id", data_type: "String" },
					{ name: "log_attributes", data_type: "Json" },
					{ name: "resource_attributes", data_type: "Json" },
				],
				[
					[
						1784258863219000000,
						"ERROR",
						17,
						"boom",
						"",
						"",
						JSON.stringify({ x: 1 }),
						JSON.stringify({ "service.name": "svc" }),
					],
				],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		const logs = await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(logs[0]?.attributes).toEqual({ x: 1 });
		expect(logs[0]?.serviceName).toBe("svc");
	});

	test("queryTraces parses a realistic response into TraceRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[
					{ name: "timestamp", data_type: "TimestampNanosecond" },
					{ name: "timestamp_end", data_type: "TimestampNanosecond" },
					{ name: "duration_nano", data_type: "UInt64" },
					{ name: "parent_span_id", data_type: "String" },
					{ name: "trace_id", data_type: "String" },
					{ name: "span_id", data_type: "String" },
					{ name: "span_kind", data_type: "String" },
					{ name: "span_name", data_type: "String" },
					{ name: "span_status_code", data_type: "String" },
					{ name: "span_status_message", data_type: "String" },
					{ name: "service_name", data_type: "String" },
					{ name: "span_events", data_type: "Json" },
					{ name: "span_links", data_type: "Json" },
				],
				[
					[
						1784258863219000000,
						// Realistic nanosecond-epoch fixture (see docs/research/greptimedb.md);
						// precision loss beyond millisecond resolution is expected and harmless.
						// eslint-disable-next-line no-loss-of-precision
						1784258863342776166,
						123557166,
						null,
						"3d4b2df34204eb410b75a498e9a53090",
						"effaab75e5a7621a",
						"SPAN_KIND_INTERNAL",
						"GET /api/orders",
						"STATUS_CODE_OK",
						"",
						"paperhanger-test-svc",
						[],
						[],
					],
					[
						1784258863347000000,
						// eslint-disable-next-line no-loss-of-precision
						1784258863702875500,
						355875500,
						"effaab75e5a7621a",
						"3d4b2df34204eb410b75a498e9a53090",
						"6b495731395880b7",
						"SPAN_KIND_INTERNAL",
						"db.query orders_table",
						"STATUS_CODE_ERROR",
						"connection timeout",
						"paperhanger-test-svc",
						[
							{
								name: "exception",
								attributes: { "exception.message": "timeout" },
							},
						],
						[],
					],
				],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		const spans = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { trace_id: "3d4b2df34204eb410b75a498e9a53090" },
		});

		expect(spans.length).toBe(2);
		expect(spans[0]?.parentSpanId).toBeUndefined();
		expect(spans[0]?.name).toBe("GET /api/orders");
		expect(spans[0]?.statusCode).toBe("STATUS_CODE_OK");
		expect(spans[1]?.parentSpanId).toBe("effaab75e5a7621a");
		expect(spans[1]?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(spans[1]?.durationNano).toBe(355875500);
		expect(spans[1]?.attributes.statusMessage).toBe("connection timeout");
		expect(spans[1]?.attributes.events).toEqual([
			{ name: "exception", attributes: { "exception.message": "timeout" } },
		]);
	});
});

describe("GreptimeDbSource - error mapping", () => {
	test("maps a non-2xx SQL response into a GreptimeDbError with code/message", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						code: 4001,
						error:
							"Failed to plan SQL: Table not found: greptime.public.opentelemetry_logs",
						execution_time_ms: 2,
					}),
					{ status: 400 },
				),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		let caught: unknown;
		try {
			await source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(GreptimeDbError);
		const err = caught as InstanceType<typeof GreptimeDbError>;
		expect(err.code).toBe(4001);
		expect(err.httpStatus).toBe(400);
		expect(err.message).toContain("Table not found");
	});

	test("maps a 401 auth error into a GreptimeDbError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						code: 7002,
						error:
							"Username and password does not match, username: greptime_user",
					}),
					{ status: 401 },
				),
		);
		const source = new GreptimeDbSource(
			{
				url: "http://greptime.test",
				database: "public",
				auth: "greptime_user:wrong",
			},
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			}),
		).rejects.toMatchObject({ code: 7002, httpStatus: 401 });
	});
});

describe("GreptimeDbSource - PromQL metrics", () => {
	test("queryMetrics issues a GET with query params (not a body) and parses a matrix response", async () => {
		const { fetchImpl, calls } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "success",
						data: {
							resultType: "matrix",
							result: [
								{
									metric: {
										__name__: "http_requests_total",
										job: "paperhanger-test-svc",
										service_name: "paperhanger-test-svc",
										status: "200",
									},
									values: [
										[1784258920.0, "0"],
										[1784258935.0, "3"],
									],
								},
							],
						},
					}),
					{ status: 200 },
				),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "paperhanger-test-svc" },
			promql:
				'rate(http_requests_total{service_name="paperhanger-test-svc"}[1m])',
		});

		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.body).toBeUndefined();
		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/v1/prometheus/api/v1/query_range");
		expect(url.searchParams.get("query")).toBe(
			'rate(http_requests_total{service_name="paperhanger-test-svc"}[1m])',
		);
		expect(url.searchParams.get("start")).toBeTruthy();
		expect(url.searchParams.get("end")).toBeTruthy();
		expect(url.searchParams.get("step")).toMatch(/^\d+s$/);

		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("http_requests_total");
		expect(series[0]?.labels).toEqual({
			job: "paperhanger-test-svc",
			service_name: "paperhanger-test-svc",
			status: "200",
		});
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920000).toISOString(), value: 0 },
			{ timestamp: new Date(1784258935000).toISOString(), value: 3 },
		]);
	});

	test("queryMetrics returns an empty array and does not call fetch when no promql is given", async () => {
		const { fetchImpl, calls } = stubFetch(
			() => new Response("{}", { status: 200 }),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
		});
		expect(series).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("queryMetrics maps a PromQL error response to GreptimeDbError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "error",
						errorType: "InvalidArguments",
						error: "no expression found in input",
					}),
					{ status: 400 },
				),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryMetrics({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T00:05:00.000Z",
				},
				labels: {},
				promql: "invalid{{{",
			}),
		).rejects.toThrow(/no expression found in input/);
	});
});

describe("GreptimeDbSource - non-JSON response bodies", () => {
	function htmlErrorFetch(): typeof fetch {
		return (async (_input, _init) =>
			new Response("<html><body>502 Bad Gateway</body></html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			})) as typeof fetch;
	}

	test("queryLogs (runSql-based) maps a non-JSON error body to GreptimeDbError, not a raw SyntaxError", async () => {
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			htmlErrorFetch(),
		);

		let caught: unknown;
		try {
			await source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(GreptimeDbError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
		expect((caught as InstanceType<typeof GreptimeDbError>).httpStatus).toBe(
			502,
		);
	});

	test("queryMetrics maps a non-JSON response body to GreptimeDbError, not a raw SyntaxError", async () => {
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			htmlErrorFetch(),
		);

		let caught: unknown;
		try {
			await source.queryMetrics({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T00:05:00.000Z",
				},
				labels: {},
				promql: "up",
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(GreptimeDbError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
		expect((caught as InstanceType<typeof GreptimeDbError>).httpStatus).toBe(
			502,
		);
	});
});

describe("GreptimeDbSource - request timeout", () => {
	/** A `fetch` whose returned promise only ever settles by rejecting on abort. */
	function hangingFetch(): typeof fetch {
		return (async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}) as typeof fetch;
	}

	test("queryLogs (runSql-based) throws a typed timeout error instead of hanging forever", async () => {
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public", timeoutMs: 10 },
			silentLogger(),
			hangingFetch(),
		);

		let caught: unknown;
		try {
			await source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(GreptimeDbError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});

	test("queryMetrics throws a typed timeout error instead of hanging forever", async () => {
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public", timeoutMs: 15 },
			silentLogger(),
			hangingFetch(),
		);

		let caught: unknown;
		try {
			await source.queryMetrics({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T00:05:00.000Z",
				},
				labels: {},
				promql: "up",
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(GreptimeDbError);
		expect((caught as Error).message).toContain("timed out after 15ms");
	});

	test("resolves normally when the response arrives before the timeout", async () => {
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public", timeoutMs: 5_000 },
			silentLogger(),
			(async (_input, _init) =>
				sqlSuccessResponse(
					[{ name: "timestamp", data_type: "TimestampNanosecond" }],
					[],
				)) as typeof fetch,
		);

		await expect(
			source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			}),
		).resolves.toEqual([]);
	});
});

describe("GreptimeDbSource - OpenTelemetry span instrumentation", () => {
	test("queryLogs creates a CLIENT span with db.system.name/db.collection.name and OK status on success", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.name).toBe("greptimedb.query_logs");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["db.system.name"]).toBe("greptimedb");
		expect(span?.attributes["paperhanger.query.kind"]).toBe("logs");
		expect(span?.attributes["db.collection.name"]).toBe(DEFAULT_LOGS_TABLE);
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test("queryTraces sets paperhanger.query.strategy = 'trace_ids' when a trace_id filter is given", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { trace_id: "abc123" },
		});

		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe("greptimedb.query_traces");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["paperhanger.query.strategy"]).toBe("trace_ids");
		expect(span?.attributes["db.collection.name"]).toBe(DEFAULT_TRACES_TABLE);
	});

	test("queryTraces sets paperhanger.query.strategy = 'representative' without a trace_id filter", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		const span = exporter.getFinishedSpans()[0];
		expect(span?.attributes["paperhanger.query.strategy"]).toBe(
			"representative",
		);
	});

	test("queryMetrics sets paperhanger.query.skipped = true and records no HTTP attributes on the no-promql early return", async () => {
		const { fetchImpl, calls } = stubFetch(
			() => new Response("{}", { status: 200 }),
		);
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
		});

		expect(calls.length).toBe(0);
		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe("greptimedb.query_metrics");
		expect(span?.attributes["paperhanger.query.kind"]).toBe("metrics");
		expect(span?.attributes["paperhanger.query.skipped"]).toBe(true);
		expect(span?.attributes["http.response.status_code"]).toBeUndefined();
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test("queryMetrics's no-promql warn log correlates (traceId/spanId) with the finished CLIENT span", async () => {
		const { fetchImpl, calls } = stubFetch(
			() => new Response("{}", { status: 200 }),
		);
		const { tracer, exporter } = setupTracing();
		const { logger, lines } = capturingLogger();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			logger,
			fetchImpl,
			tracer,
		);

		await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
		});

		// The early-return branch makes no fetch call at all, so this warn's
		// correlation can't be observed via a stub-fetch-based active-span
		// check (unlike the "makes the query span active..." test below) --
		// only the logger's own captured output can confirm it ran inside the
		// span's active context.
		expect(calls.length).toBe(0);
		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe("greptimedb.query_metrics");
		expect(span?.attributes["paperhanger.query.skipped"]).toBe(true);

		const entries = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		const warnEntry = entries.find((entry) => entry.level === "warn");
		expect(warnEntry?.msg).toBe(
			"queryMetrics called without a PromQL expression; returning no series",
		);
		const spanContext = span?.spanContext();
		expect(warnEntry?.traceId).toBe(spanContext?.traceId);
		expect(warnEntry?.spanId).toBe(spanContext?.spanId);
	});

	test("a failing GreptimeDB query sets ERROR status with a redacted message and never leaks the raw SQL/error text into the span", async () => {
		// A recognizable marker standing in for GreptimeDB echoing the
		// offending SQL/PromQL text back in its error response body -- this
		// must never reach any span field (attributes, status message, or
		// exception events).
		const secretSqlMarker = "SECRET_SQL_TOKEN__evil_label_value";
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						code: 4001,
						error: `Failed to plan SQL: syntax error near '${secretSqlMarker}'`,
					}),
					{ status: 400 },
				),
		);
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		let caught: unknown;
		try {
			await source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: { service: secretSqlMarker },
			});
		} catch (err) {
			caught = err;
		}

		// Rethrown unchanged: the raw (unredacted) message is still available
		// to the caller via the thrown error -- redaction applies only to the
		// exported span, not to error semantics.
		expect(caught).toBeInstanceOf(GreptimeDbError);
		expect((caught as Error).message).toContain(secretSqlMarker);

		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe("greptimedb.query_logs");
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.status.message).toBe("GreptimeDB query failed (code=4001)");
		expect(span?.status.message).not.toContain(secretSqlMarker);
		expect(span?.attributes["paperhanger.greptimedb.error_code"]).toBe(4001);
		expect(span?.attributes["http.response.status_code"]).toBe(400);
		// recordException is never called for GreptimeDbError, so no
		// exception event (which would carry the raw message) is recorded.
		expect(span?.events.length).toBe(0);
		// Belt-and-suspenders: the marker must not appear anywhere in the
		// exported span at all (attributes, status, or events).
		const serializedSpan = JSON.stringify({
			attributes: span?.attributes,
			status: span?.status,
			events: span?.events,
		});
		expect(serializedSpan).not.toContain(secretSqlMarker);
	});

	test("non-GreptimeDbError exceptions (locally thrown) are still recorded via recordException", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		await expect(
			source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: { 'bad"key`; --': "x" },
			}),
		).rejects.toThrow(/Invalid attribute\/label key/);

		const span = exporter.getFinishedSpans()[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.status.message).toMatch(/Invalid attribute\/label key/);
		expect(span?.events.length).toBe(1);
		expect(span?.events[0]?.name).toBe("exception");
	});

	test("makes the query span active for the duration of the query, so code inside (e.g. the underlying fetch) observes it via getActiveSpan", async () => {
		let observedSpanId: string | undefined;
		let observedTraceId: string | undefined;
		const { fetchImpl } = stubFetch((_req) => {
			const active = trace.getActiveSpan();
			observedSpanId = active?.spanContext().spanId;
			observedTraceId = active?.spanContext().traceId;
			return sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			);
		});
		const { tracer, exporter } = setupTracing();
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
			tracer,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		const span = exporter.getFinishedSpans()[0];
		expect(observedSpanId).toBe(span?.spanContext().spanId);
		expect(observedTraceId).toBe(span?.spanContext().traceId);
	});

	test("falls back to a no-op tracer when none is injected, keeping existing call sites working", async () => {
		const { fetchImpl } = stubFetch(() =>
			sqlSuccessResponse(
				[{ name: "timestamp", data_type: "TimestampNanosecond" }],
				[],
			),
		);
		const source = new GreptimeDbSource(
			{ url: "http://greptime.test", database: "public" },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			}),
		).resolves.toEqual([]);
	});
});
