/**
 * Valibot schemas for the `fix-incident` agent's input/output contract.
 *
 * This is the canonical definition. The Bun-side process cannot import this
 * file directly (agent-host is a separate, Node-only package), so
 * `src/agent/contract.ts` in the parent repo hand-maintains a structural Zod
 * mirror of this same shape. Keep both in sync when this contract changes.
 */

import * as v from "valibot";

export const AlertSchema = v.object({
	title: v.string(),
	severity: v.string(),
	source: v.string(),
	generatorUrl: v.optional(v.string()),
	labels: v.record(v.string(), v.string()),
	annotations: v.record(v.string(), v.string()),
});

export const RepoInputSchema = v.object({
	owner: v.string(),
	repo: v.string(),
	/** HTTPS clone URL with an embedded installation token. Treat as a secret. */
	cloneUrl: v.string(),
	defaultBranch: v.string(),
	branchName: v.string(),
	/** Shell script executed in the cloned repo before diagnosis (from a matching, enabled RepoDefinition). */
	setupScript: v.optional(v.string()),
	setupScripts: v.optional(
		v.array(
			v.object({
				triggerFile: v.string(),
				script: v.string(),
			}),
		),
		[],
	),
	/** Overrides agent-host test auto-detection (from a matching, enabled RepoDefinition). */
	testCommand: v.optional(v.string()),
});

export const LimitsSchema = v.object({
	timeoutMinutes: v.number(),
	maxDiffLines: v.number(),
	/** Max fix attempts (initial + test-failure retries) before this workflow gives up. */
	maxFixAttempts: v.number(),
});

export const FixIncidentInputSchema = v.object({
	incidentId: v.string(),
	contextMarkdown: v.string(),
	alert: AlertSchema,
	repo: RepoInputSchema,
	limits: LimitsSchema,
	forbiddenPaths: v.array(v.string()),
	/** Dashboard-managed operator instructions shared by every repository. */
	systemPrompt: v.optional(v.string()),
	/**
	 * Per-repository operator instructions (from the resolved repo's enabled
	 * RepoDefinition, or its `repos.systemPrompts` config entry). Takes
	 * precedence over `systemPrompt` when set: this section is rendered
	 * instead of the common one.
	 */
	repoSystemPrompt: v.optional(v.string()),
});

export const FixSchema = v.object({
	branch: v.string(),
	commitMessage: v.string(),
	changedFiles: v.array(v.string()),
	testCommand: v.optional(v.string()),
	testsPassed: v.boolean(),
});

export const FixIncidentOutputSchema = v.object({
	outcome: v.picklist(["fixed", "report_only", "failed"]),
	diagnosis: v.string(),
	report: v.string(),
	fix: v.optional(FixSchema),
	failureReason: v.optional(v.string()),
});

export type Alert = v.InferOutput<typeof AlertSchema>;
export type RepoInput = v.InferOutput<typeof RepoInputSchema>;
export type Limits = v.InferOutput<typeof LimitsSchema>;
export type FixIncidentInput = v.InferOutput<typeof FixIncidentInputSchema>;
export type Fix = v.InferOutput<typeof FixSchema>;
export type FixIncidentOutput = v.InferOutput<typeof FixIncidentOutputSchema>;

export const FIX_INCIDENT_RESULT_DATA_NAME = "result";
