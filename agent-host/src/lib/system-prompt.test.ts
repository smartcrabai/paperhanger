import { describe, expect, test } from "bun:test";
import { renderCommonSystemPromptSection } from "./system-prompt.ts";

describe("renderCommonSystemPromptSection", () => {
	test("returns no lines when systemPrompt is undefined", () => {
		expect(renderCommonSystemPromptSection(undefined)).toEqual([]);
	});

	test("returns no lines when systemPrompt is an empty string", () => {
		expect(renderCommonSystemPromptSection("")).toEqual([]);
	});

	test("returns no lines when systemPrompt is whitespace-only", () => {
		expect(renderCommonSystemPromptSection("   \n\t  ")).toEqual([]);
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

	test("preserves internal multiline structure of the prompt", () => {
		const lines = renderCommonSystemPromptSection(
			"Line one.\nLine two.\nLine three.",
		);

		expect(lines.join("\n")).toContain("Line one.\nLine two.\nLine three.");
	});

	test("preserves internal blank and whitespace-only lines", () => {
		const lines = renderCommonSystemPromptSection(
			"Line one.\n\n   \nLine two.",
		);

		expect(lines.join("\n")).toContain("Line one.\n\n   \nLine two.");
	});
});
