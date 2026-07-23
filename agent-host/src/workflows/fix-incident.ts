/**
 * The `fix-incident` workflow: diagnose -> fix -> test -> push. Discovered
 * as `POST /workflows/fix-incident` (via the `route` export below) and
 * invoked by the parent repo's `src/agent/runner.ts` through `@flue/sdk`.
 *
 * Division of responsibility (docs/architecture.md "Flue agent host (Node
 * sidecar)"): this workflow pushes a branch; it never opens a pull request.
 * The parent repo's runner re-verifies the pushed diff against guardrails via
 * the GitHub compare API and creates the PR itself.
 *
 * Orchestration here is deterministic application code (clone, checkout,
 * detect/run tests, commit, push) with the model only invoked for the
 * diagnose-and-implement-a-fix step, following the "Action-style pipeline"
 * pattern from the Flue docs (guide/actions: "clone repo, run tests, if red
 * retry the diagnose step ... a fixed pipeline that still uses
 * `harness.session().prompt(...)` internally").
 *
 * Credential handling (defense in depth against a compromised/adversarial
 * model turn, since the model has full shell access inside `local()`):
 *
 * 1. `git clone` embeds the GitHub App installation token in the remote URL
 *    (unavoidable -- that's how the checkout gets read access). Immediately
 *    afterward, out-of-band and strictly before the first model turn,
 *    `cloneAndPrepareBranch` scrubs it: `git remote set-url origin
 *    <tokenless URL>`. From that point on nothing in the checkout's
 *    `.git/config` carries a credential the model could read back out and
 *    reuse to push to an arbitrary ref (bypassing the parent repo's
 *    compare-API guardrails, which only ever inspect this run's own fixed
 *    incident branch).
 * 2. The final push (`commitAndPush`) never uses `origin`. It passes the
 *    credentialed URL as a one-off argument straight to `git push` --
 *    `git push <credentialed-url> HEAD:<branchName>` -- executed
 *    out-of-band by this workflow, never recorded in the model's
 *    conversation transcript and never persisted to disk.
 * 3. Before that push (and before the "no test suite" early-push path),
 *    `verifyNoTamper` re-reads `origin` and the current branch and fails
 *    the run closed if either no longer matches what step 1 set up --
 *    catching other forms of checkout tampering even though the push
 *    target itself no longer depends on `origin`.
 * 4. Every string this workflow returns (`diagnosis`, `report`,
 *    `fix.commitMessage`, `failureReason`) is passed through a single
 *    `sanitizeOutput()` right before `run()` returns, redacting both the
 *    clone token and the GreptimeDB auth value (when configured) -- not
 *    just the workflow's own thrown-error text, since a model-authored
 *    `report`/`commitMessage` could in principle echo either secret back
 *    (e.g. from `query_telemetry` tool output or a misguided `cat
 *    .git/config` during diagnosis).
 * 5. `local()`'s env allowlist (see `../fix-agent.ts` and
 *    `agent-host/README.md` "Sandbox") already keeps provider API keys and
 *    the GreptimeDB auth value out of every model-facing shell by default
 *    -- nothing here needs to additionally strip them per-command.
 *
 * See `agent-host/README.md` "Secret handling" for the full writeup.
 */

import type {
	FlueHarness,
	ShellResult,
	WorkflowRouteHandler,
	WorkflowRunsHandler,
} from "@flue/runtime";
import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import {
	type WorkflowInput,
	WorkflowInputSchema,
	type WorkflowOutput,
	WorkflowOutputSchema,
} from "../contract.ts";
import { fixAgent } from "../fix-agent.ts";
import { decideFixAttempt } from "../lib/fix-attempt-policy.ts";
import { collectSecrets, sanitizeOutput } from "../lib/output-sanitizer.ts";
import { redactSecrets, tokenlessCloneUrl } from "../lib/redaction.ts";
import { checkForTamper } from "../lib/tamper-check.ts";
import {
	detectTestCommand,
	type TestSuiteProbe,
} from "../lib/test-detection.ts";

/**
 * Named timeouts (ms) for every out-of-band git shell command this workflow
 * runs, so a hung `git` process can never stall an incident indefinitely
 * (finding 4). Plain local git plumbing is capped tightly; clone/push get
 * more room for real network variance against GitHub.
 */
const CLONE_SHELL_TIMEOUT_MS = 300_000; // 5 minutes
const LOCAL_GIT_SHELL_TIMEOUT_MS = 60_000; // 1 minute: checkout/config/add/commit/status/tamper-check reads
const PUSH_SHELL_TIMEOUT_MS = 120_000; // 2 minutes
const TEST_SHELL_TIMEOUT_MS = 10 * 60_000; // 10 minutes, unchanged
const SETUP_SHELL_TIMEOUT_MS = 10 * 60_000; // 10 minutes, same discipline as TEST_SHELL_TIMEOUT_MS
const MAX_TEST_OUTPUT_CHARS = 8_000;

const DiagnosisResultSchema = v.object({
	diagnosis: v.string(),
	report: v.string(),
	codeFixable: v.boolean(),
	commitMessage: v.optional(v.string()),
});

const FixRetryResultSchema = v.object({
	report: v.string(),
	commitMessage: v.string(),
});

/**
 * Runs a local (non-credentialed) git plumbing command out-of-band. Safe to
 * surface raw stdout/stderr on failure -- none of these commands ever touch
 * the credentialed remote URL.
 */
async function runOrThrow(
	harness: FlueHarness,
	command: string,
	timeoutMs: number,
): Promise<ShellResult> {
	const startedAt = Date.now();
	const result = await harness.shell(command, { timeoutMs });
	if (result.exitCode !== 0) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`Command timed out after ${timeoutMs}ms: ${command}`);
		}
		const detail = (result.stderr || result.stdout).slice(0, 2_000);
		throw new Error(
			`Command failed (exit ${result.exitCode}): ${command}\n${detail}`,
		);
	}
	return result;
}

/**
 * Runs a command touching the credentialed remote URL (clone, push)
 * out-of-band. Git can echo an authenticated URL back in its own
 * stdout/stderr (e.g. on an auth failure), so any captured output is
 * redacted (finding 1b/2) before it can reach a thrown error -- and
 * therefore before it can reach a report/failureReason/log line.
 */
async function runRemoteGitCommandOrThrow(
	harness: FlueHarness,
	command: string,
	description: string,
	timeoutMs: number,
	secrets: ReadonlyArray<string | undefined>,
): Promise<void> {
	const startedAt = Date.now();
	const result = await harness.shell(command, { timeoutMs });
	if (result.exitCode !== 0) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`${description} timed out after ${timeoutMs}ms`);
		}
		const detail = redactSecrets(result.stderr || result.stdout, secrets).slice(
			0,
			2_000,
		);
		throw new Error(
			`${description} failed (exit ${result.exitCode}): ${detail}`,
		);
	}
}

async function cloneAndPrepareBranch(
	harness: FlueHarness,
	input: WorkflowInput,
	secrets: ReadonlyArray<string | undefined>,
): Promise<void> {
	await runRemoteGitCommandOrThrow(
		harness,
		`git clone --depth 20 ${input.repo.cloneUrl} .`,
		"git clone",
		CLONE_SHELL_TIMEOUT_MS,
		secrets,
	);

	// Finding 1a: scrub the credential out-of-band, immediately after clone
	// and strictly before the first model turn (`harness.session()` below
	// hasn't been created yet). From this point on, `origin` carries no
	// credential the model could ever read back out of `.git/config`.
	await runOrThrow(
		harness,
		`git remote set-url origin ${tokenlessCloneUrl(input.repo.cloneUrl)}`,
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);

	await runOrThrow(
		harness,
		`git checkout -b ${input.repo.branchName}`,
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);
	await runOrThrow(
		harness,
		'git config user.name "paperhanger[bot]"',
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);
	await runOrThrow(
		harness,
		'git config user.email "paperhanger[bot]@users.noreply.github.com"',
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);
}

/**
 * Runs an operator-configured setup script (a RepoDefinition's `setupScript`,
 * threaded through `WorkflowInput.repo.setupScript`) once, immediately after
 * `cloneAndPrepareBranch` and strictly before the first model turn. A
 * non-zero exit terminates the run outright with `outcome: "failed"` -- the
 * model never sees or retries a failed setup. Output is redacted with the
 * same `secrets` list every other shell step uses (finding 2) and bounded to
 * `MAX_TEST_OUTPUT_CHARS`, even though by this point `.git/config` no longer
 * carries the clone token (finding 1a already ran).
 */
async function runSetupScript(
	harness: FlueHarness,
	setupScript: string,
	secrets: ReadonlyArray<string | undefined>,
): Promise<{ ok: true } | { ok: false; failureReason: string }> {
	const startedAt = Date.now();
	const result = await harness.shell(setupScript, {
		timeoutMs: SETUP_SHELL_TIMEOUT_MS,
	});
	if (result.exitCode === 0) {
		return { ok: true };
	}
	const tail = redactSecrets(
		`${result.stdout}\n${result.stderr}`,
		secrets,
	).slice(-MAX_TEST_OUTPUT_CHARS);
	// Mirrors runOrThrow/runRemoteGitCommandOrThrow: ShellResult carries no
	// timeout flag, so a killed-at-timeout process is only distinguishable
	// from a genuine script failure by comparing elapsed wall-clock time
	// against the timeout we passed in.
	if (Date.now() - startedAt >= SETUP_SHELL_TIMEOUT_MS) {
		return {
			ok: false,
			failureReason: `setup script timed out after ${SETUP_SHELL_TIMEOUT_MS}ms\n${tail}`,
		};
	}
	return {
		ok: false,
		failureReason: `setup script failed (exit ${result.exitCode})\n${tail}`,
	};
}

/** Parses `git status --porcelain` output into a flat list of changed file paths. */
function parsePorcelainStatus(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const body = line.slice(3);
			const arrowIndex = body.indexOf(" -> ");
			return arrowIndex === -1 ? body : body.slice(arrowIndex + 4);
		});
}

/**
 * Finding 1c: verifies the model didn't repoint `origin` or switch branches
 * before the deterministic commit+push step runs. Fails closed (throws) on
 * any mismatch against what `cloneAndPrepareBranch` set up.
 */
async function verifyNoTamper(
	harness: FlueHarness,
	input: WorkflowInput,
): Promise<void> {
	const remoteResult = await runOrThrow(
		harness,
		"git remote get-url origin",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);
	const branchResult = await runOrThrow(
		harness,
		"git rev-parse --abbrev-ref HEAD",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);

	const check = checkForTamper({
		actualRemoteUrl: remoteResult.stdout,
		expectedRemoteUrl: tokenlessCloneUrl(input.repo.cloneUrl),
		actualBranch: branchResult.stdout,
		expectedBranch: input.repo.branchName,
	});
	if (!check.ok) {
		throw new Error(`Tamper check failed: ${check.reason}`);
	}
}

async function commitAndPush(
	harness: FlueHarness,
	input: WorkflowInput,
	commitMessage: string,
	secrets: ReadonlyArray<string | undefined>,
): Promise<{ changedFiles: string[] }> {
	await verifyNoTamper(harness, input);

	const status = await runOrThrow(
		harness,
		"git status --porcelain",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);
	const changedFiles = parsePorcelainStatus(status.stdout);

	await runOrThrow(harness, "git add -A", LOCAL_GIT_SHELL_TIMEOUT_MS);
	await harness.fs.writeFile(".paperhanger-commit-message.txt", commitMessage);
	await runOrThrow(
		harness,
		"git commit -F .paperhanger-commit-message.txt",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
	);
	await harness.fs.rm(".paperhanger-commit-message.txt", { force: true });

	// Finding 1b: push straight to the credentialed URL, passed as a one-off
	// command argument -- never through `origin` (which by now carries no
	// credential at all) and never persisted anywhere on disk.
	await runRemoteGitCommandOrThrow(
		harness,
		`git push ${input.repo.cloneUrl} HEAD:${input.repo.branchName}`,
		"git push",
		PUSH_SHELL_TIMEOUT_MS,
		secrets,
	);

	return { changedFiles };
}

interface TestRunResult {
	command?: string;
	passed: boolean;
	output: string;
	/** Whether any recognized test suite/toolchain was found at all. */
	found: boolean;
}

/**
 * Best-effort test-suite detection: probes the checkout for recognized
 * ecosystem files/lockfiles, then hands that plain-data probe (plus an
 * optional `testCommandOverride`, from a matching RepoDefinition's
 * `testCommand`) to the pure `detectTestCommand`
 * (agent-host/src/lib/test-detection.ts) to pick a command -- the override
 * verbatim when set, otherwise package.json `scripts.test`, `go test ./...`,
 * or `cargo test`.
 */
async function detectAndRunTests(
	harness: FlueHarness,
	testCommandOverride?: string,
): Promise<TestRunResult> {
	// An override always wins in detectTestCommand, so the probe below (7
	// fs.exists calls plus a package.json read/parse) would be run and its
	// result discarded. Skip it entirely and run the override directly, with
	// the same shell/timeout/redaction handling as the detected-command path
	// below.
	let command: string | undefined;
	if (testCommandOverride && testCommandOverride.trim().length > 0) {
		command = testCommandOverride;
	} else {
		const probe: TestSuiteProbe = {
			packageJsonExists: await harness.fs.exists("package.json"),
			bunLockExists: await harness.fs.exists("bun.lock"),
			bunLockbExists: await harness.fs.exists("bun.lockb"),
			pnpmLockExists: await harness.fs.exists("pnpm-lock.yaml"),
			yarnLockExists: await harness.fs.exists("yarn.lock"),
			goModExists: await harness.fs.exists("go.mod"),
			cargoTomlExists: await harness.fs.exists("Cargo.toml"),
		};

		if (probe.packageJsonExists) {
			try {
				const raw = await harness.fs.readFile("package.json");
				const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
				probe.packageJsonScripts = pkg.scripts;
			} catch {
				// Malformed package.json; detectTestCommand falls through to other
				// ecosystems below.
			}
		}

		command = detectTestCommand(probe, testCommandOverride);
	}

	if (!command) {
		return { passed: false, output: "", found: false };
	}

	const result = await harness.shell(command, {
		timeoutMs: TEST_SHELL_TIMEOUT_MS,
	});
	const output = `${result.stdout}\n${result.stderr}`.slice(
		-MAX_TEST_OUTPUT_CHARS,
	);
	return { command, passed: result.exitCode === 0, output, found: true };
}

function buildDiagnosisPrompt(input: WorkflowInput): string {
	const forbidden =
		input.forbiddenPaths.length > 0
			? input.forbiddenPaths.join(", ")
			: "(none configured)";
	return [
		"## Incident context",
		input.contextMarkdown,
		"",
		"## Constraints for this run",
		`- Forbidden paths (never modify a matching file): ${forbidden}`,
		`- Max diff size: ${input.limits.maxDiffLines} changed lines (additions + deletions)`,
		"",
		"Investigate the checked-out repository at your current working directory and respond with the",
		"structured result: `diagnosis` (root-cause analysis), `report` (a complete markdown write-up",
		"suitable for a notification or pull request description), `codeFixable` (boolean), and",
		"`commitMessage` (required when `codeFixable` is true).",
	].join("\n");
}

function buildRetryPrompt(testRun: TestRunResult): string {
	return [
		"The test suite failed after your fix. Command:",
		"```",
		testRun.command ?? "(unknown)",
		"```",
		"",
		"Output (tail):",
		"```",
		testRun.output,
		"```",
		"",
		"Investigate the failure and adjust your fix, respecting the same forbidden-paths and diff-size",
		"constraints as before. Respond with the structured result: an updated `report` and `commitMessage`.",
	].join("\n");
}

async function runFixIncident(
	input: WorkflowInput,
	harness: FlueHarness,
): Promise<WorkflowOutput> {
	const secrets = collectSecrets(input);
	await cloneAndPrepareBranch(harness, input, secrets);

	// Operator-configured setup (RepoDefinition.setupScript, when a matching,
	// enabled definition was found by the parent repo's runner). Runs before
	// any model turn; a failure here terminates the run without ever invoking
	// the model.
	if (input.repo.setupScript) {
		const setup = await runSetupScript(
			harness,
			input.repo.setupScript,
			secrets,
		);
		if (!setup.ok) {
			return {
				outcome: "failed",
				diagnosis:
					"The configured setup script failed before diagnosis could begin.",
				report:
					"The configured setup script failed before the fix agent could begin " +
					`diagnosis.\n\n\`\`\`\n${setup.failureReason}\n\`\`\``,
				failureReason: setup.failureReason,
			};
		}
	}

	// Note (finding 1e, verified): `input.repo.cloneUrl` (and its embedded
	// token) is never interpolated into any prompt below -- `buildDiagnosisPrompt`
	// only surfaces `contextMarkdown`/`forbiddenPaths`/`limits.maxDiffLines`,
	// and `buildRetryPrompt` only surfaces the test command/output. The
	// static `FIX_AGENT_INSTRUCTIONS` in `../fix-agent.ts` isn't templated at
	// all.
	const session = await harness.session();
	const diagnosisResponse = await session.prompt(buildDiagnosisPrompt(input), {
		result: DiagnosisResultSchema,
	});
	const diagnosis = diagnosisResponse.data;

	if (!diagnosis.codeFixable) {
		return {
			outcome: "report_only",
			diagnosis: diagnosis.diagnosis,
			report: diagnosis.report,
		};
	}

	let report = diagnosis.report;
	let commitMessage = diagnosis.commitMessage ?? `fix: ${input.alert.title}`;
	let lastTestRun: TestRunResult = { passed: false, output: "", found: false };
	const maxFixAttempts = input.limits.maxFixAttempts;

	for (let attempt = 1; attempt <= maxFixAttempts; attempt++) {
		lastTestRun = await detectAndRunTests(harness, input.repo.testCommand);
		const decision = decideFixAttempt({
			attempt,
			maxFixAttempts,
			testRun: lastTestRun,
		});

		if (decision.action === "commit") {
			const { changedFiles } = await commitAndPush(
				harness,
				input,
				commitMessage,
				secrets,
			);
			return {
				outcome: "fixed",
				diagnosis: diagnosis.diagnosis,
				report: decision.tested
					? report
					: `${report}\n\n_No automated test suite was detected in this repository; this fix was not verified by tests._`,
				fix: {
					branch: input.repo.branchName,
					commitMessage,
					changedFiles,
					testCommand: decision.tested ? lastTestRun.command : undefined,
					testsPassed: decision.tested,
				},
			};
		}

		if (decision.action === "give_up") {
			break;
		}

		const retryResponse = await session.prompt(buildRetryPrompt(lastTestRun), {
			result: FixRetryResultSchema,
		});
		report = retryResponse.data.report;
		commitMessage = retryResponse.data.commitMessage;
	}

	return {
		outcome: "failed",
		diagnosis: diagnosis.diagnosis,
		report: `${report}\n\n## Test failures (last attempt)\n\`\`\`\n${lastTestRun.output}\n\`\`\``,
		failureReason: `Tests kept failing after ${maxFixAttempts} fix attempt(s); command: ${lastTestRun.command ?? "(unknown)"}.`,
	};
}

export default defineWorkflow({
	agent: fixAgent,
	input: WorkflowInputSchema,
	output: WorkflowOutputSchema,
	async run({ harness, input }): Promise<WorkflowOutput> {
		const secrets = collectSecrets(input);
		try {
			const result = await runFixIncident(input, harness);
			return sanitizeOutput(result, secrets);
		} catch (err) {
			const rawMessage = err instanceof Error ? err.message : String(err);
			return sanitizeOutput(
				{
					outcome: "failed",
					diagnosis:
						"The fix agent encountered an internal error before completing its diagnosis.",
					report: `The workflow failed with an internal error: ${rawMessage}`,
					failureReason: rawMessage,
				},
				secrets,
			);
		}
	},
});

/** Enables `POST /workflows/fix-incident` (see docs/architecture.md; invoked via `@flue/sdk`). */
export const route: WorkflowRouteHandler = async (_c, next) => next();
/** Enables `GET /runs/:runId` for this workflow's runs, for observability. */
export const runs: WorkflowRunsHandler = async (_c, next) => next();
