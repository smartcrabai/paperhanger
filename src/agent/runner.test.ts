import { describe, expect, test } from "bun:test";
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
} from "../repo/github";
import type { ResolvedRepo } from "../repo/resolver";
import { SqliteIncidentStore } from "../storage/sqlite";
import type { IncidentContext } from "../telemetry/types";
import {
	FixAgentRunner,
	type FixAgentFlueClient,
	type FixAgentGitHubClient,
	type FixAgentRunnerConfig,
} from "./runner";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

function silentLogger() {
	return createLogger({ sink: () => {} });
}
function capturingLogger() {
	const lines: string[] = [];
	return { logger: createLogger({ sink: (line) => lines.push(line) }), lines };
}

async function createStoreWithIncident() {
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
	compareResult?: CompareCommitsResult;
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
			return "main";
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
			if (options.deleteRefShouldThrow)
				throw new Error("delete ref failed: network error");
		},
		async createPullRequest(_owner, _repo, input) {
			calls.createPullRequest.push(input);
			return { url: "https://github.com/acme/widgets/pull/9", number: 9 };
		},
		async addLabels(_owner, _repo, issueNumber, labels) {
			calls.addLabels.push({ issueNumber, labels });
			if (options.addLabelsShouldThrow)
				throw new Error("labels endpoint exploded");
		},
	};
	return { client, calls };
}
function createFakeFlue(result: unknown) {
	const calls: {
		url?: string;
		send?: Parameters<FixAgentFlueClient["send"]>[0];
		read: number;
		abort: number;
	} = { read: 0, abort: 0 };
	const client: FixAgentFlueClient = {
		async send(options) {
			calls.send = options;
			return {
				streamUrl:
					"http://agent-host.internal:9000/api/agents/fix-incident/run-1/events",
				offset: "-1",
				submissionId: "sub-1",
				uid: "uid-1",
			};
		},
		async read() {
			calls.read++;
			return {
				submissionId: "sub-1",
				data: { result: [result] },
			};
		},
		async abort() {
			calls.abort++;
			return { aborted: true };
		},
	};
	return { client, calls };
}
function createHangingFlue(abortShouldThrow = false, sendShouldHang = false) {
	const calls = {
		send: undefined as Parameters<FixAgentFlueClient["send"]>[0] | undefined,
		read: 0,
		abort: 0,
	};
	const client: FixAgentFlueClient = {
		async send(options) {
			calls.send = options;
			if (sendShouldHang) {
				const { promise, reject } = Promise.withResolvers<never>();
				options.signal?.addEventListener("abort", () =>
					reject(new Error("The operation was aborted")),
				);
				return promise;
			}
			return {
				streamUrl:
					"http://agent-host.internal:9000/api/agents/fix-incident/run-timeout/events",
				offset: "-1",
				submissionId: "sub-timeout",
				uid: "uid-timeout",
			};
		},
		read(_admission, options) {
			calls.read++;
			const { promise, reject } = Promise.withResolvers<never>();
			options?.signal?.addEventListener("abort", () =>
				reject(new Error("The operation was aborted")),
			);
			return promise;
		},
		async abort() {
			calls.abort++;
			if (abortShouldThrow) throw new Error("abort unavailable");
			return { aborted: true };
		},
	};
	return { client, calls };
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
function makeRunner(
	store: SqliteIncidentStore,
	github: FixAgentGitHubClient,
	flue: FixAgentFlueClient,
	config = makeConfig(),
	createFlueClient?: (options: { url: string }) => FixAgentFlueClient,
) {
	return new FixAgentRunner({
		flue: {
			baseUrl: "http://agent-host.internal:9000/api?token=discard#fragment",
		},
		github,
		store,
		repoDefinitions: store,
		config,
		logger: silentLogger(),
		createFlueClient: createFlueClient ?? (() => flue),
	});
}

describe("FixAgentRunner conversation protocol", () => {
	test("sends initial data to an encoded conversation URL and handles fixed output", async () => {
		const { store, incident } = await createStoreWithIncident();
		let agentRunId = "";
		const createAgentRun = store.createAgentRun.bind(store);
		store.createAgentRun = async (input) => {
			const run = await createAgentRun(input);
			agentRunId = run.id;
			return run;
		};
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
		const createdUrls: string[] = [];
		const runner = makeRunner(
			store,
			github.client,
			flue.client,
			makeConfig(),
			(options) => {
				createdUrls.push(options.url);
				return flue.client;
			},
		);
		const result = await runner.run(
			incident,
			makeContext(incident, makeAlert()),
			testRepo,
		);
		expect(result.status).toBe("pr_created");
		expect(createdUrls[0]).toBe(
			`http://agent-host.internal:9000/api/agents/fix-incident/${encodeURIComponent(agentRunId)}`,
		);
		expect(flue.calls.send?.message).toEqual({
			kind: "signal",
			type: "paperhanger.fix-incident",
			body: `Run paperhanger fix incident ${incident.id}.`,
		});
		expect(flue.calls.send?.uid).toBeNull();
		const send = flue.calls.send;
		if (!send) throw new Error("expected send call");
		expect(send.signal).toBeInstanceOf(AbortSignal);
		expect((send.initialData as { incidentId: string }).incidentId).toBe(
			incident.id,
		);
		await store.close();
	});

	test("returns report_only and failed data parts", async () => {
		for (const output of [
			{ outcome: "report_only", diagnosis: "d", report: "r" },
			{
				outcome: "failed",
				diagnosis: "d",
				report: "r",
				failureReason: "tests failed",
			},
		]) {
			const { store, incident } = await createStoreWithIncident();
			const flue = createFakeFlue(output);
			const result = await makeRunner(
				store,
				createFakeGithub().client,
				flue.client,
			).run(incident, makeContext(incident, makeAlert()), testRepo);
			expect(result.status).toBe(output.outcome as "report_only" | "failed");
			await store.close();
		}
	});

	test("rejects missing, duplicate, and malformed result data", async () => {
		for (const data of [
			{},
			{ result: [FIXED_OUTPUT_BASE, FIXED_OUTPUT_BASE] },
			{
				result: [
					{
						outcome: "fixed",
						diagnosis: "d",
						report: "r",
					},
				],
			},
			{ result: [{ nope: true }] },
		]) {
			const { store, incident } = await createStoreWithIncident();
			const flue = createFakeFlue(FIXED_OUTPUT_BASE);
			flue.client.read = async () => ({
				submissionId: "sub-1",
				data: data as Record<string, unknown[]>,
			});
			const result = await makeRunner(
				store,
				createFakeGithub().client,
				flue.client,
			).run(incident, makeContext(incident, makeAlert()), testRepo);
			if (result.status !== "failed") throw new Error("expected failed result");
			expect(result.failureReason).toContain("Malformed fix-agent result");
			await store.close();
		}
	});
	test("converts admission and read failures into failed runs", async () => {
		for (const phase of ["send", "read"] as const) {
			const { store, incident } = await createStoreWithIncident();
			const flue = createFakeFlue(FIXED_OUTPUT_BASE);
			if (phase === "send") {
				flue.client.send = async () => {
					throw new Error("admission failed");
				};
			} else {
				flue.client.read = async () => {
					throw new Error("stream failed");
				};
			}
			const result = await makeRunner(
				store,
				createFakeGithub().client,
				flue.client,
			).run(incident, makeContext(incident, makeAlert()), testRepo);
			if (result.status !== "failed") throw new Error("expected failed result");
			expect(result.failureReason).toContain(
				`${phase === "send" ? "admission" : "stream"} failed`,
			);
			await store.close();
		}
	});
});

describe("FixAgentRunner guardrails and timeout", () => {
	test("times out while admitting the agent", async () => {
		const { store, incident } = await createStoreWithIncident();
		const flue = createHangingFlue(false, true);
		const runner = new FixAgentRunner({
			flue: { baseUrl: "http://agent-host:9000" },
			github: createFakeGithub().client,
			store,
			repoDefinitions: store,
			config: makeConfig({ timeoutMinutes: 0.0005 }),
			logger: silentLogger(),
			createFlueClient: () => flue.client,
		});
		const result = await runner.run(
			incident,
			makeContext(incident, makeAlert()),
			testRepo,
		);
		if (result.status !== "failed") throw new Error("expected failed result");
		expect(result.failureReason).toContain("admission request aborted");
		expect(flue.calls.read).toBe(0);
		expect(flue.calls.abort).toBe(0);
		await store.close();
	});
	test("deletes a forbidden branch and preserves the guardrail failure", async () => {
		const { store, incident } = await createStoreWithIncident();
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
		const result = await makeRunner(store, github.client, flue.client).run(
			incident,
			makeContext(incident, makeAlert()),
			testRepo,
		);
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("expected failed result");
		expect(result.failureReason).toContain("forbidden path");
		expect(github.calls.deleteRef).toEqual([
			`heads/paperhanger/incident-${incident.id}`,
		]);
		await store.close();
	});

	test("aborts once after a local timeout and records the submission id", async () => {
		const { store, incident } = await createStoreWithIncident();
		const flue = createHangingFlue();
		const { logger, lines } = capturingLogger();
		const runner = new FixAgentRunner({
			flue: { baseUrl: "http://agent-host:9000" },
			github: createFakeGithub().client,
			store,
			repoDefinitions: store,
			config: makeConfig({ timeoutMinutes: 0.0005 }),
			logger,
			createFlueClient: () => flue.client,
		});
		const result = await runner.run(
			incident,
			makeContext(incident, makeAlert()),
			testRepo,
		);
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("expected failed result");
		expect(result.failureReason).toContain("abort requested");
		expect(flue.calls.abort).toBe(1);
		expect(
			lines.some((line) => line.includes('"submissionId":"sub-timeout"')),
		).toBe(true);
		await store.close();
	});

	test("reports that execution may continue when abort fails", async () => {
		const { store, incident } = await createStoreWithIncident();
		const flue = createHangingFlue(true);
		const runner = new FixAgentRunner({
			flue: { baseUrl: "http://agent-host:9000" },
			github: createFakeGithub().client,
			store,
			repoDefinitions: store,
			config: makeConfig({ timeoutMinutes: 0.0005 }),
			logger: silentLogger(),
			createFlueClient: () => flue.client,
		});
		const result = await runner.run(
			incident,
			makeContext(incident, makeAlert()),
			testRepo,
		);
		if (result.status !== "failed") throw new Error("expected failed result");
		expect(result.failureReason).toContain("execution may continue");
		await store.close();
	});
});

describe("FixAgentRunner instrumentation", () => {
	test("marks the invoke_workflow span ERROR when client creation fails", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const { store, incident } = await createStoreWithIncident();
		const runner = new FixAgentRunner({
			flue: { baseUrl: "invalid-url" },
			github: createFakeGithub().client,
			store,
			repoDefinitions: store,
			config: makeConfig(),
			logger: silentLogger(),
			tracer: provider.getTracer("test"),
			createFlueClient: () => {
				throw new Error("Invalid URL");
			},
		});
		const result = await runner.run(
			incident,
			makeContext(incident, makeAlert()),
			testRepo,
		);
		expect(result.status).toBe("failed");
		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe("agent.invoke_workflow");
		expect(span?.kind).toBe(SpanKind.CLIENT);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		await provider.shutdown();
		await store.close();
	});
});
