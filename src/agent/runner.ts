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
import type {
	CommonSetupScriptStore,
	CommonSystemPromptStore,
	IncidentStore,
	RepoDefinitionStore,
} from "../storage/types";
import { renderContextMarkdown } from "../telemetry/context-builder";
import type { IncidentContext } from "../telemetry/types";
import {
	FIX_INCIDENT_AGENT_ROUTE,
	FIX_INCIDENT_RESULT_DATA_NAME,
	type FixAgentInput,
	type FixAgentOutput,
	FixAgentOutputSchema,
} from "./contract";
import { findForbiddenPaths } from "./forbidden-paths";

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

export interface FixAgentAdmission {
	streamUrl: string;
	offset: string;
	submissionId: string;
	uid: string;
	deduplicated?: boolean;
}

export interface FixAgentFlueClient {
	send(options: {
		message: { kind: "signal"; type: string; body: string };
		initialData: unknown;
		uid: null;
		signal?: AbortSignal;
	}): Promise<FixAgentAdmission>;
	read(
		admission: FixAgentAdmission,
		options?: { signal?: AbortSignal },
	): Promise<{
		submissionId: string;
		data: Record<string, unknown[]>;
	}>;
	abort(options?: { signal?: AbortSignal }): Promise<{ aborted: boolean }>;
}

export interface FlueClientProvider {
	baseUrl: string;
}
export type FixAgentFlueClientFactory = (options: {
	url: string;
}) => FixAgentFlueClient;

export interface FixAgentRunnerConfig {
	agent: {
		model: string;
		timeoutMinutes: number;
		forbiddenPaths: string[];
		maxDiffLines: number;
		maxFixAttempts: number;
		draftPr: boolean;
		/**
		 * Config-file fallback for the common system prompt
		 * (`agent.systemPrompt` in paperhanger.yaml). The dashboard-managed
		 * common prompt takes precedence when set; see
		 * `resolveCommonSystemPrompt`.
		 */
		systemPrompt?: string;
	};
	/**
	 * Optional `repos` slice of the app config; only `systemPrompts` is read.
	 * Config-file per-repository operator instructions keyed by "owner/repo".
	 * An enabled RepoDefinition's own `systemPrompt` takes precedence over the
	 * matching entry here; see `resolveRepoSystemPrompt`.
	 */
	repos?: {
		systemPrompts?: Record<string, string>;
	};
}

export interface FixAgentRunnerDeps {
	flue: FlueClientProvider;
	github: FixAgentGitHubClient;
	store: IncidentStore;
	repoDefinitions: Pick<RepoDefinitionStore, "findRepoDefinitionByRepo">;
	commonSetupScripts?: Pick<CommonSetupScriptStore, "listCommonSetupScripts">;
	/** Supplies the dashboard-managed operator instruction text shared by every repository. */
	commonSystemPrompt?: Pick<CommonSystemPromptStore, "getCommonSystemPrompt">;
	config: FixAgentRunnerConfig;
	logger: Logger;
	createFlueClient?: FixAgentFlueClientFactory;
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

/**
 * Per-repo fields sourced from the resolved repo's enabled RepoDefinition
 * (see `FixAgentRunner.resolveRepoOverrides`): setup/test overrides plus the
 * per-repository system prompt, already trimmed to `undefined` when blank.
 */
type RepoOverrides = Pick<
	FixAgentInput["repo"],
	"setupScript" | "testCommand"
> & {
	systemPrompt?: string;
};

function conversationUrl(baseUrl: string, agentRunId: string): string {
	const url = new URL(baseUrl);
	url.search = "";
	url.hash = "";
	const prefix = url.pathname.replace(/\/+$/, "");
	url.pathname = `${prefix}${FIX_INCIDENT_AGENT_ROUTE}/${encodeURIComponent(agentRunId)}`;
	return url.toString();
}

function buildPrBody(
	output: FixAgentOutput,
	incident: Incident,
	alert: IncidentEvent,
	contextMarkdown: string,
): string {
	const lines = [
		output.report.trim(),
		"",
		"## Telemetry evidence",
		"<details>",
		"<summary>Collected logs, traces, and metrics (click to expand)</summary>",
		"",
		contextMarkdown,
		"",
		"</details>",
		"",
		"## Alert",
		`- **${alert.title}** (severity: ${alert.severity}, source: ${alert.source})`,
	];
	if (alert.generatorUrl) lines.push(`- [Alert link](${alert.generatorUrl})`);
	lines.push("", `_Incident ${incident.id}. Generated by paperhanger._`);
	return lines.join("\n");
}

export class FixAgentRunner {
	private readonly logger: Logger;
	private readonly createFlueClientFn: FixAgentFlueClientFactory;

	constructor(private readonly deps: FixAgentRunnerDeps) {
		this.logger = deps.logger.child({ component: "fix-agent-runner" });
		this.createFlueClientFn =
			deps.createFlueClient ??
			((options) =>
				defaultCreateFlueClient(options) as unknown as FixAgentFlueClient);
	}

	async run(
		incident: Incident,
		incidentContext: IncidentContext,
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
			const contextMarkdown = renderContextMarkdown(incidentContext);
			const alert = incidentContext.alert;
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
			const setupScripts = await this.resolveCommonSetupScripts(incident.id);
			const systemPrompt = await this.resolveCommonSystemPrompt(incident.id);
			const repoSystemPrompt = this.resolveRepoSystemPrompt(
				repo.owner,
				repo.repo,
				repoOverrides,
			);

			const input: FixAgentInput = {
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
					setupScripts,
					setupScript: repoOverrides.setupScript,
					testCommand: repoOverrides.testCommand,
				},
				limits: {
					timeoutMinutes: config.agent.timeoutMinutes,
					maxDiffLines: config.agent.maxDiffLines,
					maxFixAttempts: config.agent.maxFixAttempts,
				},
				forbiddenPaths: config.agent.forbiddenPaths,
				systemPrompt,
				repoSystemPrompt,
			};
			const invocation = await this.invokeAgent(
				input,
				config.agent.timeoutMinutes,
				incident.id,
				agentRun.id,
			);
			if (!invocation.ok)
				return await this.finalize(agentRun.id, {
					status: "failed",
					failureReason: invocation.failureReason,
				});
			const parsed = FixAgentOutputSchema.safeParse(invocation.result);
			if (!parsed.success) {
				this.logger.error("fix_agent.malformed_result", {
					incidentId: incident.id,
					issues: parsed.error.issues,
				});
				return await this.finalize(agentRun.id, {
					status: "failed",
					failureReason: `Malformed fix-agent result: ${parsed.error.message}`,
				});
			}
			const output = parsed.data;
			if (output.outcome === "report_only")
				return await this.finalize(agentRun.id, {
					status: "report_only",
					diagnosis: output.diagnosis,
					report: output.report,
				});
			if (output.outcome === "failed")
				return await this.finalize(agentRun.id, {
					status: "failed",
					failureReason:
						output.failureReason ?? "Agent reported failure without a reason.",
					diagnosis: output.diagnosis,
					report: output.report,
				});
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

	private async resolveCommonSetupScripts(
		incidentId: string,
	): Promise<FixAgentInput["repo"]["setupScripts"]> {
		try {
			const scripts =
				(await this.deps.commonSetupScripts?.listCommonSetupScripts()) ?? [];
			return scripts.map(({ triggerFile, script }) => ({
				triggerFile,
				script,
			}));
		} catch (err) {
			this.logger.warn("fix_agent.common_setup_scripts_lookup_failed", {
				incidentId,
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/**
	 * Looks up the dashboard-managed operator instruction text shared by every
	 * repository, falling back to the config-file `agent.systemPrompt` when the
	 * dashboard has none saved. A blank/whitespace-only value (stored or
	 * configured), an unconfigured dependency, or a lookup failure all move on
	 * to the next fallback -- mirroring `resolveCommonSetupScripts`'s fail-soft
	 * precedent, since a broken lookup must not block a fix run.
	 */
	private async resolveCommonSystemPrompt(
		incidentId: string,
	): Promise<string | undefined> {
		try {
			const stored =
				await this.deps.commonSystemPrompt?.getCommonSystemPrompt();
			const prompt = stored?.prompt.trim();
			if (prompt) return prompt;
		} catch (err) {
			this.logger.warn("fix_agent.common_system_prompt_lookup_failed", {
				incidentId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		const configured = this.deps.config.agent.systemPrompt?.trim();
		return configured ? configured : undefined;
	}

	/**
	 * Resolves the per-repository operator instructions for the resolved repo.
	 * An enabled RepoDefinition's non-blank `systemPrompt` (already looked up
	 * by `resolveRepoOverrides`, fail-soft) wins; a definition without one --
	 * or a failed lookup, which lands here as `{}` -- falls through to the
	 * config-file `repos.systemPrompts` entry for "owner/repo" (matched
	 * case-insensitively, like `findRepoDefinitionByRepo`). Blank values are
	 * treated as unset at both levels, so an unset per-repo prompt inherits
	 * the common one downstream (agent-host renders one section or the other).
	 */
	private resolveRepoSystemPrompt(
		owner: string,
		repo: string,
		repoOverrides: RepoOverrides,
	): string | undefined {
		if (repoOverrides.systemPrompt) return repoOverrides.systemPrompt;
		const configured = this.deps.config.repos?.systemPrompts;
		if (!configured) return undefined;
		const wanted = `${owner}/${repo}`.toLowerCase();
		for (const [key, value] of Object.entries(configured)) {
			if (key.toLowerCase() !== wanted) continue;
			const prompt = value.trim();
			if (prompt) return prompt;
		}
		return undefined;
	}

	private async resolveRepoOverrides(
		owner: string,
		repo: string,
		incidentId: string,
	): Promise<RepoOverrides> {
		try {
			const definition =
				await this.deps.repoDefinitions.findRepoDefinitionByRepo(owner, repo);
			if (!definition || !definition.enabled) return {};
			const systemPrompt = definition.systemPrompt?.trim();
			return {
				setupScript: definition.setupScript,
				testCommand: definition.testCommand,
				systemPrompt: systemPrompt ? systemPrompt : undefined,
			};
		} catch (err) {
			this.logger.warn("fix_agent.repo_definition_lookup_failed", {
				incidentId,
				owner,
				repo,
				error: err instanceof Error ? err.message : String(err),
			});
			return {};
		}
	}

	private async invokeAgent(
		input: FixAgentInput,
		timeoutMinutes: number,
		incidentId: string,
		agentRunId: string,
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
			return await context.with(
				trace.setSpan(context.active(), span),
				async () => {
					let invocation:
						| { ok: true; result: unknown }
						| { ok: false; failureReason: string };
					try {
						const client = this.createFlueClientFn({
							url: conversationUrl(this.deps.flue.baseUrl, agentRunId),
						});
						const operationController = new AbortController();
						let timedOut = false;
						const timer = setTimeout(() => {
							timedOut = true;
							operationController.abort();
						}, timeoutMinutes * 60_000);
						let admission: FixAgentAdmission | undefined;
						try {
							admission = await client.send({
								message: {
									kind: "signal",
									type: "paperhanger.fix-incident",
									body: `Run paperhanger fix incident ${incidentId}.`,
								},
								initialData: input,
								uid: null,
								signal: operationController.signal,
							});
							const reply = await client.read(admission, {
								signal: operationController.signal,
							});
							if (timedOut) throw new Error("operation timed out");
							const values = reply.data[FIX_INCIDENT_RESULT_DATA_NAME];
							invocation = {
								ok: true,
								result:
									Array.isArray(values) && values.length === 1
										? values[0]
										: undefined,
							};
						} catch (err) {
							if (timedOut) {
								let abortNote = admission
									? "abort requested"
									: "admission request aborted";
								if (admission) {
									const abortController = new AbortController();
									const abortTimer = setTimeout(
										() => abortController.abort(),
										10_000,
									);
									try {
										await client.abort({ signal: abortController.signal });
									} catch (abortError) {
										const message =
											abortError instanceof Error
												? abortError.message
												: String(abortError);
										abortNote = `abort request failed (${message}); execution may continue`;
									} finally {
										clearTimeout(abortTimer);
									}
								}
								this.logger.warn("fix_agent.workflow_wait_timed_out", {
									incidentId,
									timeoutMinutes,
									submissionId: admission?.submissionId,
								});
								invocation = {
									ok: false,
									failureReason: `Timed out after waiting ${timeoutMinutes}m for the fix-incident agent to finish; ${abortNote}.`,
								};
							} else {
								const message =
									err instanceof Error ? err.message : String(err);
								invocation = {
									ok: false,
									failureReason: `Failed to invoke the fix-incident agent: ${message}`,
								};
							}
						} finally {
							clearTimeout(timer);
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						invocation = {
							ok: false,
							failureReason: `Failed to invoke the fix-incident agent: ${message}`,
						};
					}
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
		output: FixAgentOutput;
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
		if (forbidden.length > 0 || totalChangedLines > config.agent.maxDiffLines) {
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
				failureReason = `${guardrailFailureReason} Additionally, cleanup of the rejected branch failed (branch "${branchName}" may still exist in the repo): ${message}`;
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
