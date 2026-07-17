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
 *      context (with an explanatory note) rather than aborting the run.
 *   3. Persist the `resolving_repo` transition, then resolve the target
 *      repository (attribute -> mapping -> org-search, per spec 3.5),
 *      deriving resource-attribute hints from whatever telemetry was
 *      collected. A `null` result or a "low" confidence result is a terminal
 *      `report_only` (never guess at a fix target).
 *   4. Otherwise, hand off to `FixAgentRunner.run()`, which manages its own
 *      `diagnosing`/`fixing` transitions, and map its outcome to a terminal
 *      incident status.
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
 */

import {
	buildIncidentContext as defaultBuildIncidentContext,
	computeWindow,
	renderContextMarkdown as defaultRenderContextMarkdown,
	type ContextBuilderConfig,
} from "../telemetry/context-builder";
import type { IncidentContext, TelemetrySource } from "../telemetry/types";
import { incidentSnapshot } from "../notify/types";
import type { Notifier } from "../notify/types";
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
	context: IncidentContext,
): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	for (const log of context.telemetry.logs) {
		for (const [key, value] of Object.entries(log.resourceAttributes)) {
			if (merged[key] === undefined && value !== null && value !== undefined) {
				merged[key] = String(value);
			}
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export class IncidentPipeline implements IncidentProcessor {
	private readonly logger: Logger;
	private readonly buildIncidentContextFn: typeof defaultBuildIncidentContext;
	private readonly renderContextMarkdownFn: typeof defaultRenderContextMarkdown;

	constructor(private readonly deps: IncidentPipelineDeps) {
		this.logger = deps.logger.child({ component: "incident-pipeline" });
		this.buildIncidentContextFn =
			deps.buildIncidentContext ?? defaultBuildIncidentContext;
		this.renderContextMarkdownFn =
			deps.renderContextMarkdown ?? defaultRenderContextMarkdown;
	}

	async process(incident: Incident): Promise<void> {
		try {
			await this.deps.notifier.notify({
				kind: "diagnosis_started",
				incident: incidentSnapshot(incident),
			});

			const collecting = await this.deps.store.updateIncident(incident.id, {
				status: "collecting",
			});
			const alert = await this.resolveAlertEvent(collecting);
			const context = await this.buildContext(collecting, alert);

			const resolvingRepo = await this.deps.store.updateIncident(
				collecting.id,
				{ status: "resolving_repo" },
			);

			const resolved = await this.deps.resolver.resolve({
				labels: alert.labels,
				annotations: alert.annotations,
				resourceAttributes: deriveResourceAttributes(context),
			});

			if (!resolved || resolved.confidence === "low") {
				await this.finalizeUnresolved(resolvingRepo, context, resolved);
				return;
			}

			const result = await this.deps.agentRunner.run(
				resolvingRepo,
				context,
				resolved,
			);
			await this.finalizeAgentResult(resolvingRepo, result);
		} catch (err) {
			await this.finalizeUnexpectedFailure(incident, err);
		}
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
			const note = `Telemetry collection failed (${message}); proceeding with an empty-telemetry context.`;
			return buildDegradedContext(incident, alert, config, note);
		}
	}

	/**
	 * Terminal `report_only` for a repository that could not be confidently
	 * resolved (spec section 3.5): either no candidate at all, or an
	 * org-search hit whose confidence the resolver itself flagged as "low".
	 * Never hands a guessed repo to the fix agent.
	 */
	private async finalizeUnresolved(
		incident: Incident,
		context: IncidentContext,
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
		const report = `${preamble}\n\n${this.renderContextMarkdownFn(context)}`;

		const updated = await store.updateIncident(incident.id, {
			status: "report_only",
			diagnosis: preamble,
		});
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
	 * propagating an unhandled rejection up through `IncidentManager`.
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

		try {
			const updated = await store.updateIncident(incident.id, {
				status: "failed",
				failureReason: message,
			});
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
