/**
 * Renders the operator-authored system prompt as a leading section of the
 * diagnosis prompt. Two scopes exist: the per-repository override
 * (`repoSystemPrompt`, from the resolved repo's RepoDefinition or its
 * `repos.systemPrompts` config entry) and the common prompt shared by every
 * repository (`systemPrompt`). The per-repository override wins when set --
 * it REPLACES the common section rather than stacking on top of it. Both
 * renderers return `[]` for unset/blank input, so callers can unconditionally
 * spread the result without an extra guard.
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

/** Per-repository counterpart to `renderCommonSystemPromptSection`. */
export function renderRepoSystemPromptSection(
	repoSystemPrompt: string | undefined,
): string[] {
	const trimmed = repoSystemPrompt?.trim();
	if (!trimmed) {
		return [];
	}
	return ["## Operator instructions (this repository)", "", trimmed];
}

/**
 * Resolves which operator-instructions section (if any) leads the diagnosis
 * prompt: the per-repository override when non-blank, otherwise the common
 * prompt, otherwise nothing. Precedence is decided here (not in the parent
 * process) so both scopes travel through the workflow input verbatim and the
 * replacement rule lives next to the renderers it chooses between.
 */
export function renderEffectiveSystemPromptSection(input: {
	systemPrompt?: string;
	repoSystemPrompt?: string;
}): string[] {
	const repoSection = renderRepoSystemPromptSection(input.repoSystemPrompt);
	if (repoSection.length > 0) {
		return repoSection;
	}
	return renderCommonSystemPromptSection(input.systemPrompt);
}
