# paperhanger agent-host

The Flue-based fix agent for [paperhanger](../README.md), packaged as a
**separate, Node-only application**. This is not part of the main Bun
process's dependency graph — it has its own `package.json`, its own
`node_modules`, and is built/run independently. See the parent repo's
`docs/architecture.md` ("Flue agent host (Node sidecar)") and
`docs/research/flue.md` for the full rationale.

## Why a separate Node app?

Flue's Node-target server (`vite build` -> `dist/server.mjs`) unconditionally
imports `@flue/runtime/node`, which statically imports `node:sqlite` — a
module Bun does not implement. The core runtime APIs run fine under Bun, but
a *served* Flue app cannot. So:

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
  vite.config.ts            # vite + flue() plugin (the Flue 2 build)
  src/
    app.ts                   # custom Hono app: mounts the agent router + /healthz
    contract.ts              # Valibot schemas for the agent input/output contract
    fix-agent.ts              # "use agent" agent function: instructions + hooks
    fix-incident.ts           # deterministic host steps: diagnose -> fix -> test -> push
    tools.ts                  # defineTool: query_telemetry
    telemetry-client.ts        # HTTP client for the parent's POST /telemetry/query callback (no direct backend access, no backend credentials)
    lib/                       # pure, @flue/*-free modules -- unit tested by the
                                # main repo's `bun test` (root package.json "test")
      redaction.ts              # clone-token extraction + multi-secret redaction
      output-sanitizer.ts        # central FixIncidentOutput redaction (collectSecrets/sanitizeOutput)
      sql-guard.ts               # read-only single-statement SQL guard (imported by the PARENT's src/telemetry/followup.ts; see "The query_telemetry tool" below)
      telemetry-descriptions.ts  # per-source query_telemetry tool description, with a safe default for an unrecognized source name
      test-detection.ts          # test-command selection from a file-existence probe
      fix-attempt-policy.ts       # pure retry/give-up/commit decision for the fix-retry loop
      tamper-check.ts            # remote/branch tamper-check comparison
      diagnosis-prompt.ts        # first-turn diagnosis prompt builder
      system-prompt.ts           # operator-instructions prompt section
      common-setup-scripts.ts    # trigger-file-gated common setup scripts
  scripts/
    smoke.mjs                 # Node-run schema/shape smoke test (no model/sandbox needed)
```

Routing is explicit (Flue 2 has no directory discovery): `src/app.ts` mounts
`createAgentRouter(FixIncidentAgent)` at `/agents/fix-incident`, so each run
is a conversation admitted as `POST /agents/fix-incident/<run-id>` with the
run input passed as `initialData` (validated against
`FixIncidentAgent.initialData`). `fix-agent.ts` carries the `"use agent"`
directive that registers it with the Flue build.

Relative imports in `src/` use explicit `.ts` extensions so the sources can
also be loaded directly by plain Node (used by `scripts/smoke.mjs`), not just
through Flue's bundler.

`src/lib/*.ts` deliberately import nothing from `@flue/*` (not even
transitively): `src/fix-agent.ts` imports `local` from `@flue/runtime/node`,
which statically imports `node:sqlite` — a module Bun does not implement (see
"Why a separate Node app?" above). Since the main repo's `bun test` runs
under **Bun**, any test file that imports the agent module directly fails
immediately with `error: No such built-in module: node:sqlite`, regardless of
what it's actually trying to test. Keeping the security-relevant
deterministic logic `@flue/*`-free in `lib/` is what makes it possible to
unit test at all outside of `agent-host`'s own Node-only `bun
install`/`vite build` cycle.

## Agent contract

Input (`FixIncidentInputSchema` in `src/contract.ts`; mirrored as a Zod schema
at `src/agent/contract.ts` in the parent repo, since that Bun-side process
cannot import this package directly):

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
    setupScript?: string;         // repo-definition override, run right after clone
    setupScripts?: { triggerFile: string; script: string }[];  // common, trigger-file-gated
    testCommand?: string;         // repo-definition override for test auto-detection
  };
  limits: { timeoutMinutes: number; maxDiffLines: number; maxFixAttempts: number };
  forbiddenPaths: string[];
  systemPrompt?: string;          // dashboard-managed operator instructions (all repos)
}
```

Note there is no `telemetry` field: the fix agent's `query_telemetry` tool
gets its backend access through an env-configured HTTP callback into the
parent process, not through the agent input -- see "The `query_telemetry`
tool" below. This process never holds a telemetry backend's URL, database
name, or auth value at all.

Output (`FixIncidentOutputSchema`):

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

This agent only **pushes** a branch on `outcome: "fixed"` — it never opens a
pull request. The parent repo's `src/agent/runner.ts` re-derives the actual
diff via the GitHub compare API (never trusting the agent's self-reported
`changedFiles`), checks it against `forbiddenPaths`/
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
   (`cloneAndPrepareBranch`, out-of-band via the host's own `sandbox.exec()`,
   never the model-facing bash tool), the host runs `git remote set-url
   origin <tokenless URL>`. From that point on, nothing on disk in the
   checkout carries a credential the model could read back out (`cat
   .git/config`,
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
4. **Central output redaction.** Every string this agent returns
   (`diagnosis`, `report`, `fix.commitMessage`, `failureReason`) passes
   through a single `sanitizeOutput()` (`src/lib/output-sanitizer.ts`) right
   before `run()` returns, which redacts both the clone token — derived
   deterministically from `input.repo.cloneUrl` via `extractCloneToken`,
   never by pattern-matching arbitrary text — and this process's own
   telemetry callback token (`PAPERHANGER_TELEMETRY_CALLBACK_TOKEN`), when
   set. This replaces the old approach of only redacting the workflow's own
   catch-block error message: a model-authored `report`/`commitMessage`
   could in principle echo either secret back (e.g. a `query_telemetry`
   tool result, or the model deciding to `cat` something it shouldn't).
   Note there is no telemetry backend URL/database/auth value to redact
   here anymore -- this process never receives one; see "The
   `query_telemetry` tool" below.
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
into `contextMarkdown`. Unlike the tool's original design, this process never
talks to a telemetry backend directly: `run()` POSTs the request
(`src/telemetry-client.ts`) to the parent repo's own `POST /telemetry/query`
route, which dispatches it to whichever `TelemetrySource` the parent already
constructed (`src/telemetry/followup.ts` in the parent repo) and reuses that
source's existing escaping/validation. This works against every telemetry
source the parent supports, not just GreptimeDB.

The request shape is `{ signal: "logs"|"traces"|"metrics", timeRange, filter?,
expression?, limit? }`. `filter` (structured label equality) is the main path;
`expression` is a narrow escape hatch -- the backend-specific metric query for
`signal: "metrics"`, or (GreptimeDB only) a single read-only SQL statement for
`signal: "logs"`/`"traces"`. `limit` is honored for every path, including the
raw-SQL one: the parent's `followup.ts` appends a `LIMIT` clause to a `SELECT`
that doesn't already carry a (small enough) one of its own before running it,
so `expression` can't run fully unbounded against the backend just because it
bypassed the structured builders. A query outside the configured source's
capabilities (a missing required hint, or `expression` against a non-GreptimeDB
source) comes back as an empty result with an explanatory `notes` entry rather
than failing; a genuine backend failure/timeout throws, which `run()`
propagates unchanged so Flue surfaces it to the model as a tool error for a
retry-or-rephrase decision.

The tool reads its callback config from three environment variables --
`PAPERHANGER_TELEMETRY_CALLBACK_URL`, `_TOKEN`, and `_SOURCE`. In the default
internal agent-host mode these are set automatically by the parent repo's
sidecar when it spawns this process (see `buildSpawnEnv` in
`src/agent/sidecar.ts`); `_TOKEN` is a DEDICATED bearer token for that one
route, deliberately separate from the parent's dashboard/incident-CRUD
`server.apiToken`. **In external agent-host mode** (the parent's
`agent.hostUrl` set), the parent process never spawns this one, so it never
sets any of the three -- the operator running this process must set all
three themselves: `PAPERHANGER_TELEMETRY_CALLBACK_URL` to the parent's own,
externally-reachable `/telemetry/query` endpoint (e.g.
`https://<paperhanger-host>/telemetry/query` -- NOT the parent's internal
`http://127.0.0.1:<port>/telemetry/query` default, which is only reachable
when this process happens to share the parent's network namespace),
`PAPERHANGER_TELEMETRY_CALLBACK_TOKEN` matching the parent's configured
`agent.telemetryCallbackToken`, and `PAPERHANGER_TELEMETRY_CALLBACK_SOURCE`
matching the parent's `config.telemetry.source`. Tool registration is
skipped entirely (`createTelemetryTools()` returns `[]`) when any of the
three is absent -- covering "no telemetry backend configured" and, in
external agent-host mode, "the operator didn't set these three env vars on
this process" (see the parent repo's `src/config/schema.ts` for the
`telemetryCallbackToken` config field).

`_SOURCE` (the parent's `config.telemetry.source`) is used only to build the
tool's `description` via `describeTelemetrySource`
(`src/lib/telemetry-descriptions.ts`), so the model is told the real
per-backend capability limits up front (e.g. Zabbix: logs are problem/event
history, traces don't exist, metrics need an explicit item key). That lookup
has a SAFE DEFAULT for a source name it doesn't recognize -- e.g. a future
`composite` source -- so an unrecognized name degrades to a generic
description rather than crashing or asserting.

## Sandbox

Uses `local()` from `@flue/runtime/node` — direct host filesystem/shell
access, `cwd` set to a fresh temp directory per conversation (keyed by the
conversation id, so concurrent incidents never collide). `local()` provides
**no isolation of its own**; the agent-host container itself is the
isolation boundary (per `docs/architecture.md`).

### Env sanitization for model-facing shells (investigated, already enforced)

Every command the model runs via its bash-like tool, and every out-of-band
`sandbox.exec()` call the host makes, goes through the same
`local()`-provided `exec()`. Reading the installed `@flue/runtime` package
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
- `src/fix-agent.ts` calls `local({ env: { GIT_TERMINAL_PROMPT: "0", MISE_YES:
  "1", MISE_RUBY_COMPILE: "false" } })` — the only vars explicitly added on
  top of the allowlist (the latter two exist to make the paperhanger
  Dockerfile's mise-tool-wrapper on-demand installs behave the same inside a
  model-facing shell as they do container-wide). Every provider API
  key env var the sidecar forwards to this process (`PROVIDER_API_KEY_ENV_VARS`
  in the parent repo's `src/agent/sidecar.ts` — `AI_GATEWAY_API_KEY`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `CEREBRAS_API_KEY`,
  `DEEPSEEK_API_KEY`, `FIREWORKS_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`,
  `HF_TOKEN`, `KIMI_API_KEY`, `MINIMAX_API_KEY`, `MISTRAL_API_KEY`,
  `MOONSHOT_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `TOGETHER_API_KEY`, `XAI_API_KEY`, `ZAI_API_KEY`), plus
  `PAPERHANGER_TELEMETRY_CALLBACK_TOKEN` (the dedicated bearer token for the
  `query_telemetry` proxy's callback route -- see "The `query_telemetry`
  tool" above; this process holds no telemetry backend URL/database/auth
  value at all anymore), are therefore **never** exposed to any model-facing
  shell, by construction
  — not because of any code added here, but because `local()` requires them
  to be explicitly opted in via `env`, and nothing in this app does that.
  `GITHUB_APP_PRIVATE_KEY` is a different case, not an example of the same
  allowlist protection: the sidecar's `buildSpawnEnv` never forwards it to
  this process at all (it's in neither `PASSTHROUGH_ENV_VARS` nor
  `PROVIDER_API_KEY_ENV_VARS`), so it's absent from this process's
  environment entirely, not merely kept off model-facing shells by the
  allowlist.
- Per-call `exec()` options layer further on top of that same base for one
  command, which is what the host's own out-of-band git commands use for
  timeouts, not additional env exposure.

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
transaction, close }`), not bundled with a driver — the `.d.ts` shape
verified in `docs/research/flue.md` section 5 still holds at 2.x. Pin it to
the same `2.0.1` as the other `@flue/*` packages here.

## Model

`FLUE_MODEL` env var (default `anthropic/claude-sonnet-4-6`, matching
`docs/spec.md` section 3.6), set by the parent repo's sidecar from
`config.agent.model`. Provider credentials for every supported model prefix
(`anthropic/`, `openai/`, `openrouter/`, `google/`, `deepseek/`, `xai/`,
`groq/`, `mistral/`, `zai/`, `minimax/`, `fireworks/`, `together/`,
`cerebras/`, `huggingface/`, `kimi-coding/`, `moonshotai/`,
`vercel-ai-gateway/`) are passed through from the sidecar's own process
environment — see `PROVIDER_API_KEY_ENV_VARS` in the parent repo's
`src/agent/sidecar.ts` (or the root README's "Provider API keys" row) for the
full env-var-to-prefix mapping.

## Building and running

```bash
bun install                       # or npm/pnpm install -- this is a plain Node package
ANTHROPIC_API_KEY=... bun run build   # vite build (see package.json scripts)
node dist/server.mjs              # PORT env var, default 3000
curl localhost:3000/healthz       # -> {"ok":true}
```

Requires Node >= 22.19 to *run* the built server (`node:sqlite`); `vite
build` itself works fine under Bun since building doesn't touch the
Node-only runtime path. Verified against Node 22.22.3 and 26.5.0.

## Smoke test

```bash
node scripts/smoke.mjs
```

Imports `src/contract.ts` and `src/fix-agent.ts` directly and asserts the
input/output schemas parse example payloads as expected and that
`FixIncidentAgent` is well-formed (`agentName`, `initialData`). It then boots
the built `dist/server.mjs` (run `bun run build` first) and checks `/healthz`
plus route admission (invalid `initialData` -> 400, valid -> 202). This does
**not** exercise the sandbox or call a real model — it is a fast, no-network
structural check, meant to catch contract drift and import/wiring errors, not
full pipeline behavior.

## Unit tests (`src/lib/`, plus `tools.ts`/`telemetry-client.ts`)

```bash
# From this directory:
bun test src

# Or from the main repo root (this is what CI/`bun run test` actually runs):
cd .. && bun run test   # -> bun test src agent-host/src
```

Every `src/lib/*.ts` module is colocated with a `*.test.ts` suite runnable
directly by **Bun**, unlike `scripts/smoke.mjs` (Node-only, see "Layout"
above) or `fix-agent.ts`/`fix-incident.ts` (which import `local` from
`@flue/runtime/node`, and so need `agent-host`'s own Node-only `bun
install`/`vite build` cycle). This is the primary coverage for the
security-relevant deterministic logic described under "Secret handling" and
"Env sanitization" above: token extraction/redaction, the read-only SQL
guard, test-command detection, and the remote/branch tamper check.

`tools.ts` and `telemetry-client.ts` are colocated with their own
`*.test.ts` too: unlike `fix-agent.ts`, they only import the non-Node
`@flue/runtime` entrypoint (not `@flue/runtime/node`), which has no
`node:sqlite` dependency and runs fine under Bun -- covering
`createTelemetryTools()`'s env-var gating, the request/response schema, and
the callback HTTP client's request/error handling.

## Version pinning

All `@flue/*` packages are pinned to the exact version `2.0.1`
(`@flue/github` is not used anywhere in this app — see
`docs/research/flue.md` section 9). Flue is no longer pre-1.0 beta, but do
not float these to a semver range: the beta -> 2.0.1 upgrade was a breaking
redesign that required a code migration (PR #8), and a persisted database
written by an incompatible Flue version refuses to start rather than
migrating in place. Upgrades stay deliberate, tested changes.
