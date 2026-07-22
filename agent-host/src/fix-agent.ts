/**
 * The fix agent's `defineAgent()` definition: model, instructions, sandbox,
 * and tools. Bound to the `fix-incident` workflow (workflows/fix-incident.ts)
 * rather than discovered under `agents/`, since it has no need for a
 * persistent, addressable agent route (see the Flue Workflow API docs: "The
 * agent may be private to the workflow. Discovery under `agents/` is
 * required only for persistent agent routes and `dispatch()`.").
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { createTelemetryTools } from "./tools.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

const FIX_AGENT_INSTRUCTIONS = `You are paperhanger's incident fix agent. You are handed a production
incident's alert details and collected telemetry (logs, traces, metrics), and a git repository already
cloned at your current working directory, checked out on a fresh branch.

Your job, in order:

1. Form a root-cause hypothesis from the incident context you are given, then investigate the checked-out
   code to confirm or refute it. Use the \`query_telemetry\` tool (when available) for any follow-up
   logs/traces/metrics queries beyond what was already collected.
2. Decide whether the root cause is fixable by a code change in THIS repository. It is NOT code-fixable if
   the root cause is infrastructure, configuration, an external/third-party service, or bad data — in that
   case, do not modify any files; you will report your analysis instead of a fix.
3. If it IS code-fixable, implement the smallest possible fix using your file-editing tools:
   - Never modify any file matching the forbidden path patterns you are given.
   - Keep the total diff at or under the configured max changed-line count (additions + deletions).
   - Do not run \`git commit\`, \`git push\`, or otherwise finalize your change yourself — the workflow
     that invoked you runs tests and commits/pushes deterministically after you respond.
   - Do not touch git remotes or credentials; the checkout's remote already has what it needs.

Always respond with the structured result the workflow asks for. Be specific and honest in your written
analysis: a confident, well-reasoned "this is not code-fixable" is a successful outcome, not a failure.`;

/** Directory the sandbox's fs/shell operations resolve relative paths against for one workflow run. */
function createWorkDir(runId: string): string {
	const dir = join(tmpdir(), "paperhanger-fix-agent", runId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export const fixAgent = defineAgent((context) => {
	const workDir = createWorkDir(context.id);
	return {
		model: process.env.FLUE_MODEL || DEFAULT_MODEL,
		instructions: FIX_AGENT_INSTRUCTIONS,
		thinkingLevel: "high",
		// The agent-host container is the isolation boundary (docs/architecture.md
		// "Flue agent host (Node sidecar)"); local() itself provides none.
		//
		// MISE_YES/MISE_RUBY_COMPILE: local()'s env allowlist (see
		// agent-host/README.md "Env sanitization for model-facing shells")
		// doesn't include either, so they'd otherwise never reach a
		// model-facing or harness shell even though the Dockerfile sets both
		// container-wide -- passing them here as overrides bypasses the
		// allowlist entirely, the same way GIT_TERMINAL_PROMPT already does.
		// Without MISE_YES, the mise-tool-wrapper shims a target repo's test
		// run invokes on demand (see .mise.toml) would hang on mise's install
		// confirmation prompt instead of installing non-interactively.
		// Without MISE_RUBY_COMPILE, an on-demand Ruby install here would
		// silently fall back to mise's real default (compile from source,
		// ~13 minutes) despite the Dockerfile comment claiming that cost was
		// eliminated -- this was missed once already (verified by re-finding
		// it via code review) precisely because it's easy to set a container-
		// wide ENV and forget this allowlist exists at all.
		sandbox: local({
			env: {
				GIT_TERMINAL_PROMPT: "0",
				MISE_YES: "1",
				MISE_RUBY_COMPILE: "false",
			},
		}),
		cwd: workDir,
		tools: createTelemetryTools(),
	};
});
