import { describe, expect, test } from "bun:test";
import type { FixAgentRunResult } from "../agent/runner";
import { createLogger } from "../observability/logger";
import type { ResolvedRepo, ResolveRepoInput } from "../repo/resolver";
import type { NotificationEvent, Notifier } from "../notify/types";
import { SqliteIncidentStore } from "../storage/sqlite";
import type { IncidentStore, UpdateIncidentInput } from "../storage/types";
import type { ContextBuilderConfig } from "../telemetry/context-builder";
import type { IncidentContext, TelemetrySource } from "../telemetry/types";
import type { Incident, IncidentEvent } from "./types";
import {
	IncidentPipeline,
	type IncidentPipelineDeps,
	type PipelineAgentRunner,
	type PipelineGitHubClient,
	type PipelineResolver,
} from "./pipeline";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

async function setup(): Promise<{
	store: SqliteIncidentStore;
	incident: Incident;
}> {
	const store = new SqliteIncidentStore(":memory:");
	await store.init();
	const incident = await store.createIncident({
		fingerprint: "fp-1",
		source: "grafana",
		status: "received",
		severity: "critical",
		title: "Checkout API 500s",
		labels: { service: "checkout" },
		annotations: {},
	});
	const event: IncidentEvent = {
		fingerprint: "fp-1",
		source: "grafana",
		status: "firing",
		severity: "critical",
		title: "Checkout API 500s",
		labels: { service: "checkout" },
		annotations: {},
		startsAt: new Date().toISOString(),
		raw: {},
	};
	await store.appendEvent(incident.id, event, event.raw);
	return { store, incident };
}

/**
 * Wraps a real store's `updateIncident` to record every `status` a caller
 * asked to transition to, in call order -- used to assert stage-transition
 * ordering against the real `SqliteIncidentStore` rather than a hand-rolled
 * fake that could drift from the real persistence contract.
 */
function trackTransitions(store: IncidentStore): {
	transitions: string[];
} {
	const transitions: string[] = [];
	const original = store.updateIncident.bind(store);
	store.updateIncident = async (id: string, patch: UpdateIncidentInput) => {
		if (patch.status) {
			transitions.push(patch.status);
		}
		return original(id, patch);
	};
	return { transitions };
}

class RecordingNotifier implements Notifier {
	readonly name = "recording";
	readonly events: NotificationEvent[] = [];

	async notify(event: NotificationEvent): Promise<void> {
		this.events.push(event);
	}
}

function fakeTelemetrySource(
	overrides: Partial<TelemetrySource> = {},
): TelemetrySource {
	return {
		name: "fake-telemetry",
		queryLogs: async () => [],
		queryTraces: async () => [],
		queryMetrics: async () => [],
		...overrides,
	};
}

function fakeResolver(result: ResolvedRepo | null): PipelineResolver {
	return {
		async resolve(_input: ResolveRepoInput) {
			return result;
		},
	};
}

function fakeGithub(
	overrides: Partial<PipelineGitHubClient> = {},
): PipelineGitHubClient {
	return {
		async getRepo(owner: string, repo: string) {
			return { htmlUrl: `https://github.com/${owner}/${repo}` };
		},
		...overrides,
	};
}

function fakeAgentRunner(
	result: FixAgentRunResult,
	calls: {
		incident: Incident;
		context: IncidentContext;
		repo: ResolvedRepo;
	}[] = [],
): PipelineAgentRunner {
	return {
		async run(incident, context, repo) {
			calls.push({ incident, context, repo });
			return result;
		},
	};
}

function makeConfig(): ContextBuilderConfig {
	return { collect: { windowBeforeMinutes: 30, windowAfterMinutes: 5 } };
}

/** Agent runner that must never be invoked; fails the test loudly if it is. */
function unreachableAgentRunner(): PipelineAgentRunner {
	return {
		async run() {
			throw new Error("agentRunner.run should not have been called");
		},
	};
}

/** Resolver that must never be invoked; fails the test loudly if it is. */
function unreachableResolver(): PipelineResolver {
	return {
		async resolve() {
			throw new Error("resolver.resolve should not have been called");
		},
	};
}

function makePipeline(
	overrides: Partial<IncidentPipelineDeps> & { store: IncidentStore },
): IncidentPipeline {
	return new IncidentPipeline({
		telemetrySource: undefined,
		resolver: fakeResolver(null),
		github: fakeGithub(),
		agentRunner: unreachableAgentRunner(),
		notifier: new RecordingNotifier(),
		config: makeConfig(),
		logger: silentLogger(),
		...overrides,
	});
}

describe("IncidentPipeline - happy path to pr_created", () => {
	test("resolves a high-confidence repo, hands off to the agent runner, and reaches pr_created in order", async () => {
		const { store, incident } = await setup();
		const { transitions } = trackTransitions(store);
		const notifier = new RecordingNotifier();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};
		const runnerResult: FixAgentRunResult = {
			status: "pr_created",
			prUrl: "https://github.com/acme/widgets/pull/9",
			diagnosis: "Root cause: null pointer in checkout.",
			report: "## report",
		};
		const agentCalls: {
			incident: Incident;
			context: IncidentContext;
			repo: ResolvedRepo;
		}[] = [];

		const pipeline = makePipeline({
			store,
			notifier,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner(runnerResult, agentCalls),
		});

		await pipeline.process(incident);

		expect(transitions).toEqual(["collecting", "resolving_repo", "pr_created"]);

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("pr_created");
		expect(final?.prUrl).toBe(runnerResult.prUrl);
		expect(final?.diagnosis).toBe(runnerResult.diagnosis);

		expect(agentCalls.length).toBe(1);
		expect(agentCalls[0]?.repo).toEqual(resolved);
		expect(agentCalls[0]?.incident.status).toBe("resolving_repo");

		expect(notifier.events.map((e) => e.kind)).toEqual([
			"diagnosis_started",
			"pr_created",
		]);
		const prEvent = notifier.events[1];
		if (prEvent?.kind === "pr_created") {
			expect(prEvent.prUrl).toBe(runnerResult.prUrl);
			expect(prEvent.summary).toBe(runnerResult.diagnosis);
		} else {
			throw new Error("expected a pr_created notification");
		}
	});
});

describe("IncidentPipeline - telemetry degradation", () => {
	test("degrades to an empty-telemetry context (with a note) when no telemetry source is configured", async () => {
		const { store, incident } = await setup();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "mapping",
			confidence: "high",
		};
		let capturedContext: IncidentContext | undefined;
		const agentRunner: PipelineAgentRunner = {
			async run(_incident, context) {
				capturedContext = context;
				return { status: "report_only", diagnosis: "d", report: "r" };
			},
		};

		const pipeline = makePipeline({
			store,
			telemetrySource: undefined,
			resolver: fakeResolver(resolved),
			agentRunner,
		});

		await pipeline.process(incident);

		expect(capturedContext?.telemetry).toEqual({
			logs: [],
			traces: [],
			metrics: [],
		});
		expect(
			capturedContext?.notes.some((note) =>
				note.includes("No telemetry source is configured"),
			),
		).toBe(true);
		expect((await store.getIncident(incident.id))?.status).toBe("report_only");
	});

	test("degrades to an empty-telemetry context (with a note) when the telemetry query itself fails", async () => {
		const { store, incident } = await setup();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "mapping",
			confidence: "high",
		};
		const failingSource = fakeTelemetrySource({
			queryLogs: async () => {
				throw new Error("greptimedb unreachable");
			},
		});
		let capturedContext: IncidentContext | undefined;
		const agentRunner: PipelineAgentRunner = {
			async run(_incident, context) {
				capturedContext = context;
				return { status: "report_only", diagnosis: "d", report: "r" };
			},
		};

		const pipeline = makePipeline({
			store,
			telemetrySource: failingSource,
			resolver: fakeResolver(resolved),
			agentRunner,
		});

		await pipeline.process(incident);

		expect(capturedContext?.telemetry).toEqual({
			logs: [],
			traces: [],
			metrics: [],
		});
		expect(
			capturedContext?.notes.some((note) =>
				note.includes("Telemetry collection failed"),
			),
		).toBe(true);
		expect(
			capturedContext?.notes.some((note) => note.includes("unreachable")),
		).toBe(true);
		// The run still reaches a normal terminal state -- collection failure
		// must not abort the incident.
		expect((await store.getIncident(incident.id))?.status).toBe("report_only");
	});
});

describe("IncidentPipeline - repo resolution fallback to report_only", () => {
	test("resolver returning null falls back to report_only with a clear unresolved preamble", async () => {
		const { store, incident } = await setup();
		const notifier = new RecordingNotifier();

		const pipeline = makePipeline({
			store,
			notifier,
			resolver: fakeResolver(null),
		});

		await pipeline.process(incident);

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("report_only");
		expect(final?.diagnosis).toContain("could not be confidently resolved");
		expect(final?.diagnosis).toContain("method: none");

		const reportEvent = notifier.events.find((e) => e.kind === "report_only");
		if (reportEvent?.kind === "report_only") {
			expect(reportEvent.report).toContain("could not be confidently resolved");
			expect(reportEvent.report).toContain("# Incident:");
		} else {
			throw new Error("expected a report_only notification");
		}
	});

	test("a low-confidence resolution falls back to report_only, enriched with a github link", async () => {
		const { store, incident } = await setup();
		const lowConfidence: ResolvedRepo = {
			owner: "acme",
			repo: "maybe-widgets",
			method: "org-search",
			confidence: "low",
		};

		const pipeline = makePipeline({
			store,
			resolver: fakeResolver(lowConfidence),
			github: fakeGithub(),
		});

		await pipeline.process(incident);

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("report_only");
		expect(final?.diagnosis).toContain("org-search");
		expect(final?.diagnosis).toContain("https://github.com/acme/maybe-widgets");
	});

	test("falls back to a plain owner/repo hint when the github lookup itself fails", async () => {
		const { store, incident } = await setup();
		const lowConfidence: ResolvedRepo = {
			owner: "acme",
			repo: "maybe-widgets",
			method: "org-search",
			confidence: "low",
		};
		const github = fakeGithub({
			async getRepo() {
				throw new Error("404 not found");
			},
		});

		const pipeline = makePipeline({
			store,
			resolver: fakeResolver(lowConfidence),
			github,
		});

		await pipeline.process(incident);

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("report_only");
		expect(final?.diagnosis).toContain("acme/maybe-widgets");
	});
});

describe("IncidentPipeline - fix agent outcome mapping", () => {
	test("maps a 'failed' agent outcome to a terminal failed incident + notification", async () => {
		const { store, incident } = await setup();
		const notifier = new RecordingNotifier();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};
		const result: FixAgentRunResult = {
			status: "failed",
			failureReason: "tests did not pass",
			diagnosis: "diag",
		};

		const pipeline = makePipeline({
			store,
			notifier,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner(result),
		});

		await pipeline.process(incident);

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("failed");
		expect(final?.failureReason).toBe("tests did not pass");
		expect(final?.diagnosis).toBe("diag");

		const failedEvent = notifier.events.find((e) => e.kind === "failed");
		if (failedEvent?.kind === "failed") {
			expect(failedEvent.reason).toBe("tests did not pass");
		} else {
			throw new Error("expected a failed notification");
		}
	});

	test("maps a 'report_only' agent outcome to a terminal report_only incident + notification", async () => {
		const { store, incident } = await setup();
		const notifier = new RecordingNotifier();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};
		const result: FixAgentRunResult = {
			status: "report_only",
			diagnosis: "Root cause is infra drift, not code.",
			report: "## Full report",
		};

		const pipeline = makePipeline({
			store,
			notifier,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner(result),
		});

		await pipeline.process(incident);

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("report_only");
		expect(final?.diagnosis).toBe(result.diagnosis);

		const reportEvent = notifier.events.find((e) => e.kind === "report_only");
		if (reportEvent?.kind === "report_only") {
			expect(reportEvent.report).toBe("## Full report");
		} else {
			throw new Error("expected a report_only notification");
		}
	});
});

describe("IncidentPipeline - unexpected failures never escape as unhandled rejections", () => {
	test("an unexpected exception anywhere in the pipeline still reaches a terminal 'failed' incident", async () => {
		const { store, incident } = await setup();
		const notifier = new RecordingNotifier();
		const resolver: PipelineResolver = {
			async resolve() {
				throw new Error("resolver blew up");
			},
		};

		const pipeline = makePipeline({ store, notifier, resolver });

		await expect(pipeline.process(incident)).resolves.toBeUndefined();

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("failed");
		expect(final?.failureReason).toBe("resolver blew up");

		expect(notifier.events.map((e) => e.kind)).toEqual([
			"diagnosis_started",
			"failed",
		]);
	});

	test("an exception from the agent runner itself also reaches a terminal 'failed' incident", async () => {
		const { store, incident } = await setup();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};
		const agentRunner: PipelineAgentRunner = {
			async run() {
				throw new Error("flue sidecar unreachable");
			},
		};

		const pipeline = makePipeline({
			store,
			resolver: fakeResolver(resolved),
			agentRunner,
		});

		await expect(pipeline.process(incident)).resolves.toBeUndefined();

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("failed");
		expect(final?.failureReason).toBe("flue sidecar unreachable");
	});

	test("never calls resolver.resolve or agentRunner.run when persisting the resolving_repo transition fails", async () => {
		const { store, incident } = await setup();
		const notifier = new RecordingNotifier();

		const original = store.updateIncident.bind(store);
		store.updateIncident = async (id: string, patch: UpdateIncidentInput) => {
			if (patch.status === "resolving_repo") {
				throw new Error("db unavailable during resolving_repo transition");
			}
			return original(id, patch);
		};

		const pipeline = makePipeline({
			store,
			notifier,
			resolver: unreachableResolver(),
			agentRunner: unreachableAgentRunner(),
		});

		await expect(pipeline.process(incident)).resolves.toBeUndefined();

		const final = await store.getIncident(incident.id);
		expect(final?.status).toBe("failed");
		expect(final?.failureReason).toBe(
			"db unavailable during resolving_repo transition",
		);

		expect(notifier.events.map((e) => e.kind)).toEqual([
			"diagnosis_started",
			"failed",
		]);
	});

	test("logs but does not throw when persisting the failure itself also fails", async () => {
		const { store, incident } = await setup();
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line) });
		const resolver: PipelineResolver = {
			async resolve() {
				throw new Error("resolver blew up");
			},
		};

		const original = store.updateIncident.bind(store);
		store.updateIncident = async (id: string, patch: UpdateIncidentInput) => {
			if (patch.status === "failed") {
				throw new Error("db unavailable");
			}
			return original(id, patch);
		};

		const pipeline = makePipeline({ store, resolver, logger });

		await expect(pipeline.process(incident)).resolves.toBeUndefined();

		expect(
			lines.some((line) => line.includes("pipeline.failed_to_persist_failure")),
		).toBe(true);
	});
});

describe("IncidentPipeline - notification emission matrix", () => {
	test("diagnosis_started always fires first, exactly once, regardless of the terminal outcome", async () => {
		const scenarios: {
			label: string;
			resolver: PipelineResolver;
			agentRunner: PipelineAgentRunner;
			expectedKinds: NotificationEvent["kind"][];
		}[] = [
			{
				label: "pr_created",
				resolver: fakeResolver({
					owner: "acme",
					repo: "widgets",
					method: "attribute",
					confidence: "high",
				}),
				agentRunner: fakeAgentRunner({
					status: "pr_created",
					prUrl: "https://github.com/acme/widgets/pull/1",
					diagnosis: "d",
					report: "r",
				}),
				expectedKinds: ["diagnosis_started", "pr_created"],
			},
			{
				label: "report_only via agent",
				resolver: fakeResolver({
					owner: "acme",
					repo: "widgets",
					method: "attribute",
					confidence: "high",
				}),
				agentRunner: fakeAgentRunner({
					status: "report_only",
					diagnosis: "d",
					report: "r",
				}),
				expectedKinds: ["diagnosis_started", "report_only"],
			},
			{
				label: "report_only via unresolved repo",
				resolver: fakeResolver(null),
				agentRunner: unreachableAgentRunner(),
				expectedKinds: ["diagnosis_started", "report_only"],
			},
			{
				label: "failed via agent",
				resolver: fakeResolver({
					owner: "acme",
					repo: "widgets",
					method: "attribute",
					confidence: "high",
				}),
				agentRunner: fakeAgentRunner({
					status: "failed",
					failureReason: "boom",
				}),
				expectedKinds: ["diagnosis_started", "failed"],
			},
		];

		for (const scenario of scenarios) {
			const { store, incident } = await setup();
			const notifier = new RecordingNotifier();
			const pipeline = makePipeline({
				store,
				notifier,
				resolver: scenario.resolver,
				agentRunner: scenario.agentRunner,
			});

			await pipeline.process(incident);

			expect(notifier.events.map((e) => e.kind)).toEqual(
				scenario.expectedKinds,
			);
		}
	});
});
