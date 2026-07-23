/**
 * Zod mirror of the `fix-incident` Flue workflow's input/output contract.
 *
 * The canonical definition lives in `agent-host/src/contract.ts` as Valibot
 * schemas (agent-host is a separate Node-only package per
 * docs/architecture.md's "Flue agent host (Node sidecar)" section, so it
 * cannot be imported directly from the main Bun process). This file is a
 * hand-maintained structural mirror used by `src/agent/runner.ts` to validate
 * the raw JSON result returned by `client.workflows.invoke(...)` before
 * trusting it. Keep the two schemas in sync when the contract changes.
 */

import { z } from "zod";

export const FixAgentAlertSchema = z.object({
	title: z.string(),
	severity: z.string(),
	source: z.string(),
	generatorUrl: z.string().optional(),
	labels: z.record(z.string(), z.string()),
	annotations: z.record(z.string(), z.string()),
});

export const FixAgentRepoInputSchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
	/** HTTPS clone URL with an embedded installation token. Treat as a secret. */
	cloneUrl: z.string().min(1),
	defaultBranch: z.string().min(1),
	branchName: z.string().min(1),
	/** Shell script executed in the cloned repo before diagnosis (from a matching, enabled RepoDefinition). */
	setupScript: z.string().optional(),
	/** Overrides agent-host test auto-detection (from a matching, enabled RepoDefinition). */
	testCommand: z.string().optional(),
});

export const FixAgentLimitsSchema = z.object({
	timeoutMinutes: z.number().positive(),
	maxDiffLines: z.number().positive(),
	/** Max fix attempts (initial + test-failure retries) before the agent-host workflow gives up. */
	maxFixAttempts: z.number().positive(),
});

/**
 * `telemetry` is a discriminated union on `source`, mirroring
 * `src/config/schema.ts`'s `TelemetrySchema` -- `greptimedb` is the only
 * member today. Keep this and `agent-host/src/contract.ts`'s
 * `TelemetryConfigSchema` in sync when a new source is added.
 */
export const FixAgentGreptimeDbTelemetryConfigSchema = z.object({
	source: z.literal("greptimedb"),
	url: z.string().min(1),
	database: z.string().min(1),
	auth: z.string().optional(),
});

export const FixAgentTelemetryConfigSchema = z.discriminatedUnion("source", [
	FixAgentGreptimeDbTelemetryConfigSchema,
]);

export const FixAgentWorkflowInputSchema = z.object({
	incidentId: z.string().min(1),
	contextMarkdown: z.string(),
	alert: FixAgentAlertSchema,
	repo: FixAgentRepoInputSchema,
	limits: FixAgentLimitsSchema,
	forbiddenPaths: z.array(z.string()),
	telemetry: FixAgentTelemetryConfigSchema.optional(),
});

export const FixAgentFixSchema = z.object({
	branch: z.string().min(1),
	commitMessage: z.string().min(1),
	changedFiles: z.array(z.string()),
	testCommand: z.string().optional(),
	testsPassed: z.boolean(),
});

/**
 * The workflow's output. `outcome: "fixed"` is required to carry a `fix`
 * block (enforced below via `superRefine`, since Valibot/Zod's plain object
 * schema can't express "field B is required when field A has value X").
 */
export const FixAgentWorkflowOutputSchema = z
	.object({
		outcome: z.enum(["fixed", "report_only", "failed"]),
		diagnosis: z.string(),
		report: z.string(),
		fix: FixAgentFixSchema.optional(),
		failureReason: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		if (value.outcome === "fixed" && !value.fix) {
			ctx.addIssue({
				code: "custom",
				message: 'outcome "fixed" requires a "fix" block',
				path: ["fix"],
			});
		}
	});

export type FixAgentAlert = z.infer<typeof FixAgentAlertSchema>;
export type FixAgentRepoInput = z.infer<typeof FixAgentRepoInputSchema>;
export type FixAgentLimits = z.infer<typeof FixAgentLimitsSchema>;
export type FixAgentTelemetryConfig = z.infer<
	typeof FixAgentTelemetryConfigSchema
>;
export type FixAgentWorkflowInput = z.infer<typeof FixAgentWorkflowInputSchema>;
export type FixAgentFix = z.infer<typeof FixAgentFixSchema>;
export type FixAgentWorkflowOutput = z.infer<
	typeof FixAgentWorkflowOutputSchema
>;

/** Name of the discovered Flue workflow (`agent-host/src/workflows/fix-incident.ts`). */
export const FIX_INCIDENT_WORKFLOW_NAME = "fix-incident";
