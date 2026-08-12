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
 * `notifiers` below -- adding a future backend means adding one more member
 * here plus a `case` in `src/telemetry/factory.ts` (the initial-collection
 * path every backend must support). Wiring a backend into the fix agent's
 * *follow-up* query tool is a separate, optional step -- a `case` in
 * `agent-host/src/tools.ts` plus the two contract mirrors
 * (`src/agent/contract.ts` / `agent-host/src/contract.ts`). This tool is
 * SQL/PromQL-shaped and stays scoped to `greptimedb` only -- `src/index.ts`
 * narrows `config.telemetry` to that one member before passing it through to
 * the agent-host sidecar/runner (see also the doc comments on
 * `AgentHostSidecarConfig.telemetry` (`src/agent/sidecar.ts`) and
 * `FixAgentRunnerConfig.telemetry` (`src/agent/runner.ts`) for why every
 * other source below is collection-only, no follow-up query tool). This
 * holds for `source: "composite"` too: a composite's slots are never
 * greptimedb-narrowed for the follow-up tool, even when a slot happens to be
 * greptimedb -- see `src/telemetry/composite.ts`'s module doc comment.
 * `greptimedb`, `loki`, `tempo`, `prometheus`, `clickstack`, `signoz`,
 * `openobserve`, `datadog`, `newrelic`, `grafana`, `zabbix`, and `mackerel`
 * are the single-backend members; `composite` (below) routes each signal to
 * its own single-backend member instead of picking just one.
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

/**
 * Logs-only backend (see `src/telemetry/loki.ts`): `queryTraces`/`queryMetrics`
 * against a Loki-sourced `TelemetrySource` gracefully return no results,
 * since a single Loki instance carries no trace/metric data.
 */
const LokiTelemetrySchema = z.object({
	source: z.literal("loki"),
	url: z.string().min(1),
	/** `username:password`, unencoded; base64-encoded internally (Basic auth). */
	auth: z.string().optional(),
	/** `X-Scope-OrgID` tenant header, for multi-tenant Loki deployments. */
	orgId: z.string().min(1).optional(),
	/** Per-request HTTP timeout in milliseconds. Defaults to 30s when omitted. */
	timeoutMs: z.number().int().positive().optional(),
});

/**
 * Traces-only backend (see `src/telemetry/tempo.ts`): `queryLogs`/`queryMetrics`
 * against a Tempo-sourced `TelemetrySource` gracefully return no results,
 * since a single Tempo instance carries no log/metric data.
 */
const TempoTelemetrySchema = z.object({
	source: z.literal("tempo"),
	url: z.string().min(1),
	auth: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/**
 * Metrics-only backend (see `src/telemetry/prometheus.ts`): `queryLogs`/`queryTraces`
 * against a Prometheus-sourced `TelemetrySource` gracefully return no
 * results, since a single Prometheus instance carries no log/trace data.
 * Like `GreptimeDbSource.queryMetrics`, `queryMetrics` only runs when the
 * caller supplies a PromQL expression (see `context-builder.ts`'s
 * promql/metric annotation gate).
 */
const PrometheusTelemetrySchema = z.object({
	source: z.literal("prometheus"),
	url: z.string().min(1),
	auth: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** ClickStack (ClickHouse's observability stack, successor of HyperDX); see `src/telemetry/clickstack.ts`. */
const ClickStackTelemetrySchema = z.object({
	source: z.literal("clickstack"),
	/** ClickHouse HTTP interface base URL, e.g. `http://localhost:8123`. */
	url: z.string().min(1),
	database: z.string().min(1),
	auth: z.string().optional(),
	logsTable: z.string().min(1).optional(),
	tracesTable: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** SigNoz's unified `query_range` API; see `src/telemetry/signoz.ts`. */
const SigNozTelemetrySchema = z.object({
	source: z.literal("signoz"),
	url: z.string().min(1),
	/** Sent as the `SIGNOZ-API-KEY` header. */
	apiKey: z.string().min(1),
	timeoutMs: z.number().int().positive().optional(),
});

/** OpenObserve's `_search` API; see `src/telemetry/openobserve.ts`. */
const OpenObserveTelemetrySchema = z.object({
	source: z.literal("openobserve"),
	url: z.string().min(1),
	/** Organization slug in the URL path (`/api/{organization}/...`). */
	organization: z.string().min(1),
	auth: z.string().optional(),
	logsStream: z.string().min(1).optional(),
	tracesStream: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** See `src/telemetry/datadog.ts`'s module doc comment for the verified API shapes. */
const DatadogTelemetrySchema = z.object({
	source: z.literal("datadog"),
	apiKey: z.string().min(1),
	appKey: z.string().min(1),
	/** Datadog site, e.g. `datadoghq.com` (default), `datadoghq.eu`, `us3.datadoghq.com`. */
	site: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** See `src/telemetry/newrelic.ts`'s module doc comment for the verified API shapes. */
const NewRelicTelemetrySchema = z.object({
	source: z.literal("newrelic"),
	apiKey: z.string().min(1),
	accountId: z.number().int().positive(),
	region: z.enum(["US", "EU"]).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** See `src/telemetry/grafana.ts`'s module doc comment for the chosen API and its tradeoffs. */
const GrafanaTelemetrySchema = z.object({
	source: z.literal("grafana"),
	url: z.string().min(1),
	serviceAccountToken: z.string().min(1),
	lokiDatasourceUid: z.string().min(1).optional(),
	tempoDatasourceUid: z.string().min(1).optional(),
	prometheusDatasourceUid: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** See `src/telemetry/zabbix.ts`'s module doc comment for the version assumption and API shapes. */
const ZabbixTelemetrySchema = z.object({
	source: z.literal("zabbix"),
	url: z.string().min(1),
	apiToken: z.string().min(1),
	timeoutMs: z.number().int().positive().optional(),
});

/** See `src/telemetry/mackerel.ts`'s module doc comment for the API shapes and monitoring-only limitations. */
const MackerelTelemetrySchema = z.object({
	source: z.literal("mackerel"),
	apiKey: z.string().min(1),
	baseUrl: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/**
 * The twelve single-backend telemetry schemas, as a tuple so both
 * `SignalSourceSchema` below (a composite slot: one backend per signal) and
 * `TelemetrySchema` (the top-level `telemetry:` config) can share the exact
 * same member list without drifting out of sync.
 */
const signalSourceSchemas = [
	GreptimeDbTelemetrySchema,
	LokiTelemetrySchema,
	TempoTelemetrySchema,
	PrometheusTelemetrySchema,
	ClickStackTelemetrySchema,
	SigNozTelemetrySchema,
	OpenObserveTelemetrySchema,
	DatadogTelemetrySchema,
	NewRelicTelemetrySchema,
	GrafanaTelemetrySchema,
	ZabbixTelemetrySchema,
	MackerelTelemetrySchema,
] as const;

/**
 * A single composite slot (`logs:`/`traces:`/`metrics:` under
 * `source: composite` below): any one of the twelve single-backend
 * telemetry schemas, but deliberately NOT `CompositeTelemetrySchema` itself
 * -- nesting a composite inside a composite slot is rejected by this union,
 * rather than by ad hoc validation, since a slot names exactly one backend
 * to own that signal.
 */
const SignalSourceSchema = z.discriminatedUnion("source", signalSourceSchemas);

/**
 * Routes each signal to its own backend, for stacks with no single
 * multi-signal store -- the standard Grafana OSS setup (Loki + Tempo +
 * Prometheus) is the motivating case (see docs/spec.md section 3.4 and
 * `src/telemetry/composite.ts`). At least one of `logs`/`traces`/`metrics`
 * must be set: an all-empty composite configures nothing, which is what
 * omitting `telemetry` entirely is already for.
 */
const CompositeTelemetrySchema = z
	.object({
		source: z.literal("composite"),
		logs: SignalSourceSchema.optional(),
		traces: SignalSourceSchema.optional(),
		metrics: SignalSourceSchema.optional(),
	})
	.refine((data) => Boolean(data.logs || data.traces || data.metrics), {
		message:
			"composite telemetry must configure at least one of logs, traces, or metrics",
	});

const TelemetrySchema = z.discriminatedUnion("source", [
	...signalSourceSchemas,
	CompositeTelemetrySchema,
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
	/**
	 * Config-file per-repository operator instructions, keyed by "owner/repo"
	 * (matched case-insensitively). Precedence mirrors the repo-resolution
	 * chain (dashboard-managed definitions beat this file): an enabled
	 * RepoDefinition's own `systemPrompt` wins over the entry here, and either
	 * one replaces the common system prompt for that repository. Blank values
	 * are treated as unset. Read live per fix run by
	 * `FixAgentRunner.resolveRepoSystemPrompt` -- never seeded into the DB.
	 */
	systemPrompts: z.record(z.string(), z.string()).default({}),
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
	/**
	 * Config-file fallback for the common system prompt (operator instructions
	 * shared by every repository). The dashboard-managed common prompt
	 * (GET/PUT /system-prompt) takes precedence when set; a blank value here
	 * is treated as unset. Unlike the dashboard/API surface there is no length
	 * cap -- consistent with every other free-text field in this file -- but
	 * the same context-budget consideration applies (see docs/spec.md section
	 * 3.11).
	 */
	systemPrompt: z.string().optional(),
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
 * Self-instrumentation: where paperhanger exports ITS OWN OTLP logs.
 * Mirroring the parent section's shape, presence of this subsection is the
 * enable flag (see `src/observability/log-export.ts`).
 */
const ObservabilityLogsSchema = z.object({
	/** OTLP/HTTP logs endpoint, e.g. "http://localhost:4318/v1/logs". */
	endpoint: z.string().min(1),
	/**
	 * Extra headers sent with every OTLP log export request (values may use
	 * ${ENV_VAR}). When omitted, the parent `observability.headers` apply --
	 * typical collectors share auth across signals.
	 */
	headers: z.record(z.string(), z.string()).optional(),
});

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
	/**
	 * Optional: when present, paperhanger also exports its own logs over
	 * OTLP/HTTP in addition to the stdout JSON-lines sink (see
	 * `src/observability/log-export.ts`). Omit to export traces only.
	 */
	logs: ObservabilityLogsSchema.optional(),
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
		systemPrompts: {},
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
export type LokiTelemetryConfig = z.infer<typeof LokiTelemetrySchema>;
export type TempoTelemetryConfig = z.infer<typeof TempoTelemetrySchema>;
export type PrometheusTelemetryConfig = z.infer<
	typeof PrometheusTelemetrySchema
>;
export type ClickStackTelemetryConfig = z.infer<
	typeof ClickStackTelemetrySchema
>;
export type SigNozTelemetryConfig = z.infer<typeof SigNozTelemetrySchema>;
export type OpenObserveTelemetryConfig = z.infer<
	typeof OpenObserveTelemetrySchema
>;
export type DatadogTelemetryConfig = z.infer<typeof DatadogTelemetrySchema>;
export type NewRelicTelemetryConfig = z.infer<typeof NewRelicTelemetrySchema>;
export type GrafanaTelemetryConfig = z.infer<typeof GrafanaTelemetrySchema>;
export type ZabbixTelemetryConfig = z.infer<typeof ZabbixTelemetrySchema>;
export type MackerelTelemetryConfig = z.infer<typeof MackerelTelemetrySchema>;
/** A single composite slot's config -- any one non-composite telemetry member. */
export type SignalSourceConfig = z.infer<typeof SignalSourceSchema>;
export type CompositeTelemetryConfig = z.infer<typeof CompositeTelemetrySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
export type ObservabilityLogsConfig = z.infer<typeof ObservabilityLogsSchema>;
