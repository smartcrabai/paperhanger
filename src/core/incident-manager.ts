/**
 * Deduplication, cooldown, and lifecycle management for incidents, plus a
 * concurrency-limited FIFO queue that feeds an `IncidentProcessor`. See
 * docs/spec.md section 3.2.
 */

import { incidentSnapshot } from "../notify/types";
import type { Notifier } from "../notify/types";
import type { Logger } from "../observability/logger";
import { DuplicateOpenIncidentError } from "../storage/types";
import type { IncidentStore } from "../storage/types";
import type { Incident, IncidentEvent } from "./types";

/**
 * Statuses that count toward the cooldown window. Note this is a *subset* of
 * the terminal statuses: "skipped" incidents never really ran, so they don't
 * suppress a fresh alert with the same fingerprint (spec section 3.2).
 */
const COOLDOWN_ELIGIBLE_STATUSES = new Set<Incident["status"]>([
	"pr_created",
	"report_only",
	"failed",
]);

/** Runs the actual diagnose/fix pipeline for an incident. Injected so M1 can use a stub. */
export interface IncidentProcessor {
	process(incident: Incident): Promise<void>;
}

export type IngestAction =
	| "created"
	| "deduped"
	| "cooldown"
	| "resolved"
	| "resolved-skip"
	| "dropped";

export interface IngestResult {
	action: IngestAction;
	incident?: Incident;
}

export interface IncidentManagerDeps {
	store: IncidentStore;
	logger: Logger;
	/** Only `agent.concurrency` and `agent.cooldownHours` are read from this. */
	config: {
		agent: {
			concurrency: number;
			cooldownHours: number;
		};
	};
	processor: IncidentProcessor;
	/**
	 * Optional: enables the "skipped" notification (spec section 3.8). Not
	 * required by any pre-M7 test, so it stays optional here rather than
	 * forcing every caller (and every existing test fixture) to supply one.
	 *
	 * Notification policy for this manager's own events (the pipeline in
	 * `pipeline.ts` owns everything downstream of "collecting"):
	 * - `resolved-skip` (a still-queued incident whose alert resolved before
	 *   processing started) fires a `"skipped"` notification: this is the one
	 *   case where a human should know processing was abandoned.
	 * - `deduped` and `cooldown` are deliberately log-only, never notified:
	 *   they happen on every repeated firing of the same alert while it stays
	 *   open/in cooldown, so notifying on them would spam every notifier on
	 *   every duplicate delivery.
	 */
	notifier?: Notifier;
	/**
	 * Injectable clock, used only for the cooldown-window comparison in
	 * `withinCooldown`. Defaults to the real wall clock; tests use this to pin
	 * the cooldown boundary deterministically (e.g. to tell "59 minutes ago"
	 * from "61 minutes ago" apart from `cooldownHours` unit-conversion bugs)
	 * without relying on real elapsed time.
	 */
	now?: () => Date;
}

export class IncidentManager {
	private readonly queue: string[] = [];
	private readonly activeIncidentIds = new Set<string>();
	private active = 0;
	private draining = false;
	private readonly now: () => Date;
	/**
	 * Per-fingerprint promise chains serializing `handleEvent` calls. This is
	 * the in-process half of the dedup check-then-act race fix (spec section
	 * 3.2, docs/architecture.md): without it, two concurrent `handleEvent`
	 * calls for a brand-new fingerprint can both observe no open incident via
	 * `findOpenIncidentByFingerprint` and both call `createIncident`. Entries
	 * are removed once their chain drains (see `serializeByFingerprint`), so
	 * this map only holds entries for fingerprints with in-flight work.
	 */
	private readonly fingerprintChains = new Map<string, Promise<void>>();

	constructor(private readonly deps: IncidentManagerDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	/** Number of incidents currently queued or being processed. Mainly for tests/observability. */
	get pendingCount(): number {
		return this.queue.length + this.active;
	}

	async handleEvent(event: IncidentEvent): Promise<IngestResult> {
		return this.serializeByFingerprint(event.fingerprint, () =>
			event.status === "firing"
				? this.handleFiring(event)
				: this.handleResolved(event),
		);
	}

	/**
	 * Chains `fn` after any in-flight call for the same `fingerprint`, so the
	 * check-then-act sequence inside `handleFiring`/`handleResolved` (read
	 * open incident -> decide -> write) never interleaves with another call
	 * for the same fingerprint within this process. See `fingerprintChains`.
	 *
	 * The map read/write here is synchronous (no `await` before
	 * `fingerprintChains.set`), which matters: two calls made back-to-back
	 * (e.g. via `Promise.all`) must link into the chain in call order rather
	 * than both reading a stale `previous` value before either writes.
	 */
	private serializeByFingerprint<T>(
		fingerprint: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const previous =
			this.fingerprintChains.get(fingerprint) ?? Promise.resolve();
		// Run `fn` regardless of whether the previous call in the chain
		// succeeded or failed: one bad event must not wedge every later event
		// for the same fingerprint.
		const result = previous.then(fn, fn);
		// A version of `result` that never rejects, used purely for chaining
		// and cleanup so this method itself never produces an unhandled
		// rejection.
		const tracker: Promise<void> = result.then(
			() => undefined,
			() => undefined,
		);
		this.fingerprintChains.set(fingerprint, tracker);
		void tracker.then(() => {
			// Only clean up if no newer call has already replaced this entry.
			if (this.fingerprintChains.get(fingerprint) === tracker) {
				this.fingerprintChains.delete(fingerprint);
			}
		});
		return result;
	}

	private async handleFiring(event: IncidentEvent): Promise<IngestResult> {
		const { store, logger } = this.deps;

		const open = await store.findOpenIncidentByFingerprint(event.fingerprint);
		if (open) {
			return this.dedupeOntoOpenIncident(open, event);
		}

		const terminal = await store.findLatestTerminalByFingerprint(
			event.fingerprint,
		);
		if (
			terminal &&
			COOLDOWN_ELIGIBLE_STATUSES.has(terminal.status) &&
			this.withinCooldown(terminal)
		) {
			await store.appendEvent(terminal.id, event, event.raw);
			logger.info("incident.cooldown", {
				incidentId: terminal.id,
				fingerprint: event.fingerprint,
				terminalStatus: terminal.status,
			});
			return { action: "cooldown", incident: terminal };
		}

		let incident: Incident;
		try {
			incident = await store.createIncident({
				fingerprint: event.fingerprint,
				source: event.source,
				status: "received",
				severity: event.severity,
				title: event.title,
				labels: event.labels,
				annotations: event.annotations,
			});
		} catch (err) {
			if (err instanceof DuplicateOpenIncidentError) {
				// Cross-process race: another writer created (or is creating)
				// an open incident for this fingerprint between our
				// `findOpenIncidentByFingerprint` check above and this insert.
				// The partial unique index (storage/{sqlite,postgres}.ts) is
				// the source of truth here; fall back to it and treat this
				// event as a dedup rather than failing the request.
				logger.warn("incident.dedup_race_detected", {
					fingerprint: event.fingerprint,
				});
				const existing = await store.findOpenIncidentByFingerprint(
					event.fingerprint,
				);
				if (existing) {
					return this.dedupeOntoOpenIncident(existing, event);
				}
			}
			throw err;
		}
		await store.appendEvent(incident.id, event, event.raw);
		logger.info("incident.created", {
			incidentId: incident.id,
			fingerprint: event.fingerprint,
		});

		this.enqueue(incident.id);
		return { action: "created", incident };
	}

	/**
	 * Appends `event` onto an already-open incident. If this process has no
	 * in-memory record of the incident being queued or actively processed, it
	 * is re-enqueued instead of just recording the event. This closes the
	 * restart black hole (docs/architecture.md "Incident state machine"):
	 * without it, an incident left mid-pipeline by a crash/restart (before
	 * `recoverOpenIncidents` runs, or in the unlikely case it was somehow
	 * missed) would dedup every future firing of its fingerprint forever,
	 * with no processing and no notification.
	 */
	private async dedupeOntoOpenIncident(
		open: Incident,
		event: IncidentEvent,
	): Promise<IngestResult> {
		const { store, logger } = this.deps;
		await store.appendEvent(open.id, event, event.raw);

		const inFlight =
			this.activeIncidentIds.has(open.id) || this.queue.includes(open.id);
		if (inFlight) {
			logger.info("incident.deduped", {
				incidentId: open.id,
				fingerprint: event.fingerprint,
			});
		} else {
			logger.warn("incident.deduped.requeued", {
				incidentId: open.id,
				fingerprint: event.fingerprint,
				status: open.status,
			});
			this.enqueue(open.id);
		}
		return { action: "deduped", incident: open };
	}

	private async handleResolved(event: IncidentEvent): Promise<IngestResult> {
		const { store, logger } = this.deps;

		const open = await store.findOpenIncidentByFingerprint(event.fingerprint);
		if (!open) {
			logger.info("incident.resolved.dropped", {
				fingerprint: event.fingerprint,
			});
			return { action: "dropped" };
		}

		const resolvedAt = event.endsAt ?? this.now().toISOString();

		// Not yet dequeued for processing: cancel it outright rather than
		// running the (potentially expensive) pipeline for an alert that
		// already resolved itself.
		if (!this.activeIncidentIds.has(open.id)) {
			const updated = await store.updateIncident(open.id, {
				status: "skipped",
				resolvedAt,
			});
			await store.appendEvent(open.id, event, event.raw);
			this.removeFromQueue(open.id);
			logger.info("incident.resolved.skipped", { incidentId: open.id });
			await this.deps.notifier?.notify({
				kind: "skipped",
				incident: incidentSnapshot(updated),
				reason:
					"Alert resolved while the incident was still queued for processing.",
			});
			return { action: "resolved-skip", incident: updated };
		}

		// Already being processed: let it run to completion, just record when
		// the underlying alert resolved.
		const updated = await store.updateIncident(open.id, { resolvedAt });
		await store.appendEvent(open.id, event, event.raw);
		logger.info("incident.resolved.recorded", { incidentId: open.id });
		return { action: "resolved", incident: updated };
	}

	private withinCooldown(incident: Incident): boolean {
		const cooldownMs = this.deps.config.agent.cooldownHours * 60 * 60 * 1000;
		return (
			this.now().getTime() - new Date(incident.updatedAt).getTime() < cooldownMs
		);
	}

	private enqueue(incidentId: string): void {
		this.queue.push(incidentId);
		this.drain();
	}

	private removeFromQueue(incidentId: string): void {
		const index = this.queue.indexOf(incidentId);
		if (index !== -1) {
			this.queue.splice(index, 1);
		}
	}

	/**
	 * Synchronously dispatches as many queued incidents as the concurrency
	 * limit allows. Each dispatched run re-triggers `drain()` on completion to
	 * pick up the next queued incident. The `draining` guard protects against
	 * reentrant calls; since nothing here awaits, plain recursion from
	 * `enqueue()` cannot interleave with an in-progress drain anyway, but the
	 * guard keeps the invariant explicit and cheap to check.
	 */
	private drain(): void {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			while (
				this.active < this.deps.config.agent.concurrency &&
				this.queue.length > 0
			) {
				const incidentId = this.queue.shift();
				if (incidentId === undefined) {
					break;
				}
				this.active++;
				this.activeIncidentIds.add(incidentId);
				void this.runOne(incidentId).finally(() => {
					this.active--;
					this.activeIncidentIds.delete(incidentId);
					this.drain();
				});
			}
		} finally {
			this.draining = false;
		}
	}

	/**
	 * Re-enqueues every open (non-terminal) incident found in the store. Call
	 * this once at startup, right after construction and before the server
	 * starts accepting webhooks, to close the restart black hole
	 * (docs/architecture.md "Incident state machine"): incidents left
	 * mid-pipeline by a crash/restart would otherwise never be re-processed,
	 * and `findOpenIncidentByFingerprint` would keep matching them forever,
	 * silently deduping every future firing of that fingerprint with no
	 * notification.
	 *
	 * Recovered incidents restart their pipeline run from the top (the
	 * pipeline is idempotent about persisting the same transitions again), so
	 * a duplicate `diagnosis_started` notification for an incident that was
	 * already mid-flight before the crash is an accepted trade-off.
	 */
	async recoverOpenIncidents(): Promise<void> {
		const { store, logger } = this.deps;
		const open = await store.listOpenIncidents();
		for (const incident of open) {
			logger.info("incident.recovered", {
				incidentId: incident.id,
				fingerprint: incident.fingerprint,
				status: incident.status,
			});
			this.enqueue(incident.id);
		}
	}

	private async runOne(incidentId: string): Promise<void> {
		const { store, logger, processor } = this.deps;
		const incident = await store.getIncident(incidentId);
		if (!incident) {
			logger.warn("incident.process.missing", { incidentId });
			return;
		}

		try {
			await processor.process(incident);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("incident.process.failed", { incidentId, error: message });
			await store.updateIncident(incidentId, {
				status: "failed",
				failureReason: message,
			});
		}
	}
}
