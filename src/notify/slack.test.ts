import { describe, expect, test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../observability/logger";
import { DiscordNotifier } from "./discord";
import { SlackNotifier } from "./slack";
import type { IncidentSnapshot, NotificationEvent } from "./types";
import { NotifierResponseError } from "./types";
import { WebhookNotifier } from "./webhook";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

interface FetchCall {
	url: string;
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

const WEBHOOK_URL = "https://hooks.slack.example/services/T000/B000/xxx";

describe("SlackNotifier", () => {
	test("has name 'slack'", () => {
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
		);
		expect(notifier.name).toBe("slack");
	});

	test("posts a header, fields, and body section for diagnosis_started", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl },
		);
		const event: NotificationEvent = { kind: "diagnosis_started", incident };

		await notifier.notify(event);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(WEBHOOK_URL);
		const payload = calls[0]?.body as {
			text: string;
			blocks: Array<Record<string, unknown>>;
		};
		expect(payload.text).toContain("🔍");
		expect(payload.text).toContain("High error rate");

		const header = payload.blocks[0] as {
			type: string;
			text: { text: string };
		};
		expect(header.type).toBe("header");
		expect(header.text.text).toBe("🔍 Diagnosis started");

		const fieldsBlock = payload.blocks[1] as {
			fields: Array<{ text: string }>;
		};
		const fieldTexts = fieldsBlock.fields.map((f) => f.text);
		expect(fieldTexts.some((t) => t.includes("critical"))).toBe(true);
		expect(fieldTexts.some((t) => t.includes("grafana"))).toBe(true);
		expect(fieldTexts.some((t) => t.includes("fp-abc123"))).toBe(true);
	});

	test("includes the PR link as an extra field and the summary as the body for pr_created", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl },
		);
		const event: NotificationEvent = {
			kind: "pr_created",
			incident,
			prUrl: "https://github.com/example/repo/pull/42",
			summary: "Fixed a null pointer dereference in the retry loop.",
		};

		await notifier.notify(event);

		const payload = calls[0]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		const fieldsBlock = payload.blocks[1] as {
			fields: Array<{ text: string }>;
		};
		expect(
			fieldsBlock.fields.some((f) =>
				f.text.includes("https://github.com/example/repo/pull/42"),
			),
		).toBe(true);

		const bodyBlock = payload.blocks[2] as { text: { text: string } };
		expect(bodyBlock.text.text).toBe(
			"Fixed a null pointer dereference in the retry loop.",
		);
	});

	test("truncates reports over Slack's 3000-character section limit", async () => {
		for (const length of [3001, 4000]) {
			const { fetchImpl, calls } = mockFetch(
				new Response("ok", { status: 200 }),
			);
			const notifier = new SlackNotifier(
				{ type: "slack", webhookUrl: WEBHOOK_URL },
				silentLogger(),
				{ fetchImpl },
			);
			const event: NotificationEvent = {
				kind: "report_only",
				incident,
				report: "x".repeat(length),
			};

			await notifier.notify(event);

			const payload = calls[0]?.body as {
				blocks: Array<Record<string, unknown>>;
			};
			const bodyBlock = payload.blocks[2] as { text: { text: string } };
			expect(bodyBlock.text.text.length).toBeLessThanOrEqual(3000);
			expect(bodyBlock.text.text).toContain("truncated");
		}
	});

	test("passes reports at or under Slack's 3000-character limit unmodified", async () => {
		const exactReport = "z".repeat(3000);
		const shortReport = "Root cause: config drift in the deployment manifest.";
		for (const report of [exactReport, shortReport]) {
			const { fetchImpl, calls } = mockFetch(
				new Response("ok", { status: 200 }),
			);
			const notifier = new SlackNotifier(
				{ type: "slack", webhookUrl: WEBHOOK_URL },
				silentLogger(),
				{ fetchImpl },
			);
			await notifier.notify({ kind: "report_only", incident, report });

			const payload = calls[0]?.body as {
				blocks: Array<Record<string, unknown>>;
			};
			const bodyBlock = payload.blocks[2] as { text: { text: string } };
			expect(bodyBlock.text.text).toBe(report);
			if (report === exactReport) {
				expect(bodyBlock.text.text.length).toBe(3000);
			}
		}
	});

	test("uses the reason as the body for failed and skipped events", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl },
		);

		await notifier.notify({
			kind: "failed",
			incident,
			reason: "Tests did not pass after the proposed fix.",
		});
		await notifier.notify({
			kind: "skipped",
			incident,
			reason: "Cooldown window active for this fingerprint.",
		});

		const failedPayload = calls[0]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		const skippedPayload = calls[1]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		expect(
			(failedPayload.blocks[2] as { text: { text: string } }).text.text,
		).toBe("Tests did not pass after the proposed fix.");
		expect(
			(skippedPayload.blocks[2] as { text: { text: string } }).text.text,
		).toBe("Cooldown window active for this fingerprint.");
	});

	test("threads the injected tracer into postJson, producing a notify.post span with component 'slack'", async () => {
		const { fetchImpl } = mockFetch(new Response("ok", { status: 200 }));
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			{ fetchImpl, tracer: provider.getTracer("test") },
		);

		await notifier.notify({ kind: "diagnosis_started", incident });

		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBe(1);
		expect(spans[0]?.name).toBe("notify.post");
		expect(spans[0]?.kind).toBe(SpanKind.CLIENT);
		expect(spans[0]?.attributes["paperhanger.notify.component"]).toBe("slack");
	});

	test("throws NotifierResponseError and logs an excerpt on a non-2xx response", async () => {
		type Logger = ReturnType<typeof createLogger>;
		type Notifying = {
			notify(event: NotificationEvent): Promise<void>;
		};
		const scenarios: Array<{
			name: string;
			status: number;
			body: string;
			event: NotificationEvent;
			create: (logger: Logger, fetchImpl: typeof fetch) => Notifying;
		}> = [
			{
				name: "slack",
				status: 400,
				body: "invalid_payload",
				event: { kind: "diagnosis_started", incident },
				create: (logger, fetchImpl) =>
					new SlackNotifier(
						{ type: "slack", webhookUrl: WEBHOOK_URL },
						logger,
						{ fetchImpl },
					),
			},
			{
				name: "discord",
				status: 429,
				body: "rate limited",
				event: { kind: "diagnosis_started", incident },
				create: (logger, fetchImpl) =>
					new DiscordNotifier(
						{
							type: "discord",
							webhookUrl: "https://discord.com/api/webhooks/123/abc",
						},
						logger,
						{ fetchImpl },
					),
			},
			{
				name: "webhook",
				status: 500,
				body: "internal error",
				event: { kind: "failed", incident, reason: "agent crashed" },
				create: (logger, fetchImpl) =>
					new WebhookNotifier(
						{
							type: "webhook",
							url: "https://internal.example.com/hooks/paperhanger",
						},
						logger,
						{ fetchImpl },
					),
			},
		];

		for (const scenario of scenarios) {
			const { fetchImpl } = mockFetch(
				new Response(scenario.body, { status: scenario.status }),
			);
			const lines: string[] = [];
			const notifier = scenario.create(
				createLogger({ sink: (line) => lines.push(line) }),
				fetchImpl,
			);

			await expect(notifier.notify(scenario.event)).rejects.toThrow(
				NotifierResponseError,
			);

			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0] as string);
			expect(entry.status).toBe(scenario.status);
			expect(entry.bodyExcerpt).toBe(scenario.body);
			if (scenario.name === "slack") {
				expect(entry.level).toBe("error");
			}
			if (scenario.name === "webhook") {
				expect(entry.notifier).toBe("webhook");
			}
		}
	});
});
