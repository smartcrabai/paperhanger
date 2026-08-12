import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { createTelemetryTools } from "./tools";

const ENV_KEYS = [
	"PAPERHANGER_TELEMETRY_CALLBACK_URL",
	"PAPERHANGER_TELEMETRY_CALLBACK_TOKEN",
	"PAPERHANGER_TELEMETRY_CALLBACK_SOURCE",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("createTelemetryTools", () => {
	test("returns [] when no callback env vars are set", () => {
		expect(createTelemetryTools()).toEqual([]);
	});

	test.each([
		["PAPERHANGER_TELEMETRY_CALLBACK_URL"],
		["PAPERHANGER_TELEMETRY_CALLBACK_TOKEN"],
		["PAPERHANGER_TELEMETRY_CALLBACK_SOURCE"],
	])("returns [] when only %s is missing", (missingKey) => {
		for (const key of ENV_KEYS) {
			if (key !== missingKey) process.env[key] = "value";
		}
		expect(createTelemetryTools()).toEqual([]);
	});

	test("returns a single query_telemetry tool when all three callback env vars are set", () => {
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_URL =
			"http://parent/telemetry/query";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN = "cb-secret-token";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE = "zabbix";

		const tools = createTelemetryTools();
		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("query_telemetry");
		expect(tools[0]?.description).toContain("Zabbix");
	});

	test("input schema accepts a minimal request and rejects an invalid signal", () => {
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_URL =
			"http://parent/telemetry/query";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN = "cb-secret-token";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE = "greptimedb";
		const tool = createTelemetryTools()[0];
		if (!tool?.input) throw new Error("expected an input schema");

		const valid = v.safeParse(tool.input, {
			signal: "logs",
			timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:05:00Z" },
			filter: { service: "checkout" },
		});
		expect(valid.success).toBe(true);

		const invalid = v.safeParse(tool.input, {
			signal: "not-a-signal",
			timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:05:00Z" },
		});
		expect(invalid.success).toBe(false);
	});

	test("output schema accepts the shape returned by the parent's callback route", () => {
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_URL =
			"http://parent/telemetry/query";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN = "cb-secret-token";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE = "greptimedb";
		const tool = createTelemetryTools()[0];
		if (!tool?.output) throw new Error("expected an output schema");

		const result = v.safeParse(tool.output, {
			logs: [{ body: "boom" }],
			truncated: false,
			notes: [],
		});
		expect(result.success).toBe(true);
	});

	test("run() POSTs to the configured callback URL and returns its response as `output`", async () => {
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_URL =
			"http://parent/telemetry/query";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN = "cb-secret-token";
		process.env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE = "greptimedb";
		const originalFetch = globalThis.fetch;
		let capturedAuth: string | null = null;
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			capturedAuth =
				(init?.headers as Record<string, string> | undefined)?.Authorization ??
				null;
			return new Response(
				JSON.stringify({ logs: [], truncated: false, notes: [] }),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const tool = createTelemetryTools()[0];
			if (!tool) throw new Error("expected a tool");
			const result = await tool.run({
				toolCallId: "call-1",
				log: () => {},
				data: {
					signal: "logs",
					timeRange: {
						from: "2026-01-01T00:00:00Z",
						to: "2026-01-01T00:05:00Z",
					},
				},
				// biome-ignore lint/suspicious/noExplicitAny: ToolContext's exact generic instantiation isn't worth spelling out in a test
			} as any);
			expect(capturedAuth).toBe("Bearer cb-secret-token");
			expect(result).toEqual({
				output: { logs: [], truncated: false, notes: [] },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
