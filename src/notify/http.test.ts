import { describe, expect, test } from "bun:test";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../observability/logger";
import { postJson } from "./http";
import { NotifierResponseError, NotifierTimeoutError } from "./types";

// Registered once at module scope so postJson's `context.with(...)` reflects
// in `context.active()`, letting the logger's active-span correlation
// actually kick in -- mirrors the shared hermetic test pattern used across
// this OTel instrumentation work (see src/observability/logger.test.ts).
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

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

describe("postJson - notify.post span", () => {
	function testTracerProvider() {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		return { tracer: provider.getTracer("test"), exporter };
	}

	test("records a CLIENT span with the notify.component attribute and no url attribute on success", async () => {
		const { tracer, exporter } = testTracerProvider();
		const fetchImpl = (async (_input, _init) =>
			new Response("ok", { status: 200 })) as typeof fetch;

		await postJson({
			fetchImpl,
			url: "https://hooks.slack.example/services/T000/B000/xxx",
			body: {},
			notifierName: "slack",
			logger: silentLogger(),
			tracer,
			component: "slack",
		});

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.name).toBe("notify.post");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["paperhanger.notify.component"]).toBe("slack");
		expect(span?.attributes["http.response.status_code"]).toBe(200);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
		// Webhook URLs embed secrets; the span must never carry one.
		expect(Object.keys(span?.attributes ?? {})).not.toContain("url");
		expect(
			Object.values(span?.attributes ?? {}).some(
				(value) =>
					typeof value === "string" && value.includes("hooks.slack.example"),
			),
		).toBe(false);
	});

	test("records a redacted ERROR span status (no recordException) on a non-2xx response", async () => {
		const { tracer, exporter } = testTracerProvider();
		const fetchImpl = (async (_input, _init) =>
			new Response("bad request", { status: 400 })) as typeof fetch;

		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: {},
				notifierName: "webhook",
				logger: silentLogger(),
				tracer,
				component: "webhook",
			}),
		).rejects.toThrow(NotifierResponseError);

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.attributes["http.response.status_code"]).toBe(400);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.status.message).toBe("notifier request failed (status=400)");
		// NotifierResponseError's message embeds the raw response body, so it
		// must never be recorded as an exception event on the span.
		expect(span?.events.some((e) => e.name === "exception")).toBe(false);
	});

	test("never leaks a fragment of the raw response body onto the failing span", async () => {
		const { tracer, exporter } = testTracerProvider();
		const secretBody =
			"internal error: db password=hunter2 at host db.internal.example";
		const fetchImpl = (async (_input, _init) =>
			new Response(secretBody, { status: 500 })) as typeof fetch;

		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: {},
				notifierName: "webhook",
				logger: silentLogger(),
				tracer,
				component: "webhook",
			}),
		).rejects.toThrow(NotifierResponseError);

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const span = spans[0];

		const serializedSpan = JSON.stringify({
			status: span?.status,
			attributes: span?.attributes,
			events: span?.events,
		});
		expect(serializedSpan).not.toContain("hunter2");
		expect(serializedSpan).not.toContain(secretBody);
		expect(span?.events.some((e) => e.name === "exception")).toBe(false);
	});

	test("records an ERROR span status and the exception on timeout", async () => {
		const { tracer, exporter } = testTracerProvider();
		const fetchImpl = (async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}) as typeof fetch;

		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: {},
				notifierName: "discord",
				logger: silentLogger(),
				timeoutMs: 10,
				tracer,
				component: "discord",
			}),
		).rejects.toThrow(NotifierTimeoutError);

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.events.some((e) => e.name === "exception")).toBe(true);
		// No status_code attribute: the request never completed.
		expect(span?.attributes["http.response.status_code"]).toBeUndefined();
	});

	test("falls back to a working no-op tracer (getTracer('notify')) when none is injected", async () => {
		const fetchImpl = (async (_input, _init) =>
			new Response("ok", { status: 200 })) as typeof fetch;

		// No tracer/component passed: must not throw, and the default global
		// no-op tracer means no span is ever recorded anywhere observable here.
		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: {},
				notifierName: "webhook",
				logger: silentLogger(),
			}),
		).resolves.toBeUndefined();
	});
});

describe("postJson - log/span correlation", () => {
	function testTracerProvider() {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		return { tracer: provider.getTracer("test"), exporter };
	}

	test("the notify.http_error log entry carries the notify.post span's traceId/spanId", async () => {
		const { tracer, exporter } = testTracerProvider();
		const fetchImpl = (async (_input, _init) =>
			new Response("bad request", { status: 400 })) as typeof fetch;
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });

		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: {},
				notifierName: "webhook",
				logger,
				tracer,
				component: "webhook",
			}),
		).rejects.toThrow(NotifierResponseError);

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const spanContext = spans[0]?.spanContext();
		expect(spanContext).toBeDefined();

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.msg).toBe("notify.http_error");
		expect(entry.traceId).toBe(spanContext?.traceId);
		expect(entry.spanId).toBe(spanContext?.spanId);
	});

	test("the notify.timeout log entry carries the notify.post span's traceId/spanId", async () => {
		const { tracer, exporter } = testTracerProvider();
		const fetchImpl = (async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}) as typeof fetch;
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });

		await expect(
			postJson({
				fetchImpl,
				url: "https://example.com/hook",
				body: {},
				notifierName: "hangy",
				logger,
				timeoutMs: 10,
				tracer,
				component: "webhook",
			}),
		).rejects.toThrow(NotifierTimeoutError);

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		const spanContext = spans[0]?.spanContext();
		expect(spanContext).toBeDefined();

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.msg).toBe("notify.timeout");
		expect(entry.traceId).toBe(spanContext?.traceId);
		expect(entry.spanId).toBe(spanContext?.spanId);
	});
});
