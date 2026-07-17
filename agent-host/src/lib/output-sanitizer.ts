/**
 * Central output-redaction helpers for the `fix-incident` workflow (finding
 * 2). Pulled out of `../workflows/fix-incident.ts` into `lib/` -- alongside
 * this file's `import type` of `../contract.ts` (a plain Valibot schema
 * module, no `@flue/*` dependency) -- specifically so it stays unit
 * testable directly by the main paperhanger repo's `bun test`.
 *
 * This matters in practice: `../workflows/fix-incident.ts` imports
 * `../fix-agent.ts`, which imports `local` from `@flue/runtime/node`, which
 * (per docs/research/flue.md) statically imports `node:sqlite` -- a module
 * Bun does not implement. Importing the workflow file itself under Bun's
 * test runner fails immediately for that reason, so the security-relevant,
 * dependency-free logic has to live in a module the workflow file merely
 * *composes*, not one it re-exports from.
 */

import type { WorkflowInput, WorkflowOutput } from "../contract.ts";
import { extractCloneToken, redactSecrets } from "./redaction.ts";

/**
 * Every known secret that could appear in this workflow's output, derived
 * deterministically from the workflow input -- never by pattern-matching
 * arbitrary error/report text (see the redaction module's own note).
 */
export function collectSecrets(
	input: WorkflowInput,
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
	output: WorkflowOutput,
	secrets: ReadonlyArray<string | undefined>,
): WorkflowOutput {
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
