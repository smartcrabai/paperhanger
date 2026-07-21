/**
 * Shutdown-drain helper, extracted from `src/index.ts` (the composition
 * root) so it can be unit tested directly -- importing `index.ts` itself
 * would run the whole composition root (`main()`) as a side effect of the
 * module load, per docs/architecture.md's "Dependency injection" (`src/
 * index.ts` is the only composition root).
 */

import type { Logger } from "../observability/logger";

const DEFAULT_POLL_INTERVAL_MS = 200;

export interface WaitForDrainOptions {
	/** Injectable for tests; defaults to `Bun.sleep`. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable clock for tests; defaults to `Date.now`. */
	now?: () => number;
	/** Milliseconds between `pendingCount` polls; defaults to 200. */
	pollIntervalMs?: number;
}

/**
 * Polls `pendingCount` until it drains to zero or `timeoutMs` elapses.
 * This is a best-effort wait, not a guarantee: an incident still mid-flight
 * when the timeout fires is simply abandoned at whatever status it last
 * persisted (crash-observable per docs/architecture.md). It IS automatically
 * re-queued and reprocessed on the next start
 * (`IncidentManager.recoverOpenIncidents`), but that recovery restarts the
 * pipeline from the top rather than resuming from the abandoned stage. A
 * full fix-agent run can take up to `agent.timeoutMinutes`, far longer than
 * any reasonable shutdown grace period, so waiting for full drain
 * unconditionally is not attempted.
 */
export async function waitForDrain(
	pendingCount: () => number,
	timeoutMs: number,
	log: Logger,
	options: WaitForDrainOptions = {},
): Promise<void> {
	const sleep = options.sleep ?? Bun.sleep;
	const now = options.now ?? Date.now;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	const deadline = now() + timeoutMs;
	while (pendingCount() > 0 && now() < deadline) {
		await sleep(pollIntervalMs);
	}
	const remaining = pendingCount();
	if (remaining > 0) {
		log.warn("shutdown.drain_timeout", { pending: remaining, timeoutMs });
	} else {
		log.info("shutdown.drained", {});
	}
}
