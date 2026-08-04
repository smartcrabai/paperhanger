import { describe, expect, test } from "bun:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createLogger } from "../observability/logger";
import { NewRelicError, NewRelicSource } from "./newrelic";

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

function nrqlResponse(results: Record<string, unknown>[]): Response {
	return new Response(
		JSON.stringify({ data: { actor: { account: { nrql: { results } } } } }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("NewRelicSource - config and auth", () => {
	test("sends the Api-Key header and defaults to the US NerdGraph endpoint", async () => {
		const { fetchImpl, calls } = stubFetch(() => nrqlResponse([]));
		const source = new NewRelicSource(
			{ apiKey: "NRAK-secret", accountId: 12345 },
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
		expect(calls[0]?.url).toBe("https://api.newrelic.com/graphql");
		expect(calls[0]?.headers["Api-Key"]).toBe("NRAK-secret");
	});

	test("uses the EU NerdGraph endpoint when region is EU", async () => {
		const { fetchImpl, calls } = stubFetch(() => nrqlResponse([]));
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1, region: "EU" },
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

		expect(calls[0]?.url).toBe("https://api.eu.newrelic.com/graphql");
	});
});

describe("NewRelicSource - query construction", () => {
	test("queryLogs builds an NRQL WHERE clause from service/severity conventions and escapes single quotes", async () => {
		const { fetchImpl, calls } = stubFetch(() => nrqlResponse([]));
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout's api", severity: "error" },
			limit: 25,
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.variables.accountId).toBe(1);
		const nrql = body.variables.nrql as string;
		expect(nrql).toContain("FROM Log");
		expect(nrql).toContain("service.name = 'checkout\\'s api'");
		expect(nrql).toContain("level = 'ERROR'");
		expect(nrql).toContain("LIMIT 25");
	});

	test("queryTraces builds a trace.id IN (...) clause with no time filter conflict when trace_id labels are given", async () => {
		const { fetchImpl, calls } = stubFetch(() => nrqlResponse([]));
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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
		const nrql = body.variables.nrql as string;
		expect(nrql).toContain("FROM Span");
		expect(nrql).toContain("trace.id IN ('abc123', 'def456')");
	});

	test("queryTraces without a trace_id filters by entity.name and error-or-slow", async () => {
		const { fetchImpl, calls } = stubFetch(() => nrqlResponse([]));
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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

		const nrql = JSON.parse(calls[0]?.body ?? "{}").variables.nrql as string;
		expect(nrql).toContain("entity.name = 'checkout'");
		expect(nrql).toContain("error is true OR duration > 0.05");
	});
});

describe("NewRelicSource - response parsing", () => {
	test("queryLogs maps a realistic NRQL result into LogRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			nrqlResponse([
				{
					timestamp: 1784258863219,
					level: "ERROR",
					message: "database connection timeout",
					"service.name": "checkout",
					"trace.id": "3d4b2df34204eb410b75a498e9a53090",
					"span.id": "effaab75e5a7621a",
				},
			]),
		);
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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
		expect(logs[0]?.severityText).toBe("ERROR");
		expect(logs[0]?.severityNumber).toBe(17);
		expect(logs[0]?.body).toBe("database connection timeout");
		expect(logs[0]?.traceId).toBe("3d4b2df34204eb410b75a498e9a53090");
		expect(logs[0]?.serviceName).toBe("checkout");
	});

	test("queryTraces converts New Relic's seconds-based duration into nanoseconds", async () => {
		const { fetchImpl } = stubFetch(() =>
			nrqlResponse([
				{
					"trace.id": "3d4b2df34204eb410b75a498e9a53090",
					id: "effaab75e5a7621a",
					"parent.id": "0000000000000000",
					name: "GET /api/orders",
					category: "http",
					"entity.name": "checkout",
					timestamp: 1784258863219,
					duration: 0.123557166,
					error: true,
				},
			]),
		);
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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
		expect(spans[0]?.durationNano).toBe(123557166);
		expect(spans[0]?.statusCode).toBe("STATUS_CODE_ERROR");
	});
});

describe("NewRelicSource - metrics", () => {
	test("queryMetrics returns an empty array and does not call fetch when no NRQL query string is given", async () => {
		const { fetchImpl, calls } = stubFetch(() => nrqlResponse([]));
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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

	test("queryMetrics runs the given NRQL and maps TIMESERIES-shaped rows into MetricSeries points", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			nrqlResponse([
				{ beginTimeSeconds: 1784258920, "average.value": 0.5 },
				{ beginTimeSeconds: 1784258935, "average.value": 0.8 },
			]),
		);
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "checkout" },
			promql:
				"SELECT average(newrelic.timeslice.value) FROM Metric WHERE metricTimesliceName = 'Custom/Foo' TIMESERIES",
		});

		expect(calls.length).toBe(1);
		expect(series.length).toBe(1);
		expect(series[0]?.labels).toEqual({ service: "checkout" });
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920000).toISOString(), value: 0.5 },
			{ timestamp: new Date(1784258935000).toISOString(), value: 0.8 },
		]);
	});
});

describe("NewRelicSource - error mapping", () => {
	test("maps a GraphQL-level errors[] into a NewRelicError even on HTTP 200", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({ errors: [{ message: "Invalid NRQL syntax" }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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
		expect(caught).toBeInstanceOf(NewRelicError);
		expect((caught as NewRelicError).message).toContain("Invalid NRQL syntax");
	});

	test("maps a non-2xx HTTP response into a NewRelicError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({ errors: [{ message: "Unauthorized" }] }),
					{
						status: 401,
					},
				),
		);
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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
		).rejects.toMatchObject({ httpStatus: 401 });
	});

	test("maps a non-JSON error body to a NewRelicError, not a raw SyntaxError", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response("<html>502 Bad Gateway</html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			})) as typeof fetch;
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1 },
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
		expect(caught).toBeInstanceOf(NewRelicError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});

	test("never includes the API key in a thrown error message", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(JSON.stringify({ errors: [{ message: "auth failed" }] }), {
					status: 403,
				}),
		);
		const source = new NewRelicSource(
			{ apiKey: "NRAK-super-secret-key", accountId: 1 },
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
		expect((caught as NewRelicError).message).not.toContain("super-secret");
	});
});

describe("NewRelicSource - request timeout", () => {
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
		const source = new NewRelicSource(
			{ apiKey: "k", accountId: 1, timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(NewRelicError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});
