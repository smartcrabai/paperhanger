import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { DiscordNotifier } from "./discord";
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
	severity: "warning",
	title: "Latency spike",
	source: "alertmanager",
};

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";

describe("DiscordNotifier", () => {
	test("has name 'discord'", () => {
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			silentLogger(),
		);
		expect(notifier.name).toBe("discord");
	});

	test("posts an embed with title, color, and severity/source/fingerprint fields", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const event: NotificationEvent = { kind: "diagnosis_started", incident };

		await notifier.notify(event);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(WEBHOOK_URL);
		const payload = calls[0]?.body as {
			content: string;
			embeds: Array<{
				title: string;
				description: string;
				color: number;
				fields: Array<{ name: string; value: string }>;
			}>;
		};
		expect(payload.content).toContain("🔍");
		const embed = payload.embeds[0];
		expect(embed?.title).toBe("🔍 Diagnosis started");
		expect(typeof embed?.color).toBe("number");
		const fieldValues = embed?.fields.map((f) => `${f.name}:${f.value}`) ?? [];
		expect(fieldValues.some((f) => f.includes("warning"))).toBe(true);
		expect(fieldValues.some((f) => f.includes("alertmanager"))).toBe(true);
		expect(fieldValues.some((f) => f.includes("fp-abc123"))).toBe(true);
	});

	test("uses a distinct color per kind", async () => {
		const seen = new Set<number>();
		for (const kind of [
			"diagnosis_started",
			"pr_created",
			"report_only",
			"failed",
			"skipped",
		] as const) {
			const { fetchImpl, calls } = mockFetch(
				new Response("ok", { status: 200 }),
			);
			const notifier = new DiscordNotifier(
				{ type: "discord", webhookUrl: WEBHOOK_URL },
				silentLogger(),
				fetchImpl,
			);
			const event = {
				kind,
				incident,
				prUrl: "https://example.com/pr/1",
				summary: "summary",
				report: "report",
				reason: "reason",
			} as unknown as NotificationEvent;

			await notifier.notify(event);
			const payload = calls[0]?.body as {
				embeds: Array<{ color: number }>;
			};
			seen.add(payload.embeds[0]?.color as number);
		}
		expect(seen.size).toBe(5);
	});

	test("includes the PR link as a field for pr_created", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);

		await notifier.notify({
			kind: "pr_created",
			incident,
			prUrl: "https://github.com/example/repo/pull/7",
			summary: "Adjusted the retry backoff.",
		});

		const payload = calls[0]?.body as {
			embeds: Array<{
				description: string;
				fields: Array<{ name: string; value: string }>;
			}>;
		};
		const embed = payload.embeds[0];
		expect(embed?.description).toBe("Adjusted the retry backoff.");
		expect(
			embed?.fields.some(
				(f) => f.value === "https://github.com/example/repo/pull/7",
			),
		).toBe(true);
	});

	test("truncates a description longer than Discord's 4096-character limit", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const longReport = "y".repeat(5000);

		await notifier.notify({
			kind: "report_only",
			incident,
			report: longReport,
		});

		const payload = calls[0]?.body as {
			embeds: Array<{ description: string }>;
		};
		expect(payload.embeds[0]?.description.length).toBeLessThanOrEqual(4096);
		expect(payload.embeds[0]?.description).toContain("truncated");
	});

	test("passes a description of exactly 4096 characters through unmodified", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);
		const exactReport = "z".repeat(4096);

		await notifier.notify({
			kind: "report_only",
			incident,
			report: exactReport,
		});

		const payload = calls[0]?.body as {
			embeds: Array<{ description: string }>;
		};
		expect(payload.embeds[0]?.description).toBe(exactReport);
		expect(payload.embeds[0]?.description.length).toBe(4096);
	});

	test("truncates a description of 4097 characters (one over the limit)", async () => {
		const { fetchImpl, calls } = mockFetch(new Response("ok", { status: 200 }));
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			silentLogger(),
			fetchImpl,
		);

		await notifier.notify({
			kind: "report_only",
			incident,
			report: "z".repeat(4097),
		});

		const payload = calls[0]?.body as {
			embeds: Array<{ description: string }>;
		};
		expect(payload.embeds[0]?.description.length).toBeLessThanOrEqual(4096);
		expect(payload.embeds[0]?.description).toContain("truncated");
	});

	test("throws NotifierResponseError and logs an excerpt on a non-2xx response", async () => {
		const { fetchImpl } = mockFetch(
			new Response("rate limited", { status: 429 }),
		);
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });
		const notifier = new DiscordNotifier(
			{ type: "discord", webhookUrl: WEBHOOK_URL },
			logger,
			fetchImpl,
		);

		await expect(
			notifier.notify({ kind: "diagnosis_started", incident }),
		).rejects.toThrow(NotifierResponseError);

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.status).toBe(429);
		expect(entry.bodyExcerpt).toBe("rate limited");
	});
});
