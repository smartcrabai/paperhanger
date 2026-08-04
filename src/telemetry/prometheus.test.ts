import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { PrometheusError, PrometheusSource } from "./prometheus";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

/** A logger whose sink captures each emitted JSON line for correlation assertions. */
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

describe("PrometheusSource - PromQL metrics", () => {
	test("issues a GET with query params (not a body) and parses a matrix response", async () => {
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
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "paperhanger-test-svc" },
			promql: 'rate(http_requests_total{job="paperhanger-test-svc"}[1m])',
		});

		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.body).toBeUndefined();
		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/api/v1/query_range");
		expect(url.searchParams.get("query")).toBe(
			'rate(http_requests_total{job="paperhanger-test-svc"}[1m])',
		);
		expect(url.searchParams.get("start")).toBeTruthy();
		expect(url.searchParams.get("end")).toBeTruthy();
		expect(url.searchParams.get("step")).toMatch(/^\d+s$/);
		// No `db` query param -- that's a GreptimeDB PromQL-compat detail, not
		// part of the real Prometheus HTTP API.
		expect(url.searchParams.has("db")).toBe(false);

		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("http_requests_total");
		expect(series[0]?.labels).toEqual({
			job: "paperhanger-test-svc",
			status: "200",
		});
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920000).toISOString(), value: 0 },
			{ timestamp: new Date(1784258935000).toISOString(), value: 3 },
		]);
	});

	test("returns an empty array and does not call fetch when no promql is given", async () => {
		const { fetchImpl, calls } = stubFetch(
			() => new Response("{}", { status: 200 }),
		);
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
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

	test("logs a warning (correlatable) when called without a promql expression", async () => {
		const { fetchImpl } = stubFetch(() => new Response("{}", { status: 200 }));
		const { logger, lines } = capturingLogger();
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
			logger,
			fetchImpl,
		);

		await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
		});

		const entries = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		const warnEntry = entries.find((entry) => entry.level === "warn");
		expect(warnEntry?.msg).toBe(
			"queryMetrics called without a PromQL expression; returning no series",
		);
	});

	test("maps a PromQL error response to PrometheusError", async () => {
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
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
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

	test("maps a non-JSON response body to PrometheusError, not a raw SyntaxError", async () => {
		function htmlErrorFetch(): typeof fetch {
			return (async (_input, _init) =>
				new Response("<html><body>502 Bad Gateway</body></html>", {
					status: 502,
					headers: { "Content-Type": "text/html" },
				})) as typeof fetch;
		}
		const fetchImpl = htmlErrorFetch();
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
			silentLogger(),
			fetchImpl,
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
		expect(caught).toBeInstanceOf(PrometheusError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
		expect((caught as PrometheusError).httpStatus).toBe(502);
	});

	test("a hanging request throws a typed timeout error instead of hanging forever", async () => {
		const source = new PrometheusSource(
			{ url: "http://prometheus.test", timeoutMs: 15 },
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
		expect(caught).toBeInstanceOf(PrometheusError);
		expect((caught as Error).message).toContain("timed out after 15ms");
	});
});

describe("PrometheusSource - auth headers", () => {
	test("basic auth header is set only when configured", async () => {
		const { fetchImpl, calls } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "success",
						data: { resultType: "matrix", result: [] },
					}),
					{
						status: 200,
					},
				),
		);
		const withAuth = new PrometheusSource(
			{ url: "http://prometheus.test", auth: "user:pass" },
			silentLogger(),
			fetchImpl,
		);
		await withAuth.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "up",
		});
		expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa("user:pass")}`);

		const { fetchImpl: fetchImpl2, calls: calls2 } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "success",
						data: { resultType: "matrix", result: [] },
					}),
					{
						status: 200,
					},
				),
		);
		const withoutAuth = new PrometheusSource(
			{ url: "http://prometheus.test" },
			silentLogger(),
			fetchImpl2,
		);
		await withoutAuth.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "up",
		});
		expect(calls2[0]?.headers.Authorization).toBeUndefined();
	});
});

describe("PrometheusSource - graceful degradation for unsupported signals", () => {
	test("queryLogs logs a warning and returns no logs without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(
			() => new Response("{}", { status: 200 }),
		);
		const { logger, lines } = capturingLogger();
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
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

	test("queryTraces logs a warning and returns no spans without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(
			() => new Response("{}", { status: 200 }),
		);
		const source = new PrometheusSource(
			{ url: "http://prometheus.test" },
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
});
