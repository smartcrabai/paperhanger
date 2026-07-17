import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { SlackNotifier } from "./slack";
import type { IncidentSnapshot, NotificationEvent } from "./types";
import { NotifierResponseError } from "./types";

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
			fetchImpl,
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
			fetchImpl,
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

	test("truncates a report longer than Slack's 3000-character section limit", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const longReport = "x".repeat(4000);
		const event: NotificationEvent = {
			kind: "report_only",
			incident,
			report: longReport,
		};

		await notifier.notify(event);

		const payload = calls[0]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		const bodyBlock = payload.blocks[2] as { text: { text: string } };
		expect(bodyBlock.text.text.length).toBeLessThanOrEqual(3000);
		expect(bodyBlock.text.text).toContain("truncated");
	});

	test("passes a report of exactly 3000 characters through unmodified", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const exactReport = "z".repeat(3000);
		const event: NotificationEvent = {
			kind: "report_only",
			incident,
			report: exactReport,
		};

		await notifier.notify(event);

		const payload = calls[0]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		const bodyBlock = payload.blocks[2] as { text: { text: string } };
		expect(bodyBlock.text.text).toBe(exactReport);
		expect(bodyBlock.text.text.length).toBe(3000);
	});

	test("truncates a report of 3001 characters (one over the limit)", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const event: NotificationEvent = {
			kind: "report_only",
			incident,
			report: "z".repeat(3001),
		};

		await notifier.notify(event);

		const payload = calls[0]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		const bodyBlock = payload.blocks[2] as { text: { text: string } };
		expect(bodyBlock.text.text.length).toBeLessThanOrEqual(3000);
		expect(bodyBlock.text.text).toContain("truncated");
	});

	test("does not truncate a report under the limit", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const shortReport = "Root cause: config drift in the deployment manifest.";
		const event: NotificationEvent = {
			kind: "report_only",
			incident,
			report: shortReport,
		};

		await notifier.notify(event);

		const payload = calls[0]?.body as {
			blocks: Array<Record<string, unknown>>;
		};
		const bodyBlock = payload.blocks[2] as { text: { text: string } };
		expect(bodyBlock.text.text).toBe(shortReport);
	});

	test("uses the reason as the body for failed and skipped events", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
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

	test("throws NotifierResponseError and logs an excerpt on a non-2xx response", async () => {
		const { fetchImpl } = mockFetch(
			new Response("invalid_payload", { status: 400 }),
		);
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });
		const notifier = new SlackNotifier(
			{ type: "slack", webhookUrl: WEBHOOK_URL },
			logger,
			fetchImpl,
		);

		await expect(
			notifier.notify({ kind: "diagnosis_started", incident }),
		).rejects.toThrow(NotifierResponseError);

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.level).toBe("error");
		expect(entry.status).toBe(400);
		expect(entry.bodyExcerpt).toBe("invalid_payload");
	});
});
