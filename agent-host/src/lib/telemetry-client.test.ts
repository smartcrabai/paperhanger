import { describe, expect, test } from "bun:test";
import { queryTelemetry } from "./telemetry-client";

const CONFIG = {
	url: "http://parent.internal/telemetry/query",
	token: "cb-secret-token",
	source: "greptimedb",
};

describe("queryTelemetry", () => {
	test("POSTs the request body and Authorization header to the configured callback URL", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedInit = init;
			return new Response(
				JSON.stringify({ logs: [], truncated: false, notes: [] }),
				{ status: 200 },
			);
		}) as typeof fetch;

		const input = {
			signal: "logs" as const,
			timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:05:00Z" },
			filter: { service: "checkout" },
		};
		await queryTelemetry(CONFIG, input, fetchImpl);

		expect(capturedUrl).toBe(CONFIG.url);
		expect(capturedInit?.method).toBe("POST");
		expect(
			(capturedInit?.headers as Record<string, string> | undefined)
				?.Authorization,
		).toBe(`Bearer ${CONFIG.token}`);
		expect(JSON.parse(capturedInit?.body as string)).toEqual(input);
	});

	test("returns the parsed response on success", async () => {
		const body = {
			logs: [{ body: "boom" }],
			truncated: true,
			notes: ["dropped some rows"],
		};
		const fetchImpl = (async () =>
			new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

		const result = await queryTelemetry(
			CONFIG,
			{
				signal: "logs",
				timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:05:00Z" },
			},
			fetchImpl,
		);
		expect(result).toEqual(body);
	});

	test("throws on a non-2xx response, without leaking the bearer token", async () => {
		const fetchImpl = (async () =>
			new Response("backend unavailable", { status: 502 })) as typeof fetch;

		await expect(
			queryTelemetry(
				CONFIG,
				{
					signal: "logs",
					timeRange: {
						from: "2026-01-01T00:00:00Z",
						to: "2026-01-01T00:05:00Z",
					},
				},
				fetchImpl,
			),
		).rejects.toThrow(/502/);
		try {
			await queryTelemetry(
				CONFIG,
				{
					signal: "logs",
					timeRange: {
						from: "2026-01-01T00:00:00Z",
						to: "2026-01-01T00:05:00Z",
					},
				},
				fetchImpl,
			);
		} catch (err) {
			expect((err as Error).message).not.toContain(CONFIG.token);
		}
	});

	test("throws when the response body is not valid JSON", async () => {
		const fetchImpl = (async () =>
			new Response("not json", { status: 200 })) as typeof fetch;

		await expect(
			queryTelemetry(
				CONFIG,
				{
					signal: "logs",
					timeRange: {
						from: "2026-01-01T00:00:00Z",
						to: "2026-01-01T00:05:00Z",
					},
				},
				fetchImpl,
			),
		).rejects.toThrow(/JSON/);
	});
});
