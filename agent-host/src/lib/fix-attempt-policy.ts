/**
 * Pure decision logic for the fix-retry loop in `../workflows/fix-incident.ts`,
 * extracted for the same reason `./test-detection.ts` is: it's the part of
 * the loop that doesn't need `harness`/model I/O, so it can be unit tested
 * directly by the main paperhanger repo's `bun test` without pulling in
 * `../fix-agent.ts` (which statically imports `node:sqlite` via
 * `@flue/runtime/node` and cannot load under Bun's test runner -- see the
 * file-level comment on `./output-sanitizer.ts`).
 *
 * `../workflows/fix-incident.ts` still owns the loop itself (running tests,
 * committing/pushing, prompting the model for a retry) and calls
 * `decideFixAttempt` once per iteration with a plain-data summary of that
 * iteration's test run.
 */

/** Plain-data summary of one `detectAndRunTests` call, enough to decide what to do next. */
export interface FixAttemptTestRun {
	/** Whether any recognized test suite/toolchain was found at all. */
	found: boolean;
	/** Whether the detected test command exited zero. Meaningless when `found` is false. */
	passed: boolean;
}

export interface FixAttemptDecisionInput {
	/** 1-based index of the attempt that just ran (matches the loop in fix-incident.ts). */
	attempt: number;
	/** `agent.maxFixAttempts` from config, threaded through `limits.maxFixAttempts`. */
	maxFixAttempts: number;
	testRun: FixAttemptTestRun;
}

export type FixAttemptDecision =
	/** Commit and push now: either tests passed, or no test suite was found to verify against. */
	| { action: "commit"; tested: boolean }
	/** Prompt the model for another attempt; more retries remain. */
	| { action: "retry" }
	/** Tests kept failing and no retries remain; report a terminal failure. */
	| { action: "give_up" };

/**
 * Decides what the fix-retry loop should do after one `detectAndRunTests`
 * call. Never invoked when `maxFixAttempts < 1` (the config schema and both
 * contract mirrors already enforce `maxFixAttempts` as a positive integer).
 */
export function decideFixAttempt(
	input: FixAttemptDecisionInput,
): FixAttemptDecision {
	const { attempt, maxFixAttempts, testRun } = input;

	if (!testRun.found) {
		return { action: "commit", tested: false };
	}
	if (testRun.passed) {
		return { action: "commit", tested: true };
	}
	if (attempt >= maxFixAttempts) {
		return { action: "give_up" };
	}
	return { action: "retry" };
}
