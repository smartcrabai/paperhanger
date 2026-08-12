/**
 * Central output-redaction helpers for the fix agent. This module has no
 * Flue runtime dependency, so it remains directly unit-testable from Bun.
 */

import type { FixIncidentInput, FixIncidentOutput } from "../contract.ts";
import { extractCloneToken, redactSecrets } from "./redaction.ts";

/**
 * Every known secret that could appear in this workflow's output, derived
 * deterministically from the workflow input (and, for the telemetry
 * callback token, this process's own environment) -- never by
 * pattern-matching arbitrary error/report text (see the redaction module's
 * own note).
 *
 * `env` defaults to `process.env` and is only a parameter for testability.
 * The telemetry backend itself (URL, database, auth) never reaches this
 * process at all anymore -- the parent proxies every follow-up query over
 * HTTP (see `../tools.ts`) -- so the only telemetry-related secret this
 * workflow could ever echo back is its own callback bearer token, read here
 * the same way `../tools.ts` reads it.
 */
export function collectSecrets(
	input: FixIncidentInput,
	env: Record<string, string | undefined> = process.env,
): ReadonlyArray<string | undefined> {
	return [
		extractCloneToken(input.repo.cloneUrl),
		env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN,
	];
}

/**
 * Central redaction point (finding 2): every string field that leaves the
 * fix-incident workflow -- whether authored by the model (`diagnosis`,
 * `report`, `fix.commitMessage`) or by the workflow's own error handling
 * (`failureReason`) -- is redacted here, once, immediately before `run()`
 * returns. This replaces the old approach of only redacting the workflow's
 * own catch-block error message.
 */
export function sanitizeOutput(
	output: FixIncidentOutput,
	secrets: ReadonlyArray<string | undefined>,
): FixIncidentOutput {
	return {
		...output,
		diagnosis: redactSecrets(output.diagnosis, secrets),
		report: redactSecrets(output.report, secrets),
		failureReason:
			output.failureReason !== undefined
				? redactSecrets(output.failureReason, secrets)
				: output.failureReason,
		fix: output.fix
			? {
					...output.fix,
					commitMessage: redactSecrets(output.fix.commitMessage, secrets),
				}
			: output.fix,
	};
}
