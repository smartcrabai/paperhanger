/**
 * Central output-redaction helpers for the fix agent. This module has no
 * Flue runtime dependency, so it remains directly unit-testable from Bun.
 */

import type { FixIncidentInput, FixIncidentOutput } from "../contract.ts";
import { extractCloneToken, redactSecrets } from "./redaction.ts";

/**
 * Every known secret that could appear in this workflow's output, derived
 * deterministically from the workflow input -- never by pattern-matching
 * arbitrary error/report text (see the redaction module's own note).
 */
export function collectSecrets(
	input: FixIncidentInput,
): ReadonlyArray<string | undefined> {
	// `input.telemetry` is a discriminated union on `source`; every currently
	// supported source (just "greptimedb" today) happens to carry its secret
	// under `auth`. A future source with a differently-named secret field
	// should collect it via its own arm here rather than assuming `auth`.
	return [extractCloneToken(input.repo.cloneUrl), input.telemetry?.auth];
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
