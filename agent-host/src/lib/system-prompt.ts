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
 * Flue `1.0.0-beta.9` exposes no per-run system-prompt override
 * (`AgentInitializerContext` is only `{ id, env }`, and `OperationOptions` has
 * no `instructions`/`system` field), so this text cannot be delivered via
 * `AgentRuntimeConfig.instructions`. Delivering it as a prompt section instead
 * is the closest achievable equivalent; see docs/architecture.md's "Flue
 * agent host" section for the full investigation.
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
