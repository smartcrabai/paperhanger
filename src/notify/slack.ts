/**
 * Slack Incoming Webhook notifier. See docs/spec.md section 3.8.
 *
 * Posts `{ text, blocks }` where `blocks` uses Slack's Block Kit: a header
 * block (emoji + title), a fields section (severity/source/fingerprint, plus
 * any kind-specific extras like the PR link), and a body section carrying
 * the PR summary / report / reason. Section `text` objects are capped at
 * Slack's 3000-character limit.
 */

import type { NotifierConfig } from "../config/schema";
import type { Logger } from "../observability/logger";
import {
	bodyForEvent,
	emojiForKind,
	extraFields,
	fallbackLine,
	titleForKind,
	truncate,
} from "./format";
import { DEFAULT_NOTIFY_TIMEOUT_MS, postJson } from "./http";
import type { Notifier, NotificationEvent } from "./types";

export type SlackNotifierConfig = Extract<NotifierConfig, { type: "slack" }>;

/** Slack section `text` objects are rejected above this length. */
const SLACK_SECTION_TEXT_LIMIT = 3000;

interface SlackPlainText {
	type: "plain_text";
	text: string;
	emoji?: boolean;
}

interface SlackMrkdwnText {
	type: "mrkdwn";
	text: string;
}

type SlackBlock =
	| { type: "header"; text: SlackPlainText }
	| { type: "section"; text?: SlackMrkdwnText; fields?: SlackMrkdwnText[] };

interface SlackPayload {
	text: string;
	blocks: SlackBlock[];
}

function buildPayload(event: NotificationEvent): SlackPayload {
	const { incident } = event;
	const fields: SlackMrkdwnText[] = [
		{ type: "mrkdwn", text: `*Severity*\n${incident.severity}` },
		{ type: "mrkdwn", text: `*Source*\n${incident.source}` },
		{ type: "mrkdwn", text: `*Fingerprint*\n${incident.fingerprint}` },
		...extraFields(event).map(
			(field): SlackMrkdwnText => ({
				type: "mrkdwn",
				text: `*${field.name}*\n${field.value}`,
			}),
		),
	];

	return {
		text: fallbackLine(event),
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: `${emojiForKind(event.kind)} ${titleForKind(event.kind)}`,
					emoji: true,
				},
			},
			{ type: "section", fields },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: truncate(bodyForEvent(event), SLACK_SECTION_TEXT_LIMIT),
				},
			},
		],
	};
}

export class SlackNotifier implements Notifier {
	readonly name = "slack";

	constructor(
		private readonly config: SlackNotifierConfig,
		private readonly logger: Logger,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly timeoutMs: number = DEFAULT_NOTIFY_TIMEOUT_MS,
	) {}

	async notify(event: NotificationEvent): Promise<void> {
		await postJson({
			fetchImpl: this.fetchImpl,
			url: this.config.webhookUrl,
			body: buildPayload(event),
			notifierName: this.name,
			logger: this.logger,
			timeoutMs: this.timeoutMs,
		});
	}
}
