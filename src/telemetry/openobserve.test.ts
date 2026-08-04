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
	DEFAULT_LOGS_STREAM,
	DEFAULT_TRACES_STREAM,
	OpenObserveError,
	OpenObserveSource,
} from "./openobserve";

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

function searchResponse(hits: Record<string, unknown>[]): Response {
	return new Response(
		JSON.stringify({
			took: 1,
			hits,
			total: hits.length,
			from: 0,
			size: hits.length,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("OpenObserveSource - _search body construction and escaping", () => {
	test("queryLogs escapes single quotes in a malicious label value", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "evil'; DROP TABLE default; --" },
		});

		expect(calls.length).toBe(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe("http://openobserve.test/api/acme/_search");
		const body = JSON.parse(call?.body ?? "{}");
		expect(body.query.sql).toContain("evil''; DROP TABLE default; --");
		expect(body.query.sql).toContain("service_name = ");
		expect(body.query.start_time).toBeTypeOf("number");
		expect(body.query.end_time).toBeTypeOf("number");
		// microseconds, not milliseconds
		expect(body.query.start_time).toBe(
			new Date("2026-01-01T00:00:00.000Z").getTime() * 1000,
		);
	});

	test("queryLogs applies the ERROR severity threshold via the 'severity' convention", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.query.sql).toContain("severity_number >= 17");
	});

	test("queryLogs converts dotted resource attribute keys into underscore-joined columns", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

		expect(calls[0]?.body).toContain("deployment_environment = 'prod'");
	});

	test("queryLogs rejects an invalid (non-whitelisted) attribute key", async () => {
		const { fetchImpl } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

	test("rejects an invalid logsStream/tracesStream identifier at construction", () => {
		expect(
			() =>
				new OpenObserveSource(
					{
						url: "http://openobserve.test",
						organization: "acme",
						logsStream: "logs; DROP TABLE x",
					},
					silentLogger(),
				),
		).toThrow(/Invalid SQL identifier/);
	});

	test("uses configurable stream names in the generated SQL", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{
				url: "http://openobserve.test",
				organization: "acme",
				logsStream: "custom_logs",
				tracesStream: "custom_traces",
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

	test("defaults to the documented OpenObserve stream names", () => {
		expect(DEFAULT_LOGS_STREAM).toBe("default");
		expect(DEFAULT_TRACES_STREAM).toBe("default");
	});

	test("queryTraces builds an IN (...) clause with escaped trace ids and no time filter in WHERE", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.query.sql).toContain("trace_id IN ('abc123', 'def456')");
		expect(body.query.sql).not.toContain("_timestamp >=");
	});

	test("queryTraces rejects a malformed trace id", async () => {
		const { fetchImpl } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

	test("queryTraces without a trace_id filters by service_name and orders error-first-then-slowest", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.query.sql).toContain("service_name = 'checkout'");
		expect(body.query.sql).toContain("UPPER(span_status) = 'ERROR'");
		expect(body.query.sql).toContain(
			"ORDER BY CASE WHEN UPPER(span_status) = 'ERROR' THEN 0 ELSE 1 END, duration DESC",
		);
		expect(body.query.sql).toContain("LIMIT 10");
		expect(body.query.size).toBe(10);
	});

	test("basic auth header is set only when auth is configured", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const withAuth = new OpenObserveSource(
			{
				url: "http://openobserve.test",
				organization: "acme",
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
			searchResponse([]),
		);
		const withoutAuth = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

describe("OpenObserveSource - response parsing", () => {
	test("queryLogs parses a realistic hits response into LogRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			searchResponse([
				{
					_timestamp: 1_784_258_863_219_000,
					severity_text: "ERROR",
					severity_number: 17,
					body: "database connection timeout after 30s",
					trace_id: "3d4b2df34204eb410b75a498e9a53090",
					span_id: "effaab75e5a7621a",
					service_name: "paperhanger-test-svc",
					deployment_environment: "test",
				},
				{
					_timestamp: 1_784_258_000_000,
					severity_text: "INFO",
					severity_number: 9,
					body: "startup complete",
					service_name: "paperhanger-test-svc",
				},
			]),
		);
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		expect(logs[0]?.attributes.deployment_environment).toBe("test");
		expect(logs[0]?.resourceAttributes["service.name"]).toBe(
			"paperhanger-test-svc",
		);
		expect(logs[0]?.timestamp).toBe(
			new Date(1_784_258_863_219_000 / 1000).toISOString(),
		);
		expect(logs[1]?.traceId).toBeUndefined();
		expect(logs[1]?.spanId).toBeUndefined();
	});

	test("queryTraces parses a realistic hits response into TraceRecord[], converting duration microseconds to nanoseconds", async () => {
		const { fetchImpl } = stubFetch(() =>
			searchResponse([
				{
					trace_id: "3d4b2df34204eb410b75a498e9a53090",
					span_id: "effaab75e5a7621a",
					parent_span_id: "",
					operation_name: "GET /api/orders",
					span_kind: "SPAN_KIND_INTERNAL",
					service_name: "paperhanger-test-svc",
					start_time: 1_784_258_863_219_000_000,
					duration: 123557,
					span_status: "OK",
				},
				{
					trace_id: "3d4b2df34204eb410b75a498e9a53090",
					span_id: "6b495731395880b7",
					parent_span_id: "effaab75e5a7621a",
					operation_name: "db.query orders_table",
					span_kind: "SPAN_KIND_INTERNAL",
					service_name: "paperhanger-test-svc",
					start_time: 1_784_258_863_347_000_000,
					duration: 355875,
					span_status: "ERROR",
					status_message: "connection timeout",
				},
			]),
		);
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		expect(spans[0]?.statusCode).toBe("OK");
		expect(spans[0]?.durationNano).toBe(123557000);
		expect(spans[1]?.parentSpanId).toBe("effaab75e5a7621a");
		expect(spans[1]?.statusCode).toBe("ERROR");
		expect(spans[1]?.durationNano).toBe(355875000);
		expect(spans[1]?.attributes.statusMessage).toBe("connection timeout");
	});
});

describe("OpenObserveSource - error mapping", () => {
	test("maps a non-2xx JSON error response into an OpenObserveError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({ code: 400, message: "SQL parse error" }),
					{
						status: 400,
					},
				),
		);
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		expect(caught).toBeInstanceOf(OpenObserveError);
		const err = caught as InstanceType<typeof OpenObserveError>;
		expect(err.httpStatus).toBe(400);
		expect(err.message).toBe("SQL parse error");
	});

	test("maps a non-JSON response to an OpenObserveError, not a raw SyntaxError", async () => {
		const { fetchImpl } = stubFetch(
			() => new Response("<html>502</html>", { status: 502 }),
		);
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		expect(caught).toBeInstanceOf(OpenObserveError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});
});

describe("OpenObserveSource - request timeout", () => {
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
		const source = new OpenObserveSource(
			{
				url: "http://openobserve.test",
				organization: "acme",
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
		expect(caught).toBeInstanceOf(OpenObserveError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});

describe("OpenObserveSource - PromQL metrics", () => {
	test("queryMetrics issues a GET with query params against the inferred prometheus query_range path", async () => {
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
										service_name: "paperhanger-test-svc",
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
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		expect(url.pathname).toBe("/api/acme/prometheus/api/v1/query_range");
		expect(url.searchParams.get("query")).toBe(
			'rate(http_requests_total{service_name="paperhanger-test-svc"}[1m])',
		);

		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("http_requests_total");
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920000).toISOString(), value: 0 },
			{ timestamp: new Date(1784258935000).toISOString(), value: 3 },
		]);
	});

	test("queryMetrics returns an empty array and does not call fetch when no promql is given", async () => {
		const { fetchImpl, calls } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

	test("queryMetrics maps a PromQL error response to OpenObserveError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "error",
						error: "no expression found in input",
					}),
					{ status: 400 },
				),
		);
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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

describe("OpenObserveSource - OpenTelemetry span instrumentation", () => {
	test("queryLogs creates a CLIENT span with db.system.name/db.collection.name and OK status on success", async () => {
		const { fetchImpl } = stubFetch(() => searchResponse([]));
		const { tracer, exporter } = setupTracing();
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		expect(span?.name).toBe("openobserve.query_logs");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["db.system.name"]).toBe("openobserve");
		expect(span?.attributes["paperhanger.query.kind"]).toBe("logs");
		expect(span?.attributes["db.collection.name"]).toBe(DEFAULT_LOGS_STREAM);
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test("a failing query sets ERROR status and records the http status code", async () => {
		const { fetchImpl } = stubFetch(
			() => new Response("boom", { status: 500 }),
		);
		const { tracer, exporter } = setupTracing();
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
		).rejects.toBeInstanceOf(OpenObserveError);

		const span = exporter.getFinishedSpans()[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes["http.response.status_code"]).toBe(500);
	});

	test("falls back to a no-op tracer when none is injected, keeping existing call sites working", async () => {
		const { fetchImpl } = stubFetch(() => searchResponse([]));
		const source = new OpenObserveSource(
			{ url: "http://openobserve.test", organization: "acme" },
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
