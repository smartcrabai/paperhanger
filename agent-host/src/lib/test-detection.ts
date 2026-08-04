/**
 * Deterministic test-command selection extracted from the fix agent's
 * orchestration. The pure decision logic is testable without a sandbox;
 * runtime command execution stays in the agent module.
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
	/**
	 * Raw `pyproject.toml` content, when the file exists at the repo root
	 * and read cleanly. Content, not mere existence, is the signal (mirroring
	 * how `package.json` is only a Node marker when it has `scripts.test`):
	 * a `pyproject.toml` without a `[tool.pytest...]` section doesn't imply
	 * a pytest suite (Poetry/uv/metadata-only projects). A bare
	 * `requirements*.txt` is deliberately NOT probed at all: a dependency
	 * manifest doesn't declare a test suite, detection runs no install step,
	 * and `python -m pytest` against an environment without pytest fails
	 * deterministically -- too weak a signal to spend a fix attempt on.
	 */
	pyprojectToml?: string;
	pytestIniExists: boolean;
	toxIniExists: boolean;
	setupCfgExists: boolean;
	gemfileExists: boolean;
	/** Whether a `spec` entry (RSpec's conventional directory) exists at the repo root. */
	specDirExists: boolean;
	/** Whether a `test` entry (Minitest's conventional directory) exists at the repo root. */
	testDirExists: boolean;
	pomXmlExists: boolean;
	/** Whether the `mvnw` Maven wrapper script exists at the repo root. */
	mvnwExists: boolean;
	/** Whether `build.gradle` or `build.gradle.kts` exists at the repo root. */
	buildGradleExists: boolean;
	/** Whether the `gradlew` Gradle wrapper script exists at the repo root. */
	gradlewExists: boolean;
	composerJsonExists: boolean;
	/** Whether `phpunit.xml` or `phpunit.xml.dist` exists at the repo root. */
	phpunitXmlExists: boolean;
	/**
	 * Whether any `*.sln` or `*.csproj` exists at the repo root. Root-level
	 * only on purpose: bare `dotnet test` resolves a solution/project from
	 * the current directory, so a `*.csproj` nested in a subdirectory would
	 * be a marker for a command that fails anyway.
	 */
	dotnetProjectExists: boolean;
	/** Whether `deno.json` or `deno.jsonc` exists at the repo root. */
	denoJsonExists: boolean;
	/**
	 * Parsed `deno.json`/`deno.jsonc` `tasks` map, when the file exists and
	 * parsed cleanly. `deno.jsonc` permits comments/trailing commas, so a
	 * parse failure just leaves this undefined.
	 */
	denoJsonTasks?: Record<string, string>;
}

/**
 * Line-anchored match for a `[tool.pytest]`/`[tool.pytest.ini_options]` table
 * header. The trailing `\b` matters: without it this would also match an
 * unrelated table like `[tool.pytestcov]`, since `pytest` is a prefix of
 * `pytestcov` -- `\b` requires the next character to end the word (`.` or
 * `]`, both non-word characters), which a same-prefix-but-different-tool
 * table name doesn't satisfy.
 */
const PYPROJECT_PYTEST_SECTION = /^[ \t]*\[tool\.pytest\b/m;

/**
 * Chooses a test command from a best-effort probe of the checked-out repo:
 * an explicit `override` (a RepoDefinition's `testCommand`, threaded through
 * `FixIncidentInput.repo.testCommand`) always wins and is returned verbatim,
 * bypassing detection entirely. A whitespace-only override is treated as
 * absent (it would otherwise run a blank shell command that exits 0,
 * falsely reporting tests as passed), falling through to auto-detection.
 * Otherwise the first matching ecosystem wins, in this order:
 *
 * 1. `package.json` `scripts.test` (lockfile-aware package manager selection)
 * 2. `go.mod` -> `go test ./...`
 * 3. `Cargo.toml` -> `cargo test`
 * 4. Python pytest markers (`pytest.ini`, `tox.ini`, `setup.cfg`, or a
 *    `pyproject.toml` with a `[tool.pytest...]` section) -> `python -m pytest`
 * 5. `Gemfile` with `spec/` -> `bundle exec rspec`, with `test/` ->
 *    `bundle exec rake test` (a `Gemfile` alone says nothing about which
 *    test framework the repo uses, so it doesn't detect on its own)
 * 6. `pom.xml` -> `./mvnw test` when the Maven wrapper is checked in, else
 *    `mvn test`; `build.gradle(.kts)` -> `./gradlew test` when the Gradle
 *    wrapper is checked in, else `gradle test`
 * 7. `composer.json` + `phpunit.xml(.dist)` -> `vendor/bin/phpunit` (both
 *    required: `composer.json` alone doesn't imply a PHPUnit suite)
 * 8. root-level `*.sln`/`*.csproj` -> `dotnet test`
 * 9. `deno.json`/`deno.jsonc` -> `deno task test` when it defines a
 *    `tasks.test` (mirroring how `package.json` `scripts.test` is preferred
 *    over the toolchain default), else the built-in `deno test`
 *
 * Returns `undefined` when no usable override was given and no recognized
 * test suite/toolchain is found.
 */
export function detectTestCommand(
	probe: TestSuiteProbe,
	override?: string,
): string | undefined {
	if (override && override.trim().length > 0) {
		return override;
	}
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
	if (
		probe.pytestIniExists ||
		probe.toxIniExists ||
		probe.setupCfgExists ||
		(probe.pyprojectToml !== undefined &&
			PYPROJECT_PYTEST_SECTION.test(probe.pyprojectToml))
	) {
		return "python -m pytest";
	}
	if (probe.gemfileExists) {
		if (probe.specDirExists) {
			return "bundle exec rspec";
		}
		if (probe.testDirExists) {
			return "bundle exec rake test";
		}
	}
	if (probe.pomXmlExists) {
		return probe.mvnwExists ? "./mvnw test" : "mvn test";
	}
	if (probe.buildGradleExists) {
		return probe.gradlewExists ? "./gradlew test" : "gradle test";
	}
	if (probe.composerJsonExists && probe.phpunitXmlExists) {
		return "vendor/bin/phpunit";
	}
	if (probe.dotnetProjectExists) {
		return "dotnet test";
	}
	if (probe.denoJsonExists) {
		return probe.denoJsonTasks?.test ? "deno task test" : "deno test";
	}
	return undefined;
}
