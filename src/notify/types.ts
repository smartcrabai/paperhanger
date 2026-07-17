/**
 * Notifier abstraction. Implementations: Slack Incoming Webhook, Discord
 * Webhook, and a generic JSON webhook. See docs/spec.md section 3.8.
 *
 * Notification timing points (spec 3.8): diagnosis started, PR created,
 * report-only, failed, skipped. Each event carries a compact snapshot of the
 * incident (not the full `Incident` record) so notifiers don't need to know
 * about storage internals.
 */

import type { Incident } from "../core/types";
import type { Logger } from "../observability/logger";

/** Compact incident snapshot attached to every notification event. */
export interface IncidentSnapshot {
	id: string;
	fingerprint: string;
	severity: string;
	title: string;
	source: string;
}

/** Projects a full `Incident` down to the compact snapshot notifiers see. */
export function incidentSnapshot(incident: Incident): IncidentSnapshot {
	return {
		id: incident.id,
		fingerprint: incident.fingerprint,
		severity: incident.severity,
		title: incident.title,
		source: incident.source,
	};
}

/**
 * A notification-worthy event, one per timing point described in spec
 * section 3.8. Discriminated on `kind`.
 */
export type NotificationEvent =
	| { kind: "diagnosis_started"; incident: IncidentSnapshot }
	| {
			kind: "pr_created";
			incident: IncidentSnapshot;
			prUrl: string;
			summary: string;
	  }
	| { kind: "report_only"; incident: IncidentSnapshot; report: string }
	| { kind: "failed"; incident: IncidentSnapshot; reason: string }
	| { kind: "skipped"; incident: IncidentSnapshot; reason: string };

export interface Notifier {
	readonly name: string;
	notify(event: NotificationEvent): Promise<void>;
}

/**
 * Thrown by a `Notifier` implementation when the remote endpoint responds
 * with a non-2xx status. Notifiers must throw this (after logging the
 * response body excerpt themselves); `CompositeNotifier` is the layer
 * responsible for swallowing it so one bad notifier doesn't block the rest.
 */
export class NotifierResponseError extends Error {
	constructor(
		public readonly notifierName: string,
		public readonly status: number,
		public readonly bodyExcerpt: string,
	) {
		super(`${notifierName} notifier received HTTP ${status}: ${bodyExcerpt}`);
		this.name = "NotifierResponseError";
	}
}

/**
 * Thrown by `postJson` (via the individual `Notifier` implementations) when
 * the HTTP request does not complete within its configured timeout. Without
 * this, a hung endpoint would never reject its `fetch` call, and since
 * `IncidentPipeline` awaits `notify()` while holding a concurrency slot, a
 * couple of hung notifications would permanently exhaust the pipeline's
 * concurrency with zero log output. `CompositeNotifier` isolates this the
 * same way it isolates `NotifierResponseError`.
 */
export class NotifierTimeoutError extends Error {
	constructor(
		public readonly notifierName: string,
		public readonly timeoutMs: number,
	) {
		super(`${notifierName} notifier timed out after ${timeoutMs}ms`);
		this.name = "NotifierTimeoutError";
	}
}

/**
 * Fans a single `NotificationEvent` out to every configured notifier. Each
 * notifier's failure is isolated: it is logged and never rethrown, and there
 * are no retries in v1 (spec section 3.8 sets no approval gate and no retry
 * requirement).
 */
export class CompositeNotifier implements Notifier {
	readonly name = "composite";

	constructor(
		private readonly notifiers: readonly Notifier[],
		private readonly logger: Logger,
	) {}

	async notify(event: NotificationEvent): Promise<void> {
		await Promise.all(
			this.notifiers.map(async (notifier) => {
				try {
					await notifier.notify(event);
				} catch (err) {
					this.logger.error("notify.failed", {
						notifier: notifier.name,
						kind: event.kind,
						incidentId: event.incident.id,
						fingerprint: event.incident.fingerprint,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}),
		);
	}
}
