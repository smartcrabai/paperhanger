import { describe, expect, test } from "bun:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createLogger } from "../observability/logger";
import { MackerelError, MackerelSource } from "./mackerel";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

function silentLogger() {
	return createLogger({ sink: () => {} });
}

interface RecordedRequest {
	url: string;
	method: string;
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

describe("MackerelSource - config and auth", () => {
	test("sends the X-Api-Key header and defaults to the api.mackerelio.com base URL", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ alerts: [] }));
		const source = new MackerelSource(
			{ apiKey: "mackerel-key" },
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
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toContain("https://api.mackerelio.com/api/v0/alerts");
		expect(calls[0]?.headers["X-Api-Key"]).toBe("mackerel-key");
	});

	test("honors a configured baseUrl override", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({ alerts: [] }));
		const source = new MackerelSource(
			{ apiKey: "k", baseUrl: "https://mackerel.test" },
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

		expect(calls[0]?.url).toContain("https://mackerel.test/api/v0/alerts");
	});
});

describe("MackerelSource - queryLogs (alerts)", () => {
	test("resolves member host ids via hosts?service= before filtering alerts, when a service label is given", async () => {
		const openedAt = Math.floor(
			new Date("2026-01-01T00:30:00.000Z").getTime() / 1000,
		);
		const { fetchImpl, calls } = stubFetch((req) => {
			if (req.url.includes("/api/v0/hosts")) {
				expect(req.url).toContain("service=checkout");
				return jsonResponse({ hosts: [{ id: "host-1" }, { id: "host-2" }] });
			}
			return jsonResponse({
				alerts: [
					{
						id: "alert-1",
						status: "CRITICAL",
						monitorId: "mon-1",
						type: "host",
						hostId: "host-1",
						message: "load average is high",
						openedAt,
					},
					{
						id: "alert-2",
						status: "WARNING",
						monitorId: "mon-2",
						type: "host",
						hostId: "host-other",
						openedAt,
					},
				],
			});
		});
		const source = new MackerelSource(
			{ apiKey: "k" },
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

		expect(calls.length).toBe(2);
		expect(logs.length).toBe(1);
		expect(logs[0]?.body).toBe("load average is high");
	});

	test("filters alerts by openedAt within the requested window", async () => {
		const fromSec = Math.floor(
			new Date("2026-01-01T00:00:00.000Z").getTime() / 1000,
		);
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				alerts: [
					{
						id: "a1",
						status: "CRITICAL",
						type: "service",
						openedAt: fromSec + 60,
					},
					{
						id: "a2",
						status: "CRITICAL",
						type: "service",
						openedAt: fromSec - 3600,
					},
				],
			}),
		);
		const source = new MackerelSource(
			{ apiKey: "k" },
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
	});

	test("maps a realistic alert into a LogRecord with the OTel severity mapping", async () => {
		const openedAt = Math.floor(
			new Date("2026-01-01T00:30:00.000Z").getTime() / 1000,
		);
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({
				alerts: [
					{
						id: "a1",
						status: "CRITICAL",
						monitorId: "mon-1",
						type: "external",
						reason: "timeout",
						openedAt,
					},
				],
			}),
		);
		const source = new MackerelSource(
			{ apiKey: "k" },
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
		expect(logs[0]?.severityText).toBe("CRITICAL");
		expect(logs[0]?.severityNumber).toBe(21);
		expect(logs[0]?.body).toBe("timeout");
		expect(logs[0]?.timestamp).toBe(new Date(openedAt * 1000).toISOString());
	});
});

describe("MackerelSource - queryTraces", () => {
	test("always returns [] without calling fetch (no distributed tracing concept)", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));
		const source = new MackerelSource(
			{ apiKey: "k" },
			silentLogger(),
			fetchImpl,
		);

		const traces = await source.queryTraces({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		expect(traces).toEqual([]);
		expect(calls.length).toBe(0);
	});
});

describe("MackerelSource - queryMetrics (service metrics)", () => {
	test("returns [] and calls no endpoints when either the service label or metric-name hint is missing", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));
		const source = new MackerelSource(
			{ apiKey: "k" },
			silentLogger(),
			fetchImpl,
		);

		const withoutHint = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "checkout" },
		});
		const withoutService = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: {},
			promql: "loadavg5",
		});

		expect(withoutHint).toEqual([]);
		expect(withoutService).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("queries service metrics with name/from/to and maps into a MetricSeries, filtering out null points", async () => {
		const { fetchImpl, calls } = stubFetch((req) => {
			expect(req.url).toContain("/api/v0/services/checkout/metrics");
			expect(req.url).toContain("name=custom.requests.rate");
			return jsonResponse({
				metrics: [
					{ time: 1784258920, value: 0.5 },
					{ time: 1784258935, value: null },
					{ time: 1784258950, value: 0.8 },
				],
			});
		});
		const source = new MackerelSource(
			{ apiKey: "k" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "checkout" },
			promql: "custom.requests.rate",
		});

		expect(calls.length).toBe(1);
		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("custom.requests.rate");
		expect(series[0]?.labels).toEqual({ service: "checkout" });
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920 * 1000).toISOString(), value: 0.5 },
			{ timestamp: new Date(1784258950 * 1000).toISOString(), value: 0.8 },
		]);
	});
});

describe("MackerelSource - error mapping", () => {
	test("maps a non-2xx response with a string error field into a MackerelError", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ error: "Forbidden" }, 403),
		);
		const source = new MackerelSource(
			{ apiKey: "k" },
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
		expect(caught).toBeInstanceOf(MackerelError);
		expect((caught as MackerelError).httpStatus).toBe(403);
		expect((caught as MackerelError).message).toContain("Forbidden");
	});

	test("maps a non-2xx response with an object error field into a MackerelError", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ error: { message: "invalid api key" } }, 401),
		);
		const source = new MackerelSource(
			{ apiKey: "k" },
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

	test("maps a non-JSON error body to a MackerelError, not a raw SyntaxError", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response("<html>502 Bad Gateway</html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			})) as typeof fetch;
		const source = new MackerelSource(
			{ apiKey: "k" },
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
		expect(caught).toBeInstanceOf(MackerelError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});

	test("never includes the API key in a thrown error message", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ error: "auth failed" }, 403),
		);
		const source = new MackerelSource(
			{ apiKey: "super-secret-mackerel-key" },
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
		expect((caught as MackerelError).message).not.toContain("super-secret");
	});
});

describe("MackerelSource - request timeout", () => {
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
		const source = new MackerelSource(
			{ apiKey: "k", timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(MackerelError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});
