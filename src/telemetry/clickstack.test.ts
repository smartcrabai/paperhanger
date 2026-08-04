import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import {
	ClickStackError,
	ClickStackSource,
	DEFAULT_LOGS_TABLE,
	DEFAULT_TRACES_TABLE,
} from "./clickstack";

// See greptimedb.test.ts for why this is registered once at module scope.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

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

interface RecordedRequest {
	url: string;
	method: string;
	body?: string;
	headers: Record<string, string>;
}

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

function clickhouseJsonResponse(data: Record<string, unknown>[]): Response {
	return new Response(
		JSON.stringify({
			meta: [],
			data,
			rows: data.length,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("ClickStackSource - SQL building and escaping", () => {
	test("queryLogs escapes single quotes in a malicious label value", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "evil'; DROP TABLE otel_logs; --" },
		});

		expect(calls.length).toBe(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe("http://clickhouse.test:8123/?database=default");
		const sql = call?.body ?? "";
		expect(sql).toContain("evil''; DROP TABLE otel_logs; --");
		expect(sql).toContain("ServiceName = ");
	});

	test("queryLogs applies the ERROR severity threshold via the 'severity' convention", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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

		expect(calls[0]?.body).toContain("SeverityNumber >= 17");
	});

	test("queryLogs uses Map(...) access for generic resource attribute filters", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { "deployment.environment": "prod" },
		});

		expect(calls[0]?.body).toContain(
			"ResourceAttributes['deployment.environment'] = 'prod'",
		);
	});

	test("queryLogs rejects an invalid (non-whitelisted) attribute key", async () => {
		const { fetchImpl } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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

	test("rejects an invalid database/logsTable/tracesTable identifier at construction", () => {
		expect(
			() =>
				new ClickStackSource(
					{
						url: "http://clickhouse.test:8123",
						database: "default; DROP TABLE x",
					},
					silentLogger(),
				),
		).toThrow(/Invalid SQL identifier/);
		expect(
			() =>
				new ClickStackSource(
					{
						url: "http://clickhouse.test:8123",
						database: "default",
						logsTable: "logs; DROP TABLE x",
					},
					silentLogger(),
				),
		).toThrow(/Invalid SQL identifier/);
	});

	test("uses configurable table names in the generated SQL", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{
				url: "http://clickhouse.test:8123",
				database: "default",
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

		expect(calls[0]?.body).toContain("FROM custom_logs");
		expect(calls[1]?.body).toContain("FROM custom_traces");
	});

	test("defaults to the documented ClickStack table names", () => {
		expect(DEFAULT_LOGS_TABLE).toBe("otel_logs");
		expect(DEFAULT_TRACES_TABLE).toBe("otel_traces");
	});

	test("queryTraces builds an IN (...) clause with escaped trace ids and no time filter", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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

		const sql = calls[0]?.body ?? "";
		expect(sql).toContain("TraceId IN ('abc123', 'def456')");
		expect(sql).not.toContain("Timestamp >=");
	});

	test("queryTraces rejects a malformed trace id", async () => {
		const { fetchImpl } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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

		const sql = calls[0]?.body ?? "";
		expect(sql).toContain("ServiceName = 'checkout'");
		expect(sql).toContain("STATUS_CODE_ERROR");
		expect(sql).toContain(
			"ORDER BY CASE WHEN StatusCode = 'STATUS_CODE_ERROR' THEN 0 ELSE 1 END, Duration DESC",
		);
		expect(sql).toContain("LIMIT 10");
	});

	test("basic auth header is set only when auth is configured", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const withAuth = new ClickStackSource(
			{
				url: "http://clickhouse.test:8123",
				database: "default",
				auth: "user:pass",
			},
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
			clickhouseJsonResponse([]),
		);
		const withoutAuth = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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

describe("ClickStackSource - response parsing", () => {
	test("queryLogs parses a realistic response into LogRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			clickhouseJsonResponse([
				{
					Timestamp: "2026-01-01 00:10:00.123456789",
					SeverityText: "ERROR",
					SeverityNumber: "17",
					Body: "database connection timeout after 30s",
					TraceId: "3d4b2df34204eb410b75a498e9a53090",
					SpanId: "effaab75e5a7621a",
					ServiceName: "paperhanger-test-svc",
					LogAttributes: { "log.type": "custom" },
					ResourceAttributes: { "deployment.environment": "test" },
				},
				{
					Timestamp: "2026-01-01 00:00:00.000000000",
					SeverityText: "INFO",
					SeverityNumber: 9,
					Body: "startup complete",
					TraceId: "",
					SpanId: "",
					ServiceName: "paperhanger-test-svc",
					LogAttributes: {},
					ResourceAttributes: {},
				},
			]),
		);
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
		expect(logs[0]?.resourceAttributes["deployment.environment"]).toBe("test");
		expect(logs[0]?.resourceAttributes["service.name"]).toBe(
			"paperhanger-test-svc",
		);
		// Sub-millisecond precision is truncated (see clickhouseTimestampToIso).
		expect(logs[0]?.timestamp).toBe("2026-01-01T00:10:00.123Z");

		expect(logs[1]?.traceId).toBeUndefined();
		expect(logs[1]?.spanId).toBeUndefined();
	});

	test("queryTraces parses a realistic response into TraceRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			clickhouseJsonResponse([
				{
					Timestamp: "2026-01-01 00:10:00.000000000",
					Duration: "123557166",
					ParentSpanId: "",
					TraceId: "3d4b2df34204eb410b75a498e9a53090",
					SpanId: "effaab75e5a7621a",
					SpanKind: "SPAN_KIND_INTERNAL",
					SpanName: "GET /api/orders",
					StatusCode: "STATUS_CODE_OK",
					StatusMessage: "",
					ServiceName: "paperhanger-test-svc",
				},
				{
					Timestamp: "2026-01-01 00:10:00.347000000",
					Duration: 355875500,
					ParentSpanId: "effaab75e5a7621a",
					TraceId: "3d4b2df34204eb410b75a498e9a53090",
					SpanId: "6b495731395880b7",
					SpanKind: "SPAN_KIND_INTERNAL",
					SpanName: "db.query orders_table",
					StatusCode: "STATUS_CODE_ERROR",
					StatusMessage: "connection timeout",
					ServiceName: "paperhanger-test-svc",
				},
			]),
		);
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
		expect(spans[0]?.durationNano).toBe(123557166);
		expect(spans[1]?.parentSpanId).toBe("effaab75e5a7621a");
		expect(spans[1]?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(spans[1]?.durationNano).toBe(355875500);
		expect(spans[1]?.attributes.statusMessage).toBe("connection timeout");
	});
});

describe("ClickStackSource - error mapping", () => {
	test("maps a non-2xx plain-text response into a ClickStackError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					"Code: 60. DB::Exception: Table default.otel_logs doesn't exist",
					{ status: 404 },
				),
		);
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
		expect(caught).toBeInstanceOf(ClickStackError);
		const err = caught as InstanceType<typeof ClickStackError>;
		expect(err.httpStatus).toBe(404);
		expect(err.message).toContain("Table default.otel_logs doesn't exist");
	});

	test("maps a non-JSON success response to a ClickStackError, not a raw SyntaxError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response("not json", {
					status: 200,
					headers: { "Content-Type": "text/plain" },
				}),
		);
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
		expect(caught).toBeInstanceOf(ClickStackError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});
});

describe("ClickStackSource - request timeout", () => {
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

	test("queryLogs throws a typed timeout error instead of hanging forever", async () => {
		const source = new ClickStackSource(
			{
				url: "http://clickhouse.test:8123",
				database: "default",
				timeoutMs: 10,
			},
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
		expect(caught).toBeInstanceOf(ClickStackError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});

describe("ClickStackSource - metrics (unsupported)", () => {
	test("queryMetrics always returns an empty array with no fetch call", async () => {
		const { fetchImpl, calls } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "rate(http_requests_total[1m])",
		});
		expect(series).toEqual([]);
		expect(calls.length).toBe(0);
	});
});

describe("ClickStackSource - OpenTelemetry span instrumentation", () => {
	test("queryLogs creates a CLIENT span with db.system.name/db.collection.name and OK status on success", async () => {
		const { fetchImpl } = stubFetch(() => clickhouseJsonResponse([]));
		const { tracer, exporter } = setupTracing();
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
		expect(span?.name).toBe("clickstack.query_logs");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["db.system.name"]).toBe("clickhouse");
		expect(span?.attributes["paperhanger.query.kind"]).toBe("logs");
		expect(span?.attributes["db.collection.name"]).toBe(DEFAULT_LOGS_TABLE);
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test("a failing query sets ERROR status and records the http status code, without falling back to a no-op tracer", async () => {
		const { fetchImpl } = stubFetch(
			() => new Response("boom", { status: 500 }),
		);
		const { tracer, exporter } = setupTracing();
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
				labels: {},
			}),
		).rejects.toBeInstanceOf(ClickStackError);

		const span = exporter.getFinishedSpans()[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes["http.response.status_code"]).toBe(500);
	});

	test("falls back to a no-op tracer when none is injected, keeping existing call sites working", async () => {
		const { fetchImpl } = stubFetch(() => clickhouseJsonResponse([]));
		const source = new ClickStackSource(
			{ url: "http://clickhouse.test:8123", database: "default" },
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
