import { describe, expect, test } from "bun:test";
import type { createFlueClient } from "@flue/sdk";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Incident, IncidentEvent } from "../core/types";
import { createLogger } from "../observability/logger";
import type {
	CompareCommitsResult,
	CreatePullRequestInput,
	CreatePullRequestResult,
} from "../repo/github";
import type { ResolvedRepo } from "../repo/resolver";
import { SqliteIncidentStore } from "../storage/sqlite";
import type { IncidentContext } from "../telemetry/types";
import {
	type FixAgentFlueClient,
	type FixAgentGitHubClient,
	FixAgentRunner,
	type FixAgentRunnerConfig,
} from "./runner";

// Registered once at module scope so the span activated by `context.with(...)`
// inside `invokeWorkflow` stays active across `await`s (design doc section
// 10) -- needed for the log/trace correlation test below. A second
// registration in the same bun process would return `false` and keep this
// one -- harmless, since it's the same manager class; no other file in
// `bun test src/agent` registers a context manager.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

function silentLogger() {
	return createLogger({ sink: () => {} });
}

/** A logger whose sink captures each emitted JSON line for correlation assertions. */
function capturingLogger() {
	const lines: string[] = [];
	const logger = createLogger({ sink: (line) => lines.push(line) });
	return { logger, lines };
}

async function createStoreWithIncident(): Promise<{
	store: SqliteIncidentStore;
	incident: Incident;
}> {
	const store = new SqliteIncidentStore(":memory:");
	await store.init();
	const incident = await store.createIncident({
		fingerprint: "fp-1",
		source: "grafana",
		status: "resolving_repo",
		severity: "critical",
		title: "Checkout API 500s",
		labels: { service: "checkout" },
		annotations: {},
	});
	return { store, incident };
}

function makeAlert(overrides: Partial<IncidentEvent> = {}): IncidentEvent {
	return {
		fingerprint: "fp-1",
		source: "grafana",
		status: "firing",
		severity: "critical",
		title: "Checkout API 500s",
		labels: { service: "checkout" },
		annotations: {},
		startsAt: new Date().toISOString(),
		generatorUrl: "https://grafana.example.com/alert/1",
		raw: {},
		...overrides,
	};
}

function makeContext(
	incident: Incident,
	alert: IncidentEvent,
): IncidentContext {
	return {
		incident,
		alert,
		window: {
			from: "2026-07-17T00:00:00.000Z",
			to: "2026-07-17T00:30:00.000Z",
		},
		telemetry: { logs: [], traces: [], metrics: [] },
		notes: [],
	};
}

const testRepo: ResolvedRepo = {
	owner: "acme",
	repo: "widgets",
	method: "attribute",
	confidence: "high",
};

function makeConfig(
	overrides: Partial<FixAgentRunnerConfig["agent"]> = {},
): FixAgentRunnerConfig {
	return {
		agent: {
			model: "anthropic/claude-sonnet-4-6",
			timeoutMinutes: 30,
			forbiddenPaths: [".github/workflows/**"],
			maxDiffLines: 500,
			maxFixAttempts: 3,
			draftPr: false,
			...overrides,
		},
		telemetry: {
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
		},
	};
}

interface FakeGithubOptions {
	defaultBranch?: string;
	compareResult?: CompareCommitsResult;
	createPullRequestResult?: CreatePullRequestResult;
	addLabelsShouldThrow?: boolean;
	deleteRefShouldThrow?: boolean;
}

function createFakeGithub(options: FakeGithubOptions = {}) {
	const calls = {
		createPullRequest: [] as CreatePullRequestInput[],
		addLabels: [] as { issueNumber: number; labels: string[] }[],
		deleteRef: [] as string[],
		compareCommits: [] as { base: string; head: string }[],
	};

	const client: FixAgentGitHubClient = {
		async getRepoInstallation() {
			return { id: 42 };
		},
		async createInstallationToken() {
			return {
				token: "installation-token",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			};
		},
		cloneUrlWithToken(owner, repo, token) {
			return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
		},
		async getDefaultBranch() {
			return options.defaultBranch ?? "main";
		},
		async compareCommits(_owner, _repo, base, head) {
			calls.compareCommits.push({ base, head });
			return (
				options.compareResult ?? {
					files: [],
					totalAdditions: 0,
					totalDeletions: 0,
				}
			);
		},
		async deleteRef(_owner, _repo, ref) {
			calls.deleteRef.push(ref);
			if (options.deleteRefShouldThrow) {
				throw new Error("delete ref failed: network error");
			}
		},
		async createPullRequest(_owner, _repo, input) {
			calls.createPullRequest.push(input);
			return (
				options.createPullRequestResult ?? {
					url: "https://github.com/acme/widgets/pull/9",
					number: 9,
				}
			);
		},
		async addLabels(_owner, _repo, issueNumber, labels) {
			calls.addLabels.push({ issueNumber, labels });
			if (options.addLabelsShouldThrow) {
				throw new Error("labels endpoint exploded");
			}
		},
	};

	return { client, calls };
}

function createFakeFlue(result: unknown): {
	client: FixAgentFlueClient;
	invokeCalls: { name: string; input: unknown }[];
} {
	const invokeCalls: { name: string; input: unknown }[] = [];
	const client: FixAgentFlueClient = {
		workflows: {
			async invoke(name, options) {
				invokeCalls.push({ name, input: options.input });
				return { runId: "run-1", result };
			},
		},
	};
	return { client, invokeCalls };
}

/** A flue client whose invoke() only settles when the caller's AbortSignal fires. */
function createHangingFlue(): FixAgentFlueClient {
	return {
		workflows: {
			invoke(_name, options) {
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						reject(err);
					});
				});
			},
		},
	};
}

const FIXED_OUTPUT_BASE = {
	outcome: "fixed" as const,
	diagnosis: "The null pointer came from an unchecked cache miss.",
	report: "## Root cause\nUnchecked cache miss in `getUser`.",
	fix: {
		branch: "paperhanger/incident-x",
		commitMessage: "fix: guard against cache miss",
		changedFiles: ["src/index.ts"],
		testCommand: "bun test",
		testsPassed: true,
	},
};

describe("FixAgentRunner - fixed outcome happy path", () => {
	test("verifies the diff, creates a PR with the expected payload/body, and labels it", async () => {
		const { store, incident } = await createStoreWithIncident();
		const alert = makeAlert();
		const context = makeContext(incident, alert);
		const github = createFakeGithub({
			compareResult: {
				files: [
					{
						filename: "src/index.ts",
						status: "modified",
						additions: 8,
						deletions: 2,
					},
				],
				totalAdditions: 8,
				totalDeletions: 2,
			},
		});
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("pr_created");
		if (result.status !== "pr_created") {
			throw new Error("expected pr_created");
		}
		expect(result.prUrl).toBe("https://github.com/acme/widgets/pull/9");
		expect(result.diagnosis).toBe(FIXED_OUTPUT_BASE.diagnosis);

		expect(flue.invokeCalls.length).toBe(1);
		expect(flue.invokeCalls[0]?.name).toBe("fix-incident");
		const input = flue.invokeCalls[0]?.input as {
			incidentId: string;
			repo: { branchName: string; cloneUrl: string; defaultBranch: string };
			forbiddenPaths: string[];
			limits: {
				timeoutMinutes: number;
				maxDiffLines: number;
				maxFixAttempts: number;
			};
			telemetry?: { source: string; url: string; database: string };
		};
		expect(input.incidentId).toBe(incident.id);
		expect(input.repo.branchName).toBe(`paperhanger/incident-${incident.id}`);
		expect(input.repo.cloneUrl).toContain("installation-token");
		expect(input.repo.defaultBranch).toBe("main");
		expect(input.forbiddenPaths).toEqual([".github/workflows/**"]);
		expect(input.limits.maxFixAttempts).toBe(3);
		expect(input.telemetry).toEqual({
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
		});

		expect(github.calls.compareCommits).toEqual([
			{ base: "main", head: `paperhanger/incident-${incident.id}` },
		]);

		expect(github.calls.createPullRequest.length).toBe(1);
		const pr = github.calls.createPullRequest[0];
		expect(pr?.title).toBe(`fix: ${alert.title} (incident ${incident.id})`);
		expect(pr?.head).toBe(`paperhanger/incident-${incident.id}`);
		expect(pr?.base).toBe("main");
		expect(pr?.draft).toBe(false);
		expect(pr?.body).toContain(FIXED_OUTPUT_BASE.report);
		expect(pr?.body).toContain("## Telemetry evidence");
		expect(pr?.body).toContain(alert.generatorUrl as string);
		expect(pr?.body?.toLowerCase()).toContain("generated by paperhanger");

		expect(github.calls.addLabels).toEqual([
			{ issueNumber: 9, labels: ["paperhanger", "automated-fix"] },
		]);
		expect(github.calls.deleteRef).toEqual([]);

		// The runner manages diagnosing/fixing but never sets a terminal status
		// itself; the last transition it made should stick.
		const stored = await store.getIncident(incident.id);
		expect(stored?.status).toBe("fixing");

		await store.close();
	});

	test("does not fail the run when addLabels fails (best-effort)", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub({ addLabelsShouldThrow: true });
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("pr_created");
		expect(github.calls.addLabels.length).toBe(1);

		await store.close();
	});
});

describe("FixAgentRunner - guardrail violations", () => {
	test("deletes the branch and fails when a changed file matches a forbidden path", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub({
			compareResult: {
				files: [
					{
						filename: ".github/workflows/ci.yml",
						status: "modified",
						additions: 1,
						deletions: 1,
					},
				],
				totalAdditions: 1,
				totalDeletions: 1,
			},
		});
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(result.failureReason).toContain("forbidden path");
		expect(result.failureReason).toContain(".github/workflows/ci.yml");

		expect(github.calls.deleteRef).toEqual([
			`heads/paperhanger/incident-${incident.id}`,
		]);
		expect(github.calls.createPullRequest).toEqual([]);

		await store.close();
	});

	test("deletes the branch and fails when the diff exceeds maxDiffLines", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub({
			compareResult: {
				files: [
					{
						filename: "src/index.ts",
						status: "modified",
						additions: 400,
						deletions: 300,
					},
				],
				totalAdditions: 400,
				totalDeletions: 300,
			},
		});
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig({ maxDiffLines: 500 }),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(result.failureReason).toContain("700 lines");
		expect(result.failureReason).toContain("500-line limit");

		expect(github.calls.deleteRef).toEqual([
			`heads/paperhanger/incident-${incident.id}`,
		]);
		expect(github.calls.createPullRequest).toEqual([]);

		await store.close();
	});

	test("keeps the guardrail violation as the primary failure reason and notes the branch left behind when deleteRef throws", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub({
			compareResult: {
				files: [
					{
						filename: ".github/workflows/ci.yml",
						status: "modified",
						additions: 1,
						deletions: 1,
					},
				],
				totalAdditions: 1,
				totalDeletions: 1,
			},
			deleteRefShouldThrow: true,
		});
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		// The original guardrail violation must still be front-and-center, not
		// silently replaced by the raw deleteRef error.
		expect(result.failureReason).toContain(
			"Guardrail violation: fix touched forbidden path(s)",
		);
		expect(result.failureReason).toContain(".github/workflows/ci.yml");
		expect(result.failureReason).toContain(
			"cleanup of the rejected branch failed",
		);
		expect(result.failureReason).toContain(
			`paperhanger/incident-${incident.id}`,
		);
		expect(result.failureReason).toContain("delete ref failed: network error");

		expect(github.calls.deleteRef).toEqual([
			`heads/paperhanger/incident-${incident.id}`,
		]);
		expect(github.calls.createPullRequest).toEqual([]);

		await store.close();
	});
});

describe("FixAgentRunner - maxDiffLines boundary", () => {
	test("a diff of exactly maxDiffLines (500 of 500) passes and creates a PR", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub({
			compareResult: {
				files: [
					{
						filename: "src/index.ts",
						status: "modified",
						additions: 300,
						deletions: 200,
					},
				],
				totalAdditions: 300,
				totalDeletions: 200,
			},
		});
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig({ maxDiffLines: 500 }),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("pr_created");
		expect(github.calls.deleteRef).toEqual([]);

		await store.close();
	});

	test("a diff of maxDiffLines + 1 (501 of 500) fails as a guardrail violation", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub({
			compareResult: {
				files: [
					{
						filename: "src/index.ts",
						status: "modified",
						additions: 300,
						deletions: 201,
					},
				],
				totalAdditions: 300,
				totalDeletions: 201,
			},
		});
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig({ maxDiffLines: 500 }),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(result.failureReason).toContain("501 lines");
		expect(result.failureReason).toContain("500-line limit");
		expect(github.calls.deleteRef).toEqual([
			`heads/paperhanger/incident-${incident.id}`,
		]);

		await store.close();
	});
});

describe("FixAgentRunner - report_only and failed passthrough", () => {
	test("passes through a report_only outcome without touching GitHub compare/PR APIs", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({
			outcome: "report_only",
			diagnosis:
				"Root cause is a saturated connection pool in the DB, not the code.",
			report:
				"## Analysis\nThe DB connection pool is undersized for current load.",
		});
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result).toEqual({
			status: "report_only",
			diagnosis:
				"Root cause is a saturated connection pool in the DB, not the code.",
			report:
				"## Analysis\nThe DB connection pool is undersized for current load.",
		});
		expect(github.calls.compareCommits).toEqual([]);
		expect(github.calls.createPullRequest).toEqual([]);

		const stored = await store.getIncident(incident.id);
		expect(stored?.status).toBe("diagnosing");

		await store.close();
	});

	test("passes through a failed outcome reported directly by the agent", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({
			outcome: "failed",
			diagnosis: "Attempted three fixes; tests kept failing.",
			report:
				"## Attempts\nThree fix attempts, all broke the integration test suite.",
			failureReason: "Tests failed after 3 fix attempts.",
		});
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result).toEqual({
			status: "failed",
			failureReason: "Tests failed after 3 fix attempts.",
			diagnosis: "Attempted three fixes; tests kept failing.",
			report:
				"## Attempts\nThree fix attempts, all broke the integration test suite.",
		});

		await store.close();
	});
});

describe("FixAgentRunner - malformed workflow result", () => {
	test("fails when outcome is `fixed` but no `fix` block is present", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({
			outcome: "fixed",
			diagnosis: "diagnosis text",
			report: "report text",
		});
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(result.failureReason).toContain(
			"Malformed fix-agent workflow result",
		);

		await store.close();
	});

	test("fails when the result is missing required fields entirely", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({ foo: "bar" });
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(result.failureReason).toContain(
			"Malformed fix-agent workflow result",
		);

		await store.close();
	});
});

describe("FixAgentRunner - timeout", () => {
	test("fails with an honest, non-terminal-sounding message when the workflow invocation is aborted on timeout", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createHangingFlue();
		const runner = new FixAgentRunner({
			flue,
			github: github.client,
			store,
			// 0.0005 minutes = 30ms; keeps the test fast without changing the
			// production default anywhere.
			config: makeConfig({ timeoutMinutes: 0.0005 }),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		// The message must not claim a clean, contained failure: paperhanger
		// only gave up on *waiting*, it did not (and per @flue/sdk 1.0.0-beta.9,
		// could not) cancel the underlying workflow run.
		expect(result.failureReason).toContain("Timed out after waiting");
		expect(result.failureReason).toContain(
			"may still be executing the workflow",
		);
		expect(result.failureReason).toContain(
			"no workflow-level cancellation API",
		);

		await store.close();
	});
});

describe("FixAgentRunner - flue client provider", () => {
	test("accepts a pre-built client directly (baseUrl form is exercised via the runner's lazy factory)", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({
			outcome: "report_only",
			diagnosis: "d",
			report: "r",
		});
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);
		expect(result.status).toBe("report_only");

		await store.close();
	});

	test("the { baseUrl } provider form lazily constructs a client via the injected factory with the right base URL", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({
			outcome: "report_only",
			diagnosis: "d",
			report: "r",
		});
		const factoryCalls: { baseUrl: string }[] = [];
		const fakeCreateFlueClient: typeof createFlueClient = ((options: {
			baseUrl: string;
		}) => {
			factoryCalls.push({ baseUrl: options.baseUrl });
			return flue.client as unknown as ReturnType<typeof createFlueClient>;
		}) as typeof createFlueClient;

		const runner = new FixAgentRunner({
			flue: { baseUrl: "http://agent-host.internal:9000" },
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
			createFlueClient: fakeCreateFlueClient,
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("report_only");
		expect(factoryCalls).toEqual([
			{ baseUrl: "http://agent-host.internal:9000" },
		]);
		expect(flue.invokeCalls.length).toBe(1);

		await store.close();
	});
});

describe("FixAgentRunner - agent.invoke_workflow span", () => {
	function testTracerProvider() {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		return { tracer: provider.getTracer("test"), exporter };
	}

	test("records a CLIENT span with incident/timeout attributes and no ERROR status on a successful invocation", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue({
			outcome: "report_only",
			diagnosis: "d",
			report: "r",
		});
		const { tracer, exporter } = testTracerProvider();
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig({ timeoutMinutes: 30 }),
			logger: silentLogger(),
			tracer,
		});

		const result = await runner.run(incident, context, testRepo);
		expect(result.status).toBe("report_only");

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "agent.invoke_workflow");
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.attributes["paperhanger.incident.id"]).toBe(incident.id);
		expect(span?.attributes["paperhanger.agent.timeout_minutes"]).toBe(30);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
		expect(span?.attributes["paperhanger.agent.ok"]).toBeUndefined();

		await store.close();
	});

	test("sets ERROR status from the RESOLVED value (not a thrown exception) with failureReason as the message when the workflow wait times out", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createHangingFlue();
		const { tracer, exporter } = testTracerProvider();
		const runner = new FixAgentRunner({
			flue,
			github: github.client,
			store,
			// 0.0005 minutes = 30ms; keeps the test fast.
			config: makeConfig({ timeoutMinutes: 0.0005 }),
			logger: silentLogger(),
			tracer,
		});

		const result = await runner.run(incident, context, testRepo);
		expect(result.status).toBe("failed");

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "agent.invoke_workflow");
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes["paperhanger.agent.ok"]).toBe(false);
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(span?.status.message).toBe(result.failureReason);
		// invokeWorkflow never throws: no exception event should be recorded,
		// only a status set from the resolved { ok: false } value.
		expect(span?.events.some((e) => e.name === "exception")).toBe(false);

		await store.close();
	});

	test("the fix_agent.workflow_wait_timed_out warn log correlates (traceId/spanId) with the finished agent.invoke_workflow span", async () => {
		const { store, incident } = await createStoreWithIncident();
		const incidentContext = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createHangingFlue();
		const { tracer, exporter } = testTracerProvider();
		const { logger, lines } = capturingLogger();
		const runner = new FixAgentRunner({
			flue,
			github: github.client,
			store,
			// 0.0005 minutes = 30ms; keeps the test fast.
			config: makeConfig({ timeoutMinutes: 0.0005 }),
			logger,
			tracer,
		});

		const result = await runner.run(incident, incidentContext, testRepo);
		expect(result.status).toBe("failed");

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "agent.invoke_workflow");
		expect(spans.length).toBe(1);
		const span = spans[0];
		const spanContext = span?.spanContext();

		const entries = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		const warnEntry = entries.find(
			(entry) => entry.msg === "fix_agent.workflow_wait_timed_out",
		);
		expect(warnEntry).toBeDefined();
		expect(warnEntry?.traceId).toBe(spanContext?.traceId);
		expect(warnEntry?.spanId).toBe(spanContext?.spanId);

		await store.close();
	});

	test("a throwing client factory resolves { ok: false, failureReason } (never-throw contract) and the span gets ERROR status instead of ending UNSET", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const { tracer, exporter } = testTracerProvider();
		const throwingCreateFlueClient: typeof createFlueClient = (() => {
			throw new Error("Invalid URL: 127.0.0.1:8700");
		}) as typeof createFlueClient;
		const runner = new FixAgentRunner({
			flue: { baseUrl: "127.0.0.1:8700" },
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
			tracer,
			createFlueClient: throwingCreateFlueClient,
		});

		const result = await runner.run(incident, context, testRepo);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") {
			throw new Error("expected failed");
		}
		expect(result.failureReason).toContain("Invalid URL: 127.0.0.1:8700");

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "agent.invoke_workflow");
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.status.message).toBe(result.failureReason);
		expect(span?.attributes["paperhanger.agent.ok"]).toBe(false);

		await store.close();
	});

	test("falls back to a working no-op tracer when none is injected", async () => {
		const { store, incident } = await createStoreWithIncident();
		const context = makeContext(incident, makeAlert());
		const github = createFakeGithub();
		const flue = createFakeFlue(FIXED_OUTPUT_BASE);
		const runner = new FixAgentRunner({
			flue: flue.client,
			github: github.client,
			store,
			config: makeConfig(),
			logger: silentLogger(),
		});

		const result = await runner.run(incident, context, testRepo);
		expect(result.status).toBe("pr_created");

		await store.close();
	});
});
