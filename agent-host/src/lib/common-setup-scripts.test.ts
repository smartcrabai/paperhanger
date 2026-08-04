import { describe, expect, test } from "bun:test";
import { runConditionalSetupScripts } from "./common-setup-scripts.ts";

describe("runConditionalSetupScripts", () => {
	test("runs matching scripts in order, skips missing triggers, and stops on failure", async () => {
		const commands: string[] = [];
		const signals: (AbortSignal | undefined)[] = [];
		const runLabels: string[] = [];
		const harness = {
			async exec(
				command: string,
				options: { timeoutMs: number; signal?: AbortSignal },
			): Promise<{ exitCode: number }> {
				commands.push(command);
				signals.push(options.signal);
				return { exitCode: command.includes("package-lock.json") ? 42 : 0 };
			},
		};
		const controller = new AbortController();
		const result = await runConditionalSetupScripts(
			harness,
			[
				{ triggerFile: "bun.lock", script: "install-a" },
				{ triggerFile: "package-lock.json", script: "install-skipped" },
				{ triggerFile: "packages/app's lock", script: "install-b" },
				{ triggerFile: "Cargo.toml", script: "install-never" },
			],
			30_000,
			async (script, label) => {
				runLabels.push(label);
				return script === "install-b"
					? { ok: false, failureReason: "failed" }
					: { ok: true };
			},
			controller.signal,
		);

		expect(result).toEqual({ ok: false, failureReason: "failed" });
		expect(commands).toEqual([
			"if test -f 'bun.lock'; then exit 0; else exit 42; fi",
			"if test -f 'package-lock.json'; then exit 0; else exit 42; fi",
			`if test -f 'packages/app'"'"'s lock'; then exit 0; else exit 42; fi`,
		]);
		expect(runLabels).toEqual([
			"setup script for bun.lock",
			"setup script for packages/app's lock",
		]);
		expect(signals).toEqual([
			controller.signal,
			controller.signal,
			controller.signal,
		]);
	});

	test("fails closed when checking a trigger file cannot complete", async () => {
		let ran = false;
		const result = await runConditionalSetupScripts(
			{
				async exec() {
					return { exitCode: 1 };
				},
			},
			[{ triggerFile: "bun.lock", script: "install" }],
			30_000,
			async () => {
				ran = true;
				return { ok: true };
			},
		);

		expect(result).toEqual({
			ok: false,
			failureReason: "trigger check for bun.lock failed (exit 1)",
		});
		expect(ran).toBe(false);
	});
});
