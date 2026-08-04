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
	pytestIniExists: false,
	toxIniExists: false,
	setupCfgExists: false,
	gemfileExists: false,
	specDirExists: false,
	testDirExists: false,
	pomXmlExists: false,
	mvnwExists: false,
	buildGradleExists: false,
	gradlewExists: false,
	composerJsonExists: false,
	phpunitXmlExists: false,
	dotnetProjectExists: false,
	denoJsonExists: false,
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

	test("detects pytest from pytest.ini", () => {
		expect(detectTestCommand({ ...NOTHING, pytestIniExists: true })).toBe(
			"python -m pytest",
		);
	});

	test("detects pytest from tox.ini", () => {
		expect(detectTestCommand({ ...NOTHING, toxIniExists: true })).toBe(
			"python -m pytest",
		);
	});

	test("detects pytest from setup.cfg", () => {
		expect(detectTestCommand({ ...NOTHING, setupCfgExists: true })).toBe(
			"python -m pytest",
		);
	});

	test("detects pytest from a pyproject.toml with a [tool.pytest] section", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				pyprojectToml:
					'[project]\nname = "app"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
			}),
		).toBe("python -m pytest");
	});

	test("does not detect pytest from a pyproject.toml without a [tool.pytest] section", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				pyprojectToml: '[project]\nname = "app"\n\n[tool.ruff]\n',
			}),
		).toBeUndefined();
	});

	test("does not mistake an unrelated same-prefix table (e.g. [tool.pytestcov]) for a pytest section", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				pyprojectToml: '[project]\nname = "app"\n\n[tool.pytestcov]\n',
			}),
		).toBeUndefined();
	});

	test("detects RSpec from a Gemfile with a spec/ directory", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				gemfileExists: true,
				specDirExists: true,
			}),
		).toBe("bundle exec rspec");
	});

	test("detects Minitest from a Gemfile with a test/ directory", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				gemfileExists: true,
				testDirExists: true,
			}),
		).toBe("bundle exec rake test");
	});

	test("prefers RSpec over Minitest when both spec/ and test/ are present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				gemfileExists: true,
				specDirExists: true,
				testDirExists: true,
			}),
		).toBe("bundle exec rspec");
	});

	test("does not detect a Ruby test command from a Gemfile alone", () => {
		expect(
			detectTestCommand({ ...NOTHING, gemfileExists: true }),
		).toBeUndefined();
	});

	test("does not detect a Ruby test command from spec/ or test/ without a Gemfile", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				specDirExists: true,
				testDirExists: true,
			}),
		).toBeUndefined();
	});

	test("uses the Maven wrapper for pom.xml when mvnw is checked in", () => {
		expect(
			detectTestCommand({ ...NOTHING, pomXmlExists: true, mvnwExists: true }),
		).toBe("./mvnw test");
	});

	test("falls back to the global mvn for pom.xml without the wrapper", () => {
		expect(detectTestCommand({ ...NOTHING, pomXmlExists: true })).toBe(
			"mvn test",
		);
	});

	test("uses the Gradle wrapper for a Gradle build when gradlew is checked in", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				buildGradleExists: true,
				gradlewExists: true,
			}),
		).toBe("./gradlew test");
	});

	test("falls back to the global gradle for a Gradle build without the wrapper", () => {
		expect(detectTestCommand({ ...NOTHING, buildGradleExists: true })).toBe(
			"gradle test",
		);
	});

	test("prefers Maven over Gradle when both build files are present", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				pomXmlExists: true,
				buildGradleExists: true,
				gradlewExists: true,
			}),
		).toBe("mvn test");
	});

	test("detects PHPUnit from composer.json with a phpunit.xml(.dist)", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				composerJsonExists: true,
				phpunitXmlExists: true,
			}),
		).toBe("vendor/bin/phpunit");
	});

	test("does not detect PHPUnit from composer.json alone", () => {
		expect(
			detectTestCommand({ ...NOTHING, composerJsonExists: true }),
		).toBeUndefined();
	});

	test("does not detect PHPUnit from phpunit.xml without composer.json", () => {
		expect(
			detectTestCommand({ ...NOTHING, phpunitXmlExists: true }),
		).toBeUndefined();
	});

	test("detects .NET from a root-level solution or project file", () => {
		expect(detectTestCommand({ ...NOTHING, dotnetProjectExists: true })).toBe(
			"dotnet test",
		);
	});

	test("detects the built-in runner from deno.json without a tasks.test", () => {
		expect(detectTestCommand({ ...NOTHING, denoJsonExists: true })).toBe(
			"deno test",
		);
	});

	test("prefers `deno task test` when deno.json defines a tasks.test", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				denoJsonExists: true,
				denoJsonTasks: { test: "deno test --coverage" },
			}),
		).toBe("deno task test");
	});

	test("falls back to `deno test` when tasks exists but has no test entry", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				denoJsonExists: true,
				denoJsonTasks: { build: "deno compile main.ts" },
			}),
		).toBe("deno test");
	});

	test("prefers the established ecosystems over the newly detected ones", () => {
		expect(
			detectTestCommand({
				...NOTHING,
				cargoTomlExists: true,
				pytestIniExists: true,
				gemfileExists: true,
				specDirExists: true,
				pomXmlExists: true,
				composerJsonExists: true,
				phpunitXmlExists: true,
				dotnetProjectExists: true,
				denoJsonExists: true,
			}),
		).toBe("cargo test");
	});

	test("orders the newly detected ecosystems Python > Ruby > Java > PHP > .NET > Deno", () => {
		const rubyAndLater: TestSuiteProbe = {
			...NOTHING,
			gemfileExists: true,
			specDirExists: true,
			pomXmlExists: true,
			composerJsonExists: true,
			phpunitXmlExists: true,
			dotnetProjectExists: true,
			denoJsonExists: true,
		};
		expect(detectTestCommand(rubyAndLater)).toBe("bundle exec rspec");
		expect(
			detectTestCommand({
				...rubyAndLater,
				gemfileExists: false,
				specDirExists: false,
			}),
		).toBe("mvn test");
		expect(
			detectTestCommand({
				...rubyAndLater,
				gemfileExists: false,
				specDirExists: false,
				pomXmlExists: false,
			}),
		).toBe("vendor/bin/phpunit");
		expect(
			detectTestCommand({
				...rubyAndLater,
				gemfileExists: false,
				specDirExists: false,
				pomXmlExists: false,
				composerJsonExists: false,
				phpunitXmlExists: false,
			}),
		).toBe("dotnet test");
		expect(
			detectTestCommand({
				...rubyAndLater,
				gemfileExists: false,
				specDirExists: false,
				pomXmlExists: false,
				composerJsonExists: false,
				phpunitXmlExists: false,
				dotnetProjectExists: false,
			}),
		).toBe("deno test");
	});

	test("an explicit override wins over auto-detection", () => {
		expect(
			detectTestCommand(
				{
					...NOTHING,
					packageJsonExists: true,
					packageJsonScripts: { test: "jest" },
					bunLockExists: true,
				},
				"make test",
			),
		).toBe("make test");
	});

	test("an explicit override is used verbatim even when nothing is auto-detectable", () => {
		expect(detectTestCommand(NOTHING, "make test")).toBe("make test");
	});

	test("an empty-string override is ignored and falls through to auto-detection", () => {
		expect(detectTestCommand({ ...NOTHING, goModExists: true }, "")).toBe(
			"go test ./...",
		);
	});

	test("a whitespace-only override is ignored and falls through to auto-detection", () => {
		expect(
			detectTestCommand({ ...NOTHING, goModExists: true }, "   \n\t "),
		).toBe("go test ./...");
	});
});
