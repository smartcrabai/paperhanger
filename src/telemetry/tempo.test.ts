import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { TempoError, TempoSource } from "./tempo";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

function capturingLogger() {
	const lines: string[] = [];
	const logger = createLogger({ sink: (line) => lines.push(line) });
	return { logger, lines };
}

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

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
}

/** A stub `fetch` that records requests and replays canned responses in call order. */
function stubFetch(
	responder: (req: RecordedRequest, callIndex: number) => Response,
) {
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
			headers,
		};
		const index = calls.length;
		calls.push(req);
		return responder(req, index);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function otlpAttr(
	key: string,
	value: unknown,
): { key: string; value: unknown } {
	if (typeof value === "string") return { key, value: { stringValue: value } };
	if (typeof value === "number") return { key, value: { intValue: value } };
	if (typeof value === "boolean") return { key, value: { boolValue: value } };
	return { key, value: {} };
}

describe("TempoSource - trace-by-id fetch (GET /api/traces/{traceID})", () => {
	test("builds one request per comma-separated trace id and maps OTLP spans into TraceRecord[]", async () => {
		const trace1 = {
			resourceSpans: [
				{
					resource: { attributes: [otlpAttr("service.name", "checkout")] },
					scopeSpans: [
						{
							spans: [
								{
									traceId: "3d4b2df34204eb410b75a498e9a53090",
									spanId: "effaab75e5a7621a",
									name: "GET /api/orders",
									kind: "SPAN_KIND_SERVER",
									startTimeUnixNano: "1784258863219000000",
									endTimeUnixNano: "1784258863319000000",
									status: { code: "STATUS_CODE_OK" },
									attributes: [otlpAttr("http.method", "GET")],
								},
							],
						},
					],
				},
			],
		};
		const trace2 = {
			resourceSpans: [
				{
					resource: { attributes: [otlpAttr("service.name", "checkout")] },
					scopeSpans: [
						{
							spans: [
								{
									traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
									spanId: "bbbbbbbbbbbbbbbb",
									parentSpanId: "cccccccccccccccc",
									name: "db.query orders_table",
									kind: 1,
									startTimeUnixNano: "1784258863347000000",
									endTimeUnixNano: "1784258863702000000",
									status: { code: 2, message: "connection timeout" },
									attributes: [],
								},
							],
						},
					],
				},
			],
		};
		const { fetchImpl, calls } = stubFetch((_req, index) =>
			jsonResponse(index === 0 ? trace1 : trace2),
		);
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		const spans = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {
				trace_id:
					"3d4b2df34204eb410b75a498e9a53090,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
		});

		expect(calls.length).toBe(2);
		expect(calls[0]?.url).toContain(
			"/api/traces/3d4b2df34204eb410b75a498e9a53090",
		);
		expect(calls[1]?.url).toContain(
			"/api/traces/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);

		expect(spans.length).toBe(2);
		const first = spans.find((s) => s.spanId === "effaab75e5a7621a");
		expect(first?.name).toBe("GET /api/orders");
		expect(first?.kind).toBe("SPAN_KIND_SERVER");
		expect(first?.serviceName).toBe("checkout");
		expect(first?.statusCode).toBe("STATUS_CODE_OK");
		expect(first?.parentSpanId).toBeUndefined();
		expect(first?.attributes["http.method"]).toBe("GET");

		const second = spans.find((s) => s.spanId === "bbbbbbbbbbbbbbbb");
		expect(second?.kind).toBe("SPAN_KIND_INTERNAL");
		expect(second?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(second?.parentSpanId).toBe("cccccccccccccccc");
		expect(second?.attributes.statusMessage).toBe("connection timeout");
	});

	test("rejects a malformed trace id without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			jsonResponse({ resourceSpans: [] }),
		);
		const source = new TempoSource(
			{ url: "http://tempo.test" },
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
		expect(calls.length).toBe(0);
	});
});

describe("TempoSource - representative search (GET /api/search)", () => {
	test("builds a TraceQL query selecting error-or-slow spans, scoped to the resolved service", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ traces: [] }));
		const source = new TempoSource(
			{ url: "http://tempo.test" },
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

		expect(calls.length).toBe(1);
		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/api/search");
		expect(url.searchParams.get("q")).toBe(
			'{ resource.service.name="checkout" && (status=error || duration>50ms) }',
		);
		expect(url.searchParams.get("limit")).toBe("10");
		expect(url.searchParams.get("start")).toBe(
			String(Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000)),
		);
	});

	test("omits the service condition when no service label resolves", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ traces: [] }));
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("q")).toBe(
			"{ (status=error || duration>50ms) }",
		);
	});

	test("escapes a double quote in a malicious service label value", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ traces: [] }));
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: 'evil" && true=true || resource.service.name="x' },
		});

		const url = new URL(calls[0]?.url ?? "");
		const q = url.searchParams.get("q") ?? "";
		expect(q).toContain('\\" && true=true || resource.service.name=\\"x');
	});

	test("maps a minimal search response into TraceRecord[], falling back to trace-level service/name fields", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				traces: [
					{
						traceID: "3d4b2df34204eb410b75a498e9a53090",
						rootServiceName: "checkout",
						rootTraceName: "GET /api/orders",
						startTimeUnixNano: "1784258863219000000",
						durationMs: 123,
						spanSets: [
							{
								spans: [
									{
										spanID: "effaab75e5a7621a",
										startTimeUnixNano: "1784258863219000000",
										durationNanos: "446979497",
										attributes: [otlpAttr("status", "error")],
									},
								],
							},
						],
					},
				],
			}),
		);
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		const spans = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		expect(spans.length).toBe(1);
		expect(spans[0]?.traceId).toBe("3d4b2df34204eb410b75a498e9a53090");
		expect(spans[0]?.spanId).toBe("effaab75e5a7621a");
		expect(spans[0]?.serviceName).toBe("checkout");
		expect(spans[0]?.name).toBe("GET /api/orders");
		expect(spans[0]?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(spans[0]?.durationNano).toBe(446979497);
	});

	test("tolerates the older singular spanSet field", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				traces: [
					{
						traceID: "abc123",
						spanSet: { spans: [{ spanID: "def456", attributes: [] }] },
					},
				],
			}),
		);
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		const spans = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(spans.length).toBe(1);
		expect(spans[0]?.spanId).toBe("def456");
	});
});

describe("TempoSource - auth headers", () => {
	test("basic auth header is set only when configured", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ traces: [] }));
		const withAuth = new TempoSource(
			{ url: "http://tempo.test", auth: "user:pass" },
			silentLogger(),
			fetchImpl,
		);
		await withAuth.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa("user:pass")}`);

		const { fetchImpl: fetchImpl2, calls: calls2 } = stubFetch(() =>
			jsonResponse({ traces: [] }),
		);
		const withoutAuth = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl2,
		);
		await withoutAuth.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(calls2[0]?.headers.Authorization).toBeUndefined();
	});
});

describe("TempoSource - error mapping", () => {
	test("maps a non-2xx response into a TempoError with httpStatus", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, 500));
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		let caught: unknown;
		try {
			await source.queryTraces({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TempoError);
		expect((caught as TempoError).httpStatus).toBe(500);
	});

	test("maps a non-JSON response body into a TempoError, not a raw SyntaxError", async () => {
		function nonJsonFetch(): typeof fetch {
			return (async (_input, _init) =>
				new Response("not json", { status: 200 })) as typeof fetch;
		}
		const fetchImpl = nonJsonFetch();
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		let caught: unknown;
		try {
			await source.queryTraces({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TempoError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});

	test("a hanging request throws a typed timeout error instead of hanging forever", async () => {
		const source = new TempoSource(
			{ url: "http://tempo.test", timeoutMs: 10 },
			silentLogger(),
			hangingFetch(),
		);

		let caught: unknown;
		try {
			await source.queryTraces({
				timeRange: {
					from: "2026-01-01T00:00:00.000Z",
					to: "2026-01-01T01:00:00.000Z",
				},
				labels: {},
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TempoError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});

describe("TempoSource - graceful degradation for unsupported signals", () => {
	test("queryLogs logs a warning and returns no logs without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ traces: [] }));
		const { logger, lines } = capturingLogger();
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			logger,
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
		expect(calls.length).toBe(0);
		const entries = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		expect(entries.some((e) => e.level === "warn")).toBe(true);
	});

	test("queryMetrics logs a warning and returns no series without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ traces: [] }));
		const source = new TempoSource(
			{ url: "http://tempo.test" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(series).toEqual([]);
		expect(calls.length).toBe(0);
	});
});
