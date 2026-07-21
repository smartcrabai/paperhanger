/**
 * Config schema mirroring docs/spec.md section 3.9. Validated at startup by
 * `src/config/load.ts`; the process must not start with an invalid config.
 */

import { z } from "zod";

const ServerSchema = z.object({
	port: z.number().int().positive().default(8080),
	/**
	 * Optional bearer token required to call `GET /incidents` and
	 * `GET /incidents/:id` (see `src/ingest/server.ts`). Secure by default:
	 * when unset, those endpoints refuse every request with 401 rather than
	 * serving incident data -- which can carry sensitive diagnosis/
	 * failureReason text -- with no authentication at all. `/healthz` and
	 * `/readyz` are never gated by this. Env-expandable like other secrets
	 * (`${API_TOKEN}`).
	 */
	apiToken: z.string().min(1).optional(),
});

const SqliteStorageSchema = z.object({
	driver: z.literal("sqlite"),
	path: z.string().min(1),
});

const PostgresStorageSchema = z.object({
	driver: z.literal("postgres"),
	url: z.string().min(1),
});

const StorageSchema = z.discriminatedUnion("driver", [
	SqliteStorageSchema,
	PostgresStorageSchema,
]);

const SourceConfigSchema = z.object({
	secret: z.string().min(1),
});

const SourcesSchema = z.record(z.string(), SourceConfigSchema).default({});

/**
 * `telemetry` is a discriminated union on `source`, mirroring `storage` and
 * `notifiers` below -- adding a future backend (Loki, Tempo, ...) means
 * adding one more member here plus a `case` in `src/telemetry/factory.ts`,
 * `agent-host/src/tools.ts`, and the two contract mirrors
 * (`src/agent/contract.ts` / `agent-host/src/contract.ts`); nowhere else.
 * `greptimedb` is the only member today.
 */
const GreptimeDbTelemetrySchema = z.object({
	source: z.literal("greptimedb"),
	url: z.string().min(1),
	database: z.string().min(1),
	auth: z.string().optional(),
	/** Overrides for OTLP-ingested table names (deployments can rename them). Passed through to `GreptimeDbSource`. */
	logsTable: z.string().min(1).optional(),
	tracesTable: z.string().min(1).optional(),
	/** Per-request HTTP timeout in milliseconds. Passed through to `GreptimeDbSource` (defaults to 30s when omitted). */
	timeoutMs: z.number().int().positive().optional(),
});

const TelemetrySchema = z.discriminatedUnion("source", [
	GreptimeDbTelemetrySchema,
]);

/** Time window (relative to alert time) used when collecting telemetry. See spec section 3.4. */
const CollectSchema = z.object({
	windowBeforeMinutes: z.number().nonnegative().default(30),
	windowAfterMinutes: z.number().nonnegative().default(5),
});

const RepoMappingSchema = z.object({
	match: z.record(z.string(), z.string()),
	repo: z.string().min(1),
});

const OrgSearchSchema = z.object({
	enabled: z.boolean().default(false),
	org: z.string().optional(),
});

const ReposSchema = z.object({
	attributeKeys: z.array(z.string()).default([]),
	mappings: z.array(RepoMappingSchema).default([]),
	orgSearch: OrgSearchSchema.default({ enabled: false }),
});

const AgentSchema = z.object({
	/** Flue model identifier. Defaults to Anthropic Claude per spec section 3.6. */
	model: z.string().min(1).default("anthropic/claude-sonnet-4-6"),
	concurrency: z.number().int().positive().default(2),
	timeoutMinutes: z.number().int().positive().default(30),
	cooldownHours: z.number().nonnegative().default(24),
	draftPr: z.boolean().default(false),
	forbiddenPaths: z.array(z.string()).default([".github/workflows/**"]),
	/**
	 * External agent-host base URL (see `src/agent/sidecar.ts`). When set, the
	 * sidecar connects to this URL instead of spawning a child process.
	 */
	hostUrl: z.string().min(1).optional(),
	/** Port the spawned agent-host server listens on. Ignored in external-host mode. */
	hostPort: z.number().int().positive().default(8700),
	/** Guardrail: max total changed lines (additions + deletions) before a fix is rejected. */
	maxDiffLines: z.number().int().positive().default(500),
	/**
	 * Guardrail: max fix attempts per incident (an initial attempt plus this
	 * many test-failure retries) before the agent-host workflow gives up. This
	 * is the achievable subset of the spec's per-incident cost-budget
	 * guardrail -- `@flue/sdk` exposes no aggregated workflow-level token/cost
	 * usage to bound true spend directly (see README.md "Current
	 * limitations").
	 */
	maxFixAttempts: z.number().int().positive().default(3),
});

const GitHubSchema = z.object({
	appId: z.string().min(1),
	privateKey: z.string().min(1),
});

const SlackNotifierSchema = z.object({
	type: z.literal("slack"),
	webhookUrl: z.string().min(1),
});

const DiscordNotifierSchema = z.object({
	type: z.literal("discord"),
	webhookUrl: z.string().min(1),
});

const WebhookNotifierSchema = z.object({
	type: z.literal("webhook"),
	url: z.string().min(1),
});

const NotifierSchema = z.discriminatedUnion("type", [
	SlackNotifierSchema,
	DiscordNotifierSchema,
	WebhookNotifierSchema,
]);

/**
 * Self-instrumentation: where paperhanger exports ITS OWN OTLP traces.
 * Distinct from `telemetry`, which is where paperhanger READS other
 * services' telemetry from (GreptimeDB).
 */
const ObservabilitySchema = z.object({
	/** OTLP/HTTP traces endpoint, e.g. "http://localhost:4318/v1/traces". */
	endpoint: z.string().min(1),
	/** `service.name` resource attribute on exported spans. */
	serviceName: z.string().default("paperhanger"),
	/** Extra headers sent with every OTLP export request (values may use ${ENV_VAR}). */
	headers: z.record(z.string(), z.string()).default({}),
});

export const ConfigSchema = z.object({
	server: ServerSchema.default({ port: 8080 }),
	storage: StorageSchema,
	sources: SourcesSchema,
	/**
	 * Optional: paperhanger runs fine without a telemetry backend configured
	 * (see `src/core/pipeline.ts`), degrading to an empty-telemetry
	 * `IncidentContext` rather than refusing to diagnose. When omitted, the
	 * composition root (`src/index.ts`) does not construct a telemetry source
	 * (see `src/telemetry/factory.ts`) or pass telemetry connection details to
	 * the agent-host sidecar.
	 */
	telemetry: TelemetrySchema.optional(),
	/**
	 * Optional: when omitted, paperhanger exports no traces of its own (see
	 * `src/observability/tracing.ts`). Distinct from `telemetry` above, which
	 * is where paperhanger reads other services' telemetry from.
	 */
	observability: ObservabilitySchema.optional(),
	collect: CollectSchema.default({
		windowBeforeMinutes: 30,
		windowAfterMinutes: 5,
	}),
	repos: ReposSchema.default({
		attributeKeys: [],
		mappings: [],
		orgSearch: { enabled: false },
	}),
	agent: AgentSchema.default({
		model: "anthropic/claude-sonnet-4-6",
		concurrency: 2,
		timeoutMinutes: 30,
		cooldownHours: 24,
		draftPr: false,
		forbiddenPaths: [".github/workflows/**"],
		hostPort: 8700,
		maxDiffLines: 500,
		maxFixAttempts: 3,
	}),
	github: GitHubSchema,
	notifiers: z.array(NotifierSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type StorageConfig = z.infer<typeof StorageSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type NotifierConfig = z.infer<typeof NotifierSchema>;
export type RepoMappingConfig = z.infer<typeof RepoMappingSchema>;
export type TelemetryConfig = z.infer<typeof TelemetrySchema>;
export type GreptimeDbTelemetryConfig = z.infer<
	typeof GreptimeDbTelemetrySchema
>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
