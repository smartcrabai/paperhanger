#!/usr/bin/env node
// Node-run smoke test: validates that the agent-host's workflow input/output
// contract schemas parse example payloads correctly, and that the discovered
// `fix-incident` workflow module has a well-formed default export. Does not
// call a real model or sandbox — see agent-host/README.md for the full
// `flue build`/boot verification.
//
// Run with: node --experimental-strip-types scripts/smoke.mjs
// (or plain `node scripts/smoke.mjs` on a Node version where type-stripping
// of erasable TypeScript syntax is enabled by default; see package.json's
// "smoke" script for the exact invocation used in CI/local verification.)

import * as v from "valibot";
import { WorkflowInputSchema, WorkflowOutputSchema } from "../src/contract.ts";
import workflow from "../src/workflows/fix-incident.ts";

let failures = 0;

function assert(condition, message) {
	if (condition) {
		console.log(`OK: ${message}`);
	} else {
		console.error(`FAIL: ${message}`);
		failures++;
	}
}

const exampleInput = {
	incidentId: "incident-123",
	contextMarkdown: "# Incident\nSomething broke.",
	alert: {
		title: "Checkout API 500s",
		severity: "critical",
		source: "grafana",
		generatorUrl: "https://grafana.example.com/alert/1",
		labels: { service: "checkout" },
		annotations: {},
	},
	repo: {
		owner: "acme",
		repo: "widgets",
		cloneUrl: "https://x-access-token:REDACTED@github.com/acme/widgets.git",
		defaultBranch: "main",
		branchName: "paperhanger/incident-123",
	},
	limits: { timeoutMinutes: 30, maxDiffLines: 500, maxFixAttempts: 3 },
	forbiddenPaths: [".github/workflows/**"],
	telemetry: {
		source: "greptimedb",
		url: "http://greptimedb:4000",
		database: "public",
	},
};

assert(
	v.safeParse(WorkflowInputSchema, exampleInput).success,
	"WorkflowInputSchema parses a well-formed input payload",
);

assert(
	!v.safeParse(WorkflowInputSchema, { incidentId: "x" }).success,
	"WorkflowInputSchema rejects a malformed/incomplete input payload",
);

const exampleFixedOutput = {
	outcome: "fixed",
	diagnosis: "Root cause: unchecked cache miss in getUser().",
	report: "## Report\nGuarded the cache-miss branch.",
	fix: {
		branch: "paperhanger/incident-123",
		commitMessage: "fix: guard against cache miss",
		changedFiles: ["src/index.ts"],
		testCommand: "bun run test",
		testsPassed: true,
	},
};
assert(
	v.safeParse(WorkflowOutputSchema, exampleFixedOutput).success,
	"WorkflowOutputSchema parses a well-formed 'fixed' output payload",
);

const exampleReportOnlyOutput = {
	outcome: "report_only",
	diagnosis:
		"Root cause is an under-provisioned DB connection pool (infra, not code).",
	report: "## Report\nThe connection pool is undersized for current load.",
};
assert(
	v.safeParse(WorkflowOutputSchema, exampleReportOnlyOutput).success,
	"WorkflowOutputSchema parses a well-formed 'report_only' output payload",
);

const exampleFailedOutput = {
	outcome: "failed",
	diagnosis: "Attempted three fixes; tests kept failing.",
	report:
		"## Attempts\nThree fix attempts, all broke the integration test suite.",
	failureReason: "Tests failed after 3 fix attempts.",
};
assert(
	v.safeParse(WorkflowOutputSchema, exampleFailedOutput).success,
	"WorkflowOutputSchema parses a well-formed 'failed' output payload",
);

assert(
	typeof workflow === "object" && workflow !== null,
	"fix-incident workflow module has a default export",
);
assert(
	Boolean(workflow && "agent" in workflow),
	"fix-incident workflow default export has an `agent` field",
);
assert(
	Boolean(workflow && "action" in workflow),
	"fix-incident workflow default export has an `action` field (defineWorkflow branding)",
);

if (failures > 0) {
	console.error(`\nSmoke test FAILED (${failures} failure(s))`);
	process.exitCode = 1;
} else {
	console.log("\nSmoke test PASSED");
}
