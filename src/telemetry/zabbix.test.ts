import { describe, expect, test } from "bun:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createLogger } from "../observability/logger";
import { ZabbixError, ZabbixSource } from "./zabbix";

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

/** Sequential JSON-RPC method responder: each call in `responders` handles one `method.name` in order. */
function stubJsonRpc(handlers: Record<string, (params: unknown) => unknown>) {
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
		const bodyText = typeof init?.body === "string" ? init.body : "{}";
		calls.push({ url, method: init?.method ?? "GET", body: bodyText, headers });
		const parsed = JSON.parse(bodyText) as {
			method: string;
			params: unknown;
			id: number;
		};
		const handler = handlers[parsed.method];
		if (!handler) {
			throw new Error(`no handler stubbed for Zabbix method ${parsed.method}`);
		}
		const result = handler(parsed.params);
		return new Response(
			JSON.stringify({ jsonrpc: "2.0", result, id: parsed.id }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe("ZabbixSource - config and auth", () => {
	test("sends Authorization: Bearer <token> and posts to <url>/api_jsonrpc.php", async () => {
		const { fetchImpl, calls } = stubJsonRpc({ "event.get": () => [] });
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com/zabbix", apiToken: "zbx-token" },
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
			"https://zabbix.example.com/zabbix/api_jsonrpc.php",
		);
		expect(calls[0]?.headers.Authorization).toBe("Bearer zbx-token");
		expect(calls[0]?.headers["Content-Type"]).toBe("application/json-rpc");
	});

	test("strips a trailing slash before appending /api_jsonrpc.php", async () => {
		const { fetchImpl, calls } = stubJsonRpc({ "event.get": () => [] });
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com/zabbix/", apiToken: "t" },
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
			"https://zabbix.example.com/zabbix/api_jsonrpc.php",
		);
	});
});

describe("ZabbixSource - queryLogs (event.get)", () => {
	test("resolves hostids via host.get before calling event.get when a service label is given", async () => {
		let eventGetParams: unknown;
		const { fetchImpl, calls } = stubJsonRpc({
			"host.get": () => [{ hostid: "10105" }],
			"event.get": (params) => {
				eventGetParams = params;
				return [];
			},
		});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout", severity: "error" },
			limit: 10,
		});

		expect(calls.length).toBe(2);
		expect(eventGetParams).toMatchObject({
			hostids: ["10105"],
			severities: [3, 4, 5],
			limit: 10,
		});
	});

	test("returns no events (and skips event.get) when the service label resolves to no host", async () => {
		const { fetchImpl, calls } = stubJsonRpc({
			"host.get": () => [],
			"event.get": () => {
				throw new Error("should not be called");
			},
		});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		const logs = await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "nonexistent" },
		});

		expect(logs).toEqual([]);
		expect(calls.length).toBe(1);
	});

	test("maps a realistic event.get response into LogRecord[]", async () => {
		const { fetchImpl } = stubJsonRpc({
			"event.get": () => [
				{
					eventid: "5001",
					clock: "1784258863",
					name: "Checkout API: too many HTTP 5xx errors",
					severity: "4",
					value: "1",
					objectid: "301",
					hosts: [
						{ hostid: "10105", host: "checkout-01", name: "checkout-01" },
					],
				},
			],
		});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
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
		expect(logs[0]?.body).toBe("Checkout API: too many HTTP 5xx errors");
		expect(logs[0]?.severityText).toBe("High");
		expect(logs[0]?.severityNumber).toBe(17);
		expect(logs[0]?.serviceName).toBe("checkout-01");
		expect(logs[0]?.timestamp).toBe(new Date(1784258863 * 1000).toISOString());
	});
});

describe("ZabbixSource - queryTraces", () => {
	test("always returns [] without calling fetch (no distributed tracing concept)", async () => {
		const { fetchImpl, calls } = stubJsonRpc({});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
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

describe("ZabbixSource - queryMetrics (item.get + history.get)", () => {
	test("returns [] and calls no RPC methods when either the service label or item-key hint is missing", async () => {
		const { fetchImpl, calls } = stubJsonRpc({});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
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
			promql: "system.cpu.util",
		});

		expect(withoutHint).toEqual([]);
		expect(withoutService).toEqual([]);
		expect(calls.length).toBe(0);
	});

	test("resolves host -> item -> history and maps a numeric item's history into one MetricSeries", async () => {
		const { fetchImpl, calls } = stubJsonRpc({
			"host.get": () => [{ hostid: "10105" }],
			"item.get": () => [
				{
					itemid: "42",
					key_: "system.cpu.util",
					name: "CPU utilization",
					value_type: "0",
				},
			],
			"history.get": () => [
				{ itemid: "42", clock: "1784258920", value: "12.5" },
				{ itemid: "42", clock: "1784258935", value: "18.2" },
			],
		});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "checkout" },
			promql: "system.cpu.util",
		});

		expect(calls.length).toBe(3);
		expect(series.length).toBe(1);
		expect(series[0]?.name).toBe("CPU utilization");
		expect(series[0]?.labels).toEqual({ host: "checkout" });
		expect(series[0]?.points).toEqual([
			{ timestamp: new Date(1784258920 * 1000).toISOString(), value: 12.5 },
			{ timestamp: new Date(1784258935 * 1000).toISOString(), value: 18.2 },
		]);
	});

	test("returns [] when the matched item is not numeric (e.g. a log/text item)", async () => {
		const { fetchImpl } = stubJsonRpc({
			"host.get": () => [{ hostid: "10105" }],
			"item.get": () => [
				{ itemid: "43", key_: "log[/var/log/app.log]", value_type: "2" },
			],
			"history.get": () => {
				throw new Error("should not be called for a non-numeric item");
			},
		});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "checkout" },
			promql: "log[/var/log/app.log]",
		});

		expect(series).toEqual([]);
	});

	test("returns [] when no item matches the given key on the resolved host", async () => {
		const { fetchImpl } = stubJsonRpc({
			"host.get": () => [{ hostid: "10105" }],
			"item.get": () => [],
		});
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
			silentLogger(),
			fetchImpl,
		);

		const series = await source.queryMetrics({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T00:05:00.000Z",
			},
			labels: { service: "checkout" },
			promql: "nonexistent.key",
		});

		expect(series).toEqual([]);
	});
});

describe("ZabbixSource - error mapping", () => {
	test("maps a JSON-RPC error field into a ZabbixError with code/message", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32602,
						message: "Invalid params.",
						data: 'The "hostids" parameter is missing.',
					},
					id: 1,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)) as typeof fetch;
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
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
		expect(caught).toBeInstanceOf(ZabbixError);
		const err = caught as ZabbixError;
		expect(err.code).toBe(-32602);
		expect(err.message).toContain("Invalid params.");
		expect(err.message).toContain('The "hostids" parameter is missing.');
	});

	test("maps a non-JSON error body to a ZabbixError, not a raw SyntaxError", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response("<html>502 Bad Gateway</html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			})) as typeof fetch;
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t" },
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
		expect(caught).toBeInstanceOf(ZabbixError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
	});

	test("never includes the API token in a thrown error message", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32500, message: "Not authorized" },
					id: 1,
				}),
				{ status: 200 },
			)) as typeof fetch;
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "super-secret-zbx-token" },
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
		expect((caught as ZabbixError).message).not.toContain("super-secret");
	});
});

describe("ZabbixSource - request timeout", () => {
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
		const source = new ZabbixSource(
			{ url: "https://zabbix.example.com", apiToken: "t", timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(ZabbixError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});
