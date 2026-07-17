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
  composition root.
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
    server.ts              # Bun.serve routes: POST /webhooks/:source, /healthz, /readyz
    adapters/
      types.ts             # SourceAdapter interface
      grafana.ts           # Grafana Alerting webhook payloads
      alertmanager.ts      # Prometheus Alertmanager webhook payloads (M6)
      generic.ts           # Pass-through internal format
  storage/
    types.ts               # IncidentStore interface
    sqlite.ts              # bun:sqlite implementation
    postgres.ts            # Bun.sql implementation (M6)
  telemetry/
    types.ts               # TelemetrySource, LogRecord, TraceRecord, MetricSeries
    greptimedb.ts          # HTTP SQL + PromQL-compatible API client
    context-builder.ts     # Collection strategy → token-budget-aware IncidentContext
  repo/
    resolver.ts            # attribute → mapping → org-search resolution chain
    github.ts              # GitHub App auth (JWT → installation token), PR client
  agent/
    runner.ts              # Drives the agent host via @flue/sdk; guardrails, outcome classification
    sidecar.ts             # Spawns/supervises the Node agent-host child process (optional external URL)
  notify/
    types.ts               # Notifier interface + notification event types
    slack.ts
    discord.ts
    webhook.ts             # Generic JSON POST
  observability/
    logger.ts              # Structured JSON line logger
agent-host/                # Flue app (Node.js sidecar) — separate package.json
  src/
    fix-agent.ts           # defineAgent: diagnose → fix → test → push branch
    tools.ts               # defineTool: telemetry follow-up queries, repo/PR helpers
    workflow.ts            # defineWorkflow: bounded fix pipeline with outcome contract
tests/
  integration/             # testcontainers-based suites
docs/
  spec.md                  # Behavioral spec (Japanese)
  architecture.md          # This file
  research/                # Vendor/API research notes
```

## Flue agent host (Node sidecar)

Findings from `docs/research/flue.md` (verified against `@flue/*` `1.0.0-beta.9`):

- Flue's generated production server requires Node.js (>= 22.19; it statically imports
  `node:sqlite`, which Bun does not implement). The core `define*` APIs do run under Bun,
  but a served Flue app cannot.
- Therefore the fix agent lives in `agent-host/`, a self-contained Flue app built with the
  Flue CLI and executed with Node. The main Bun process drives it through `@flue/sdk`'s
  `createFlueClient()` — `client.workflows.invoke(name, { input, wait: 'result' })`, with
  `client.runs.stream()` available for progress observation.
- By default `src/agent/sidecar.ts` spawns the agent host as a child process so the whole
  service still ships as a single container (the image includes both Bun and Node).
  `agent.hostUrl` in the config can point at an externally deployed agent host instead
  (e.g. a separate K8s sidecar/deployment), in which case nothing is spawned.
- Sandbox mode: `local()` inside the agent-host container (container boundary is the
  isolation). Remote providers (Daytona/E2B) can be added later via config.
- PR creation is NOT Flue's job (`@flue/github` only verifies inbound webhooks); the agent
  host calls back into our own GitHub client (M3) or shells out to git + GitHub REST.
- Flue is pre-1.0 beta: pin exact versions and expect schema resets on upgrades. The agent
  host's durable-execution store uses the driver-agnostic `@flue/postgres` adapter so it
  can share paperhanger's PostgreSQL when configured, falling back to its default local
  persistence otherwise.

## Interface contracts

The canonical interface signatures live in `docs/spec.md` §3 (`SourceAdapter`,
`IncidentEvent`, `TelemetrySource`, `IncidentStore`, `Notifier`). Implementations must not
widen those contracts without updating the spec first.

## Incident state machine

```
received → collecting → resolving_repo → diagnosing → fixing
  → pr_created | report_only | failed | skipped
```

Every transition is persisted through `IncidentStore` before the next stage starts, so a
restart can observe where each incident stopped. Terminal states trigger a notification.

## Webhook authentication

Each configured source has a shared secret. Requests must present it either as an
`X-Webhook-Token` header or a `?token=` query parameter; mismatch or absence yields 401
without reading the body further.
