/**
 * Valibot schemas for the `fix-incident` workflow's input/output contract.
 *
 * This is the canonical definition. The Bun-side process cannot import this
 * file directly (agent-host is a separate, Node-only package — see
 * docs/architecture.md "Flue agent host (Node sidecar)" in the parent repo),
 * so `src/agent/contract.ts` in the parent repo hand-maintains a structural
 * Zod mirror of this same shape. Keep both in sync when this contract changes.
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
});

export const LimitsSchema = v.object({
	timeoutMinutes: v.number(),
	maxDiffLines: v.number(),
	/** Max fix attempts (initial + test-failure retries) before this workflow gives up. */
	maxFixAttempts: v.number(),
});

/**
 * `telemetry` is a discriminated union on `source`, mirroring the parent
 * repo's `src/config/schema.ts` `TelemetrySchema` -- `greptimedb` is the
 * only member today. Keep this and the parent repo's
 * `src/agent/contract.ts` `FixAgentTelemetryConfigSchema` in sync when a new
 * source is added.
 */
export const GreptimeDbTelemetryConfigSchema = v.object({
	source: v.literal("greptimedb"),
	url: v.string(),
	database: v.string(),
	auth: v.optional(v.string()),
});

export const TelemetryConfigSchema = v.variant("source", [
	GreptimeDbTelemetryConfigSchema,
]);

export const WorkflowInputSchema = v.object({
	incidentId: v.string(),
	contextMarkdown: v.string(),
	alert: AlertSchema,
	repo: RepoInputSchema,
	limits: LimitsSchema,
	forbiddenPaths: v.array(v.string()),
	telemetry: v.optional(TelemetryConfigSchema),
});

export const FixSchema = v.object({
	branch: v.string(),
	commitMessage: v.string(),
	changedFiles: v.array(v.string()),
	testCommand: v.optional(v.string()),
	testsPassed: v.boolean(),
});

export const WorkflowOutputSchema = v.object({
	outcome: v.picklist(["fixed", "report_only", "failed"]),
	diagnosis: v.string(),
	report: v.string(),
	fix: v.optional(FixSchema),
	failureReason: v.optional(v.string()),
});

export type Alert = v.InferOutput<typeof AlertSchema>;
export type RepoInput = v.InferOutput<typeof RepoInputSchema>;
export type Limits = v.InferOutput<typeof LimitsSchema>;
export type TelemetryConfig = v.InferOutput<typeof TelemetryConfigSchema>;
export type WorkflowInput = v.InferOutput<typeof WorkflowInputSchema>;
export type Fix = v.InferOutput<typeof FixSchema>;
export type WorkflowOutput = v.InferOutput<typeof WorkflowOutputSchema>;
