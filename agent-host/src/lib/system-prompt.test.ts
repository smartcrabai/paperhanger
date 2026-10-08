import { describe, expect, test } from "bun:test";
import {
	renderCommonSystemPromptSection,
	renderEffectiveSystemPromptSection,
	renderRepoSystemPromptSection,
} from "./system-prompt.ts";

describe("renderCommonSystemPromptSection", () => {
	test("returns no lines when systemPrompt is unset, empty, or whitespace-only", () => {
		for (const systemPrompt of [undefined, "", "   \n\t  "]) {
			expect(renderCommonSystemPromptSection(systemPrompt)).toEqual([]);
		}
	});

	test("renders a heading followed by the trimmed prompt text", () => {
		const lines = renderCommonSystemPromptSection(
			"  Always write tests before implementing a fix.  ",
		);

		expect(lines).toEqual([
			"## Operator instructions (apply to every repository)",
			"",
			"Always write tests before implementing a fix.",
		]);
	});

	test("preserves internal multiline, blank, and whitespace-only lines", () => {
		const commonLines = renderCommonSystemPromptSection(
			"Line one.\nLine two.\nLine three.",
		);
		expect(commonLines.join("\n")).toContain(
			"Line one.\nLine two.\nLine three.",
		);

		const lines = renderCommonSystemPromptSection(
			"Line one.\n\n   \nLine two.",
		);
		expect(lines.join("\n")).toContain("Line one.\n\n   \nLine two.");

		const repoLines = renderRepoSystemPromptSection(
			"Line one.\n\n   \nLine two.",
		);
		expect(repoLines.join("\n")).toContain("Line one.\n\n   \nLine two.");
	});
});

describe("renderRepoSystemPromptSection", () => {
	test("returns no lines for undefined, empty, or whitespace-only input", () => {
		expect(renderRepoSystemPromptSection(undefined)).toEqual([]);
		expect(renderRepoSystemPromptSection("")).toEqual([]);
		expect(renderRepoSystemPromptSection("   \n\t  ")).toEqual([]);
	});

	test("renders a repository-scoped heading followed by the trimmed prompt", () => {
		expect(
			renderRepoSystemPromptSection("  Prefer minimal diffs here.  "),
		).toEqual([
			"## Operator instructions (this repository)",
			"",
			"Prefer minimal diffs here.",
		]);
	});
});

describe("renderEffectiveSystemPromptSection", () => {
	test("returns no lines when neither scope is set", () => {
		expect(renderEffectiveSystemPromptSection({})).toEqual([]);
	});

	test("renders the common section when only the common prompt is set", () => {
		expect(
			renderEffectiveSystemPromptSection({ systemPrompt: "Common rules." }),
		).toEqual(renderCommonSystemPromptSection("Common rules."));
	});

	test("renders the repo section when only the per-repo prompt is set", () => {
		expect(
			renderEffectiveSystemPromptSection({ repoSystemPrompt: "Repo rules." }),
		).toEqual(renderRepoSystemPromptSection("Repo rules."));
	});

	test("the per-repo prompt REPLACES the common one rather than stacking", () => {
		const lines = renderEffectiveSystemPromptSection({
			systemPrompt: "Common rules.",
			repoSystemPrompt: "Repo rules.",
		});

		expect(lines).toEqual(renderRepoSystemPromptSection("Repo rules."));
		expect(lines.join("\n")).not.toContain("Common rules.");
	});

	test("a blank per-repo prompt falls back to the common one", () => {
		for (const repoSystemPrompt of ["", "   \n\t "]) {
			expect(
				renderEffectiveSystemPromptSection({
					systemPrompt: "Common rules.",
					repoSystemPrompt,
				}),
			).toEqual(renderCommonSystemPromptSection("Common rules."));
		}
	});

	test("a blank common prompt does not suppress the per-repo one", () => {
		expect(
			renderEffectiveSystemPromptSection({
				systemPrompt: "   ",
				repoSystemPrompt: "Repo rules.",
			}),
		).toEqual(renderRepoSystemPromptSection("Repo rules."));
	});
});
