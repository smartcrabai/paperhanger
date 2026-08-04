import { describe, expect, test } from "bun:test";
import type { FixIncidentInput } from "../contract.ts";
import { buildDiagnosisPrompt } from "./diagnosis-prompt.ts";

function makeInput(
	overrides: Partial<FixIncidentInput> = {},
): FixIncidentInput {
	return {
		incidentId: "incident-1",
		contextMarkdown: "### Alert\nSomething broke.",
		alert: {
			title: "Something broke",
			severity: "critical",
			source: "test",
			labels: {},
			annotations: {},
		},
		repo: {
			owner: "acme",
			repo: "widgets",
			cloneUrl: "https://x-access-token:secret@github.com/acme/widgets.git",
			defaultBranch: "main",
			branchName: "fix/incident-1",
			setupScripts: [],
		},
		limits: { timeoutMinutes: 10, maxDiffLines: 200, maxFixAttempts: 2 },
		forbiddenPaths: [],
		...overrides,
	};
}

describe("buildDiagnosisPrompt", () => {
	test("omits the operator instructions section and its separator when systemPrompt is unset", () => {
		const prompt = buildDiagnosisPrompt(makeInput());

		expect(prompt.startsWith("## Incident context")).toBe(true);
		expect(prompt).not.toContain("Operator instructions");
	});

	test("omits the operator instructions section when systemPrompt is blank", () => {
		const prompt = buildDiagnosisPrompt(makeInput({ systemPrompt: "   " }));

		expect(prompt.startsWith("## Incident context")).toBe(true);
		expect(prompt).not.toContain("Operator instructions");
	});

	test("places a trimmed operator instructions section, separated by a blank line, ahead of the incident context", () => {
		const prompt = buildDiagnosisPrompt(
			makeInput({ systemPrompt: "  Always write tests first.  " }),
		);
		const lines = prompt.split("\n");
		const headingIndex = lines.indexOf(
			"## Operator instructions (apply to every repository)",
		);
		const incidentIndex = lines.indexOf("## Incident context");

		expect(headingIndex).toBe(0);
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("Always write tests first.");
		expect(lines[3]).toBe("");
		expect(incidentIndex).toBe(4);
	});

	test("labels the incident context as untrusted data, ahead of the raw context markdown", () => {
		const prompt = buildDiagnosisPrompt(
			makeInput({ contextMarkdown: "some external content" }),
		);
		const untrustedNoticeIndex = prompt.indexOf("untrusted");
		const contextIndex = prompt.indexOf("some external content");

		expect(untrustedNoticeIndex).toBeGreaterThan(-1);
		expect(untrustedNoticeIndex).toBeLessThan(contextIndex);
	});

	test("lists configured forbidden paths and the max diff size in the constraints section", () => {
		const prompt = buildDiagnosisPrompt(
			makeInput({ forbiddenPaths: ["infra/**", "secrets/**"] }),
		);

		expect(prompt).toContain(
			"Forbidden paths (never modify a matching file): infra/**, secrets/**",
		);
		expect(prompt).toContain("Max diff size: 200 changed lines");
	});

	test("reports no forbidden paths as configured when the list is empty", () => {
		const prompt = buildDiagnosisPrompt(makeInput({ forbiddenPaths: [] }));

		expect(prompt).toContain(
			"Forbidden paths (never modify a matching file): (none configured)",
		);
	});
});
