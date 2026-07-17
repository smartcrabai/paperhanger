import { describe, expect, test } from "bun:test";
import type { WorkflowInput, WorkflowOutput } from "../contract.ts";
import { collectSecrets, sanitizeOutput } from "./output-sanitizer";

function baseInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
	return {
		incidentId: "incident-1",
		contextMarkdown: "# Incident\nSomething broke.",
		alert: {
			title: "Checkout API 500s",
			severity: "critical",
			source: "grafana",
			labels: {},
			annotations: {},
		},
		repo: {
			owner: "acme",
			repo: "widgets",
			cloneUrl: "https://x-access-token:ghs_abc123@github.com/acme/widgets.git",
			defaultBranch: "main",
			branchName: "paperhanger/incident-1",
		},
		limits: { timeoutMinutes: 30, maxDiffLines: 500, maxFixAttempts: 3 },
		forbiddenPaths: [],
		...overrides,
	};
}

describe("collectSecrets", () => {
	test("includes the clone token extracted from repo.cloneUrl", () => {
		expect(collectSecrets(baseInput())).toContain("ghs_abc123");
	});

	test("includes the GreptimeDB auth value when telemetry is configured", () => {
		const secrets = collectSecrets(
			baseInput({
				telemetry: {
					source: "greptimedb",
					url: "http://greptimedb:4000",
					database: "public",
					auth: "user:pw",
				},
			}),
		);
		expect(secrets).toContain("user:pw");
	});

	test("omits the GreptimeDB auth entry (as undefined) when telemetry is not configured", () => {
		const secrets = collectSecrets(baseInput());
		expect(secrets).toContain(undefined);
	});

	test("returns undefined for the clone token when the URL has no embedded credential", () => {
		const secrets = collectSecrets(
			baseInput({
				repo: {
					owner: "acme",
					repo: "widgets",
					cloneUrl: "https://github.com/acme/widgets.git",
					defaultBranch: "main",
					branchName: "paperhanger/incident-1",
				},
			}),
		);
		expect(secrets[0]).toBeUndefined();
	});
});

describe("sanitizeOutput", () => {
	const secrets = ["ghs_abc123", "user:pw"];

	test("redacts the clone token from diagnosis and report", () => {
		const output: WorkflowOutput = {
			outcome: "report_only",
			diagnosis: "Found token ghs_abc123 in a log line.",
			report: "Report mentions ghs_abc123 too.",
		};
		const sanitized = sanitizeOutput(output, secrets);
		expect(sanitized.diagnosis).not.toContain("ghs_abc123");
		expect(sanitized.report).not.toContain("ghs_abc123");
		expect(sanitized.diagnosis).toContain("***REDACTED***");
	});

	test("redacts a configured GreptimeDB auth value from the report", () => {
		const output: WorkflowOutput = {
			outcome: "report_only",
			diagnosis: "Root cause analysis.",
			report: "query_telemetry returned auth user:pw in one row.",
		};
		const sanitized = sanitizeOutput(output, secrets);
		expect(sanitized.report).not.toContain("user:pw");
	});

	test("redacts failureReason when present", () => {
		const output: WorkflowOutput = {
			outcome: "failed",
			diagnosis: "d",
			report: "r",
			failureReason: "push failed, url was https://x@github.com ghs_abc123",
		};
		const sanitized = sanitizeOutput(output, secrets);
		expect(sanitized.failureReason).not.toContain("ghs_abc123");
	});

	test("leaves failureReason as undefined when absent", () => {
		const output: WorkflowOutput = {
			outcome: "report_only",
			diagnosis: "d",
			report: "r",
		};
		const sanitized = sanitizeOutput(output, secrets);
		expect(sanitized.failureReason).toBeUndefined();
	});

	test("redacts fix.commitMessage when a fix block is present", () => {
		const output: WorkflowOutput = {
			outcome: "fixed",
			diagnosis: "d",
			report: "r",
			fix: {
				branch: "paperhanger/incident-1",
				commitMessage: "fix: rotate leaked token ghs_abc123",
				changedFiles: ["src/index.ts"],
				testsPassed: true,
			},
		};
		const sanitized = sanitizeOutput(output, secrets);
		expect(sanitized.fix?.commitMessage).not.toContain("ghs_abc123");
		expect(sanitized.fix?.changedFiles).toEqual(["src/index.ts"]);
	});

	test("is a no-op when no secrets are configured", () => {
		const output: WorkflowOutput = {
			outcome: "report_only",
			diagnosis: "clean diagnosis",
			report: "clean report",
		};
		expect(sanitizeOutput(output, [undefined, undefined])).toEqual(output);
	});
});
