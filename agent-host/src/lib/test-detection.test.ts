import { describe, expect, test } from "bun:test";
import { detectTestCommand, type TestSuiteProbe } from "./test-detection";

const NOTHING: TestSuiteProbe = {
	packageJsonExists: false,
	bunLockExists: false,
	bunLockbExists: false,
	pnpmLockExists: false,
	yarnLockExists: false,
	goModExists: false,
	cargoTomlExists: false,
};

describe("detectTestCommand", () => {
	test("returns undefined when nothing recognizable is present", () => {
		expect(detectTestCommand(NOTHING)).toBeUndefined();
	});

	test("prefers `bun run test` when bun.lock is present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { test: "bun test" },
				bunLockExists: true,
			}),
		).toBe("bun run test");
	});

	test("prefers `bun run test` when bun.lockb (binary lockfile) is present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { test: "bun test" },
				bunLockbExists: true,
			}),
		).toBe("bun run test");
	});

	test("uses `pnpm test` when only a pnpm lockfile is present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { test: "vitest" },
				pnpmLockExists: true,
			}),
		).toBe("pnpm test");
	});

	test("uses `yarn test` when only a yarn lockfile is present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { test: "jest" },
				yarnLockExists: true,
			}),
		).toBe("yarn test");
	});

	test("falls back to `npm test` when no known lockfile is present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { test: "jest" },
			}),
		).toBe("npm test");
	});

	test("does not select an npm/yarn/pnpm/bun command when scripts.test is absent", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { build: "tsc" },
				bunLockExists: true,
			}),
		).toBeUndefined();
	});

	test("falls through to go test when there is no package.json", () => {
		expect(detectTestCommand({ ...NOTHING, goModExists: true })).toBe(
			"go test ./...",
		);
	});

	test("falls through to cargo test when there is no package.json or go.mod", () => {
		expect(detectTestCommand({ ...NOTHING, cargoTomlExists: true })).toBe(
			"cargo test",
		);
	});

	test("prefers package.json over go.mod/Cargo.toml when multiple ecosystems are present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				packageJsonExists: true,
				packageJsonScripts: { test: "jest" },
				goModExists: true,
				cargoTomlExists: true,
			}),
		).toBe("npm test");
	});

	test("prefers go.mod over Cargo.toml when both are present and there is no usable package.json", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				goModExists: true,
				cargoTomlExists: true,
			}),
		).toBe("go test ./...");
	});
});
