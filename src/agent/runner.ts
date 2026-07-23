/**
 * FixAgentRunner: invokes the `fix-incident` Flue workflow (agent-host) for a
 * single incident and turns its result into a PR, a report-only outcome, or a
 * failure. See docs/architecture.md "Flue agent host (Node sidecar)" and
 * docs/spec.md section 3.6.
 *
 * Division of responsibility (already decided in docs/architecture.md): the
 * agent host diagnoses, edits code, runs tests, and pushes a branch — it
 * never creates PRs. This runner never trusts the agent's own self-report of
 * what it changed; it re-derives the actual diff from the GitHub compare API
 * and only creates a PR once that diff clears the configured guardrails.
 *
 * This runner returns a structured result. It does not send notifications and
 * does not set a terminal incident status itself (the M7 pipeline owns
 * that) — but it does manage the intermediate "diagnosing"/"fixing"
 * transitions.
 */

import { createFlueClient as defaultCreateFlueClient } from "@flue/sdk";
import {
	context,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { Incident, IncidentEvent } from "../core/types";
import type { Logger } from "../observability/logger";
import type {
	CompareCommitsResult,
	CreatePullRequestInput,
	CreatePullRequestResult,
} from "../repo/github";
import type { ResolvedRepo } from "../repo/resolver";
import type { IncidentStore, RepoDefinitionStore } from "../storage/types";
import { renderContextMarkdown } from "../telemetry/context-builder";
import type { IncidentContext } from "../telemetry/types";
import {
	FIX_INCIDENT_WORKFLOW_NAME,
	type FixAgentWorkflowInput,
	type FixAgentWorkflowOutput,
	FixAgentWorkflowOutputSchema,
} from "./contract";
import { findForbiddenPaths } from "./forbidden-paths";

/** Structural subset of `GitHubAppClient` this runner depends on. */
export interface FixAgentGitHubClient {
	getRepoInstallation(owner: string, repo: string): Promise<{ id: number }>;
	createInstallationToken(
		installationId: number,
	): Promise<{ token: string; expiresAt: string }>;
	cloneUrlWithToken(owner: string, repo: string, token: string): string;
	getDefaultBranch(owner: string, repo: string): Promise<string>;
	compareCommits(
		owner: string,
		repo: string,
		base: string,
		head: string,
	): Promise<CompareCommitsResult>;
	deleteRef(owner: string, repo: string, ref: string): Promise<void>;
	createPullRequest(
		owner: string,
		repo: string,
		input: CreatePullRequestInput,
	): Promise<CreatePullRequestResult>;
	addLabels(
		owner: string,
		repo: string,
		issueNumber: number,
		labels: string[],
	): Promise<void>;
}

/** Structural subset of `@flue/sdk`'s `FlueClient` this runner depends on. */
export interface FixAgentFlueClient {
	workflows: {
		invoke(
			name: string,
			options: { input?: unknown; wait: "result"; signal?: AbortSignal },
		): Promise<{ runId: string; result: unknown }>;
	};
}

/** Either a ready-made client, or a base URL the runner builds one from lazily. */
export type FlueClientProvider = FixAgentFlueClient | { baseUrl: string };

/** Narrow config slice this runner needs; keeps it decoupled from the full `Config`. */
export interface FixAgentRunnerConfig {
	agent: {
		model: string;
		timeoutMinutes: number;
		forbiddenPaths: string[];
		maxDiffLines: number;
		maxFixAttempts: number;
		draftPr: boolean;
	};
	/**
	 * `source`-discriminated union mirroring `src/config/schema.ts`'s
	 * `TelemetryConfig` -- `greptimedb` is the only member today.
	 */
	telemetry?: {
		source: "greptimedb";
		url: string;
		database: string;
		auth?: string;
	};
}

export interface FixAgentRunnerDeps {
	flue: FlueClientProvider;
	github: FixAgentGitHubClient;
	store: IncidentStore;
	/** Used to look up a matching, enabled RepoDefinition for setupScript/testCommand overrides. */
	repoDefinitions: Pick<RepoDefinitionStore, "findRepoDefinitionByRepo">;
	config: FixAgentRunnerConfig;
	logger: Logger;
	/** Injectable for tests; defaults to `@flue/sdk`'s `createFlueClient`. Only used for the `{ baseUrl }` `FlueClientProvider` form. */
	createFlueClient?: typeof defaultCreateFlueClient;
	/** Tracer for the `agent.invoke_workflow` span. Defaults to a no-op tracer (tracing disabled) when omitted. */
	tracer?: Tracer;
}

export type FixAgentRunResult =
	| { status: "pr_created"; prUrl: string; diagnosis: string; report: string }
	| { status: "report_only"; diagnosis: string; report: string }
	| {
			status: "failed";
			failureReason: string;
			diagnosis?: string;
			report?: string;
	  };

const PR_LABELS = ["paperhanger", "automated-fix"];

function isFlueClient(
	provider: FlueClientProvider,
): provider is FixAgentFlueClient {
	return "workflows" in provider;
}

/**
 * Best-effort extraction of a workflow run id from a thrown error, for the
 * timeout log line. `@flue/sdk` 1.0.0-beta.9 does not expose a run id on an
 * aborted `workflows.invoke(...)` call (the id is only returned as part of
 * the success response), so this currently always resolves to `undefined`;
 * it stays defensive in case a future SDK version attaches one to the error.
 */
function extractRunId(err: unknown): string | undefined {
	if (err && typeof err === "object" && "runId" in err) {
		const runId = (err as { runId?: unknown }).runId;
		return typeof runId === "string" ? runId : undefined;
	}
	return undefined;
}

function buildPrBody(
	output: FixAgentWorkflowOutput,
	incident: Incident,
	alert: IncidentEvent,
	contextMarkdown: string,
): string {
	const lines: string[] = [];
	lines.push(output.report.trim());
	lines.push("");
	lines.push("## Telemetry evidence");
	lines.push(
		"<details>",
		"<summary>Collected logs, traces, and metrics (click to expand)</summary>",
		"",
	);
	lines.push(contextMarkdown);
	lines.push("", "</details>", "");
	lines.push("## Alert");
	lines.push(
		`- **${alert.title}** (severity: ${alert.severity}, source: ${alert.source})`,
	);
	if (alert.generatorUrl) {
		lines.push(`- [Alert link](${alert.generatorUrl})`);
	}
	lines.push("");
	lines.push(`_Incident ${incident.id}. Generated by paperhanger._`);
	return lines.join("\n");
}

export class FixAgentRunner {
	private readonly logger: Logger;
	private readonly createFlueClientFn: typeof defaultCreateFlueClient;
	private flueClient: FixAgentFlueClient | undefined;

	constructor(private readonly deps: FixAgentRunnerDeps) {
		this.logger = deps.logger.child({ component: "fix-agent-runner" });
		this.createFlueClientFn = deps.createFlueClient ?? defaultCreateFlueClient;
	}

	async run(
		incident: Incident,
		context: IncidentContext,
		repo: ResolvedRepo,
	): Promise<FixAgentRunResult> {
		const { store, config } = this.deps;
		const agentRun = await store.createAgentRun({
			incidentId: incident.id,
			startedAt: new Date().toISOString(),
			model: config.agent.model,
		});

		try {
			await store.updateIncident(incident.id, { status: "diagnosing" });

			const branchName = `paperhanger/incident-${incident.id}`;
			const contextMarkdown = renderContextMarkdown(context);
			const alert = context.alert;

			const installation = await this.deps.github.getRepoInstallation(
				repo.owner,
				repo.repo,
			);
			const installationToken = await this.deps.github.createInstallationToken(
				installation.id,
			);
			const cloneUrl = this.deps.github.cloneUrlWithToken(
				repo.owner,
				repo.repo,
				installationToken.token,
			);
			const defaultBranch = await this.deps.github.getDefaultBranch(
				repo.owner,
				repo.repo,
			);
			const repoOverrides = await this.resolveRepoOverrides(
				repo.owner,
				repo.repo,
				incident.id,
			);

			const workflowInput: FixAgentWorkflowInput = {
				incidentId: incident.id,
				contextMarkdown,
				alert: {
					title: alert.title,
					severity: alert.severity,
					source: alert.source,
					generatorUrl: alert.generatorUrl,
					labels: alert.labels,
					annotations: alert.annotations,
				},
				repo: {
					owner: repo.owner,
					repo: repo.repo,
					cloneUrl,
					defaultBranch,
					branchName,
					...repoOverrides,
				},
				limits: {
					timeoutMinutes: config.agent.timeoutMinutes,
					maxDiffLines: config.agent.maxDiffLines,
					maxFixAttempts: config.agent.maxFixAttempts,
				},
				forbiddenPaths: config.agent.forbiddenPaths,
				telemetry: config.telemetry,
			};

			const invocation = await this.invokeWorkflow(
				workflowInput,
				config.agent.timeoutMinutes,
				incident.id,
			);
			if (!invocation.ok) {
				return await this.finalize(agentRun.id, {
					status: "failed",
					failureReason: invocation.failureReason,
				});
			}

			const parsed = FixAgentWorkflowOutputSchema.safeParse(invocation.result);
			if (!parsed.success) {
				this.logger.error("fix_agent.malformed_result", {
					incidentId: incident.id,
					issues: parsed.error.issues,
				});
				return await this.finalize(agentRun.id, {
					status: "failed",
					failureReason: `Malformed fix-agent workflow result: ${parsed.error.message}`,
				});
			}
			const output = parsed.data;

			if (output.outcome === "report_only") {
				return await this.finalize(agentRun.id, {
					status: "report_only",
					diagnosis: output.diagnosis,
					report: output.report,
				});
			}

			if (output.outcome === "failed") {
				return await this.finalize(agentRun.id, {
					status: "failed",
					failureReason:
						output.failureReason ?? "Agent reported failure without a reason.",
					diagnosis: output.diagnosis,
					report: output.report,
				});
			}

			// outcome === "fixed" from here on.
			await store.updateIncident(incident.id, { status: "fixing" });
			return await this.finalizeFixed({
				agentRunId: agentRun.id,
				incident,
				alert,
				repo,
				branchName,
				defaultBranch,
				contextMarkdown,
				output,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error("fix_agent.run_failed", {
				incidentId: incident.id,
				error: message,
			});
			return await this.finalize(agentRun.id, {
				status: "failed",
				failureReason: message,
			});
		}
	}

	/**
	 * Looks up a `RepoDefinition` matching the resolved owner/repo and, when
	 * one exists and is enabled, returns its setupScript/testCommand to merge
	 * into `workflowInput.repo`. A lookup failure (store error) is logged and
	 * treated the same as "no definition found" -- a broken lookup must not
	 * block a fix run.
	 */
	private async resolveRepoOverrides(
		owner: string,
		repo: string,
		incidentId: string,
	): Promise<
		Pick<FixAgentWorkflowInput["repo"], "setupScript" | "testCommand">
	> {
		try {
			const definition =
				await this.deps.repoDefinitions.findRepoDefinitionByRepo(owner, repo);
			if (!definition || !definition.enabled) {
				return {};
			}
			return {
				setupScript: definition.setupScript,
				testCommand: definition.testCommand,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.warn("fix_agent.repo_definition_lookup_failed", {
				incidentId,
				owner,
				repo,
				error: message,
			});
			return {};
		}
	}

	private getFlueClient(): FixAgentFlueClient {
		if (!this.flueClient) {
			const provider = this.deps.flue;
			this.flueClient = isFlueClient(provider)
				? provider
				: this.createFlueClientFn({ baseUrl: provider.baseUrl });
		}
		return this.flueClient;
	}

	/**
	 * Waits (up to `timeoutMinutes`) for the fix-incident workflow to finish.
	 *
	 * IMPORTANT limitation, verified against the installed `@flue/sdk`
	 * `1.0.0-beta.9` types and docs/research/flue.md section 5 ("Recovery
	 * semantics"): this timeout only aborts *this process's* HTTP wait on
	 * `workflows.invoke(..., { wait: "result" })`. The SDK exposes
	 * `client.agents.abort(name, id)` to cancel a direct agent instance's
	 * in-flight work, but nothing analogous for a workflow *run* -- the
	 * `runs` client surface is read-only (`get`/`stream`/`events`), and the
	 * research doc notes an interrupted run's record simply "stays active
	 * forever". So when this times out, the agent-host may still be
	 * diagnosing/fixing in the background and could push a branch or
	 * otherwise mutate the repository after this method has already returned
	 * a failure. Do not report this as a clean, contained failure.
	 */
	private async invokeWorkflow(
		input: FixAgentWorkflowInput,
		timeoutMinutes: number,
		incidentId: string,
	): Promise<
		{ ok: true; result: unknown } | { ok: false; failureReason: string }
	> {
		const tracer = this.deps.tracer ?? trace.getTracer("fix-agent-runner");
		const span = tracer.startSpan("agent.invoke_workflow", {
			kind: SpanKind.CLIENT,
		});
		span.setAttribute("paperhanger.incident.id", incidentId);
		span.setAttribute("paperhanger.agent.timeout_minutes", timeoutMinutes);

		try {
			// Active so that logger calls inside this scope (e.g.
			// fix_agent.workflow_wait_timed_out) correlate to this span.
			return await context.with(
				trace.setSpan(context.active(), span),
				async () => {
					let invocation:
						| { ok: true; result: unknown }
						| { ok: false; failureReason: string };
					try {
						// getFlueClient() lives inside this try too: a malformed
						// `agent.hostUrl` (e.g. "127.0.0.1:8700") makes @flue/sdk's
						// createFlueClient throw synchronously from `new URL(...)`,
						// and that must be converted into the same resolved
						// `{ ok: false, failureReason }` shape as every other
						// failure path -- otherwise it would escape this method
						// entirely, breaking invokeWorkflow's never-throw contract
						// and leaving the span below UNSET instead of ERROR.
						const client = this.getFlueClient();
						const controller = new AbortController();
						let timedOut = false;
						const timer = setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeoutMinutes * 60_000);

						try {
							const { result } = await client.workflows.invoke(
								FIX_INCIDENT_WORKFLOW_NAME,
								{ input, wait: "result", signal: controller.signal },
							);
							invocation = { ok: true, result };
						} catch (err) {
							if (timedOut || controller.signal.aborted) {
								const runId = extractRunId(err);
								this.logger.warn("fix_agent.workflow_wait_timed_out", {
									incidentId,
									timeoutMinutes,
									runId,
								});
								invocation = {
									ok: false,
									failureReason:
										`Timed out after waiting ${timeoutMinutes}m for the fix-incident workflow to finish. ` +
										"paperhanger has stopped waiting, but the agent-host may still be executing the " +
										"workflow in the background and could push a branch or otherwise modify the " +
										"repository later; @flue/sdk currently exposes no workflow-level cancellation API " +
										"(see docs/research/flue.md section 5).",
								};
							} else {
								const message =
									err instanceof Error ? err.message : String(err);
								invocation = {
									ok: false,
									failureReason: `Failed to invoke the fix-incident workflow: ${message}`,
								};
							}
						} finally {
							clearTimeout(timer);
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						invocation = {
							ok: false,
							failureReason: `Failed to invoke the fix-incident workflow: ${message}`,
						};
					}

					// Span status is set from the RESOLVED value, not from a catch: this
					// method's contract is to never reject (a wait-timeout, an SDK-level
					// failure, and a throwing client factory are all captured above as
					// `{ ok: false, failureReason }`), so a try/catch around this whole
					// method would never observe an error. Note also that the span only
					// exports once `.end()` runs below, after `invokeWorkflow` has already
					// resolved -- a long-running workflow gives no partial visibility
					// while it's in flight; this is an accepted limitation of a
					// request/response CLIENT span here.
					if (!invocation.ok) {
						span.setAttribute("paperhanger.agent.ok", false);
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: invocation.failureReason,
						});
					}
					return invocation;
				},
			);
		} finally {
			span.end();
		}
	}

	private async finalizeFixed(args: {
		agentRunId: string;
		incident: Incident;
		alert: IncidentEvent;
		repo: ResolvedRepo;
		branchName: string;
		defaultBranch: string;
		contextMarkdown: string;
		output: FixAgentWorkflowOutput;
	}): Promise<FixAgentRunResult> {
		const {
			agentRunId,
			incident,
			alert,
			repo,
			branchName,
			defaultBranch,
			output,
		} = args;
		const { github, config } = this.deps;

		if (!output.fix) {
			// Guarded by FixAgentWorkflowOutputSchema's superRefine already; kept
			// as defense in depth against a future schema relaxation.
			return await this.finalize(agentRunId, {
				status: "failed",
				failureReason: 'Agent reported outcome "fixed" without a fix block.',
				diagnosis: output.diagnosis,
				report: output.report,
			});
		}

		const compare = await github.compareCommits(
			repo.owner,
			repo.repo,
			defaultBranch,
			branchName,
		);
		const forbidden = findForbiddenPaths(
			compare.files.map((file) => file.filename),
			config.agent.forbiddenPaths,
		);
		const totalChangedLines = compare.totalAdditions + compare.totalDeletions;
		const oversized = totalChangedLines > config.agent.maxDiffLines;

		if (forbidden.length > 0 || oversized) {
			const guardrailFailureReason =
				forbidden.length > 0
					? `Guardrail violation: fix touched forbidden path(s): ${forbidden.join(", ")}`
					: `Guardrail violation: diff changed ${totalChangedLines} lines, exceeding the ${config.agent.maxDiffLines}-line limit`;
			this.logger.warn("fix_agent.guardrail_violation", {
				incidentId: incident.id,
				branchName,
				forbidden,
				totalChangedLines,
			});

			// The guardrail violation is the actionable failure the operator
			// needs to see; a failure to clean up the now-rejected branch is a
			// secondary, best-effort concern. If `deleteRef` throws, keep the
			// guardrail violation as the primary `failureReason` (rather than
			// letting it be replaced by the raw GitHub error) and append a note
			// so the operator knows a policy-violating branch may still be
			// sitting in the repo and which one it is.
			let failureReason = guardrailFailureReason;
			try {
				await github.deleteRef(repo.owner, repo.repo, `heads/${branchName}`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.logger.error("fix_agent.guardrail_branch_cleanup_failed", {
					incidentId: incident.id,
					branchName,
					error: message,
				});
				failureReason =
					`${guardrailFailureReason} Additionally, cleanup of the rejected branch failed ` +
					`(branch "${branchName}" may still exist in the repo): ${message}`;
			}

			return await this.finalize(agentRunId, {
				status: "failed",
				failureReason,
				diagnosis: output.diagnosis,
				report: output.report,
			});
		}

		const pr = await github.createPullRequest(repo.owner, repo.repo, {
			title: `fix: ${alert.title} (incident ${incident.id})`,
			head: branchName,
			base: defaultBranch,
			draft: config.agent.draftPr,
			body: buildPrBody(output, incident, alert, args.contextMarkdown),
		});

		try {
			await github.addLabels(repo.owner, repo.repo, pr.number, PR_LABELS);
		} catch (err) {
			this.logger.warn("fix_agent.add_labels_failed", {
				incidentId: incident.id,
				prNumber: pr.number,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		return await this.finalize(agentRunId, {
			status: "pr_created",
			prUrl: pr.url,
			diagnosis: output.diagnosis,
			report: output.report,
		});
	}

	/**
	 * Persists the terminal `AgentRun` row and returns `result` unchanged.
	 * `costUsd` is left unset: the SDK does not currently expose aggregated
	 * workflow-level token/cost usage (docs/research/flue.md section 7b only
	 * documents per-prompt `PromptUsage`), so there is nothing honest to record.
	 */
	private async finalize(
		agentRunId: string,
		result: FixAgentRunResult,
	): Promise<FixAgentRunResult> {
		await this.deps.store.updateAgentRun(agentRunId, {
			finishedAt: new Date().toISOString(),
			outcome: result.status,
		});
		return result;
	}
}
