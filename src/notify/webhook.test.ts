import { describe, expect, test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../observability/logger";
import type { IncidentSnapshot, NotificationEvent } from "./types";
import { NotifierResponseError } from "./types";
import { WebhookNotifier } from "./webhook";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

interface FetchCall {
	url: string;
	init?: RequestInit;
	body: unknown;
}

function mockFetch(response: Response): {
	fetchImpl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({
			url: String(input),
			init,
			body: init?.body ? JSON.parse(init.body as string) : undefined,
		});
		return response;
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const incident: IncidentSnapshot = {
	id: "incident-1",
	fingerprint: "fp-abc123",
	severity: "critical",
	title: "High error rate",
	source: "grafana",
};

const WEBHOOK_URL = "https://internal.example.com/hooks/paperhanger";

describe("WebhookNotifier", () => {
	test("has name 'webhook'", () => {
		const notifier = new WebhookNotifier(
			{ type: "webhook", url: WEBHOOK_URL },
			silentLogger(),
		);
		expect(notifier.name).toBe("webhook");
	});

	test("POSTs the NotificationEvent as JSON, unmodified", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new WebhookNotifier(
			{ type: "webhook", url: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl },
		);
		const event: NotificationEvent = {
			kind: "pr_created",
			incident,
			prUrl: "https://github.com/example/repo/pull/1",
			summary: "Fixed the bug.",
		};

		await notifier.notify(event);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(WEBHOOK_URL);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.body).toEqual(event);
	});

	test("sends a content-type: application/json header", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new WebhookNotifier(
			{ type: "webhook", url: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl },
		);

		await notifier.notify({ kind: "skipped", incident, reason: "cooldown" });

		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("content-type")).toBe("application/json");
	});

	test("throws NotifierResponseError and logs an excerpt on a non-2xx response", async () => {
		const { fetchImpl } = mockFetch(
			new Response("internal error", { status: 500 }),
		);
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });
		const notifier = new WebhookNotifier(
			{ type: "webhook", url: WEBHOOK_URL },
			logger,
			{ fetchImpl },
		);

		await expect(
			notifier.notify({ kind: "failed", incident, reason: "agent crashed" }),
		).rejects.toThrow(NotifierResponseError);

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.notifier).toBe("webhook");
		expect(entry.status).toBe(500);
		expect(entry.bodyExcerpt).toBe("internal error");
	});

	test("threads the injected tracer into postJson, producing a notify.post span with component 'webhook'", async () => {
		const { fetchImpl } = mockFetch(new Response("ok", { status: 200 }));
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const notifier = new WebhookNotifier(
			{ type: "webhook", url: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl, tracer: provider.getTracer("test") },
		);

		await notifier.notify({ kind: "diagnosis_started", incident });

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		expect(spans[0]?.name).toBe("notify.post");
		expect(spans[0]?.kind).toBe(SpanKind.CLIENT);
		expect(spans[0]?.attributes["paperhanger.notify.component"]).toBe(
			"webhook",
		);
	});
});
