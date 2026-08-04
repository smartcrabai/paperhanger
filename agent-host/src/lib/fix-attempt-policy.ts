/**
 * Pure decision logic for the fix agent's test-retry loop. It stays
 * independent from sandbox and model I/O so the main repository can test it.
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
