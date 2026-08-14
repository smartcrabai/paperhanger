# Architecture & Coding Conventions

Companion to [spec.md](./spec.md) (the behavioral spec, in Japanese). This document defines
the module layout and coding rules that all contributions must follow.

## Conventions

- **Language**: All code comments, documentation, identifiers, test names, and commit
  messages are written in **English**.
- **Runtime**: Bun. Prefer Bun built-ins (`Bun.serve`, `bun:sqlite`, `Bun.sql`, `Bun.file`,
  `Bun.YAML` if available) over third-party equivalents. Keep the dependency footprint small.
- **Tests**:
  - Unit tests are colocated with sources as `src/**/*.test.ts` and must not require
    network access or Docker. Run with `bun run test`.
  - Integration tests live in `tests/integration/**/*.test.ts`, use **testcontainers**
    for real backing services (GreptimeDB, PostgreSQL), and run with
    `bun run test:integration` (requires Docker).
- **Style**: biome (format) + oxlint (lint) are enforced by a PostToolUse hook; code must
  pass `bun run lint` and `bun run typecheck`.
- **Errors**: never swallow exceptions silently. Log through the structured logger and
  reflect failures in incident state.
- **Dependency injection**: components receive their dependencies (interfaces) via
  constructor/factory parameters. No module-level singletons; `src/index.ts` is the only
  composition root. The one accepted exception is OTel's global context manager
  (`src/observability/tracing.ts`): context propagation across `await` boundaries has no
  non-global mechanism in `@opentelemetry/api`, so `createTracing()` registers it once via
  `context.setGlobalContextManager(...)` instead of threading it through constructors; every
  `Tracer` itself still reaches components only as an injected optional dependency.
- **Config**: validated at startup; the process exits non-zero with a readable error on
  invalid config. Secrets only via `${ENV_VAR}` expansion, never inline.

## Module layout

```
src/
  index.ts                 # Composition root: load config, wire deps, start server
  config/
    schema.ts              # Config types + validation schema
    load.ts                # YAML loading + ${ENV_VAR} expansion
  core/
    types.ts               # IncidentEvent, Incident, IncidentStatus, IncidentContext, ...
    incident-manager.ts    # Dedup, cooldown, lifecycle, concurrency-limited queue
    pipeline.ts            # Stage orchestration: collect → resolve → agent → notify
  ingest/
    server.ts              # Bun.serve routes: POST /webhooks/:source, /healthz, /readyz, GET /incidents(+:id, +:id/events), /repo-definitions + /setup-scripts + /system-prompt CRUD, POST /telemetry/query (agent-host's query_telemetry callback), GET / + /dashboard (htmlRoutes passthrough)
    repo-definitions.ts    # Zod validation + route handlers for the /repo-definitions CRUD routes (split out to keep server.ts readable)
    common-setup-scripts.ts # Zod validation + route handlers for the /setup-scripts CRUD routes
    system-prompt.ts       # Zod validation + route handlers for the single-row GET/PUT /system-prompt routes
    adapters/
      types.ts             # SourceAdapter interface
      grafana.ts           # Grafana Alerting webhook payloads
      alertmanager.ts      # Prometheus Alertmanager webhook payloads
      generic.ts           # Pass-through internal format
      sentry.ts            # Sentry Integration Platform webhooks (event_alert + issue resources)
  storage/
    types.ts               # IncidentStore + RepoDefinitionStore + CommonSetupScriptStore + CommonSystemPromptStore interfaces
    sqlite.ts              # bun:sqlite implementation (all interfaces)
    postgres.ts            # Bun.sql implementation (all interfaces)
  telemetry/
    types.ts               # TelemetrySource, LogRecord, TraceRecord, MetricSeries
    greptimedb.ts          # HTTP SQL + PromQL-compatible API client (logs+traces+metrics)
    loki.ts                # LogQL HTTP client (logs only; Grafana OSS stack)
    tempo.ts               # TraceQL search + trace-by-id HTTP client (traces only; Grafana OSS stack)
    prometheus.ts          # PromQL HTTP client (metrics only; Grafana OSS stack)
    clickstack.ts          # ClickHouse HTTP interface (SQL) client, ClickStack's OTel schema; no PromQL API, so metrics unsupported
    signoz.ts              # Unified query_range API (v5) client; builder-query metrics unsupported (no raw PromQL passthrough)
    openobserve.ts         # _search HTTP API (SQL) client; metrics via an inferred Prometheus-compatible query_range path
    http-client.ts         # Shared per-request timeout + OTel CLIENT span helpers for the HTTP-based sources below
    datadog.ts             # Logs Search v2 + Spans Search v2 + classic Metrics Query API
    newrelic.ts            # NRQL over NerdGraph (Log/Span/Metric event types)
    grafana.ts             # Query front-end: /api/ds/query against provisioned Loki/Tempo/Prometheus datasources
    zabbix.ts              # JSON-RPC (problem/event history + item history); monitoring-only, no tracing
    mackerel.ts            # REST (alerts + service metrics); monitoring-only, no tracing
    composite.ts           # Routes logs/traces/metrics each to their own child TelemetrySource (source: composite)
    factory.ts             # Dispatches config.telemetry.source -> concrete TelemetrySource (recurses once for composite)
    context-builder.ts     # Collection strategy → token-budget-aware IncidentContext
    followup.ts            # Dispatcher behind POST /telemetry/query: structured filter / expression escape hatch, clamping, failure semantics
  repo/
    resolver.ts            # attribute → mapping → org-search resolution chain
    github.ts              # GitHub App auth (JWT → installation token), PR client
  agent/
    contract.ts            # Zod mirror of the fix-incident workflow's input/output contract (agent-host/src/contract.ts is canonical)
    forbidden-paths.ts     # Guardrail: matches a changed file against agent.forbiddenPaths glob patterns
    runner.ts              # Drives the agent host via @flue/sdk; guardrails, outcome classification
    sidecar.ts             # Spawns/supervises the Node agent-host child process (optional external URL)
  notify/
    types.ts               # Notifier interface + notification event types
    slack.ts
    discord.ts
    webhook.ts             # Generic JSON POST
  observability/
    logger.ts              # Structured JSON line logger
    tracing.ts             # OTel tracer provider setup (traces self-instrumentation)
    log-export.ts          # OTel logger provider setup (logs self-instrumentation; bridges logger.ts)
    timeout.ts             # Bounded flush/shutdown helper shared by both signals
  dashboard/                # Personal-use configuration + observation UI (Bun HTML import + React)
    index.html              # Entry point; imported only from src/index.ts, the composition root
    main.tsx                # Browser entry point (index.html's <script> tag): mounts <App/> into #root, kept separate from app.tsx so importing the component tree never touches the DOM
    app.tsx                 # Side-effect-free root component (mounted by main.tsx): token gate + Repositories/Setup scripts/System prompt/Incidents tab state
    api.ts                  # Fetch wrapper for the dashboard's own HTTP API calls
    repositories-view.tsx   # Repo definition table + create/edit form (repo-definition-form.tsx, mappings-editor.tsx)
    setup-scripts-view.tsx  # Common setup script table + create/edit modal
    system-prompt-view.tsx  # Single always-visible editor for the common system prompt (GET/PUT /system-prompt)
    incidents-view.tsx      # Incident list (auto-refreshing) + detail panel (incident-detail.tsx, status-badge.tsx)
    token-prompt.tsx        # Full-screen API-token gate when no token is stored; reused as an overlay atop the still-mounted view during re-authentication after a 401
    dashboard.css           # Semantic layer over tokens.css -- restyle here, not in tokens.css
    tokens.css              # Generated design tokens, SmartCrab design system (Open Design project
                             # brand-eloqwnt-7dc978, imported from the user's Open Design install);
                             # do not hand-tune values here
    fonts/                  # Mazzard font files + fonts.css, copied from the same Open Design project
agent-host/                # Flue app (Node.js sidecar) — separate package.json
  src/
    app.ts                 # Custom Hono entrypoint: mounts the fix-incident agent router + a /healthz route
    contract.ts            # Valibot schemas for the fix-incident agent's input/output (canonical; mirrored by src/agent/contract.ts)
    fix-agent.ts           # "use agent" agent function: instructions + hooks (model, sandbox, tools, lifecycle)
    fix-incident.ts        # Deterministic host steps: clone → diagnose → fix → test → push branch (PR creation happens back in the parent Bun process)
    tools.ts               # defineTool: query_telemetry follow-up queries
    lib/                   # dependency-free tier, unit-tested by the root `bun test`: common-setup-scripts, diagnosis-prompt, fix-attempt-policy, output-sanitizer, redaction, sql-guard, system-prompt, tamper-check, test-detection, telemetry-callback-config, telemetry-client, telemetry-descriptions
tests/
  integration/             # testcontainers-based suites
docs/
  spec.md                  # Behavioral spec (Japanese)
  architecture.md          # This file
  research/                # Vendor/API research notes
```

## Flue agent host (Node sidecar)

Findings from `docs/research/flue.md` (researched against `@flue/*` `1.0.0-beta.9`; the
code has since migrated to `2.0.1` in PR #8):

- Flue's Node-target server requires Node.js (>= 22.19; it statically imports
  `node:sqlite`, which Bun does not implement). The core runtime APIs do run under Bun,
  but a served Flue app cannot.
- Therefore the fix agent lives in `agent-host/`, a self-contained Flue app built with
  Vite (`@flue/vite`) and executed with Node. The main Bun process drives it through
  `@flue/sdk`'s conversation-scoped `createFlueClient()` — `client.send()` with the run
  input as `initialData`, then `client.read()` for the reply carrying the result data
  part, and `client.abort()` to request cancellation on timeout (see
  `src/agent/runner.ts`).
- By default `src/agent/sidecar.ts` spawns the agent host as a child process so the whole
  service still ships as a single container (the image includes both Bun and Node).
  `agent.hostUrl` in the config can point at an externally deployed agent host instead
  (e.g. a separate K8s sidecar/deployment), in which case nothing is spawned.
- Sandbox mode: `local()` inside the agent-host container (container boundary is the
  isolation). Remote providers (Daytona/E2B) can be added later via config.
- PR creation is NOT Flue's job (`@flue/github` only verifies inbound webhooks). The agent
  host (`agent-host/src/fix-incident.ts`) only shells out to git to clone, commit,
  and push a branch; it never calls the GitHub REST API. The parent Bun process's
  `src/agent/runner.ts` (`finalizeFixed`) re-verifies the pushed diff against the guardrails
  via GitHub's compare API and then creates the PR itself through `GitHubAppClient`
  (`src/repo/github.ts`).
- Flue is no longer pre-1.0 beta (`2.0.1`, pinned exactly), but keep upgrades deliberate
  and tested: the beta's persisted schema was reset-only, and at 2.x a persisted database
  written by an incompatible Flue version refuses to start rather than migrating in place.
  No `src/db.ts` is configured today, so the agent host runs on Flue's default in-memory
  persistence; the driver-agnostic `@flue/postgres` adapter remains the documented option
  for sharing paperhanger's PostgreSQL later (see `agent-host/README.md`).
- **Operator system prompts** (`docs/spec.md` §3.6/§3.11): the operator text is
  threaded through the agent input and rendered by
  `agent-host/src/lib/system-prompt.ts` as a leading section of the diagnosis prompt (see
  `buildDiagnosisPrompt` in `agent-host/src/lib/diagnosis-prompt.ts`). Under the beta SDK
  no per-run system-prompt override existed; Flue 2's agent function could interpolate the
  input into its returned instructions (they re-render every turn), but dynamic
  instructions bust the model cache (per Flue's bundled `docs/guide/building-agents.md`),
  so prompt-section delivery is kept.
  Two scopes travel through the input verbatim — `systemPrompt` (common) and
  `repoSystemPrompt` (per-repository) — and which one renders is decided by
  `renderEffectiveSystemPromptSection` in the agent host, not in the parent process, so
  the replacement rule lives next to the renderers it chooses between. The parent process
  resolves each scope's *value* (`FixAgentRunner.resolveCommonSystemPrompt` /
  `resolveRepoSystemPrompt`): dashboard-managed storage first, config file
  (`agent.systemPrompt` / `repos.systemPrompts["owner/repo"]`) second, both fail-soft — a
  lookup error is logged and treated as unset rather than blocking the fix run.

## Telemetry backends

`config.telemetry.source` selects one `TelemetrySource` implementation (see
`src/telemetry/factory.ts`); each speaks a different backend's current
public HTTP API (docs URLs and verified request/response shapes live in
each file's module doc comment):

- `greptimedb` (`greptimedb.ts`): direct SQL + PromQL-compatible HTTP APIs.
  Also the only source implementing `TelemetrySource.runRawSql`, the raw-SQL
  escape hatch the fix agent's `query_telemetry` follow-up tool can use for
  `signal: "logs"`/`"traces"` (see `src/telemetry/followup.ts`). Every
  source below is reachable through that same follow-up tool via the
  parent's `POST /telemetry/query` callback -- there is no longer a
  GreptimeDB-only carve-out for the tool itself, just this one
  GreptimeDB-only capability within it.
- `loki` / `tempo` / `prometheus` (`loki.ts` / `tempo.ts` / `prometheus.ts`):
  single-signal backends for a Grafana OSS stack that runs those three as
  separate services rather than GreptimeDB's one do-everything endpoint;
  querying a signal the chosen backend doesn't carry returns `[]` with a
  warning instead of failing.
- `clickstack` / `signoz` / `openobserve` (`clickstack.ts` / `signoz.ts` /
  `openobserve.ts`): each speaks its own native HTTP API (ClickHouse SQL,
  SigNoz's unified `query_range`, OpenObserve's `_search`); each has a
  metrics-collection caveat noted in its own module doc comment.
- `datadog` (`datadog.ts`): Logs Search API v2 + Spans Search API v2 for
  collection, the classic (v1) timeseries Metrics Query API for metrics.
- `newrelic` (`newrelic.ts`): NRQL over NerdGraph (New Relic's GraphQL API),
  querying the `Log`/`Span`/`Metric` event types.
- `grafana` (`grafana.ts`): a **query front-end**, not a store -- it proxies
  `POST /api/ds/query` to whatever Loki/Tempo/Prometheus datasources are
  provisioned behind it, addressed by UID. Chosen over Grafana Cloud's
  separate per-signal APIs because it works identically for self-hosted and
  Cloud Grafana with one service-account token; the tradeoff is that
  per-datasource query bodies are plugin-defined, not part of this HTTP
  API's own schema (see the module doc comment's field-name caveats).
- `zabbix` (`zabbix.ts`) / `mackerel` (`mackerel.ts`): monitoring systems,
  not log/trace stores, so both are shaped as best-effort context
  enrichment rather than full backends: `queryTraces` always returns no
  spans (neither has a tracing concept), `queryLogs` maps problem/alert
  history onto `LogRecord[]` as the closest available substitute, and
  `queryMetrics` only returns a series when the caller can supply both a
  resolvable host/service label and a metric-name hint. Documented plainly
  here and in README.md's config reference rather than silently degraded.
- `composite` (`composite.ts`): routes each signal to its own single-backend
  child instead of picking one backend for all three -- the standard
  Grafana OSS setup (Loki + Tempo + Prometheus) is the motivating case.
  `factory.ts` recurses once per configured slot to build each child; the
  schema forbids nesting `composite` inside a slot, so recursion never goes
  deeper than one level. Per-signal error isolation: a slot's query failure
  degrades only that signal to `[]`, unlike the whole-incident degradation
  `src/core/pipeline.ts` applies to a single (non-composite) source's
  failure. A composite is proxied by `query_telemetry` like any other
  source, and its structured follow-up queries route per signal through the
  same slot children. It implements no `runRawSql`, though, so the raw-SQL
  `expression` escape hatch resolves to the "not supported by this source"
  note rather than reaching a backend -- there is no single SQL backend
  behind a composite to reach, even when one slot happens to be
  `greptimedb`.

`src/telemetry/http-client.ts` factors the per-request timeout
(`AbortController`-based) and OTel CLIENT span wrapping the `datadog`/
`newrelic`/`grafana`/`zabbix`/`mackerel` sources share, following the
pattern `greptimedb.ts` established first (its own JSON-RPC/SQL-shaped
redaction concerns are specific enough to that file that it keeps its own
copy rather than using the shared helper; `loki`/`tempo`/`prometheus` were
written independently and likewise keep their own).

**Testing note**: none of the five non-GreptimeDB sources above were built
against a live backend (no Datadog/New Relic/Grafana/Zabbix/Mackerel
instance was available) -- their query construction and response mapping
are verified against public API docs and covered by unit tests with a
stubbed `fetch`, but not against real traffic. See each PR that introduced
them for the equivalent caveat.

### Follow-up telemetry queries (the `query_telemetry` proxy)

The fix agent runs in `agent-host/`, a separate Node process that cannot
import `src/telemetry/*` (see "Flue agent host" above), so its
`query_telemetry` tool (`agent-host/src/tools.ts`) makes an HTTP callback
into the parent's own `POST /telemetry/query` route
(`src/ingest/server.ts`) instead of talking to any backend directly. The
parent dispatches the request to whichever `TelemetrySource` `src/index.ts`
already constructed (`src/telemetry/followup.ts`), reusing that source's
existing escaping/validation rather than opening a second injection surface
per backend. Structured `filter` (mapped onto `TelemetryQuery.labels`) is
the main path; `expression` is a narrow escape hatch -- the backend-specific
metric query for `signal: "metrics"`, or (GreptimeDB only) a single
read-only SQL statement for `signal: "logs"/"traces"`, guarded by
`agent-host/src/lib/sql-guard.ts` imported directly into `followup.ts` as
the single canonical guard. A structurally unsupported query (a missing
required hint, or `expression` against a source without `runRawSql`)
resolves normally with an empty array and an explanatory note; a backend
failure/timeout throws, surfacing as a tool error to the model.

The callback route is gated by a DEDICATED bearer token, separate from
`server.apiToken`, so telemetry-read permission is not the same grant as
dashboard/incident CRUD. In the default internal (spawned-child) sidecar
mode, `src/index.ts` generates a random per-boot token and passes it (plus
the callback URL and configured source name) through the child's spawn env
as three separate vars (`PAPERHANGER_TELEMETRY_CALLBACK_URL`/`_TOKEN`/
`_SOURCE`) -- no persisted secret, no new configuration. This is also why
the sidecar no longer forwards any backend URL/database/auth value to the
agent-host process at all: the parent proxies every query itself. In
external agent-host mode (`agent.hostUrl` set) there is no spawn env to use
-- `src/index.ts` never spawns that process, so it never sets any env var on
it -- so the operator must set `agent.telemetryCallbackToken` here AND
configure all three env vars on the externally deployed agent-host's own
environment themselves: `PAPERHANGER_TELEMETRY_CALLBACK_TOKEN` (matching
this config's value), `PAPERHANGER_TELEMETRY_CALLBACK_URL` (this
deployment's own externally-reachable `/telemetry/query` URL -- the internal
`http://127.0.0.1:<server.port>/telemetry/query` default only works if that
process shares this one's network namespace), and
`PAPERHANGER_TELEMETRY_CALLBACK_SOURCE` (matching `config.telemetry.source`).
Missing any of the three there, or the token here, degrades
`query_telemetry` to unavailable rather than serving the route
unauthenticated.

## Dashboard (repo definitions + incident browser)

- Served from the same process as the ingest server, not a separate service. `src/index.ts`
  imports `src/dashboard/index.html` and passes it to `createServer` as
  `htmlRoutes: { "/": dashboard, "/dashboard": dashboard }`, which `Bun.serve` serves ahead of the `fetch`
  fallback. `src/index.ts` is the **only** file allowed to import a `.html` bundle —
  `src/ingest/server.ts` (and its unit tests) never do, keeping that module's import graph
  bundler-free.
- `buildStore()` in `src/index.ts` returns
  `IncidentStore & RepoDefinitionStore & CommonSetupScriptStore & CommonSystemPromptStore` —
  `SqliteIncidentStore`/`PostgresIncidentStore` implement all four interfaces on the same
  class/DB handle (see `docs/spec.md` §3.3). That single `store` value is then threaded to
  every consumer that needs one of those slices: `RepoResolver`'s repo-definition-source
  constructor param, `FixAgentRunner`'s `repoDefinitions`/`commonSetupScripts`/
  `commonSystemPrompt` deps, and `createServer`'s `repoDefinitions`/`commonSetupScripts`/
  `commonSystemPrompt` deps — each kept as a separate `ServerDeps` field rather than folded
  into `store`'s `Pick<IncidentStore, ...>`, so that `Pick` stays an honest, narrow slice of
  `IncidentStore` alone.
- `src/ingest/repo-definitions.ts` / `common-setup-scripts.ts` / `system-prompt.ts` hold the
  zod validation and route handlers for their respective dashboard CRUD routes; `server.ts`
  itself still owns routing dispatch and the `server.apiToken` auth gate for every dashboard
  data route.

## Interface contracts

The canonical interface signatures live in `docs/spec.md` §3 (`SourceAdapter`,
`IncidentEvent`, `TelemetrySource`, `IncidentStore`, `RepoDefinitionStore`,
`CommonSetupScriptStore`, `CommonSystemPromptStore`, `Notifier`).
Implementations must not widen those contracts without updating the spec first.

## Incident state machine

```
received → collecting → resolving_repo → diagnosing → fixing
  → pr_created | report_only | failed | skipped
```

Every transition is persisted through `IncidentStore` before the next stage starts, so a
restart can observe where each incident stopped. Terminal states trigger a notification.

**Restart resume**: `IncidentManager.recoverOpenIncidents()` re-enqueues every non-terminal
incident at startup, and `IncidentPipeline.process()` (`src/core/pipeline.ts`) resumes each
one from its last completed stage instead of restarting the whole pipeline. It does this via
an `IncidentCheckpoint` (`storage/types.ts`: `saveIncidentCheckpoint` /
`getIncidentCheckpoint` / `deleteIncidentCheckpoint`) -- one row per incident, holding the
`IncidentContext` built while collecting telemetry and, once resolved, the `ResolvedRepo`.
`loadResumePlan` reads that checkpoint (if any) and picks one of three resume points:

- No checkpoint (a fresh incident, or a crash before telemetry collection finished): runs
  every stage, identical to a full restart. This is the one window that can still produce a
  duplicate `diagnosis_started` notification.
- Checkpoint has only the `IncidentContext` (telemetry collection completed, repo resolution
  had not yet succeeded): resumes at repo resolution, skipping telemetry collection and the
  `diagnosis_started` notification (it already fired).
- Checkpoint also has a `ResolvedRepo` (repo resolution also completed -- the only way
  `diagnosing`/`fixing` are ever reached): skips straight to the agent stage, re-invoking
  `FixAgentRunner.run()` from scratch. The agent run itself has no resumable checkpoint of its
  own here, so a crash during `diagnosing`/`fixing` always re-runs the clone/diagnose/fix/test
  cycle in full, with a fresh `agent.timeoutMinutes`/`maxFixAttempts` budget -- exactly as a
  full pipeline restart already did before checkpointing existed. This is the practical limit
  of how far resume goes without deeper Flue-level durable-execution integration.

The checkpoint is deleted once the incident reaches any terminal status (`cleanupCheckpoint`
in `pipeline.ts`), so a stale checkpoint can never be read back for an incident that has
already finished.

## Webhook authentication

Each configured source has a shared secret. Requests must present it either as an
`X-Webhook-Token` header or a `?token=` query parameter; mismatch or absence yields 401
without reading the body further. Source-specific signature schemes are not verified
in-process (notably Sentry's `Sentry-Hook-Signature`, an HMAC-SHA256 of the raw body
with the integration's client secret): the `SourceAdapter` contract receives only the
request and has no per-adapter secret plumbing, so every source authenticates through
the one uniform mechanism -- see README.md "Security notes" for the rationale and the
reverse-proxy alternative.
