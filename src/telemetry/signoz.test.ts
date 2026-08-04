import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { SigNozError, SigNozSource } from "./signoz";

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

function queryRangeResponse(list: unknown[]): Response {
	return new Response(
		JSON.stringify({
			status: "success",
			data: { resultType: "raw", result: [{ queryName: "A", list }] },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("SigNozSource - query_range body construction and escaping", () => {
	test("queryLogs escapes single quotes in a malicious label value", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "evil' OR '1'='1" },
		});

		expect(calls.length).toBe(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe("http://signoz.test/api/v5/query_range");
		const body = JSON.parse(call?.body ?? "{}");
		const expression = body.compositeQuery.queries[0].spec.filter
			.expression as string;
		expect(expression).toContain("evil'' OR ''1''=''1");
		expect(expression).toContain("service.name = ");
	});

	test("queryLogs applies the ERROR severity threshold via the 'severity' convention", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		expect(body.compositeQuery.queries[0].spec.filter.expression).toContain(
			"severity_number >= 17",
		);
		expect(body.start).toBeTypeOf("number");
		expect(body.end).toBeTypeOf("number");
		expect(body.requestType).toBe("raw");
		expect(body.compositeQuery.queries[0].spec.limit).toBe(100);
	});

	test("queryLogs rejects an invalid (non-whitelisted) attribute key", async () => {
		const { fetchImpl } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryLogs({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: { "bad key; --": "x" },
			}),
		).rejects.toThrow(/Invalid attribute\/label key/);
	});

	test("queryTraces builds a trace_id IN [...] filter with escaped ids and ascending order", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		const spec = body.compositeQuery.queries[0].spec;
		expect(spec.filter.expression).toBe("trace_id IN ['abc123', 'def456']");
		expect(spec.order[0]).toEqual({
			key: { name: "timestamp" },
			direction: "asc",
		});
	});

	test("queryTraces rejects a malformed trace id", async () => {
		const { fetchImpl } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			source.queryTraces({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: { trace_id: "not-hex!'; --" },
			}),
		).rejects.toThrow(/Invalid trace id/);
	});

	test("queryTraces without a trace_id filters by service.name and has_error/duration, ordered by duration desc", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		const spec = body.compositeQuery.queries[0].spec;
		expect(spec.filter.expression).toBe(
			"service.name = 'checkout' AND (has_error = true OR duration_nano > 50000000)",
		);
		expect(spec.order[0]).toEqual({
			key: { name: "duration_nano" },
			direction: "desc",
		});
		expect(spec.limit).toBe(10);
	});

	test("sends the SIGNOZ-API-KEY header on every request", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "my-secret-key" },
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
		expect(calls[0]?.headers["SIGNOZ-API-KEY"]).toBe("my-secret-key");
	});
});

describe("SigNozSource - response parsing", () => {
	test("queryLogs parses a realistic list response into LogRecord[]", async () => {
		const nowNs = 1_784_258_863_219_000_000;
		const { fetchImpl } = stubFetch(() =>
			queryRangeResponse([
				{
					timestamp: nowNs,
					data: {
						body: "database connection timeout after 30s",
						severity_text: "ERROR",
						severity_number: 17,
						trace_id: "3d4b2df34204eb410b75a498e9a53090",
						span_id: "effaab75e5a7621a",
						"service.name": "paperhanger-test-svc",
						deployment_name: "hotrod",
					},
				},
				{
					timestamp: nowNs - 1000,
					data: {
						body: "startup complete",
						severity_text: "INFO",
						severity_number: 9,
						"service.name": "paperhanger-test-svc",
					},
				},
			]),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		expect(logs[0]?.attributes.deployment_name).toBe("hotrod");
		expect(logs[0]?.resourceAttributes["service.name"]).toBe(
			"paperhanger-test-svc",
		);
		expect(logs[1]?.traceId).toBeUndefined();
		expect(logs[1]?.spanId).toBeUndefined();
	});

	test("queryTraces parses a realistic list response into TraceRecord[]", async () => {
		const nowNs = 1_784_258_863_219_000_000;
		const { fetchImpl } = stubFetch(() =>
			queryRangeResponse([
				{
					timestamp: nowNs,
					data: {
						trace_id: "3d4b2df34204eb410b75a498e9a53090",
						span_id: "effaab75e5a7621a",
						parent_span_id: "",
						name: "GET /api/orders",
						kind: "SPAN_KIND_INTERNAL",
						"service.name": "paperhanger-test-svc",
						duration_nano: 123557166,
						has_error: false,
					},
				},
				{
					timestamp: nowNs + 1000,
					data: {
						trace_id: "3d4b2df34204eb410b75a498e9a53090",
						span_id: "6b495731395880b7",
						parent_span_id: "effaab75e5a7621a",
						name: "db.query orders_table",
						kind: "SPAN_KIND_INTERNAL",
						"service.name": "paperhanger-test-svc",
						duration_nano: 355875500,
						has_error: true,
						status_message: "connection timeout",
					},
				},
			]),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
	});

	test("falls back to data.timestamp when the list item has no top-level timestamp sibling", async () => {
		const { fetchImpl } = stubFetch(() =>
			queryRangeResponse([
				{
					// No top-level `timestamp` field on the list item itself -- only
					// nested under `data` (see the fallback in `extractList`).
					data: {
						timestamp: 1_784_258_863_219_000_000,
						body: "nested timestamp only",
						"service.name": "paperhanger-test-svc",
					},
				},
			]),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		expect(logs.length).toBe(1);
		expect(logs[0]?.body).toBe("nested timestamp only");
		expect(logs[0]?.timestamp).toBe(
			new Date(1_784_258_863_219_000_000 / 1_000_000).toISOString(),
		);
	});

	test("tolerates a null/missing list gracefully (returns [])", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "success",
						data: {
							resultType: "raw",
							result: [{ queryName: "A", list: null }],
						},
					}),
					{ status: 200 },
				),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		expect(logs).toEqual([]);
	});
});

describe("SigNozSource - error mapping", () => {
	test("maps a non-2xx response into a SigNozError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(JSON.stringify({ error: "invalid API key" }), {
					status: 401,
				}),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "wrong-key" },
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
		expect(caught).toBeInstanceOf(SigNozError);
		const err = caught as InstanceType<typeof SigNozError>;
		expect(err.httpStatus).toBe(401);
		expect(err.message).toBe("invalid API key");
	});

	test("maps a 200 response carrying status: error into a SigNozError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({ status: "error", error: "bad filter expression" }),
					{ status: 200 },
				),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		).rejects.toThrow(/bad filter expression/);
	});

	test("maps a non-JSON response to a SigNozError, not a raw SyntaxError", async () => {
		const { fetchImpl } = stubFetch(
			() => new Response("<html>502</html>", { status: 502 }),
		);
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		expect(caught).toBeInstanceOf(SigNozError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});
});

describe("SigNozSource - request timeout", () => {
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
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123", timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(SigNozError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});

describe("SigNozSource - metrics (unsupported)", () => {
	test("queryMetrics always returns an empty array with no fetch call", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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

describe("SigNozSource - OpenTelemetry span instrumentation", () => {
	test("queryLogs creates a CLIENT span with db.system.name and OK status on success", async () => {
		const { fetchImpl } = stubFetch(() => queryRangeResponse([]));
		const { tracer, exporter } = setupTracing();
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		expect(span?.name).toBe("signoz.query_logs");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["db.system.name"]).toBe("signoz");
		expect(span?.attributes["paperhanger.query.kind"]).toBe("logs");
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test("a failing query sets ERROR status and records the http status code", async () => {
		const { fetchImpl } = stubFetch(
			() => new Response("boom", { status: 500 }),
		);
		const { tracer, exporter } = setupTracing();
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
		).rejects.toBeInstanceOf(SigNozError);

		const span = exporter.getFinishedSpans()[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes["http.response.status_code"]).toBe(500);
	});

	test("falls back to a no-op tracer when none is injected, keeping existing call sites working", async () => {
		const { fetchImpl } = stubFetch(() => queryRangeResponse([]));
		const source = new SigNozSource(
			{ url: "http://signoz.test", apiKey: "key-123" },
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
