#!/usr/bin/env node
// Verifies Flue 2 schemas, agent registration, route admission, and the built
// Node server without requiring a model/provider credential.

import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import * as v from "valibot";
import {
	FixIncidentInputSchema,
	FixIncidentOutputSchema,
} from "../src/contract.ts";
import { FixIncidentAgent } from "../src/fix-agent.ts";
import { createTelemetryTools } from "../src/tools.ts";

let failures = 0;
function assert(condition, message) {
	if (condition) console.log(`ok - ${message}`);
	else {
		failures++;
		console.error(`not ok - ${message}`);
	}
}

const exampleInput = {
	incidentId: "incident-smoke",
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
		cloneUrl: "https://github.com/acme/widgets.git",
		defaultBranch: "main",
		branchName: "paperhanger/incident-smoke",
	},
	limits: { timeoutMinutes: 30, maxDiffLines: 500, maxFixAttempts: 3 },
	forbiddenPaths: [".github/workflows/**"],
	systemPrompt: "Always write tests before implementing a fix.",
};

assert(
	v.safeParse(FixIncidentInputSchema, exampleInput).success,
	"FixIncidentInputSchema accepts a valid input",
);
assert(
	!v.safeParse(FixIncidentInputSchema, { incidentId: "x" }).success,
	"FixIncidentInputSchema rejects incomplete input",
);
assert(
	v.safeParse(FixIncidentOutputSchema, {
		outcome: "fixed",
		diagnosis: "d",
		report: "r",
		fix: {
			branch: "b",
			commitMessage: "m",
			changedFiles: [],
			testsPassed: true,
		},
	}).success,
	"FixIncidentOutputSchema accepts fixed output",
);
assert(
	v.safeParse(FixIncidentOutputSchema, {
		outcome: "report_only",
		diagnosis: "d",
		report: "r",
	}).success,
	"FixIncidentOutputSchema accepts report_only output",
);
assert(
	v.safeParse(FixIncidentOutputSchema, {
		outcome: "failed",
		diagnosis: "d",
		report: "r",
		failureReason: "f",
	}).success,
	"FixIncidentOutputSchema accepts failed output",
);
assert(
	typeof FixIncidentAgent === "function",
	"FixIncidentAgent is a function",
);
assert(
	FixIncidentAgent.agentName === "fix-incident",
	"FixIncidentAgent has the fix-incident name",
);
assert(
	FixIncidentAgent.initialData === FixIncidentInputSchema,
	"FixIncidentAgent uses FixIncidentInputSchema as initialData",
);

// query_telemetry now proxies back to the parent's own PAPERHANGER_TELEMETRY
// callback route (three env vars) instead of taking a whole telemetry
// backend config through the agent input -- exercise both the "not
// configured" and "configured" shapes of that env-driven contract.
const CALLBACK_ENV_KEYS = [
	"PAPERHANGER_TELEMETRY_CALLBACK_URL",
	"PAPERHANGER_TELEMETRY_CALLBACK_TOKEN",
	"PAPERHANGER_TELEMETRY_CALLBACK_SOURCE",
];
const savedCallbackEnv = Object.fromEntries(
	CALLBACK_ENV_KEYS.map((key) => [key, process.env[key]]),
);
for (const key of CALLBACK_ENV_KEYS) delete process.env[key];
assert(
	createTelemetryTools().length === 0,
	"createTelemetryTools() returns no tools when the callback env vars are unset",
);
process.env.PAPERHANGER_TELEMETRY_CALLBACK_URL =
	"http://127.0.0.1:0/telemetry/query";
process.env.PAPERHANGER_TELEMETRY_CALLBACK_TOKEN = "smoke-callback-token";
process.env.PAPERHANGER_TELEMETRY_CALLBACK_SOURCE = "greptimedb";
const telemetryTools = createTelemetryTools();
assert(
	telemetryTools.length === 1 && telemetryTools[0].name === "query_telemetry",
	"createTelemetryTools() returns a query_telemetry tool when the callback env vars are set",
);
for (const key of CALLBACK_ENV_KEYS) {
	if (savedCallbackEnv[key] === undefined) delete process.env[key];
	else process.env[key] = savedCallbackEnv[key];
}

const portServer = createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const port = portServer.address().port;
portServer.close();
const child = spawn(process.execPath, ["dist/server.mjs"], {
	env: {
		...process.env,
		PORT: String(port),
		FLUE_MODEL: "anthropic/claude-sonnet-4-6",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
child.stdout.on("data", (chunk) => {
	childOutput += chunk;
});
child.stderr.on("data", (chunk) => {
	childOutput += chunk;
});
try {
	let health;
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			health = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (health.status === 200) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert(health?.status === 200, "built server GET /healthz returns 200");
	assert(
		(await health?.json())?.ok === true,
		"health response is { ok: true }",
	);
	const invalid = await fetch(
		`http://127.0.0.1:${port}/agents/fix-incident/smoke-invalid`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "signal",
				type: "paperhanger.smoke",
				body: "invalid",
				initialData: { incidentId: "smoke" },
				uid: null,
			}),
		},
	);
	const invalidBody = await invalid.json();
	assert(invalid.status === 400, "invalid initialData is rejected with 400");
	assert(
		invalidBody?.error?.type === "invalid_request",
		"invalid initialData reports invalid_request",
	);
	const valid = await fetch(
		`http://127.0.0.1:${port}/agents/fix-incident/smoke-valid`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "signal",
				type: "paperhanger.smoke",
				body: "valid",
				initialData: exampleInput,
				uid: null,
			}),
		},
	);
	const validBody = await valid.json();
	assert(valid.status === 202, "valid initialData is admitted with 202");
	assert(
		typeof validBody?.submissionId === "string" &&
			typeof validBody?.streamUrl === "string" &&
			typeof validBody?.offset === "string",
		"valid admission returns a readable submission",
	);
} finally {
	if (!child.killed) child.kill("SIGTERM");
	await once(child, "exit").catch(() => {});
	if (child.exitCode !== 0 && failures === 0) console.error(childOutput);
}

if (failures > 0) process.exitCode = 1;
else console.log("\nSmoke test PASSED");
