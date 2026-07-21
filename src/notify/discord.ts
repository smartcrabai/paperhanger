/**
 * Discord webhook notifier. See docs/spec.md section 3.8.
 *
 * Posts `{ content, embeds: [...] }` where the single embed carries a title
 * (emoji + kind), a description (PR summary / report / reason, capped at
 * Discord's 4096-character embed description limit), a color per kind, and
 * fields for severity/source/fingerprint plus any kind-specific extras.
 */

import type { Tracer } from "@opentelemetry/api";
import type { NotifierConfig } from "../config/schema";
import type { Logger } from "../observability/logger";
import {
	bodyForEvent,
	colorForKind,
	emojiForKind,
	extraFields,
	fallbackLine,
	titleForKind,
	truncate,
} from "./format";
import { DEFAULT_NOTIFY_TIMEOUT_MS, postJson } from "./http";
import type { NotificationEvent, Notifier } from "./types";

export type DiscordNotifierConfig = Extract<
	NotifierConfig,
	{ type: "discord" }
>;

/** Discord embed `description` is truncated above this length. */
const DISCORD_DESCRIPTION_LIMIT = 4096;

interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

interface DiscordEmbed {
	title: string;
	description: string;
	color: number;
	fields: DiscordEmbedField[];
}

interface DiscordPayload {
	content: string;
	embeds: DiscordEmbed[];
}

function buildPayload(event: NotificationEvent): DiscordPayload {
	const { incident } = event;
	const fields: DiscordEmbedField[] = [
		{ name: "Severity", value: incident.severity, inline: true },
		{ name: "Source", value: incident.source, inline: true },
		{ name: "Fingerprint", value: incident.fingerprint, inline: true },
		...extraFields(event).map((field) => ({ ...field, inline: false })),
	];

	return {
		content: fallbackLine(event),
		embeds: [
			{
				title: `${emojiForKind(event.kind)} ${titleForKind(event.kind)}`,
				description: truncate(bodyForEvent(event), DISCORD_DESCRIPTION_LIMIT),
				color: colorForKind(event.kind),
				fields,
			},
		],
	};
}

export interface DiscordNotifierOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	tracer?: Tracer;
}

export class DiscordNotifier implements Notifier {
	readonly name = "discord";
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly tracer?: Tracer;

	constructor(
		private readonly config: DiscordNotifierConfig,
		private readonly logger: Logger,
		options: DiscordNotifierOptions = {},
	) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
		this.tracer = options.tracer;
	}

	async notify(event: NotificationEvent): Promise<void> {
		await postJson({
			fetchImpl: this.fetchImpl,
			url: this.config.webhookUrl,
			body: buildPayload(event),
			notifierName: this.name,
			logger: this.logger,
			timeoutMs: this.timeoutMs,
			tracer: this.tracer,
			component: "discord",
		});
	}
}
