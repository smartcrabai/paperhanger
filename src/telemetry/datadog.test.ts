import { describe, expect, test } from "bun:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createLogger } from "../observability/logger";
import { DatadogError, DatadogSource } from "./datadog";

// Registered once at module scope so context propagates across `await`s
// (design doc section 10; matches the convention in greptimedb.test.ts).
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("DatadogSource - config and auth", () => {
	test("sends DD-API-KEY/DD-APPLICATION-KEY headers and defaults to the datadoghq.com site", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: [] }));
		const source = new DatadogSource(
			{ apiKey: "api-key-123", appKey: "app-key-456" },
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

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(
			"https://api.datadoghq.com/api/v2/logs/events/search",
		);
		expect(calls[0]?.headers["DD-API-KEY"]).toBe("api-key-123");
		expect(calls[0]?.headers["DD-APPLICATION-KEY"]).toBe("app-key-456");
	});

	test("uses a configured site for the base URL", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: [] }));
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a", site: "datadoghq.eu" },
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

		expect(calls[0]?.url).toBe(
			"https://api.datadoghq.eu/api/v2/logs/events/search",
		);
	});
});

describe("DatadogSource - query construction", () => {
	test("queryLogs builds a faceted query from service/severity conventions and quotes values", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: [] }));
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: 'checkout"; evil', severity: "error" },
			limit: 25,
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.filter.query).toContain('service:"checkout\\"; evil"');
		expect(body.filter.query).toContain("status:error");
		expect(body.filter.from).toBe("2026-01-01T00:00:00.000Z");
		expect(body.filter.to).toBe("2026-01-01T01:00:00.000Z");
		expect(body.page.limit).toBe(25);
		expect(body.sort).toBe("-timestamp");
	});

	test("queryLogs maps a non-conventional label to the @attribute facet syntax", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: [] }));
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { env: "prod" },
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.filter.query).toContain('@env:"prod"');
	});

	test("queryTraces builds an OR'd trace_id query when trace_id labels are given", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: [] }));
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
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

		expect(calls[0]?.url).toBe(
			"https://api.datadoghq.com/api/v2/spans/events/search",
		);
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.filter.query).toBe('trace_id:"abc123" OR trace_id:"def456"');
	});

	test("queryTraces without a trace_id filters by service and error-or-slow", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: [] }));
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.filter.query).toContain('service:"checkout"');
		expect(body.filter.query).toContain("status:error");
		expect(body.filter.query).toContain("@duration:>50000000");
	});
});

describe("DatadogSource - response parsing", () => {
	test("queryLogs maps a realistic response into LogRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				data: [
					{
						id: "log-1",
						attributes: {
							timestamp: "2026-01-01T00:05:00.000Z",
							status: "error",
							message: "database connection timeout",
							service: "checkout",
							tags: ["env:prod"],
							attributes: {
								"dd.trace_id": "3d4b2df34204eb410b75a498e9a53090",
								"dd.span_id": "effaab75e5a7621a",
							},
						},
					},
				],
			}),
		);
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
			silentLogger(),
			fetchImpl,
		);

		const logs = await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		expect(logs.length).toBe(1);
		expect(logs[0]?.severityText).toBe("error");
		expect(logs[0]?.severityNumber).toBe(17);
		expect(logs[0]?.body).toBe("database connection timeout");
		expect(logs[0]?.traceId).toBe("3d4b2df34204eb410b75a498e9a53090");
		expect(logs[0]?.spanId).toBe("effaab75e5a7621a");
		expect(logs[0]?.serviceName).toBe("checkout");
	});

	test("queryTraces maps a realistic response into TraceRecord[], detecting error via custom.error", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				data: [
					{
						id: "span-1",
						attributes: {
							trace_id: "3d4b2df34204eb410b75a498e9a53090",
							span_id: "effaab75e5a7621a",
							parent_id: "0",
							service: "checkout",
							resource_name: "GET /api/orders",
							type: "web",
							start_timestamp: "2026-01-01T00:05:00.000Z",
							duration: 123557166,
							custom: { error: true, "error.message": "boom" },
						},
					},
				],
			}),
		);
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
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

		expect(spans.length).toBe(1);
		expect(spans[0]?.statusCode).toBe("STATUS_CODE_ERROR");
		expect(spans[0]?.durationNano).toBe(123557166);
		expect(spans[0]?.name).toBe("GET /api/orders");
	});
});

describe("DatadogSource - metrics", () => {
	test("queryMetrics returns an empty array and does not call fetch when no metrics query string is given", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			jsonResponse({ status: "ok", series: [] }),
		);
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
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

	test("queryMetrics issues a GET with the metrics query string and parses a series response", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			jsonResponse({
				status: "ok",
				series: [
					{
						metric: "trace.express.request.duration",
						scope: "service:checkout,env:prod",
						pointlist: [
							[1784258920000, 0.5],
							[1784258935000, 0.8],
						],
					},
				],
			}),
		);
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "avg:trace.express.request.duration{service:checkout}",
		});

		expect(calls[0]?.method).toBe("GET");
		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/api/v1/query");
		expect(url.searchParams.get("query")).toBe(
			"avg:trace.express.request.duration{service:checkout}",
		);
		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("trace.express.request.duration");
		expect(series[0]?.labels).toEqual({ service: "checkout", env: "prod" });
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920000).toISOString(), value: 0.5 },
			{ timestamp: new Date(1784258935000).toISOString(), value: 0.8 },
		]);
	});
});

describe("DatadogSource - error mapping", () => {
	test("maps a non-2xx response into a DatadogError carrying the errors array", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ errors: ["Invalid query filter"] }, 400),
		);
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
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
		expect(caught).toBeInstanceOf(DatadogError);
		const err = caught as DatadogError;
		expect(err.httpStatus).toBe(400);
		expect(err.message).toContain("Invalid query filter");
	});

	test("maps a non-JSON error body to a DatadogError, not a raw SyntaxError", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response("<html>502 Bad Gateway</html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			})) as typeof fetch;
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a" },
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
		expect(caught).toBeInstanceOf(DatadogError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
		expect((caught as DatadogError).httpStatus).toBe(502);
	});

	test("never includes the API key or app key in a thrown error message", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ errors: ["auth failed"] }, 403),
		);
		const source = new DatadogSource(
			{ apiKey: "super-secret-api-key", appKey: "super-secret-app-key" },
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
		expect((caught as DatadogError).message).not.toContain("super-secret");
	});
});

describe("DatadogSource - request timeout", () => {
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

	test("throws a typed timeout error instead of hanging forever", async () => {
		const source = new DatadogSource(
			{ apiKey: "k", appKey: "a", timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(DatadogError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});
