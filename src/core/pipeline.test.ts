import { describe, expect, test } from "bun:test";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
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

// Registered once at module scope so spans created inside nested
// `context.with(...)` calls (across `await`s, e.g. child spans in
// `pipeline.ts`) correctly nest under their parent -- see
// docs design section 10. A second registration in the same bun process
// returns `false` and keeps the first, which is harmless (same manager
// class); `bun test src/core` only loads this one test file that touches
// tracing, so there is no cross-file interference here.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

/** Fresh in-memory tracer + exporter pair for a single test's span assertions. */
function newTracing() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	return { tracer: provider.getTracer("test"), exporter };
}

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

describe("IncidentPipeline - OTel span tree (design section 5+6)", () => {
	test("starts a forced-root incident.process span with incident attributes and the pr_created outcome", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};
		const runnerResult: FixAgentRunResult = {
			status: "pr_created",
			prUrl: "https://github.com/acme/widgets/pull/9",
			diagnosis: "diag",
			report: "report",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner(runnerResult),
		});

		await pipeline.process(incident);

		const rootSpan = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.process");
		if (!rootSpan) {
			throw new Error("expected an incident.process span");
		}

		// Forced root: no parent, even though this ran inside the surrounding
		// test's own active context (there isn't one here, but the design
		// requires `root: true` regardless of what's active).
		expect(rootSpan.parentSpanContext).toBeUndefined();
		expect(rootSpan.attributes["paperhanger.incident.id"]).toBe(incident.id);
		expect(rootSpan.attributes["paperhanger.incident.fingerprint"]).toBe(
			incident.fingerprint,
		);
		expect(rootSpan.attributes["paperhanger.incident.source"]).toBe(
			incident.source,
		);
		expect(rootSpan.attributes["paperhanger.incident.severity"]).toBe(
			incident.severity,
		);
		expect(rootSpan.attributes["paperhanger.incident.outcome"]).toBe(
			"pr_created",
		);
		expect(rootSpan.ended).toBe(true);
	});

	test("nests incident.collect_telemetry / incident.resolve_repo / incident.agent_run under the root span, sharing its trace id", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "pr_created",
				prUrl: "https://github.com/acme/widgets/pull/1",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		const spans = exporter.getFinishedSpans();
		const root = spans.find((s) => s.name === "incident.process");
		const collect = spans.find((s) => s.name === "incident.collect_telemetry");
		const resolve = spans.find((s) => s.name === "incident.resolve_repo");
		const agentRun = spans.find((s) => s.name === "incident.agent_run");
		if (!root || !collect || !resolve || !agentRun) {
			throw new Error(
				"expected all four incident.* spans to have been created",
			);
		}

		const rootSpanId = root.spanContext().spanId;
		const rootTraceId = root.spanContext().traceId;
		for (const child of [collect, resolve, agentRun]) {
			expect(child.parentSpanContext?.spanId).toBe(rootSpanId);
			expect(child.spanContext().traceId).toBe(rootTraceId);
		}
	});

	test("records a `notify` span event on the root span for every notifier call, in order", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "pr_created",
				prUrl: "https://github.com/acme/widgets/pull/1",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		const root = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.process");
		if (!root) {
			throw new Error("expected an incident.process span");
		}

		const notifyEvents = root.events.filter((e) => e.name === "notify");
		expect(
			notifyEvents.map((e) => e.attributes?.["paperhanger.notify.kind"]),
		).toEqual(["diagnosis_started", "pr_created"]);
	});

	test("incident.resolve_repo sets repo.resolved=false (not an error status) and the root outcome is 'unresolved' when nothing is found", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(null),
		});

		await pipeline.process(incident);

		const spans = exporter.getFinishedSpans();
		const resolveSpan = spans.find((s) => s.name === "incident.resolve_repo");
		if (!resolveSpan) {
			throw new Error("expected an incident.resolve_repo span");
		}
		expect(resolveSpan.attributes["paperhanger.repo.resolved"]).toBe(false);
		expect(resolveSpan.status.code).not.toBe(SpanStatusCode.ERROR);

		const root = spans.find((s) => s.name === "incident.process");
		expect(root?.attributes["paperhanger.incident.outcome"]).toBe("unresolved");
	});

	test("incident.resolve_repo records owner/name/method/confidence on a successful resolution", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "mapping",
			confidence: "high",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "report_only",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.resolve_repo");
		if (!span) {
			throw new Error("expected an incident.resolve_repo span");
		}
		expect(span.attributes["paperhanger.repo.owner"]).toBe("acme");
		expect(span.attributes["paperhanger.repo.name"]).toBe("widgets");
		expect(span.attributes["paperhanger.repo.method"]).toBe("mapping");
		expect(span.attributes["paperhanger.repo.confidence"]).toBe("high");
	});

	test("incident.agent_run gets an ERROR status with the failure reason as message when the agent run fails", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "failed",
				failureReason: "tests did not pass",
			}),
		});

		await pipeline.process(incident);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.agent_run");
		if (!span) {
			throw new Error("expected an incident.agent_run span");
		}
		expect(span.attributes["paperhanger.agent.outcome"]).toBe("failed");
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.status.message).toBe("tests did not pass");
	});

	test("incident.collect_telemetry records the exception + ERROR status (without aborting the run) when telemetry collection fails", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
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

		const pipeline = makePipeline({
			store,
			tracer,
			telemetrySource: failingSource,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "report_only",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.collect_telemetry");
		if (!span) {
			throw new Error("expected an incident.collect_telemetry span");
		}
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.status.message).toBe("telemetry collection failed");
		// Redacted universally: no recordException (telemetrySource errors, e.g.
		// GreptimeDbError, can echo GreptimeDB's response body -- which may
		// contain the submitted SQL/PromQL text). Only the constructor name is
		// recorded, never the raw message.
		expect(span.events.some((e) => e.name === "exception")).toBe(false);
		expect(span.attributes["paperhanger.telemetry.error_name"]).toBe("Error");

		// Collection failure degrades gracefully -- the pipeline itself still
		// reaches a normal terminal state, never an unexpected failure.
		expect((await store.getIncident(incident.id))?.status).toBe("report_only");
	});

	test("never leaks the raw telemetry error message onto the collect_telemetry span, even when it embeds upstream-tainted text (e.g. a GreptimeDbError response body echoing submitted SQL/PromQL)", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "mapping",
			confidence: "high",
		};
		const marker = "SELECT__SECRET_MARKER__FROM_UPSTREAM_SQL_9f3a";
		const failingSource = fakeTelemetrySource({
			queryLogs: async () => {
				throw new Error(`GreptimeDB query failed: ${marker}`);
			},
		});

		const pipeline = makePipeline({
			store,
			tracer,
			telemetrySource: failingSource,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "report_only",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.collect_telemetry");
		if (!span) {
			throw new Error("expected an incident.collect_telemetry span");
		}

		const serialized = JSON.stringify({
			status: span.status,
			events: span.events,
			attributes: span.attributes,
		});
		expect(serialized.includes(marker)).toBe(false);
	});

	test("incident.collect_telemetry records telemetry.configured=false and no error when no telemetry source is configured", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "mapping",
			confidence: "high",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			telemetrySource: undefined,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "report_only",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.collect_telemetry");
		if (!span) {
			throw new Error("expected an incident.collect_telemetry span");
		}
		expect(span.attributes["paperhanger.telemetry.configured"]).toBe(false);
		expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test("records a generic ERROR status (no exception event, no raw message) plus an error_name attribute on the root span, and outcome=failed, for an unexpected pipeline failure", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const resolver: PipelineResolver = {
			async resolve() {
				throw new Error("resolver blew up");
			},
		};

		const pipeline = makePipeline({ store, tracer, resolver });

		await pipeline.process(incident);

		const root = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.process");
		if (!root) {
			throw new Error("expected an incident.process span");
		}
		expect(root.status.code).toBe(SpanStatusCode.ERROR);
		expect(root.status.message).toBe("incident processing failed unexpectedly");
		// Redacted: `finalizeUnexpectedFailure` is the pipeline's guaranteed
		// catch-all, so the caught error can be anything upstream (e.g. a
		// GitHubApiError echoing a raw org-search query or response body) --
		// no recordException and no raw err.message ever reach the root span.
		expect(root.events.some((e) => e.name === "exception")).toBe(false);
		expect(root.attributes["paperhanger.incident.error_name"]).toBe("Error");
		expect(root.attributes["paperhanger.incident.outcome"]).toBe("failed");

		const notifyEvents = root.events.filter((e) => e.name === "notify");
		expect(
			notifyEvents.map((e) => e.attributes?.["paperhanger.notify.kind"]),
		).toEqual(["diagnosis_started", "failed"]);
	});

	test("never leaks a raw error message onto the root span via finalizeUnexpectedFailure, even when it embeds upstream-tainted text (e.g. a GitHubApiError echoing a raw org-search query or response body)", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const marker = "ORG_SEARCH__SECRET_MARKER__RAW_GITHUB_BODY_7c1d";
		const resolver: PipelineResolver = {
			async resolve() {
				throw new Error(`GitHub org search failed: ${marker}`);
			},
		};

		const pipeline = makePipeline({ store, tracer, resolver });

		await pipeline.process(incident);

		const root = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.process");
		if (!root) {
			throw new Error("expected an incident.process span");
		}

		const serialized = JSON.stringify({
			status: root.status,
			events: root.events,
			attributes: root.attributes,
		});
		expect(serialized.includes(marker)).toBe(false);
	});

	test("incident.resolve_repo gets a generic ERROR status (no raw message) and an error_name attribute when resolver.resolve throws, and never leaks the raw error text onto the span", async () => {
		const { store, incident } = await setup();
		const { tracer, exporter } = newTracing();
		const marker = "GH_API__SECRET_MARKER__ORG_SEARCH_QUERY_4e2b";
		const resolver: PipelineResolver = {
			async resolve() {
				throw new Error(`GitHub org search failed: ${marker}`);
			},
		};

		const pipeline = makePipeline({ store, tracer, resolver });

		await pipeline.process(incident);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name === "incident.resolve_repo");
		if (!span) {
			throw new Error("expected an incident.resolve_repo span");
		}
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.status.message).toBe("repo resolution failed");
		expect(span.attributes["paperhanger.repo.error_name"]).toBe("Error");
		expect(span.events.some((e) => e.name === "exception")).toBe(false);

		const serialized = JSON.stringify({
			status: span.status,
			events: span.events,
			attributes: span.attributes,
		});
		expect(serialized.includes(marker)).toBe(false);

		// resolveRepo rethrows unchanged, so process()'s outer catch-all still
		// runs and the incident still reaches a terminal 'failed' state.
		expect((await store.getIncident(incident.id))?.status).toBe("failed");
	});

	test("keeps the exact store.updateIncident transition order when a tracer is configured", async () => {
		const { store, incident } = await setup();
		const { transitions } = trackTransitions(store);
		const { tracer } = newTracing();
		const resolved: ResolvedRepo = {
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		};

		const pipeline = makePipeline({
			store,
			tracer,
			resolver: fakeResolver(resolved),
			agentRunner: fakeAgentRunner({
				status: "pr_created",
				prUrl: "https://github.com/acme/widgets/pull/1",
				diagnosis: "d",
				report: "r",
			}),
		});

		await pipeline.process(incident);

		expect(transitions).toEqual(["collecting", "resolving_repo", "pr_created"]);
	});
});
