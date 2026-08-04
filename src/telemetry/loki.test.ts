import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { LokiError, LokiSource } from "./loki";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

/** A logger whose sink captures each emitted JSON line for assertions (e.g. graceful-degradation warnings). */
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
			headers,
		};
		calls.push(req);
		return responder(req);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function queryRangeSuccess(result: unknown[]): Response {
	return new Response(
		JSON.stringify({
			status: "success",
			data: { resultType: "streams", result },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("LokiSource - LogQL construction", () => {
	test("resolves a service label into a stream selector", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout" },
		});

		expect(calls.length).toBe(1);
		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/loki/api/v1/query_range");
		expect(url.searchParams.get("query")).toBe('{service_name="checkout"}');
		expect(url.searchParams.get("direction")).toBe("backward");
		expect(url.searchParams.get("limit")).toBe("100");
	});

	test("falls back to a wildcard service_name matcher when no service label resolves", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
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

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("query")).toBe('{service_name=~".+"}');
	});

	test("applies the ERROR severity threshold via the 'severity' convention", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
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

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("query")).toBe(
			'{service_name="checkout"} | severity_number >= 17',
		);
	});

	test("maps a non-error severity value to a severity_text equality filter", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { severity: "WARN" },
		});

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("query")).toBe(
			'{service_name=~".+"} | severity_text="WARN"',
		);
	});

	test("escapes a double quote in a malicious label value", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: 'evil"} | line_format "pwned' },
		});

		const url = new URL(calls[0]?.url ?? "");
		const query = url.searchParams.get("query") ?? "";
		expect(query).toContain('\\"} | line_format \\"pwned');
	});

	test("treats an arbitrary label key as a structured-metadata equality filter", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
			silentLogger(),
			fetchImpl,
		);

		await source.queryLogs({
			timeRange: {
				from: "2026-01-01T00:00:00.000Z",
				to: "2026-01-01T01:00:00.000Z",
			},
			labels: { service: "checkout", deployment_environment: "prod" },
		});

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("query")).toBe(
			'{service_name="checkout"} | deployment_environment="prod"',
		);
	});

	test("rejects an invalid (non-whitelisted) metadata key", async () => {
		const { fetchImpl } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
		).rejects.toThrow(/Invalid LogQL label\/metadata name/);
	});

	test("sends nanosecond-epoch start/end query params", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
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

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("start")).toBe("1767225600000000000");
		expect(url.searchParams.get("end")).toBe("1767229200000000000");
	});
});

describe("LokiSource - auth headers", () => {
	test("basic auth and X-Scope-OrgID headers are set only when configured", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const withAuth = new LokiSource(
			{ url: "http://loki.test", auth: "user:pass", orgId: "tenant-a" },
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
		expect(calls[0]?.headers["X-Scope-OrgID"]).toBe("tenant-a");

		const { fetchImpl: fetchImpl2, calls: calls2 } = stubFetch(() =>
			queryRangeSuccess([]),
		);
		const withoutAuth = new LokiSource(
			{ url: "http://loki.test" },
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
		expect(calls2[0]?.headers["X-Scope-OrgID"]).toBeUndefined();
	});
});

describe("LokiSource - response parsing", () => {
	test("parses a realistic streams response into LogRecord[], tolerating an array-shaped metadata tuple", async () => {
		const { fetchImpl } = stubFetch(() =>
			queryRangeSuccess([
				{
					stream: {
						service_name: "paperhanger-test-svc",
						deployment_environment: "test",
					},
					values: [
						[
							"1784258863219000000",
							"database connection timeout after 30s",
							[
								{ name: "severity_text", value: "ERROR" },
								{ name: "severity_number", value: "17" },
								{ name: "trace_id", value: "3d4b2df34204eb410b75a498e9a53090" },
								{ name: "span_id", value: "effaab75e5a7621a" },
							],
						],
						["1784258000000000000", "startup complete", []],
					],
				},
			]),
		);
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
		expect(logs[0]?.resourceAttributes.deployment_environment).toBe("test");
		expect(typeof logs[0]?.timestamp).toBe("string");
		expect(new Date(logs[0]?.timestamp as string).toString()).not.toBe(
			"Invalid Date",
		);

		// No metadata at all -> no trace correlation, severity falls back to "".
		expect(logs[1]?.traceId).toBeUndefined();
		expect(logs[1]?.spanId).toBeUndefined();
		expect(logs[1]?.severityText).toBe("");
		expect(logs[1]?.severityNumber).toBe(0);
	});

	test("tolerates a plain-object metadata shape (not an array of {name,value})", async () => {
		const { fetchImpl } = stubFetch(() =>
			queryRangeSuccess([
				{
					stream: { service_name: "svc" },
					values: [
						[
							"1784258863219000000",
							"boom",
							{ severity_text: "ERROR", trace_id: "abc123" },
						],
					],
				},
			]),
		);
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
		expect(logs[0]?.severityText).toBe("ERROR");
		expect(logs[0]?.traceId).toBe("abc123");
	});

	test("derives a severity number from severity_text when severity_number is absent", async () => {
		const { fetchImpl } = stubFetch(() =>
			queryRangeSuccess([
				{
					stream: { service_name: "svc" },
					values: [
						[
							"1784258863219000000",
							"careful",
							[{ name: "severity_text", value: "WARN" }],
						],
					],
				},
			]),
		);
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
		expect(logs[0]?.severityNumber).toBe(13);
	});
});

describe("LokiSource - error mapping", () => {
	test("maps a non-2xx response into a LokiError with httpStatus", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						status: "error",
						error: "unauthorized",
						errorType: "auth",
					}),
					{ status: 401 },
				),
		);
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
		expect(caught).toBeInstanceOf(LokiError);
		expect((caught as LokiError).httpStatus).toBe(401);
		expect((caught as LokiError).message).toContain("unauthorized");
	});

	test("maps a status=success but non-JSON body into a LokiError, not a raw SyntaxError", async () => {
		function htmlErrorFetch(): typeof fetch {
			return (async (_input, _init) =>
				new Response("<html>502 Bad Gateway</html>", {
					status: 502,
				})) as typeof fetch;
		}
		const fetchImpl = htmlErrorFetch();
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
		expect(caught).toBeInstanceOf(LokiError);
		expect(caught).not.toBeInstanceOf(SyntaxError);
		expect((caught as LokiError).httpStatus).toBe(502);
	});

	test("a hanging request throws a typed timeout error instead of hanging forever", async () => {
		const source = new LokiSource(
			{ url: "http://loki.test", timeoutMs: 10 },
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
		expect(caught).toBeInstanceOf(LokiError);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});
});

describe("LokiSource - graceful degradation for unsupported signals", () => {
	test("queryTraces logs a warning and returns no spans without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const { logger, lines } = capturingLogger();
		const source = new LokiSource(
			{ url: "http://loki.test" },
			logger,
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
		const entries = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		expect(entries.some((e) => e.level === "warn")).toBe(true);
	});

	test("queryMetrics logs a warning and returns no series without calling fetch", async () => {
		const { fetchImpl, calls } = stubFetch(() => queryRangeSuccess([]));
		const source = new LokiSource(
			{ url: "http://loki.test" },
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
