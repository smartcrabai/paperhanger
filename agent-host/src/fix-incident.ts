import type { SessionEnv, ShellResult } from "@flue/runtime";
import * as v from "valibot";
import { type FixIncidentInput, type FixIncidentOutput } from "./contract.ts";
import { runConditionalSetupScripts } from "./lib/common-setup-scripts.ts";
import { decideFixAttempt } from "./lib/fix-attempt-policy.ts";
import { collectSecrets, sanitizeOutput } from "./lib/output-sanitizer.ts";
import { redactSecrets, tokenlessCloneUrl } from "./lib/redaction.ts";
import { checkForTamper } from "./lib/tamper-check.ts";
import {
	detectTestCommand,
	type TestSuiteProbe,
} from "./lib/test-detection.ts";
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export const DiagnosisResultSchema = v.object({
	diagnosis: v.string(),
	report: v.string(),
	codeFixable: v.boolean(),
	commitMessage: v.optional(v.string()),
});

export const FixRetryResultSchema = v.object({
	report: v.string(),
	commitMessage: v.string(),
});

export type DiagnosisResult = v.InferOutput<typeof DiagnosisResultSchema>;
export type FixRetryResult = v.InferOutput<typeof FixRetryResultSchema>;

const CLONE_SHELL_TIMEOUT_MS = 300_000;
const LOCAL_GIT_SHELL_TIMEOUT_MS = 60_000;
const PUSH_SHELL_TIMEOUT_MS = 120_000;
const TEST_SHELL_TIMEOUT_MS = 10 * 60_000;
const SETUP_SHELL_TIMEOUT_MS = 10 * 60_000;
const MAX_TEST_OUTPUT_CHARS = 8_000;

async function runOrThrow(
	sandbox: SessionEnv,
	command: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ShellResult> {
	const startedAt = Date.now();
	const result = await sandbox.exec(command, { timeoutMs, signal });
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

async function runRemoteGitCommandOrThrow(
	sandbox: SessionEnv,
	command: string,
	description: string,
	timeoutMs: number,
	secrets: ReadonlyArray<string | undefined>,
	signal?: AbortSignal,
): Promise<void> {
	const startedAt = Date.now();
	const result = await sandbox.exec(command, { timeoutMs, signal });
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
	sandbox: SessionEnv,
	input: FixIncidentInput,
	secrets: ReadonlyArray<string | undefined>,
	signal?: AbortSignal,
): Promise<void> {
	await runRemoteGitCommandOrThrow(
		sandbox,
		`git clone --depth 20 ${shellQuote(input.repo.cloneUrl)} .`,
		"git clone",
		CLONE_SHELL_TIMEOUT_MS,
		secrets,
		signal,
	);
	await runOrThrow(
		sandbox,
		`git remote set-url origin ${shellQuote(tokenlessCloneUrl(input.repo.cloneUrl))}`,
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	await runOrThrow(
		sandbox,
		`git checkout -b ${shellQuote(input.repo.branchName)}`,
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	await runOrThrow(
		sandbox,
		'git config user.name "paperhanger[bot]"',
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	await runOrThrow(
		sandbox,
		'git config user.email "paperhanger[bot]@users.noreply.github.com"',
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
}

async function runSetupScript(
	sandbox: SessionEnv,
	setupScript: string,
	label: string,
	secrets: ReadonlyArray<string | undefined>,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; failureReason: string }> {
	const startedAt = Date.now();
	const result = await sandbox.exec(setupScript, {
		timeoutMs: SETUP_SHELL_TIMEOUT_MS,
		signal,
	});
	if (result.exitCode === 0) return { ok: true };
	const tail = redactSecrets(
		`${result.stdout}\n${result.stderr}`,
		secrets,
	).slice(-MAX_TEST_OUTPUT_CHARS);
	if (Date.now() - startedAt >= SETUP_SHELL_TIMEOUT_MS) {
		return {
			ok: false,
			failureReason: `${label} timed out after ${SETUP_SHELL_TIMEOUT_MS}ms\n${tail}`,
		};
	}
	return {
		ok: false,
		failureReason: `${label} failed (exit ${result.exitCode})\n${tail}`,
	};
}

export async function prepareIncident(
	input: FixIncidentInput,
	sandbox: SessionEnv,
	signal?: AbortSignal,
): Promise<void> {
	const secrets = collectSecrets(input);
	await cloneAndPrepareBranch(sandbox, input, secrets, signal);
	const commonSetup = await runConditionalSetupScripts(
		sandbox,
		input.repo.setupScripts,
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		(script, label) => runSetupScript(sandbox, script, label, secrets, signal),
		signal,
	);
	if (!commonSetup.ok) throw new Error(commonSetup.failureReason);
	if (input.repo.setupScript) {
		const setup = await runSetupScript(
			sandbox,
			input.repo.setupScript,
			"repository setup script",
			secrets,
			signal,
		);
		if (!setup.ok) throw new Error(setup.failureReason);
	}
}

export async function verifyNoTamper(
	sandbox: SessionEnv,
	input: FixIncidentInput,
	signal?: AbortSignal,
): Promise<void> {
	const remoteResult = await runOrThrow(
		sandbox,
		"git remote get-url origin",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	const branchResult = await runOrThrow(
		sandbox,
		"git rev-parse --abbrev-ref HEAD",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	const check = checkForTamper({
		actualRemoteUrl: remoteResult.stdout,
		expectedRemoteUrl: tokenlessCloneUrl(input.repo.cloneUrl),
		actualBranch: branchResult.stdout,
		expectedBranch: input.repo.branchName,
	});
	if (!check.ok) throw new Error(`Tamper check failed: ${check.reason}`);
}

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

export async function commitAndPush(
	sandbox: SessionEnv,
	input: FixIncidentInput,
	commitMessage: string,
	secrets: ReadonlyArray<string | undefined>,
	signal?: AbortSignal,
): Promise<{ changedFiles: string[] }> {
	await verifyNoTamper(sandbox, input, signal);
	const status = await runOrThrow(
		sandbox,
		"git status --porcelain",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	const changedFiles = parsePorcelainStatus(status.stdout);
	await runOrThrow(sandbox, "git add -A", LOCAL_GIT_SHELL_TIMEOUT_MS, signal);
	await sandbox.writeFile(".paperhanger-commit-message.txt", commitMessage);
	await runOrThrow(
		sandbox,
		"git commit -F .paperhanger-commit-message.txt",
		LOCAL_GIT_SHELL_TIMEOUT_MS,
		signal,
	);
	await sandbox.rm(".paperhanger-commit-message.txt", { force: true });
	await runRemoteGitCommandOrThrow(
		sandbox,
		`git push ${shellQuote(input.repo.cloneUrl)} HEAD:${shellQuote(input.repo.branchName)}`,
		"git push",
		PUSH_SHELL_TIMEOUT_MS,
		secrets,
		signal,
	);
	return { changedFiles };
}

export interface TestRunResult {
	command?: string;
	passed: boolean;
	output: string;
	found: boolean;
}

export async function detectAndRunTests(
	sandbox: SessionEnv,
	testCommandOverride?: string,
	signal?: AbortSignal,
): Promise<TestRunResult> {
	let command: string | undefined;
	if (testCommandOverride && testCommandOverride.trim().length > 0) {
		command = testCommandOverride;
	} else {
		const probe: TestSuiteProbe = {
			packageJsonExists: await sandbox.exists("package.json"),
			bunLockExists: await sandbox.exists("bun.lock"),
			bunLockbExists: await sandbox.exists("bun.lockb"),
			pnpmLockExists: await sandbox.exists("pnpm-lock.yaml"),
			yarnLockExists: await sandbox.exists("yarn.lock"),
			goModExists: await sandbox.exists("go.mod"),
			cargoTomlExists: await sandbox.exists("Cargo.toml"),
		};
		if (probe.packageJsonExists) {
			try {
				const raw = await sandbox.readFile("package.json");
				const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
				probe.packageJsonScripts = pkg.scripts;
			} catch {
				// Detection continues through the other supported ecosystems.
			}
		}
		command = detectTestCommand(probe, testCommandOverride);
	}
	if (!command) return { passed: false, output: "", found: false };
	const result = await sandbox.exec(command, {
		timeoutMs: TEST_SHELL_TIMEOUT_MS,
		signal,
	});
	const output = `${result.stdout}\n${result.stderr}`.slice(
		-MAX_TEST_OUTPUT_CHARS,
	);
	return { command, passed: result.exitCode === 0, output, found: true };
}

export function buildRetryPrompt(testRun: TestRunResult): string {
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

export function failedResult(
	input: FixIncidentInput,
	err: unknown,
): FixIncidentOutput {
	const rawMessage = err instanceof Error ? err.message : String(err);
	const secrets = collectSecrets(input);
	return sanitizeOutput(
		{
			outcome: "failed",
			diagnosis:
				"The fix agent encountered an internal error before completing its diagnosis.",
			report: `The fix agent failed with an internal error: ${rawMessage}`,
			failureReason: rawMessage,
		},
		secrets,
	);
}

export function sanitizeIncidentOutput(
	input: FixIncidentInput,
	output: FixIncidentOutput,
): FixIncidentOutput {
	return sanitizeOutput(output, collectSecrets(input));
}

export function decideTestAttempt(args: {
	attempt: number;
	maxFixAttempts: number;
	testRun: TestRunResult;
}) {
	return decideFixAttempt(args);
}
