import { describe, expect, test } from "bun:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createLogger } from "../observability/logger";
import { GrafanaError, GrafanaSource } from "./grafana";

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

function dsQueryResponse(results: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ results }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const baseConfig = {
	url: "https://grafana.example.com",
	serviceAccountToken: "glsa_secret",
	lokiDatasourceUid: "loki-uid",
	tempoDatasourceUid: "tempo-uid",
	prometheusDatasourceUid: "prom-uid",
};

describe("GrafanaSource - config and auth", () => {
	test("sends Authorization: Bearer <token> and posts to /api/ds/query", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ A: { frames: [] } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://grafana.example.com/api/ds/query");
		expect(calls[0]?.headers.Authorization).toBe("Bearer glsa_secret");
	});

	test("strips a trailing slash from the base URL", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ A: { frames: [] } }),
		);
		const source = new GrafanaSource(
			{ ...baseConfig, url: "https://grafana.example.com/" },
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

		expect(calls[0]?.url).toBe("https://grafana.example.com/api/ds/query");
	});
});

describe("GrafanaSource - query construction", () => {
	test("queryLogs builds a LogQL selector against the Loki datasource UID", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ A: { frames: [] } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: 'checkout"api' },
			limit: 25,
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.queries[0].datasource.uid).toBe("loki-uid");
		expect(body.queries[0].expr).toBe('{service_name="checkout\\"api"}');
		expect(body.queries[0].maxLines).toBe(25);
		expect(body.from).toBe(
			String(new Date("2026-01-01T00:00:00.000Z").getTime()),
		);
		expect(body.to).toBe(
			String(new Date("2026-01-01T01:00:00.000Z").getTime()),
		);
	});

	test("queryLogs falls back to a catch-all selector when no service label resolves", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ A: { frames: [] } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.queries[0].expr).toBe('{job=~".+"}');
	});

	test("queryTraces issues one sub-query per trace id against the Tempo datasource UID", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ abc123: { frames: [] }, def456: { frames: [] } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { trace_id: "abc123,def456" },
		});

		expect(calls.length).toBe(1);
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.queries.length).toBe(2);
		expect(body.queries[0]).toMatchObject({
			refId: "abc123",
			queryType: "traceql",
			query: "abc123",
			datasource: { uid: "tempo-uid" },
		});
	});

	test("queryTraces without a trace_id builds a TraceQL search expression", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ search: { frames: [] } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.queries[0].queryType).toBe("traceql");
		expect(body.queries[0].query).toContain(
			'resource.service.name = "checkout"',
		);
		expect(body.queries[0].query).toContain(
			"status = error || duration > 50ms",
		);
	});

	test("queryMetrics sends the given PromQL expr against the Prometheus datasource UID", async () => {
		const { fetchImpl, calls } = stubFetch(() =>
			dsQueryResponse({ A: { frames: [] } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: 'rate(http_requests_total{service="checkout"}[1m])',
		});

		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.queries[0].datasource.uid).toBe("prom-uid");
		expect(body.queries[0].expr).toBe(
			'rate(http_requests_total{service="checkout"}[1m])',
		);
		expect(body.queries[0].range).toBe(true);
	});
});

describe("GrafanaSource - not-configured skips", () => {
	test("queryLogs returns [] without calling fetch when no Loki UID is configured", async () => {
		const { fetchImpl, calls } = stubFetch(() => dsQueryResponse({}));
		const source = new GrafanaSource(
			{ url: baseConfig.url, serviceAccountToken: "t" },
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
		expect(calls.length).toBe(0);
	});

	test("queryTraces returns [] without calling fetch when no Tempo UID is configured", async () => {
		const { fetchImpl, calls } = stubFetch(() => dsQueryResponse({}));
		const source = new GrafanaSource(
			{ url: baseConfig.url, serviceAccountToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		const traces = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: {},
		});
		expect(traces).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("queryMetrics returns [] when no Prometheus UID is configured, even with a promql hint", async () => {
		const { fetchImpl, calls } = stubFetch(() => dsQueryResponse({}));
		const source = new GrafanaSource(
			{ url: baseConfig.url, serviceAccountToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "up",
		});
		expect(series).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("queryMetrics returns [] when Prometheus is configured but no promql hint is given", async () => {
		const { fetchImpl, calls } = stubFetch(() => dsQueryResponse({}));
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

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
});

describe("GrafanaSource - response parsing", () => {
	test("queryLogs maps a Time/Line dataframe into LogRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			dsQueryResponse({
				A: {
					frames: [
						{
							schema: {
								fields: [
									{ name: "Time", type: "time" },
									{
										name: "Line",
										type: "string",
										labels: { service_name: "checkout", level: "error" },
									},
								],
							},
							data: {
								values: [[1784258863219], ["database connection timeout"]],
							},
						},
					],
				},
			}),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		const logs = await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		expect(logs.length).toBe(1);
		expect(logs[0]?.body).toBe("database connection timeout");
		expect(logs[0]?.serviceName).toBe("checkout");
		expect(logs[0]?.severityText).toBe("error");
		expect(logs[0]?.timestamp).toBe(new Date(1784258863219).toISOString());
	});

	test("queryMetrics maps a Time/Value dataframe into a MetricSeries", async () => {
		const { fetchImpl } = stubFetch(() =>
			dsQueryResponse({
				A: {
					frames: [
						{
							schema: {
								refId: "A",
								fields: [
									{ name: "Time", type: "time" },
									{
										name: "Value",
										type: "number",
										labels: {
											__name__: "http_requests_total",
											service: "checkout",
										},
									},
								],
							},
							data: {
								values: [
									[1784258920000, 1784258935000],
									[0, 3],
								],
							},
						},
					],
				},
			}),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "up",
		});

		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("http_requests_total");
		expect(series[0]?.labels).toEqual({ service: "checkout" });
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920000).toISOString(), value: 0 },
			{ timestamp: new Date(1784258935000).toISOString(), value: 3 },
		]);
	});

	test("queryTraces maps a trace-by-id dataframe into TraceRecord[]", async () => {
		const { fetchImpl } = stubFetch(() =>
			dsQueryResponse({
				abc123: {
					frames: [
						{
							schema: {
								fields: [
									{ name: "traceID" },
									{ name: "spanID" },
									{ name: "operationName" },
									{ name: "serviceName" },
									{ name: "startTime" },
									{ name: "duration" },
								],
							},
							data: {
								values: [
									["abc123"],
									["effaab75e5a7621a"],
									["GET /api/orders"],
									["checkout"],
									[1784258863219],
									[123.5],
								],
							},
						},
					],
				},
			}),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

		const spans = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { trace_id: "abc123" },
		});

		expect(spans.length).toBe(1);
		expect(spans[0]?.traceId).toBe("abc123");
		expect(spans[0]?.spanId).toBe("effaab75e5a7621a");
		expect(spans[0]?.name).toBe("GET /api/orders");
		expect(spans[0]?.durationNano).toBe(123_500_000);
	});
});

describe("GrafanaSource - error mapping", () => {
	test("maps a per-query 'error' field into a GrafanaError", async () => {
		const { fetchImpl } = stubFetch(() =>
			dsQueryResponse({ A: { error: "datasource not found" } }),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

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
		expect(caught).toBeInstanceOf(GrafanaError);
		expect((caught as GrafanaError).message).toContain("datasource not found");
	});

	test("maps a non-2xx response into a GrafanaError", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(JSON.stringify({ message: "invalid token" }), {
					status: 401,
				}),
		);
		const source = new GrafanaSource(baseConfig, silentLogger(), fetchImpl);

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

	test("never includes the service account token in a thrown error message", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(JSON.stringify({ message: "auth failed" }), {
					status: 403,
				}),
		);
		const source = new GrafanaSource(
			{ ...baseConfig, serviceAccountToken: "glsa_super_secret_token" },
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
		expect((caught as GrafanaError).message).not.toContain("super_secret");
	});
});

describe("GrafanaSource - request timeout", () => {
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
		const source = new GrafanaSource(
			{ ...baseConfig, timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(GrafanaError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});
