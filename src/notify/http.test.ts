import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { postJson } from "./http";
import { NotifierResponseError, NotifierTimeoutError } from "./types";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error("expected the promise to reject");
}

describe("postJson - response excerpt truncation", () => {
	test("truncates a response body over 500 characters, in both the thrown error and the log", async () => {
		const longBody = "e".repeat(600);
		const fetchImpl = (async (_input, _init) =>
			new Response(longBody, { status: 500 })) as typeof fetch;
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });

		const err = await captureRejection(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: { a: 1 },
				notifierName: "test",
				logger,
			}),
		);

		expect(err).toBeInstanceOf(NotifierResponseError);
		const bodyExcerpt = (err as NotifierResponseError).bodyExcerpt;
		expect(bodyExcerpt.length).toBe(501); // 500 chars + the "…" marker
		expect(bodyExcerpt.startsWith("e".repeat(500))).toBe(true);
		expect(bodyExcerpt.endsWith("…")).toBe(true);

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.bodyExcerpt.length).toBe(501);
	});

	test("does not truncate a response body at exactly 500 characters", async () => {
		const body = "e".repeat(500);
		const fetchImpl = (async (_input, _init) =>
			new Response(body, { status: 500 })) as typeof fetch;

		const err = await captureRejection(
			postJson({
				fetchImpl,
				url: "https://example.com",
				body: {},
				notifierName: "test",
				logger: silentLogger(),
			}),
		);

		expect((err as NotifierResponseError).bodyExcerpt).toBe(body);
	});

	test("falls back to a placeholder when res.text() rejects", async () => {
		const brokenResponse = {
			ok: false,
			status: 502,
			text: () => Promise.reject(new Error("stream torn down")),
		} as unknown as Response;
		const fetchImpl = (async (_input, _init) => brokenResponse) as typeof fetch;

		const err = await captureRejection(
			postJson({
				fetchImpl,
				url: "https://example.com",
				body: {},
				notifierName: "test",
				logger: silentLogger(),
			}),
		);

		expect(err).toBeInstanceOf(NotifierResponseError);
		expect((err as NotifierResponseError).bodyExcerpt).toBe(
			"(failed to read response body)",
		);
	});
});

describe("postJson - timeout", () => {
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

	test("aborts and throws NotifierTimeoutError once the timeout elapses", async () => {
		const err = await captureRejection(
			postJson({
				fetchImpl: hangingFetch(),
				url: "https://example.com",
				body: {},
				notifierName: "hangy",
				logger: silentLogger(),
				timeoutMs: 10,
			}),
		);

		expect(err).toBeInstanceOf(NotifierTimeoutError);
		expect((err as NotifierTimeoutError).notifierName).toBe("hangy");
		expect((err as NotifierTimeoutError).timeoutMs).toBe(10);
		expect((err as Error).message).toContain("timed out after 10ms");
	});

	test("resolves normally when the response arrives well before the timeout", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response("ok", { status: 200 })) as typeof fetch;

		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com",
				body: {},
				notifierName: "fast",
				logger: silentLogger(),
				timeoutMs: 1000,
			}),
		).resolves.toBeUndefined();
	});

	test("defaults to a 10s timeout when none is provided", async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchImpl = (async (_input, init) => {
			observedSignal = init?.signal ?? undefined;
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		await postJson({
			fetchImpl,
			url: "https://example.com",
			body: {},
			notifierName: "default-timeout",
			logger: silentLogger(),
		});

		expect(observedSignal).toBeDefined();
		expect(observedSignal?.aborted).toBe(false);
	});
});
