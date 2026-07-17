import { describe, expect, test } from "bun:test";
import { findForbiddenPaths, isForbiddenPath } from "./forbidden-paths";

describe("isForbiddenPath", () => {
	test("matches a direct child of a `**`-suffixed directory pattern", () => {
		expect(
			isForbiddenPath(".github/workflows/ci.yml", [".github/workflows/**"]),
		).toBe(true);
	});

	test("matches a nested descendant of a `**`-suffixed directory pattern", () => {
		expect(
			isForbiddenPath(".github/workflows/sub/ci.yml", [".github/workflows/**"]),
		).toBe(true);
	});

	test("does not match the bare directory itself", () => {
		expect(isForbiddenPath(".github/workflows", [".github/workflows/**"])).toBe(
			false,
		);
	});

	test("does not match an unrelated path", () => {
		expect(isForbiddenPath("src/index.ts", [".github/workflows/**"])).toBe(
			false,
		);
	});

	test("does not match a sibling directory whose name merely starts with the pattern's leaf directory", () => {
		expect(
			isForbiddenPath(".github/workflows-old/deploy.yml", [
				".github/workflows/**",
			]),
		).toBe(false);
	});

	test("does not match a differently-named top-level directory that merely contains the pattern's segments", () => {
		expect(
			isForbiddenPath(".github-workflows/ci.yml", [".github/workflows/**"]),
		).toBe(false);
	});

	test("matches a leading `**` pattern at any depth, including the root", () => {
		expect(isForbiddenPath("file.pem", ["**/*.pem"])).toBe(true);
		expect(isForbiddenPath("deep/nested/dir/file.pem", ["**/*.pem"])).toBe(
			true,
		);
	});

	test("matches when any of several patterns matches", () => {
		const patterns = ["secrets/*.yaml", ".github/workflows/**"];
		expect(isForbiddenPath(".github/workflows/ci.yml", patterns)).toBe(true);
		expect(isForbiddenPath("secrets/prod.yaml", patterns)).toBe(true);
		expect(isForbiddenPath("src/index.ts", patterns)).toBe(false);
	});

	test("returns false when there are no patterns", () => {
		expect(isForbiddenPath("anything.ts", [])).toBe(false);
	});
});

describe("findForbiddenPaths", () => {
	test("returns only the files that match a forbidden pattern", () => {
		const filenames = [
			".github/workflows/ci.yml",
			"src/index.ts",
			".github/workflows/sub/deploy.yml",
			"README.md",
		];
		expect(findForbiddenPaths(filenames, [".github/workflows/**"])).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/sub/deploy.yml",
		]);
	});

	test("returns an empty array when no patterns are configured", () => {
		expect(findForbiddenPaths(["src/index.ts"], [])).toEqual([]);
	});

	test("returns an empty array when nothing matches", () => {
		expect(findForbiddenPaths(["src/index.ts"], ["secrets/**"])).toEqual([]);
	});
});
