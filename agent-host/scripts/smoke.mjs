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

// The tool's Valibot schemas and its defineTool wiring are asserted here
// rather than in a `src/**.test.ts` file because both need agent-host's own
// dependencies (`valibot`, `@flue/runtime`), which the main repo's `bun test`
// deliberately does not install -- see agent-host/README.md's note on the
// dependency-free `src/lib/` tier. The env gate itself and the callback
// client are pure and stay covered there.
const telemetryTool = telemetryTools[0];
const TIME_RANGE = {
	from: "2026-01-01T00:00:00Z",
	to: "2026-01-01T00:05:00Z",
};
assert(
	v.safeParse(telemetryTool.input, {
		signal: "logs",
		timeRange: TIME_RANGE,
		filter: { service: "checkout" },
	}).success,
	"query_telemetry input schema accepts a minimal structured request",
);
assert(
	!v.safeParse(telemetryTool.input, {
		signal: "not-a-signal",
		timeRange: TIME_RANGE,
	}).success,
	"query_telemetry input schema rejects an unknown signal",
);
// Mirrors FollowUpTelemetryQueryResponse in the parent's
// src/telemetry/followup.ts -- the two schemas are hand-written mirrors, so
// this is what catches them drifting apart.
assert(
	v.safeParse(telemetryTool.output, {
		logs: [{ body: "boom" }],
		truncated: false,
		notes: [],
	}).success,
	"query_telemetry output schema accepts the parent callback route's response shape",
);

// run() must reach the configured callback URL with the dedicated bearer
// token -- the wiring between the env gate and the callback client, which
// neither of their own unit tests can see.
const originalFetch = globalThis.fetch;
let capturedUrl;
let capturedAuth;
globalThis.fetch = async (url, init) => {
	capturedUrl = url;
	capturedAuth = init?.headers?.Authorization;
	return new Response(
		JSON.stringify({ logs: [], truncated: false, notes: [] }),
		{
			status: 200,
		},
	);
};
try {
	const runResult = await telemetryTool.run({
		toolCallId: "smoke-call",
		log: () => {},
		data: { signal: "logs", timeRange: TIME_RANGE },
	});
	assert(
		capturedUrl === "http://127.0.0.1:0/telemetry/query" &&
			capturedAuth === "Bearer smoke-callback-token",
		"query_telemetry run() POSTs to the configured callback URL with its bearer token",
	);
	assert(
		JSON.stringify(runResult) ===
			JSON.stringify({ output: { logs: [], truncated: false, notes: [] } }),
		"query_telemetry run() returns the callback response as `output`",
	);
} finally {
	globalThis.fetch = originalFetch;
}

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
