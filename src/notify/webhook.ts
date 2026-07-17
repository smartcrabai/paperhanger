/**
 * Generic JSON webhook notifier. See docs/spec.md section 3.8.
 *
 * POSTs the `NotificationEvent` as-is (no reshaping) so an arbitrary internal
 * system can consume the raw event. The config schema (`WebhookNotifierSchema`
 * in src/config/schema.ts) only carries `url` today; it has no field for
 * static extra headers, so none are sent. Extending the schema is out of
 * scope for this milestone.
 */

import type { NotifierConfig } from "../config/schema";
import type { Logger } from "../observability/logger";
import { DEFAULT_NOTIFY_TIMEOUT_MS, postJson } from "./http";
import type { Notifier, NotificationEvent } from "./types";

export type WebhookNotifierConfig = Extract<
	NotifierConfig,
	{ type: "webhook" }
>;

export class WebhookNotifier implements Notifier {
	readonly name = "webhook";

	constructor(
		private readonly config: WebhookNotifierConfig,
		private readonly logger: Logger,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly timeoutMs: number = DEFAULT_NOTIFY_TIMEOUT_MS,
	) {}

	async notify(event: NotificationEvent): Promise<void> {
		await postJson({
			fetchImpl: this.fetchImpl,
			url: this.config.url,
			body: event,
			notifierName: this.name,
			logger: this.logger,
			timeoutMs: this.timeoutMs,
		});
	}
}
