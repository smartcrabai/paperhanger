export interface ConditionalSetupScript {
	triggerFile: string;
	script: string;
}

interface SandboxLike {
	exec(
		command: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<{ exitCode: number }>;
}

type SetupResult = { ok: true } | { ok: false; failureReason: string };

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Evaluates trigger files and runs every matching script in list order. */
export async function runConditionalSetupScripts(
	harness: SandboxLike,
	setupScripts: readonly ConditionalSetupScript[],
	conditionTimeoutMs: number,
	run: (script: string, label: string) => Promise<SetupResult>,
	signal?: AbortSignal,
): Promise<SetupResult> {
	for (const setupScript of setupScripts) {
		const condition = await harness.exec(
			`if test -f ${shellQuote(setupScript.triggerFile)}; then exit 0; else exit 42; fi`,
			{ timeoutMs: conditionTimeoutMs, signal },
		);
		if (condition.exitCode === 42) continue;
		if (condition.exitCode !== 0) {
			return {
				ok: false,
				failureReason: `trigger check for ${setupScript.triggerFile} failed (exit ${condition.exitCode})`,
			};
		}

		const result = await run(
			setupScript.script,
			`setup script for ${setupScript.triggerFile}`,
		);
		if (!result.ok) return result;
	}
	return { ok: true };
}
