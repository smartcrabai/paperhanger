/**
 * Remote/branch tamper-check comparison used just before the deterministic
 * commit+push step in `../workflows/fix-incident.ts` (finding 1c: verify the
 * model didn't repoint the checkout's git remote or switch branches before
 * the workflow's own commit/push runs). Pure comparison logic, no
 * `@flue/*` import, so it is unit-testable directly by the main paperhanger
 * repo's `bun test`.
 */

export interface TamperCheckInput {
	/** `git remote get-url origin`, as read from the checkout right now. */
	actualRemoteUrl: string;
	/** The tokenless URL the workflow set right after cloning. */
	expectedRemoteUrl: string;
	/** `git rev-parse --abbrev-ref HEAD`, as read from the checkout right now. */
	actualBranch: string;
	/** The branch name the workflow checked out at the start of the run. */
	expectedBranch: string;
}

export type TamperCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Fails closed if either the `origin` remote or the current branch no
 * longer match what the workflow itself set up before handing control to
 * the model. This does not, by itself, change where the final push goes --
 * finding 1b already makes the push target an explicit credentialed URL
 * argument rather than `origin` -- but it catches other forms of checkout
 * tampering (e.g. a remote repointed at an attacker-controlled URL, or a
 * branch switch) as a fail-fast signal rather than silently proceeding.
 */
export function checkForTamper(input: TamperCheckInput): TamperCheckResult {
	const actualRemoteUrl = input.actualRemoteUrl.trim();
	const expectedRemoteUrl = input.expectedRemoteUrl.trim();
	if (actualRemoteUrl !== expectedRemoteUrl) {
		return {
			ok: false,
			reason: `git remote 'origin' changed during the run (expected ${expectedRemoteUrl}, found ${actualRemoteUrl})`,
		};
	}

	const actualBranch = input.actualBranch.trim();
	const expectedBranch = input.expectedBranch.trim();
	if (actualBranch !== expectedBranch) {
		return {
			ok: false,
			reason: `current branch changed during the run (expected ${expectedBranch}, found ${actualBranch})`,
		};
	}

	return { ok: true };
}
