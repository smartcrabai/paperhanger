/**
 * Generic JSON webhook notifier. See docs/spec.md section 3.8.
 *
 * POSTs the `NotificationEvent` as-is (no reshaping) so an arbitrary internal
 * system can consume the raw event. The config schema (`WebhookNotifierSchema`
 * in src/config/schema.ts) only carries `url` today; it has no field for
 * static extra headers, so none are sent. Extending the schema is out of
 * scope for this milestone.
 */

import type { Tracer } from "@opentelemetry/api";
import type { NotifierConfig } from "../config/schema";
import type { Logger } from "../observability/logger";
import { DEFAULT_NOTIFY_TIMEOUT_MS, postJson } from "./http";
import type { NotificationEvent, Notifier } from "./types";

export type WebhookNotifierConfig = Extract<
	NotifierConfig,
	{ type: "webhook" }
>;

export interface WebhookNotifierOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	tracer?: Tracer;
}

export class WebhookNotifier implements Notifier {
	readonly name = "webhook";
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly tracer?: Tracer;

	constructor(
		private readonly config: WebhookNotifierConfig,
		private readonly logger: Logger,
		options: WebhookNotifierOptions = {},
	) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
		this.tracer = options.tracer;
	}

	async notify(event: NotificationEvent): Promise<void> {
		await postJson({
			fetchImpl: this.fetchImpl,
			url: this.config.url,
			body: event,
			notifierName: this.name,
			logger: this.logger,
			timeoutMs: this.timeoutMs,
			tracer: this.tracer,
			component: "webhook",
		});
	}
}
