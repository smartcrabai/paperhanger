/**
 * Stage orchestration: collect -> resolve -> agent -> notify. This is the
 * real `IncidentProcessor` (see `incident-manager.ts`), wired in at M7.
 *
 * Stage flow (docs/spec.md section 2 and 3.5, docs/architecture.md "Incident
 * state machine"):
 *
 *   1. Notify `diagnosis_started`, then persist the `collecting` transition.
 *   2. Build an `IncidentContext` from the latest firing event for this
 *      incident. Telemetry absence/failure degrades to an empty-telemetry
 *      context (with an explanatory note) rather than aborting the run. Save
 *      an `IncidentCheckpoint` (`IncidentStore.saveIncidentCheckpoint`) with
 *      this context once it's built.
 *   3. Persist the `resolving_repo` transition, then resolve the target
 *      repository (attribute -> mapping -> org-search, per spec 3.5),
 *      deriving resource-attribute hints from whatever telemetry was
 *      collected. A `null` result or a "low" confidence result is a terminal
 *      `report_only` (never guess at a fix target). A usable resolution
 *      upgrades the checkpoint with the resolved repo.
 *   4. Otherwise, hand off to `FixAgentRunner.run()`, which manages its own
 *      `diagnosing`/`fixing` transitions, and map its outcome to a terminal
 *      incident status. The checkpoint is deleted once any terminal status is
 *      reached (see `cleanupCheckpoint`).
 *
 * Restart resume (docs/spec.md section 3.2 and 3.10, docs/architecture.md
 * "Incident state machine"): `process()` starts by loading this incident's
 * checkpoint, if any (`loadResumePlan`), and skips whichever of steps 2-3
 * that checkpoint proves already completed before a prior crash/restart --
 * see `ResumePlan` below for the three possible outcomes. A fresh,
 * never-crashed incident has no checkpoint yet, so it always takes the full
 * `"collect"` plan; this is what makes checkpointing purely additive to the
 * existing behavior below. Resuming past step 2 also skips its
 * `diagnosis_started` notification, since it already fired before the crash
 * -- see `ResumePlan`'s doc comment for exactly which crash window still
 * produces a duplicate.
 *
 * Crash-observability (docs/architecture.md): every transition is persisted
 * through `IncidentStore` before the next stage starts, so a restart can
 * observe exactly where an incident stopped. The whole method is wrapped so
 * that any unexpected exception becomes a terminal `failed` incident with a
 * reason, rather than an unhandled rejection propagating out of
 * `IncidentManager`.
 *
 * Notification policy (spec section 3.8): every terminal outcome and the
 * initial `diagnosis_started` are notified here. `skipped` is notified by
 * `IncidentManager` itself (a queued-but-not-yet-started incident whose alert
 * resolved) -- this pipeline never produces a `skipped` outcome. Dedup/
 * cooldown events are log-only and never notified (see incident-manager.ts).
 *
 * Tracing: `process()` is a detached queue job, not part of any inbound
 * request, so it starts a FORCED ROOT span (`incident.process`,
 * `{ root: true }`) rather than inheriting whatever context happens to be
 * active, and wraps its entire body in `context.with(...)` so every stage's
 * child span (and any CLIENT spans further downstream in
 * telemetry/github/agent/notify clients) nests beneath it. `deps.tracer` is
 * optional and falls back to a no-op tracer (`trace.getTracer(...)`, no
 * global provider registered) so every existing call site keeps working
 * unchanged when tracing is disabled.
 */

import {
	context,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
	type Tracer,
} from "@opentelemetry/api";
import {
	buildIncidentContext as defaultBuildIncidentContext,
	computeWindow,
	renderContextMarkdown as defaultRenderContextMarkdown,
	type ContextBuilderConfig,
} from "../telemetry/context-builder";
import type { IncidentContext, TelemetrySource } from "../telemetry/types";
import { incidentSnapshot } from "../notify/types";
import type { NotificationEvent, Notifier } from "../notify/types";
import type { Logger } from "../observability/logger";
import type { ResolvedRepo, ResolveRepoInput } from "../repo/resolver";
import type { IncidentStore } from "../storage/types";
import type { IncidentProcessor } from "./incident-manager";
import type { Incident, IncidentEvent } from "./types";
import type { FixAgentRunResult } from "../agent/runner";

/** Structural subset of `RepoResolver` this pipeline depends on. */
export interface PipelineResolver {
	resolve(input: ResolveRepoInput): Promise<ResolvedRepo | null>;
}

/** Structural subset of `FixAgentRunner` this pipeline depends on. */
export interface PipelineAgentRunner {
	run(
		incident: Incident,
		context: IncidentContext,
		repo: ResolvedRepo,
	): Promise<FixAgentRunResult>;
}

/**
 * Structural subset of `GitHubAppClient` this pipeline depends on: only used
 * to enrich the `report_only` preamble with a link when the repo resolver
 * found a *low-confidence* candidate (rather than nothing at all), so an
 * operator reading the report doesn't have to go dig up the repo by hand.
 */
export interface PipelineGitHubClient {
	getRepo(owner: string, repo: string): Promise<{ htmlUrl: string }>;
}

export interface IncidentPipelineDeps {
	store: IncidentStore;
	/** `undefined` when no telemetry backend is configured; handled as a graceful degradation, not an error. */
	telemetrySource: TelemetrySource | undefined;
	resolver: PipelineResolver;
	github: PipelineGitHubClient;
	agentRunner: PipelineAgentRunner;
	notifier: Notifier;
	config: ContextBuilderConfig;
	logger: Logger;
	/** Injectable for tests; defaults to the real implementation in `telemetry/context-builder.ts`. */
	buildIncidentContext?: typeof defaultBuildIncidentContext;
	/** Injectable for tests; defaults to the real implementation in `telemetry/context-builder.ts`. */
	renderContextMarkdown?: typeof defaultRenderContextMarkdown;
	/**
	 * OTel tracer for the `incident.*` span tree. Defaults to a no-op tracer
	 * (`trace.getTracer("incident-pipeline")`, no global provider registered)
	 * when omitted, so tracing is opt-in and every existing call site keeps
	 * working unchanged.
	 */
	tracer?: Tracer;
}

function syntheticAlertFromIncident(incident: Incident): IncidentEvent {
	return {
		fingerprint: incident.fingerprint,
		source: incident.source,
		status: "firing",
		severity: incident.severity,
		title: incident.title,
		labels: incident.labels,
		annotations: incident.annotations,
		startsAt: incident.createdAt,
		raw: {},
	};
}

function buildDegradedContext(
	incident: Incident,
	alert: IncidentEvent,
	config: ContextBuilderConfig,
	note: string,
): IncidentContext {
	return {
		incident,
		alert,
		window: computeWindow(alert, config.collect, new Date()),
		telemetry: { logs: [], traces: [], metrics: [] },
		notes: [note],
	};
}

/**
 * Merges resource attributes across every collected log record (first value
 * for a given key wins), converting to the flat `Record<string, string>`
 * shape the repo resolver expects. Returns `undefined` when nothing was
 * collected, so the resolver's attribute step cleanly skips this input
 * rather than matching against an empty object.
 */
function deriveResourceAttributes(
	incidentContext: IncidentContext,
): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	for (const log of incidentContext.telemetry.logs) {
		for (const [key, value] of Object.entries(log.resourceAttributes)) {
			if (merged[key] === undefined && value !== null && value !== undefined) {
				merged[key] = String(value);
			}
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * How much of the pipeline `process()` can skip for a given run, decided by
 * `loadResumePlan` from this incident's checkpoint (if any):
 *
 * - `"collect"`: no usable checkpoint. Either a fresh incident, or a crash
 *   before telemetry collection finished (i.e. before step 2's
 *   `saveIncidentCheckpoint` call). Runs every stage, identical to
 *   pre-checkpoint behavior -- including firing `diagnosis_started`, so a
 *   crash in this narrow window is the one case that can still produce a
 *   duplicate notification on resume.
 * - `"resolve"`: telemetry collection completed (checkpoint has an
 *   `incidentContext`) but repo resolution had not yet succeeded with usable
 *   confidence before the crash. Skips notifying `diagnosis_started` again
 *   and re-collecting telemetry; resumes at the `resolving_repo` transition
 *   using the checkpointed context.
 * - `"agent"`: repo resolution also completed (checkpoint additionally has a
 *   `resolvedRepo`) before the crash -- this is the only way `diagnosing`/
 *   `fixing` are ever reached, so a crash at either of those statuses always
 *   produces this plan. Skips straight to `runAgent`, re-invoking
 *   `FixAgentRunner.run()` from scratch: it has no resumable checkpoint of
 *   its own here, so this is the practical limit of how far resume goes --
 *   the agent run itself (clone, diagnose, fix, test) always restarts, with
 *   its own fresh `agent.timeoutMinutes`/`maxFixAttempts` budget, exactly as
 *   a full pipeline restart already did before this change.
 */
type ResumePlan =
	| { resumeAt: "collect" }
	| { resumeAt: "resolve"; incidentContext: IncidentContext }
	| {
			resumeAt: "agent";
			incidentContext: IncidentContext;
			resolvedRepo: ResolvedRepo;
	  };

export class IncidentPipeline implements IncidentProcessor {
	private readonly logger: Logger;
	private readonly tracer: Tracer;
	private readonly buildIncidentContextFn: typeof defaultBuildIncidentContext;
	private readonly renderContextMarkdownFn: typeof defaultRenderContextMarkdown;

	constructor(private readonly deps: IncidentPipelineDeps) {
		this.logger = deps.logger.child({ component: "incident-pipeline" });
		this.tracer = deps.tracer ?? trace.getTracer("incident-pipeline");
		this.buildIncidentContextFn =
			deps.buildIncidentContext ?? defaultBuildIncidentContext;
		this.renderContextMarkdownFn =
			deps.renderContextMarkdown ?? defaultRenderContextMarkdown;
	}

	/**
	 * Adds a `notify` event to the currently active span (the `incident.process`
	 * root, since every notifier call in this pipeline happens either directly
	 * inside `process()` or inside a `finalize*` helper called from it) rather
	 * than creating a dedicated child span -- the notifier's own HTTP transport
	 * (`postJson`) gets its own CLIENT span downstream.
	 */
	private recordNotifyEvent(kind: NotificationEvent["kind"]): void {
		trace
			.getActiveSpan()
			?.addEvent("notify", { "paperhanger.notify.kind": kind });
	}

	/**
	 * Loads this incident's checkpoint (if any) and translates it into a
	 * `ResumePlan` -- see `ResumePlan`'s doc comment for what each outcome
	 * means. Re-checks `incidentContext` presence defensively rather than
	 * trusting a `resolvedRepo`-bearing checkpoint blindly: `saveIncidentCheckpoint`
	 * never persists one without the other (see `process()` below), but a
	 * checkpoint row is external state this method did not just write, so a
	 * corrupted/partial row (e.g. a hand-edited database) falls back to a
	 * full `"collect"` run instead of resuming from a missing context.
	 */
	private async loadResumePlan(incidentId: string): Promise<ResumePlan> {
		const checkpoint = await this.deps.store.getIncidentCheckpoint(incidentId);
		if (!checkpoint?.incidentContext) {
			return { resumeAt: "collect" };
		}
		if (checkpoint.resolvedRepo) {
			return {
				resumeAt: "agent",
				incidentContext: checkpoint.incidentContext,
				resolvedRepo: checkpoint.resolvedRepo,
			};
		}
		return { resumeAt: "resolve", incidentContext: checkpoint.incidentContext };
	}

	/**
	 * Deletes this incident's checkpoint once it reaches a terminal status
	 * (called from each `finalize*` method, right after that status is
	 * confirmed persisted). Never throws: a cleanup hiccup must not turn an
	 * otherwise-successful terminal transition into an unhandled failure, and
	 * a leftover checkpoint row is harmless -- incident ids are never reused,
	 * and `IncidentManager` never re-enqueues a terminal incident -- beyond
	 * the minor storage cost of an orphaned row. This is also the
	 * stale-checkpoint guard for the incident's own lifetime: once deleted, a
	 * checkpoint can never be read back for this incident again, so nothing
	 * later can accidentally resume from it.
	 */
	private async cleanupCheckpoint(incidentId: string): Promise<void> {
		try {
			await this.deps.store.deleteIncidentCheckpoint(incidentId);
		} catch (err) {
			this.logger.warn("pipeline.checkpoint_cleanup_failed", {
				incidentId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async process(incident: Incident): Promise<void> {
		const plan = await this.loadResumePlan(incident.id);

		const rootSpan = this.tracer.startSpan("incident.process", {
			root: true,
			kind: SpanKind.INTERNAL,
			attributes: {
				"paperhanger.incident.id": incident.id,
				"paperhanger.incident.fingerprint": incident.fingerprint,
				"paperhanger.incident.source": incident.source,
				"paperhanger.incident.severity": incident.severity,
				"paperhanger.incident.resumed_at": plan.resumeAt,
			},
		});

		await context.with(trace.setSpan(context.active(), rootSpan), async () => {
			let outcome: "pr_created" | "report_only" | "failed" | "unresolved" =
				"failed";
			try {
				let current = incident;
				let incidentContext: IncidentContext;
				let resolved: ResolvedRepo | null;

				if (plan.resumeAt === "agent") {
					// Both telemetry collection and repo resolution already
					// completed before the crash/restart -- skip straight to the
					// agent stage. `current` keeps whatever status this incident is
					// already persisted at (`resolving_repo` if the crash landed
					// between saving this checkpoint and the first agent-run
					// transition, or `diagnosing`/`fixing` otherwise);
					// `FixAgentRunner.run()` sets its own `diagnosing` transition
					// unconditionally, so this is idempotent either way.
					incidentContext = plan.incidentContext;
					resolved = plan.resolvedRepo;
				} else {
					if (plan.resumeAt === "collect") {
						this.recordNotifyEvent("diagnosis_started");
						await this.deps.notifier.notify({
							kind: "diagnosis_started",
							incident: incidentSnapshot(current),
						});

						current = await this.deps.store.updateIncident(current.id, {
							status: "collecting",
						});
						const alert = await this.resolveAlertEvent(current);
						incidentContext = await this.buildContext(current, alert);
						await this.deps.store.saveIncidentCheckpoint(current.id, {
							incidentContext,
						});
					} else {
						// resumeAt === "resolve": telemetry collection (and its
						// diagnosis_started notification) already happened before the
						// crash -- reuse the checkpointed context instead of
						// re-collecting and re-notifying.
						incidentContext = plan.incidentContext;
					}

					current = await this.deps.store.updateIncident(current.id, {
						status: "resolving_repo",
					});
					resolved = await this.resolveRepo(
						incidentContext.alert,
						incidentContext,
					);
					if (resolved && resolved.confidence !== "low") {
						await this.deps.store.saveIncidentCheckpoint(current.id, {
							incidentContext,
							resolvedRepo: resolved,
						});
					}
				}

				if (!resolved || resolved.confidence === "low") {
					await this.finalizeUnresolved(current, incidentContext, resolved);
					outcome = "unresolved";
					return;
				}

				const result = await this.runAgent(current, incidentContext, resolved);
				outcome = result.status;
				await this.finalizeAgentResult(current, result);
			} catch (err) {
				outcome = "failed";
				await this.finalizeUnexpectedFailure(incident, err);
			} finally {
				rootSpan.setAttribute("paperhanger.incident.outcome", outcome);
				rootSpan.end();
			}
		});
	}

	/**
	 * Finds the most recently received "firing" event for this incident.
	 * Falls back to a synthetic event built from the incident's own snapshot
	 * fields if none is found (defensive only: incidents are always created
	 * from a firing event, per `IncidentManager.handleFiring`).
	 */
	private async resolveAlertEvent(incident: Incident): Promise<IncidentEvent> {
		const events = await this.deps.store.listEvents(incident.id);
		for (let i = events.length - 1; i >= 0; i--) {
			const record = events[i];
			if (record && record.event.status === "firing") {
				return record.event;
			}
		}
		this.logger.warn("pipeline.no_firing_event_found", {
			incidentId: incident.id,
		});
		return syntheticAlertFromIncident(incident);
	}

	/**
	 * Builds the `IncidentContext`, degrading to an empty-telemetry context
	 * (with an explanatory note) instead of aborting the run when telemetry is
	 * unconfigured or the collection call itself fails. Per docs/spec.md
	 * section 3.4 telemetry is an enrichment, not a hard requirement for
	 * diagnosis to proceed.
	 */
	private async buildContext(
		incident: Incident,
		alert: IncidentEvent,
	): Promise<IncidentContext> {
		const { telemetrySource, config, logger } = this.deps;
		const span = this.tracer.startSpan("incident.collect_telemetry", {
			kind: SpanKind.INTERNAL,
			attributes: {
				"paperhanger.telemetry.configured": telemetrySource !== undefined,
			},
		});

		return await context.with(
			trace.setSpan(context.active(), span),
			async () => {
				try {
					if (!telemetrySource) {
						const note =
							"No telemetry source is configured; proceeding with an empty-telemetry context.";
						logger.warn("pipeline.telemetry_not_configured", {
							incidentId: incident.id,
						});
						return buildDegradedContext(incident, alert, config, note);
					}

					try {
						return await this.buildIncidentContextFn(
							{ source: telemetrySource, logger, config },
							incident,
							alert,
						);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						logger.error("pipeline.telemetry_collection_failed", {
							incidentId: incident.id,
							error: message,
						});
						// Redact universally on the span: telemetrySource errors (e.g.
						// GreptimeDbError) can echo GreptimeDB's response body, which may
						// contain the submitted SQL/PromQL text (upstream-tainted). This
						// pipeline must not couple to the concrete GreptimeDbError type
						// (DI layering), so no recordException and no raw err.message ever
						// reach the span here -- only a generic status message plus the
						// error's constructor name. The logger.error call above still
						// carries full details to stdout logs.
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: "telemetry collection failed",
						});
						span.setAttribute(
							"paperhanger.telemetry.error_name",
							err instanceof Error ? err.name : "UnknownError",
						);
						const note = `Telemetry collection failed (${message}); proceeding with an empty-telemetry context.`;
						return buildDegradedContext(incident, alert, config, note);
					}
				} finally {
					span.end();
				}
			},
		);
	}

	/**
	 * Shared span-lifecycle scaffolding for `resolveRepo` and `runAgent`:
	 * starts an INTERNAL child span, activates it via `context.with(...)` (so
	 * any downstream CLIENT spans nest under it), and always ends the span in
	 * a `finally`. When `fn` throws, sets a generic ERROR status plus an
	 * `errorAttribute` (the error's constructor name only -- never the raw
	 * message; see the redaction note on `buildContext`'s telemetry-failure
	 * branch for why: e.g. a `GitHubApiError` from the org-search path can
	 * embed alert-label-derived search queries or a raw upstream response
	 * body) and rethrows unchanged, so the caller's own catch-all (ultimately
	 * `process()`'s) still runs and still sees the original error.
	 *
	 * `buildContext`'s `incident.collect_telemetry` span deliberately does
	 * NOT use this helper: on a telemetry-collection failure it must degrade
	 * to an empty-telemetry context rather than rethrow, which doesn't fit
	 * this helper's rethrow-on-error contract. Only its span-start /
	 * `context.with` / `finally` shape mirrors this one -- its error handling
	 * (redacted the same way) stays bespoke.
	 */
	private async withStageSpan<T>(
		name: string,
		errorAttribute: string,
		errorMessage: string,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		const span = this.tracer.startSpan(name, { kind: SpanKind.INTERNAL });

		return await context.with(
			trace.setSpan(context.active(), span),
			async () => {
				try {
					return await fn(span);
				} catch (err) {
					span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
					span.setAttribute(
						errorAttribute,
						err instanceof Error ? err.name : "UnknownError",
					);
					throw err;
				} finally {
					span.end();
				}
			},
		);
	}

	/**
	 * Wraps `resolver.resolve()` in the `incident.resolve_repo` child span.
	 * Attaches the resolved repo's identity once known; a `null` result (no
	 * candidate at all) is an accepted terminal outcome, not a span error. A
	 * thrown error (e.g. `GitHubApiError` from the org-search path) gets a
	 * redacted ERROR status via `withStageSpan` and is rethrown unchanged so
	 * `process()`'s outer catch-all still runs.
	 */
	private async resolveRepo(
		alert: IncidentEvent,
		incidentContext: IncidentContext,
	): Promise<ResolvedRepo | null> {
		return await this.withStageSpan(
			"incident.resolve_repo",
			"paperhanger.repo.error_name",
			"repo resolution failed",
			async (span) => {
				const resolved = await this.deps.resolver.resolve({
					labels: alert.labels,
					annotations: alert.annotations,
					resourceAttributes: deriveResourceAttributes(incidentContext),
				});

				if (resolved) {
					span.setAttributes({
						"paperhanger.repo.owner": resolved.owner,
						"paperhanger.repo.name": resolved.repo,
						"paperhanger.repo.method": resolved.method,
						"paperhanger.repo.confidence": resolved.confidence,
					});
				} else {
					span.setAttribute("paperhanger.repo.resolved", false);
				}

				return resolved;
			},
		);
	}

	/**
	 * Wraps `agentRunner.run()` in the `incident.agent_run` child span. A
	 * `"failed"` outcome (a normal return value, not a thrown error) sets an
	 * ERROR status with the agent's own `failureReason` as the message --
	 * that text is produced by our own agent runner, not an upstream
	 * response, so it isn't subject to the redaction rule below.
	 * `"pr_created"` / `"report_only"` are both successful spans. If
	 * `agentRunner.run()` itself throws, `withStageSpan` gives it the same
	 * redacted-ERROR-then-rethrow treatment as `resolveRepo`.
	 */
	private async runAgent(
		incident: Incident,
		incidentContext: IncidentContext,
		repo: ResolvedRepo,
	): Promise<FixAgentRunResult> {
		return await this.withStageSpan(
			"incident.agent_run",
			"paperhanger.agent.error_name",
			"agent run failed",
			async (span) => {
				const result = await this.deps.agentRunner.run(
					incident,
					incidentContext,
					repo,
				);
				span.setAttribute("paperhanger.agent.outcome", result.status);
				if (result.status === "pr_created") {
					span.setAttribute("paperhanger.pr.url", result.prUrl);
				}
				if (result.status === "failed") {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: result.failureReason,
					});
				}
				return result;
			},
		);
	}

	/**
	 * Terminal `report_only` for a repository that could not be confidently
	 * resolved (spec section 3.5): either no candidate at all, or an
	 * org-search hit whose confidence the resolver itself flagged as "low".
	 * Never hands a guessed repo to the fix agent.
	 */
	private async finalizeUnresolved(
		incident: Incident,
		incidentContext: IncidentContext,
		resolved: ResolvedRepo | null,
	): Promise<void> {
		const { store, notifier, logger, github } = this.deps;

		let hint = "";
		if (resolved) {
			try {
				const repoInfo = await github.getRepo(resolved.owner, resolved.repo);
				hint = ` Low-confidence candidate: ${repoInfo.htmlUrl} (method: ${resolved.method}).`;
			} catch (err) {
				logger.warn("pipeline.repo_hint_lookup_failed", {
					incidentId: incident.id,
					owner: resolved.owner,
					repo: resolved.repo,
					error: err instanceof Error ? err.message : String(err),
				});
				hint = ` Low-confidence candidate: ${resolved.owner}/${resolved.repo} (method: ${resolved.method}).`;
			}
		}

		const preamble =
			`Repository could not be confidently resolved (method: ${resolved?.method ?? "none"}, ` +
			`confidence: ${resolved?.confidence ?? "none"}).${hint} Falling back to report_only ` +
			"per docs/spec.md section 3.5 (repositories are never guessed at low confidence).";
		const report = `${preamble}\n\n${this.renderContextMarkdownFn(incidentContext)}`;

		const updated = await store.updateIncident(incident.id, {
			status: "report_only",
			diagnosis: preamble,
		});
		await this.cleanupCheckpoint(incident.id);
		this.recordNotifyEvent("report_only");
		await notifier.notify({
			kind: "report_only",
			incident: incidentSnapshot(updated),
			report,
		});
	}

	/** Maps a `FixAgentRunner` outcome to a terminal incident status + notification. */
	private async finalizeAgentResult(
		incident: Incident,
		result: FixAgentRunResult,
	): Promise<void> {
		const { store, notifier } = this.deps;

		if (result.status === "pr_created") {
			const updated = await store.updateIncident(incident.id, {
				status: "pr_created",
				prUrl: result.prUrl,
				diagnosis: result.diagnosis,
			});
			await this.cleanupCheckpoint(incident.id);
			this.recordNotifyEvent("pr_created");
			await notifier.notify({
				kind: "pr_created",
				incident: incidentSnapshot(updated),
				prUrl: result.prUrl,
				summary: result.diagnosis,
			});
			return;
		}

		if (result.status === "report_only") {
			const updated = await store.updateIncident(incident.id, {
				status: "report_only",
				diagnosis: result.diagnosis,
			});
			await this.cleanupCheckpoint(incident.id);
			this.recordNotifyEvent("report_only");
			await notifier.notify({
				kind: "report_only",
				incident: incidentSnapshot(updated),
				report: result.report,
			});
			return;
		}

		const updated = await store.updateIncident(incident.id, {
			status: "failed",
			failureReason: result.failureReason,
			diagnosis: result.diagnosis,
		});
		await this.cleanupCheckpoint(incident.id);
		this.recordNotifyEvent("failed");
		await notifier.notify({
			kind: "failed",
			incident: incidentSnapshot(updated),
			reason: result.failureReason,
		});
	}

	/**
	 * Last-resort handler: any exception thrown anywhere above lands here so
	 * the incident always reaches a terminal state and a notification always
	 * fires, instead of leaving the incident stuck mid-pipeline and silently
	 * propagating an unhandled rejection up through `IncidentManager`. Also
	 * sets a generic ERROR status + error-name attribute on the active (root
	 * `incident.process`) span -- this is the guaranteed catch-all for the
	 * whole pipeline, so the caught error can be anything upstream, including
	 * a `GitHubApiError` whose message may embed alert-label-derived search
	 * queries or a raw GitHub response body. No `recordException` and no raw
	 * `err.message` ever reach the span here, mirroring the redaction rule in
	 * `buildContext` and `withStageSpan`. The structured logger call below
	 * still carries the full message to stdout logs.
	 */
	private async finalizeUnexpectedFailure(
		incident: Incident,
		err: unknown,
	): Promise<void> {
		const { store, notifier, logger } = this.deps;
		const message = err instanceof Error ? err.message : String(err);
		logger.error("pipeline.unexpected_error", {
			incidentId: incident.id,
			error: message,
		});

		const activeSpan = trace.getActiveSpan();
		activeSpan?.setStatus({
			code: SpanStatusCode.ERROR,
			message: "incident processing failed unexpectedly",
		});
		activeSpan?.setAttribute(
			"paperhanger.incident.error_name",
			err instanceof Error ? err.name : "UnknownError",
		);

		try {
			const updated = await store.updateIncident(incident.id, {
				status: "failed",
				failureReason: message,
			});
			await this.cleanupCheckpoint(incident.id);
			this.recordNotifyEvent("failed");
			await notifier.notify({
				kind: "failed",
				incident: incidentSnapshot(updated),
				reason: message,
			});
		} catch (persistErr) {
			logger.error("pipeline.failed_to_persist_failure", {
				incidentId: incident.id,
				error:
					persistErr instanceof Error ? persistErr.message : String(persistErr),
			});
		}
	}
}
