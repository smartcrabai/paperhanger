/**
 * Deterministic test-command selection, extracted from
 * `../workflows/fix-incident.ts`'s `detectAndRunTests` so the decision logic
 * (which command to run, given what's on disk) is a pure function testable
 * without a sandbox/filesystem. `detectAndRunTests` itself stays in the
 * workflow file: it owns the `harness.fs`/`harness.shell` I/O, and calls
 * `detectTestCommand` with a plain-data probe of what it found.
 */

/** Best-effort, file-existence-only probe of a checked-out repository. */
export interface TestSuiteProbe {
	/** Whether `package.json` exists at the repo root. */
	packageJsonExists: boolean;
	/**
	 * Parsed `package.json` `scripts` map, when `package.json` exists and
	 * parsed cleanly. Omit (or leave undefined) when it doesn't exist, is
	 * malformed, or has no `scripts` field.
	 */
	packageJsonScripts?: Record<string, string>;
	bunLockExists: boolean;
	bunLockbExists: boolean;
	pnpmLockExists: boolean;
	yarnLockExists: boolean;
	goModExists: boolean;
	cargoTomlExists: boolean;
}

/**
 * Chooses a test command from a best-effort probe of the checked-out repo:
 * `package.json` `scripts.test` (lockfile-aware package manager selection)
 * takes precedence, then `go test ./...`, then `cargo test`. Returns
 * `undefined` when no recognized test suite/toolchain is found.
 */
export function detectTestCommand(probe: TestSuiteProbe): string | undefined {
	if (probe.packageJsonExists && probe.packageJsonScripts?.test) {
		if (probe.bunLockExists || probe.bunLockbExists) {
			return "bun run test";
		}
		if (probe.pnpmLockExists) {
			return "pnpm test";
		}
		if (probe.yarnLockExists) {
			return "yarn test";
		}
		return "npm test";
	}
	if (probe.goModExists) {
		return "go test ./...";
	}
	if (probe.cargoTomlExists) {
		return "cargo test";
	}
	return undefined;
}
