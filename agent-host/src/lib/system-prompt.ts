/**
 * Renders the operator-authored common system prompt (dashboard-managed,
 * shared by every repository) as a leading section of the diagnosis prompt.
 * Returns `[]` when unset/blank, so callers can unconditionally spread the
 * result without an extra guard.
 *
 * Placed in `lib/` -- dependency-free, no `@flue/*` import -- for the same
 * reason as `./output-sanitizer.ts`: `../fix-incident.ts` imports
 * `../fix-agent.ts`, which imports `local` from `@flue/runtime/node`, which
 * statically imports `node:sqlite`, a module Bun's test runner cannot import.
 *
 * Delivery note: under Flue `1.0.0-beta.9` no per-run system-prompt override
 * existed, so this text was threaded through the run input as a prompt
 * section. Flue 2's agent function re-renders its returned instructions every
 * turn and can read the run input via `useInitialData()`, making per-run
 * instructions technically possible -- but dynamic instructions bust the
 * model cache (per Flue's bundled docs/guide/building-agents.md), so
 * prompt-section delivery is kept. See docs/architecture.md's "Flue agent
 * host" section.
 */
export function renderCommonSystemPromptSection(
	systemPrompt: string | undefined,
): string[] {
	const trimmed = systemPrompt?.trim();
	if (!trimmed) {
		return [];
	}
	return ["## Operator instructions (apply to every repository)", "", trimmed];
}
