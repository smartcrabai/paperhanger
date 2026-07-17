# paperhanger agent-host

The Flue-based fix agent for [paperhanger](../README.md), packaged as a
**separate, Node-only application**. This is not part of the main Bun
process's dependency graph — it has its own `package.json`, its own
`node_modules`, and is built/run independently. See the parent repo's
`docs/architecture.md` ("Flue agent host (Node sidecar)") and
`docs/research/flue.md` for the full rationale.

## Why a separate Node app?

Flue's generated production server (`flue build --target node` ->
`dist/server.mjs`) unconditionally imports `@flue/runtime/node`, which
statically imports `node:sqlite` — a module Bun does not implement. The core
`define*` APIs run fine under Bun, but a *served* Flue app cannot. So:

- This directory is built and run with **Node >= 22.19** (`node:sqlite` has
  been available since Node 22.5).
- The main Bun process (`src/agent/sidecar.ts` in the parent repo) spawns this
  as a child process by default, and drives it over HTTP via `@flue/sdk`
  (`src/agent/runner.ts`), which has no Node-only dependencies and runs fine
  under Bun.
- `agent.hostUrl` in paperhanger's config can point at an externally deployed
  instance of this app instead, in which case nothing is spawned locally.

## Layout

```
agent-host/
  flue.config.ts            # target: "node"
  src/
    app.ts                   # custom Hono app: mounts flue() + adds /healthz
    contract.ts              # Valibot schemas for the workflow input/output contract
    fix-agent.ts              # defineAgent: model, instructions, sandbox, tools
    tools.ts                  # defineTool: query_telemetry
    telemetry-client.ts        # minimal read-only GreptimeDB HTTP client
    lib/                       # pure, @flue/*-free modules -- unit tested by the
                                # main repo's `bun test` (root package.json "test")
      redaction.ts              # clone-token extraction + multi-secret redaction
      output-sanitizer.ts        # central WorkflowOutput redaction (collectSecrets/sanitizeOutput)
      sql-guard.ts               # read-only single-statement SQL guard (telemetry-client.ts)
      test-detection.ts          # test-command selection from a file-existence probe
      fix-attempt-policy.ts       # pure retry/give-up/commit decision for the fix-retry loop
      tamper-check.ts            # remote/branch tamper-check comparison
    workflows/
      fix-incident.ts          # defineWorkflow: diagnose -> fix -> test -> push
  scripts/
    smoke.mjs                 # Node-run schema/shape smoke test (no model/sandbox needed)
```

Flue discovers `workflows/<name>.ts` by filename — `workflows/fix-incident.ts`
is the `fix-incident` workflow, invoked as `POST /workflows/fix-incident`
(admitted by the `route` export in that file). `fix-agent.ts` is *not* under
`agents/` on purpose: it's private to this one workflow (no persistent,
addressable agent route is needed), which Flue's docs explicitly allow ("the
agent may be private to the workflow").

Relative imports in `src/` use explicit `.ts` extensions so the sources can
also be loaded directly by plain Node (used by `scripts/smoke.mjs`), not just
through Flue's bundler.

`src/lib/*.ts` deliberately import nothing from `@flue/*` (not even
transitively): `src/workflows/fix-incident.ts` imports `src/fix-agent.ts`,
which imports `local` from `@flue/runtime/node`, which statically imports
`node:sqlite` — a module Bun does not implement (see "Why a separate Node
app?" above). Since the main repo's `bun test` runs under **Bun**, any test
file that imports the workflow module directly fails immediately with `error:
No such built-in module: node:sqlite`, regardless of what it's actually
trying to test. Keeping the security-relevant deterministic logic
`@flue/*`-free in `lib/` is what makes it possible to unit test at all
outside of `agent-host`'s own Node-only `bun install`/`flue build` cycle.

## Workflow contract

Input (`WorkflowInputSchema` in `src/contract.ts`; mirrored as a Zod schema at
`src/agent/contract.ts` in the parent repo, since that Bun-side process cannot
import this package directly):

```ts
{
  incidentId: string;
  contextMarkdown: string;       // rendered IncidentContext (alert + collected telemetry)
  alert: {
    title: string; severity: string; source: string; generatorUrl?: string;
    labels: Record<string, string>; annotations: Record<string, string>;
  };
  repo: {
    owner: string; repo: string;
    cloneUrl: string;             // HTTPS URL with an embedded installation token -- SECRET
    defaultBranch: string; branchName: string;
  };
  limits: { timeoutMinutes: number; maxDiffLines: number; maxFixAttempts: number };
  forbiddenPaths: string[];
  // Discriminated union on `source`; "greptimedb" is the only backend today
  // (mirrors the parent repo's `src/config/schema.ts` `TelemetrySchema`).
  telemetry?: { source: "greptimedb"; url: string; database: string; auth?: string };
}
```

Output (`WorkflowOutputSchema`):

```ts
{
  outcome: "fixed" | "report_only" | "failed";
  diagnosis: string;   // markdown root-cause analysis
  report: string;      // markdown, full write-up for notification/PR body
  fix?: {               // present iff outcome === "fixed"
    branch: string; commitMessage: string; changedFiles: string[];
    testCommand?: string; testsPassed: boolean;
  };
  failureReason?: string;
}
```

This workflow only **pushes** a branch on `outcome: "fixed"` — it never opens
a pull request. The parent repo's `src/agent/runner.ts` re-derives the actual
diff via the GitHub compare API (never trusting this workflow's own
self-reported `changedFiles`), checks it against `forbiddenPaths`/
`maxDiffLines`, and only then creates the PR (or deletes the pushed branch and
reports a failure if a guardrail is violated).

### Secret handling

`repo.cloneUrl` embeds a short-lived GitHub App installation token. Since the
model has unrestricted shell access inside `local()` for the whole diagnose
step, this workflow treats the token as reachable-by-the-model unless proven
otherwise, and defends in depth at every stage:

1. **Scrub immediately after clone.** `git clone` necessarily embeds the
   token in the remote URL (that's how the checkout gets read access), which
   git persists to `.git/config` as `origin`. Before the first model turn
   (`cloneAndPrepareBranch`, out-of-band via `harness.shell()`, never
   `session.shell()`), the workflow runs `git remote set-url origin
   <tokenless URL>`. From that point on, nothing on disk in the checkout
   carries a credential the model could read back out (`cat .git/config`,
   `git remote -v`, etc.) and reuse to push to an arbitrary ref — which would
   otherwise bypass the parent repo's compare-API guardrails, since those
   only ever inspect this run's own fixed incident branch.
2. **Never push through `origin`.** The final push
   (`commitAndPush`/`runRemoteGitCommandOrThrow`) passes the credentialed URL
   as a one-off `git push <credentialed-url> HEAD:<branchName>` command
   argument, executed out-of-band. It is never written to `.git/config` and
   never appears in the model's conversation transcript.
3. **Tamper check before the deterministic commit+push.**
   `verifyNoTamper` re-reads `git remote get-url origin` and the current
   branch immediately before `commitAndPush` does anything, and fails the
   run closed (`outcome: "failed"`) if either no longer matches what step 1
   set up — catching other forms of checkout tampering even though the push
   target itself no longer depends on `origin`.
4. **Central output redaction.** Every string this workflow returns
   (`diagnosis`, `report`, `fix.commitMessage`, `failureReason`) passes
   through a single `sanitizeOutput()` (`src/lib/output-sanitizer.ts`) right
   before `run()` returns, which redacts both the clone token — derived
   deterministically from `input.repo.cloneUrl` via `extractCloneToken`,
   never by pattern-matching arbitrary text — and the telemetry backend's
   auth value (`input.telemetry.auth`, for the current "greptimedb" source),
   when configured. This replaces the
   old approach of only redacting the workflow's own catch-block error
   message: a model-authored `report`/`commitMessage` could in principle echo
   either secret back (e.g. a `query_telemetry` tool result, or the model
   deciding to `cat` something it shouldn't).
5. **Named timeouts on every out-of-band git command** (`CLONE_SHELL_TIMEOUT_MS`
   = 5 min, `LOCAL_GIT_SHELL_TIMEOUT_MS` = 1 min, `PUSH_SHELL_TIMEOUT_MS` =
   2 min), so a hung `git` process can't stall an incident indefinitely the
   way an untimed clone/push previously could (the test-run step was already
   capped at 10 minutes).
6. **Verified: the workflow input is never interpolated into the model
   prompt.** `buildDiagnosisPrompt`/`buildRetryPrompt` only surface
   `contextMarkdown`, `forbiddenPaths`, `limits.maxDiffLines`, and the test
   command/output — never `input.repo.cloneUrl`. The static
   `FIX_AGENT_INSTRUCTIONS` in `src/fix-agent.ts` isn't templated at all.
   Confirmed by direct code reading; no fix was needed here.

The extracted pure logic behind points 1-3-4 above
(`extractCloneToken`/`redactSecrets`, `checkForTamper`, `collectSecrets`/
`sanitizeOutput`) lives in `src/lib/` — see "Layout" below — specifically so
it has no `@flue/*` import and is unit-testable by the main paperhanger
repo's `bun test` (`bun run test` from the repo root runs `bun test src
agent-host/src`).

## The `query_telemetry` tool

`src/tools.ts` defines a `query_telemetry` tool so the model can run follow-up
log/trace/metric queries during diagnosis, beyond what was already collected
into `contextMarkdown`. `kind: "sql"` accepts only a single `SELECT`/`SHOW`/
`DESC` statement (rejects writes and multi-statement input); `kind: "promql"`
runs an instant or range query against GreptimeDB's Prometheus-compatible API.

The tool reads its telemetry backend config from a single `PAPERHANGER_TELEMETRY`
environment variable — the whole `source`-discriminated config, serialized as
JSON (set by the parent repo's sidecar when it spawns this process; see
`buildSpawnEnv` in `src/agent/sidecar.ts`) — rather than from the
per-invocation `telemetry` field on the workflow input. This is a deliberate
choice, not an oversight: `defineAgent()`'s initializer — where `tools` is
assigned — only receives `{ id, env }`, not the workflow's `input`, so a tool
list cannot be conditioned on a specific invocation's payload. Since one
agent-host process serves one paperhanger deployment with one fixed telemetry
backend, env-var presence is an equivalent, always-correct signal for "is
telemetry configured for this deployment" — tool registration is skipped
entirely (`createTelemetryTools()` returns `[]`) when that env var is absent
or fails to parse.

`createTelemetryTools()` `switch`es on `config.source` to build the
source-appropriate tool set (today: `query_telemetry` for `"greptimedb"`,
backed by `src/telemetry-client.ts`). This `switch` is the single dispatch
point in agent-host for telemetry backend kind — a future source (Loki,
Tempo, ...) registers its own query kinds by adding a `case` here, mirroring
the parent repo's `src/telemetry/factory.ts`, and nowhere else.

## Sandbox

Uses `local()` from `@flue/runtime/node` — direct host filesystem/shell
access, `cwd` set to a fresh temp directory per workflow run (keyed by the
run id, so concurrent incidents never collide). `local()` provides **no
isolation of its own**; the agent-host container itself is the isolation
boundary (per `docs/architecture.md`).

### Env sanitization for model-facing shells (investigated, already enforced)

Every command the model runs — via its own bash-like tool, or via
`session.shell()` — and every out-of-band `harness.shell()` call this
workflow makes, goes through the same `local()`-provided `exec()`. Reading
the installed `@flue/runtime` package
(`node_modules/@flue/runtime/dist/node/index.mjs`, confirmed against the
bundled `guide/sandboxes` doc), per-command env sanitization is not just
*possible* — it's `local()`'s enforced default behavior:

- `local()` snapshots `process.env` through a **fixed allowlist**
  (`DEFAULT_LOCAL_ENV_ALLOWLIST`: `PATH`, `HOME`, `USER`, `LOGNAME`,
  `HOSTNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `TMPDIR`,
  `TMP`, `TEMP` — all explicitly documented as "nothing on this list should
  be sensitive on a typical host"), then layers whatever the caller passes
  via `local({ env })` on top. Anything not on the allowlist and not
  explicitly passed is simply absent from the child process's environment —
  the underlying `child_process.spawn()` call receives exactly this resolved
  env object, never a `{ ...process.env, ...overrides }` merge.
- `src/fix-agent.ts` calls `local({ env: { GIT_TERMINAL_PROMPT: "0" } })` —
  the only var explicitly added on top of the allowlist. `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `PAPERHANGER_TELEMETRY` (which may
  carry a telemetry backend auth value), and `GITHUB_APP_PRIVATE_KEY` (this
  process's own provider/telemetry credentials, per "Model" and
  `src/tools.ts` above) are therefore **never** exposed to any model-facing
  shell, by construction — not because of any code added here, but because
  `local()` requires them to be explicitly opted in via `env`, and nothing in
  this app does that.
- Per-call `ShellOptions.env` (available to both `harness.shell()` and
  `session.shell()`) layers further on top of that same base for one
  command, which is what this workflow's own out-of-band git commands use
  for timeouts, not additional env exposure.

**Residual risk** (documented, not fixed by env sanitization): `local()`
still provides **no isolation boundary** beyond the env allowlist. A
model-directed shell inside this container can read/write anything the
container's filesystem permissions allow, reach any network destination the
container can reach, and — for the one run in progress — has whatever the
credentialed clone URL grants until the token expires. The
`GIT_TERMINAL_PROMPT=0`-only footprint keeps *secrets* out, but does not
sandbox the *repository checkout, filesystem, or network* the way a
provider-managed remote sandbox (Daytona, E2B, Cloudflare Sandbox) would.
For a single-tenant deployment where the agent-host container itself is
disposable per deployment (the current architecture), this is an accepted
tradeoff. **If paperhanger is ever run in a hostile-tenant scenario** — e.g.
one agent-host instance servicing untrusted/adversarial target
repositories, or a threat model where a compromised target repo's own build
scripts (executed during test-detection/test-run) might attempt to pivot —
switch `fixAgent`'s `sandbox` to a remote sandbox provider instead of
`local()`, per `docs/research/flue.md` section 6 and the upstream
`guide/sandboxes` doc's own guidance ("use a remote sandbox when agent work
needs an environment that should not run on the application host").

## Durable execution / persistence

No `src/db.ts` is configured for v1: Node falls back to in-memory SQLite,
which is fine for a single-process deployment where a lost in-flight run
just gets retried by paperhanger's own incident state machine on restart (see
`docs/research/flue.md` section 5's recovery-semantics table — Node has no
crash-recovery path that terminalizes a hung run, so paperhanger's own
staleness checks matter more than this app's own persistence).

To make canonical conversation/run state survive a restart (and share
paperhanger's own PostgreSQL when configured), add later:

```ts
// src/db.ts
import { postgres } from "@flue/postgres";
import { sql } from "bun:sql"; // or any driver wrapped in the same shape

export default postgres({
  query: (text, params) => sql.unsafe(text, params),
  transaction: (fn) => sql.begin((tx) => fn({ query: (t, p) => tx.unsafe(t, p) })),
  close: () => {},
});
```

`@flue/postgres`'s `postgres()` adapter is driver-agnostic (`{ query,
transaction, close }`), not bundled with a driver — see
`docs/research/flue.md` section 5 for the verified `.d.ts` shape. Pin it to
the same `1.0.0-beta.9` as the other `@flue/*` packages here.

## Model

`FLUE_MODEL` env var (default `anthropic/claude-sonnet-4-6`, matching
`docs/spec.md` section 3.6), set by the parent repo's sidecar from
`config.agent.model`. Provider credentials (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`) are passed through from the sidecar's
own process environment.

## Building and running

```bash
bun install                       # or npm/pnpm install -- this is a plain Node package
ANTHROPIC_API_KEY=... bun run --bun flue build --target node   # or: bunx flue build --target node
node dist/server.mjs              # PORT env var, default 3000
curl localhost:3000/healthz       # -> {"ok":true}
```

Requires Node >= 22.19 to *run* the built server (`node:sqlite`); `flue
build` itself works fine under Bun since building doesn't touch the Node-only
runtime path. Verified against Node 22.22.3 and 26.5.0.

## Smoke test

```bash
node scripts/smoke.mjs
```

Imports `src/contract.ts` and `src/workflows/fix-incident.ts` directly (no
build step) and asserts the input/output schemas parse example payloads as
expected, and that the discovered workflow module has a well-formed
`defineWorkflow()` default export. This does **not** exercise the sandbox or
call a real model — it is a fast, no-network structural check, meant to catch
contract drift and import/wiring errors, not full pipeline behavior.

## Unit tests (`src/lib/`)

```bash
# From this directory:
bun test src/lib

# Or from the main repo root (this is what CI/`bun run test` actually runs):
cd .. && bun run test   # -> bun test src agent-host/src
```

Every `src/lib/*.ts` module is colocated with a `*.test.ts` suite runnable
directly by **Bun**, unlike `scripts/smoke.mjs` (Node-only, see "Layout"
above) or the rest of this package (which needs `agent-host`'s own
`node_modules`/`flue build` cycle). This is the primary coverage for the
security-relevant deterministic logic described under "Secret handling" and
"Env sanitization" above: token extraction/redaction, the read-only SQL
guard, test-command detection, and the remote/branch tamper check.

## Version pinning

All `@flue/*` packages are pinned to the exact version `1.0.0-beta.9`
(`@flue/github` is not used anywhere in this app — see
`docs/research/flue.md` section 9). Flue is pre-1.0 beta software with an
explicitly reset-only persisted schema; do not float these to a semver range.
