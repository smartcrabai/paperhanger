# Flue Framework — API Reference for paperhanger's Fix Agent

Research notes for embedding [Flue](https://flueframework.com/) as the durable "fix agent" runtime
(`src/agent/fix-agent.ts`, `src/agent/tools.ts`, `src/agent/runner.ts` per `docs/architecture.md`).

**Sourcing key**: every fact below is tagged `[docs]` (from the flueframework.com website, fetched
2026-07-17), `[cli-docs]` (from the offline docs bundled in the installed `@flue/cli`, via
`flue docs read <path>` — ground truth for the exact installed version), or `[verified]` (empirically
confirmed by installing the real packages and running code in a scratchpad project). Anything not
confirmed by an actual install is marked `[docs-only, unverified]`. Package version tested:
**`1.0.0-beta.9`** (`@flue/github` is `1.0.0-beta.1`).

## 0. TL;DR

- Packages: `@flue/runtime`, `@flue/cli` (dev), `@flue/sdk` (HTTP client), `@flue/postgres`,
  `@flue/github`. All installed cleanly with `bun add` `[verified]`.
- `defineAgent`/`defineTool`/`defineWorkflow`/`dispatch`/`invoke` from `@flue/runtime` import and run
  fine under Bun 1.3.14 `[verified]`.
- **The generated Node production server (`flue build --target node` → `dist/server.mjs`) does not
  run under Bun.** It unconditionally imports `@flue/runtime/node`, which statically imports Node's
  `node:sqlite` module — a module Bun 1.3.14 does not implement — so `bun dist/server.mjs` fails
  instantly with `error: No such built-in module: node:sqlite`, regardless of whether you configure
  `db.ts` or use `local()` `[verified]`. `node dist/server.mjs` works fine `[verified]`.
- Recommended architecture for paperhanger: run the Flue agent/workflow as a **Node.js** process
  (sidecar in the same container, or a `node` subprocess) and drive it from the Bun server over HTTP
  using `@flue/sdk`'s `createFlueClient()`, which has no Node-only dependencies and is confirmed to
  import and run under Bun `[verified]`.
- Model specifiers are `"<provider>/<model-id>"` strings (e.g. `anthropic/claude-sonnet-4-6`);
  provider credentials come from plain env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`) `[cli-docs]`.
- `@flue/postgres`'s `postgres()` adapter does **not** bundle a driver — you hand it a small
  `{ query, transaction, close }` shape, which `Bun.sql` can satisfy directly `[verified from .d.ts,
  contradicts the website's simplified example]`.
- `@flue/github` only verifies inbound GitHub webhooks and gives you a conversation-key helper; it
  has no "open a PR" API. PR creation is your own Octokit/`gh` call, run from inside the sandbox or a
  tool `[verified from .d.ts]`.
- Flue is pre-1.0 beta software: "the occasional breaking change" is explicitly expected before a
  stable 1.0, and multi-node (horizontally scaled) Node deployment is not yet supported — one live
  process must own each agent instance `[docs]`.

---

## 1. Install

```bash
bun add @flue/runtime valibot
bun add -d @flue/cli
```

`bun add` works directly — no npm fallback was needed `[verified]`. Versions resolved:

| Package | Version installed | `engines.node` |
|---|---|---|
| `@flue/runtime` | `1.0.0-beta.9` | `>=22.19.0` |
| `@flue/cli` | `1.0.0-beta.9` | `>=22.19.0` |
| `@flue/sdk` | `1.0.0-beta.9` | *(none — no engines field)* |
| `@flue/postgres` | `1.0.0-beta.9` | `>=22.19.0` |
| `@flue/github` | `1.0.0-beta.1` | `>=22.19.0` |
| `valibot` (peer) | `1.4.2` | — |

`[verified]` (read directly from each package's installed `package.json`). `bun add` reported
"Blocked 5 postinstalls" for transitive optional deps (`@google/genai`, `@mongodb-js/zstd`,
`node-liblzma`, `protobufjs` — pulled in by the multi-provider model catalog, `@earendil-works/pi-ai`)
— these are native/build-script postinstalls that Bun blocks by default; none were needed to import
or run the core API in testing.

`.env` is loaded automatically by `flue build`/`flue dev`/`flue run` before configuration, but **not**
by the built `dist/server.mjs` itself — the running server only sees whatever environment it was
started with `[cli-docs]`. This is convenient for paperhanger, since Bun already auto-loads `.env`.

Bootstrap a project (not required for library usage, only for the standalone CLI/build workflow):

```bash
npx flue init --target node        # writes flue.config.ts
```

```ts
// flue.config.ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({ target: 'node' });
```

## 2. Package map

- **`@flue/runtime`** — the core library: `defineAgent`, `defineTool`, `defineAction`,
  `defineAgentProfile`, `defineWorkflow`, `dispatch`, `invoke`, `connectMcpServer`,
  `registerProvider`/`registerApiProvider`, `observe`, `getRun`/`listRuns`/`listAgents`. Subpath
  exports: `./routing` (Hono app composition), `./node` (Node-only `local()` sandbox + `sqlite()`
  persistence), `./cloudflare` (Workers-only), `./adapter` (persistence-adapter authoring contract),
  `./tool` (tool-entrypoint helper), `./test-utils`.
- **`@flue/cli`** — `flue` binary: `init`, `dev`, `build`, `run`, `add`, `update`, `docs`. Dev-time
  only; not a runtime dependency of a deployed app.
- **`@flue/sdk`** — `createFlueClient()` HTTP/stream client for a *deployed* Flue app
  (`client.agents`, `client.workflows`, `client.runs`). This is the piece paperhanger's Bun process
  would import.
- **`@flue/postgres`** — Postgres-backed `PersistenceAdapter` for the Node target, driver-agnostic.
- **`@flue/github`** — verified GitHub webhook ingress + conversation-key helpers (inbound only).
- Ecosystem sandboxes referenced by the site but not installed in this probe: `@daytona/sdk` (via
  `flue add sandbox daytona`), `e2b` (via `flue add sandbox e2b`) `[docs, unverified]`.

## 3. Core agent API (`@flue/runtime`)

Confirmed against the installed package's bundled docs (`flue docs read api/agent-api`) and by
actually calling these functions under Bun.

### `defineAgent`

```ts
function defineAgent<TEnv = Record<string, any>>(
  initialize: (context: AgentInitializerContext<TEnv>) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): AgentDefinition<TEnv>;

interface AgentInitializerContext<TEnv> {
  id: string;     // agent instance id, or workflow run id when bound to a workflow
  env: TEnv;      // platform environment bindings
}

interface AgentRuntimeConfig {
  description?: string;
  profile?: AgentProfile;
  model?: string;                       // "<provider>/<model-id>", e.g. "anthropic/claude-sonnet-4-6"
  instructions?: string;
  skills?: Skill[];
  tools?: ToolDefinition[];
  actions?: ActionDefinition[];
  subagents?: AgentProfile[];
  thinkingLevel?: ThinkingLevel;         // 'off'|'minimal'|'low'|'medium'|'high'|'xhigh', default 'medium'
  compaction?: false | CompactionConfig;
  durability?: DurabilityConfig;         // { maxAttempts=10, timeoutMs=3_600_000 }
  cwd?: string;
  sandbox?: SandboxFactory;              // omit = virtual sandbox
}
```

Example (verified importable/callable under Bun):

```ts
import { defineAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';

const lookupTelemetry = defineTool({
  name: 'lookup_telemetry',
  description: 'Fetch telemetry for an incident by id.',
  input: v.object({ incidentId: v.string() }),
  output: v.object({ summary: v.string() }),
  async run({ input, signal }) {
    return { summary: await fetchTelemetry(input.incidentId, { signal }) };
  },
});

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Diagnose the incident using telemetry and propose a fix.',
  tools: [lookupTelemetry],
}));
```

`defineAgent(...)` is an *initializer*, re-run on every root-harness initialization — do not treat it
as a one-time constructor for a persistent instance `[cli-docs]`.

### `defineTool` — this is the telemetry follow-up query tool primitive

```ts
function defineTool<TInput extends ToolInputSchema | undefined, TOutput extends ToolOutputSchema | undefined>(
  options: {
    name: string;
    description: string;
    input?: TInput;    // Valibot object schema; validated before `run`
    output?: TOutput;   // Valibot schema; validated after `run`
    run: (ctx: { input: InferOutput<TInput>; signal: AbortSignal }) => TOutput extends undefined ? unknown : InferOutput<TOutput>;
  },
): ToolDefinition<TInput, TOutput>;
```

- `input`/`output` are Valibot schemas (`import * as v from 'valibot'`). Validation failures on input
  become a tool error the model can retry against; without an `output` schema, returning `undefined`
  sends `null` to the model `[cli-docs]`.
- A tool's parameters are **model-selected inputs, not an authorization boundary** — scope
  credentials/repo access in the closure around `run`, not from the model-supplied `input`
  `[cli-docs, guide/tools]`.
- The old `parameters`/`execute(args, signal)` shape now throws (`ToolLegacyDefinitionError`); use
  `input`/`run({ input, signal })` and return structured data directly, not `JSON.stringify(...)`
  `[cli-docs]`.
- MCP tools: `connectMcpServer(name, options)` returns already-adapted `ToolDefinition[]` (named
  `mcp__<server>__<tool>`) usable directly in a `tools` array; do not re-wrap with `defineTool()`
  `[cli-docs]`.

### `defineAction` — deterministic, application-orchestrated operations

```ts
function defineAction<TInput, TOutput>(options: {
  name: string;
  description: string;
  input?: TInput;   // Valibot schema
  output?: TOutput;  // Valibot schema
  run(context: ActionContext<TInput>): unknown | Promise<unknown>;
}): ActionDefinition<TInput, TOutput>;

type ActionContext<S> = {
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
} & (S extends ActionInputSchema ? { readonly input: InferOutput<S> } : {});
```

Use an Action (not a tool) when *your application code*, not the model, should control the sequence
of harness/session operations — e.g. "clone repo, run tests, if red retry the diagnose step" as a
fixed pipeline that still uses `harness.session().prompt(...)` internally. Errors:
`ActionInputValidationError`, `ActionOutputValidationError`, `ActionOutputSerializationError`
`[cli-docs]`.

### Harness & Session (what `run({ harness })` gives you)

```ts
interface FlueHarness {
  readonly name: string;
  session(name?: string): Promise<FlueSession>;   // default session name 'default'
  readonly sessions: FlueSessions;                // .get()/.create() with explicit not-found/exists errors
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;  // not recorded in conversation
  readonly fs: FlueFs;                                                     // not recorded in conversation
}

interface FlueSession {
  readonly name: string;
  prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
  skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;
  task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;    // delegate to a subagent
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;  // recorded in conversation
  readonly fs: FlueFs;
  compact(): Promise<void>;
}

interface FlueFs {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;  // auto-creates parent dirs
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
```

`prompt()`/`skill()`/`task()`/`shell()` return `CallHandle<T>` — a `Promise<T>` plus `.signal` and
`.abort(reason?)`. Pass `options.result` (a Valibot schema) to any of `prompt`/`skill`/`task` to get
back validated `response.data` instead of freeform text; failure to produce valid structured data
throws `ResultUnavailableError` `[cli-docs]`.

### Subagents (delegating a diagnosis/fix sub-step)

```ts
const reviewer = defineAgentProfile({
  name: 'test_runner',
  description: 'Runs the project test suite and summarizes failures.',
  instructions: 'Run the test suite and report failing tests with stack traces.',
});

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  subagents: [reviewer],
}));

// inside a workflow/action run():
const result = await (await harness.session()).task('Run tests after the fix.', { agent: 'test_runner' });
```

Subagent profiles are self-contained for capability fields (`instructions`/`tools`/`skills`/
`subagents` — inherited only if the profile itself declares them); `model`/`thinkingLevel`/
`compaction` inherit from the parent as defaults. `durability` is rejected on subagent profiles — a
subagent runs inside the parent's durable operation, not as its own submission `[cli-docs]`.

## 4. Workflows — the natural shape for "diagnose → fix → PR" as one finite job

```ts
function defineWorkflow<TInput, TOutput>(options: {
  agent: AgentDefinition;
  input?: TInput;    // Valibot schema
  output?: TOutput;   // Valibot schema
  run(context: ActionContext<TInput>): unknown | Promise<unknown>;
}): WorkflowDefinition;
// or, bound to an existing Action:
function defineWorkflow<TAction extends ActionDefinition>(options: {
  agent: AgentDefinition;
  action: TAction;
}): WorkflowDefinition<TAction>;
```

```ts
// src/workflows/fix-incident.ts
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

const fixAgent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export default defineWorkflow({
  agent: fixAgent,
  input: v.object({ incidentId: v.string(), repoUrl: v.string() }),
  output: v.object({ prUrl: v.string().nullable(), summary: v.string() }),
  async run({ harness, input }) {
    await harness.shell(`git clone ${input.repoUrl} /workspace/repo`);
    const session = await harness.session();
    await session.prompt(`Diagnose incident ${input.incidentId} using the telemetry tool, then fix it in /workspace/repo.`);
    const test = await session.shell('cd /workspace/repo && npm test');
    // ... open PR via a tool/Action that shells out to `gh pr create` or calls Octokit ...
    return { prUrl: null, summary: test.stdout };
  },
});

export const route: WorkflowRouteHandler = async (_c, next) => next();  // enables POST /workflows/fix-incident
```

- `invoke(workflow, { input })` admits one run and resolves `{ runId }` **without waiting** for the
  Action to finish — this is the fire-and-forget entry point from your own server code, equivalent to
  what an HTTP `route` export triggers `[cli-docs]`.
- `route` (Hono middleware) toggles `POST /workflows/:name`; `runs` (separate export) toggles all HTTP
  access to that workflow's *existing* run resources (`GET/HEAD /runs/:runId`). Both are optional and
  independent — you can invoke a workflow purely programmatically with no HTTP surface at all
  `[cli-docs]`.
- Lifecycle: admit input → validate/transform against the Action's schema → `run_start` → initialize
  agent+harness → run the Action → validate/serialize output → `run_end`. A schema-invalid input
  produces an observable *failed run* without ever initializing the agent or sandbox `[cli-docs]`.
- `dispatch()` (continuing **agents**) and `invoke()`/workflow runs are architecturally distinct:
  dispatched agent input never creates a workflow run and never appears in `client.runs` or `/runs`
  `[cli-docs]`.

## 5. Durable execution & state persistence

`[cli-docs]`, cross-checked against `guide/durable-execution`, `guide/database`, and the
`PersistenceAdapter` `.d.ts`.

### What "durable" means here

Flue keeps one **append-only canonical conversation stream per agent instance** (all sessions in that
instance replay from this one stream) plus a separate workflow-run store, event-stream store, and
immutable attachment store. On restart, Flue replays the canonical stream to reconstruct state and
uses recorded attempt/lease markers to decide what can be safely resumed vs. must be marked
interrupted. **Sandbox files are never part of this** — conversation durability and workspace
durability are two independent choices (§6).

### Configuring persistence — `src/db.ts`

```ts
// SQLite (Node only, via @flue/runtime/node)
import { sqlite } from '@flue/runtime/node';
export default sqlite('./data/flue.db');   // omit path for in-memory (lost on restart)
```

```ts
// Postgres — driver-agnostic adapter (verified from the real .d.ts, NOT the simplified
// `postgres(process.env.DATABASE_URL!)` example shown on the marketing site)
import { postgres, type PostgresQuery } from '@flue/postgres';

declare function postgres(runner: {
  query: PostgresQuery;                                              // (text, params?) => Promise<Row[]>
  transaction<T>(fn: (tx: { query: PostgresQuery }) => Promise<T>): Promise<T>;
  close(): void | Promise<void>;
}): PersistenceAdapter;
```

`@flue/postgres` does **not** bundle a Postgres driver — you wrap whatever client you already use
(node-postgres, porsager `postgres`, Neon, ...) in this three-method shape `[verified from .d.ts]`.
This is good news for paperhanger: `Bun.sql` (per `docs/architecture.md`'s own convention) exposes
`sql.unsafe(text, params)` and `sql.begin(fn)`, which map directly onto this `PostgresRunner`
contract — meaning the *state store* for a Node-run Flue process could still be driven by `Bun.sql`
if that process is a Bun-compatible piece; it's the Flue **server bootstrap itself** that is
Node-only (§8), not the Postgres driver choice.

Without `db.ts`, the Node target keeps everything in **process-local in-memory SQLite** — fine for
one process, lost on every restart `[cli-docs]`.

### `PersistenceAdapter` contract (for a custom adapter, if ever needed)

```ts
interface PersistenceAdapter {
  connect(): PersistenceStores | Promise<PersistenceStores>;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
interface PersistenceStores {
  readonly executionStore: AgentExecutionStore;      // submission lifecycle (not the transcript)
  readonly runStore: RunStore;                       // workflow-run records + listing
  readonly eventStreamStore: EventStreamStore;        // observable runtime events
  readonly conversationStreamStore: ConversationStreamStore; // the sole canonical transcript
  readonly attachmentStore: AttachmentStore;          // immutable payloads referenced by the transcript
}
```
Imported from `@flue/runtime/adapter`. Schema is versioned (`FLUE_SCHEMA_VERSION`, currently v7,
pre-1.0 and reset-only — no in-place migration path) `[cli-docs]`.

### Recovery semantics (Node target, with a durable `db.ts`)

| Scenario | Node, no `db.ts` | Node, durable `db.ts` |
|---|---|---|
| Process dies | All state lost | Durable stores retain conversation + queued work |
| Recovery trigger | None | Replacement process startup + periodic expired-lease scan |
| Already-completed output | — | Reused, not re-run |
| Tool call with no durable result | — | Marked interrupted, **not** auto-rerun (avoids duplicating side effects like a PR creation call) |
| Interrupted **workflow** run | Lost | Record/events survive, but the run stays `active` forever — its stream never closes and `client.runs.stream()`/live readers hang. `client.runs.events()` (catch-up only) still works. |
| Multi-process / multi-host | Not safe | Still requires routing each agent **instance** to exactly one live owner — Postgres gives failover, not active-active |

`client.agents.abort(name, id)` (`POST /agents/:name/:id/abort`) cancels in-flight + queued durable
work for an instance; the aborted work settles to a distinct `aborted` outcome, not a failure
`[cli-docs]`. Node currently has **no** crash-recovery path that terminalizes an interrupted workflow
run the way Cloudflare's Durable Object "Fiber recovery" does — worth building your own staleness
check in `IncidentStore`/`fix-agent.ts` rather than relying on Flue to notice a hung run
`[cli-docs, guide/targets/node]`.

## 6. Sandboxes — repo clone, shell, and toolchain execution

`[cli-docs]`, cross-checked against `api/sandbox-api`.

| Mode | Isolation | Persistence | Fits paperhanger? |
|---|---|---|---|
| **Virtual** (default, no `sandbox` field) | In-memory, `just-bash`-powered | Lost when the harness closes | No — no real toolchain, no git, and it is explicitly **not** a network isolation boundary (docs note current runtimes still permit outbound network from it) |
| **`local()`** (`@flue/runtime/node`, Node target only) | None — direct host fs + shell via `child_process` | Whatever the host filesystem/checkout already is | Only if the container itself *is* the disposable, single-tenant sandbox (matches "clone a repo in a sandbox" if the whole fix-agent process/container is the sandbox) |
| **Remote** (Daytona, E2B, Cloudflare Sandbox, ...) | Provider-managed, full Linux | Provider-managed lifecycle, app-owned | Best fit for real isolation per incident/tenant |

`local()`:
```ts
import { local } from '@flue/runtime/node';
const agent = defineAgent(() => ({
  sandbox: local({ env: { GH_TOKEN: process.env.GH_TOKEN } }),  // only listed env vars are exposed
  cwd: '/workspace/repo',
}));
```
Host env vars are excluded by default (API keys/tokens are deliberately not passed to the model's
shell) — pass exactly what a command needs via `env`. **`local()` provides no isolation** and is
explicitly documented as unsuitable "as an isolation boundary for untrusted requests or multiple
tenants" `[cli-docs]` — since a fix agent runs arbitrary model-directed shell commands against a
cloned third-party repo, this is the sandbox choice to scrutinize hardest.

Remote sandbox adapters (Daytona shown, E2B is structurally identical) — your app creates/owns the
provider sandbox object; Flue only adapts it:
```ts
import { Daytona } from '@daytona/sdk';
import { daytona } from '../sandboxes/daytona';   // generated by `flue add sandbox daytona`

const sandbox = await new Daytona({ apiKey: process.env.DAYTONA_API_KEY }).create();
const agent = defineAgent(() => ({ sandbox: daytona(sandbox) }));
```
`[docs, unverified]` — not installed in this probe (`flue add sandbox daytona` requires network
access to fetch the blueprint; the mechanism itself, `flue add <kind> <name>`, was confirmed to exist
via `flue --help`).

To write a custom adapter (e.g. wrapping your own container-per-incident orchestration instead of a
third-party sandbox SDK) implement `SandboxApi` (`readFile`/`writeFile`/`stat`/`readdir`/`exists`/
`mkdir`/`rm`/`exec`) and wrap it with `createSandboxSessionEnv(api, cwd)` from `@flue/runtime`; return
a `SandboxFactory` with `createSessionEnv({ id })`. Flue never deletes/terminates the underlying
provider resource — lifecycle is 100% application-owned `[cli-docs, api/sandbox-api]`.

Repo clone + shell mechanics: there is no special "clone repo" primitive — you `git clone` via
`harness.shell('git clone ...')` (out-of-band, not recorded) or `session.shell('git clone ...')`
(recorded in the transcript) against whichever sandbox is configured, then use `harness.fs` /
`session.fs` to stage/retrieve files `[cli-docs]`.

## 7. Invoking an agent/workflow programmatically from your own server

Two distinct integration surfaces, and they are **not interchangeable**:

### 7a. In-process (`dispatch()` / `invoke()`) — only from *inside* a Flue-built app

```ts
function dispatch(agent: AgentDefinition, request: { id: string; input: unknown }): Promise<DispatchReceipt>;
function invoke<W extends WorkflowDefinition>(workflow: W, request: { input?: ... }): Promise<{ runId: string }>;
```
`dispatch()` resolves once the runtime has *queued* the input — not once the agent has replied.
`invoke()` resolves once the run is admitted — not once it completes. Both throw a
`*NotConfigured`/`*Unavailable` error when called outside "a configured Flue-built server"
`[cli-docs]` — i.e., these only work from code that Flue's own build (an authored `src/app.ts` route,
a discovered agent/workflow module) has wired up. You cannot `import { invoke } from '@flue/runtime'`
into an arbitrary standalone Bun script and call it — the calling code has to *be* the Flue app.

### 7b. Out-of-process — `@flue/sdk` HTTP/stream client (Bun-compatible, verified)

This is the integration point for paperhanger's Bun server calling a separately-run Flue process.

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'http://127.0.0.1:3000',   // absolute URL required outside a browser
  token: process.env.FLUE_TOKEN,       // optional bearer token, added to every request
  headers: () => ({ 'x-request-id': crypto.randomUUID() }),  // static object or a (async) function
});
```
Confirmed under Bun: `createFlueClient` imports and returns `{ agents, runs, workflows }` with no
Node-only dependency (`@flue/sdk`'s only runtime dependency is `@durable-streams/client`, and neither
package references any `node:*` builtin) `[verified]`.

**Workflows** (fire-and-forget diagnose→fix→PR job):
```ts
const run = await client.workflows.invoke('fix-incident', { input: { incidentId, repoUrl } });
console.log(run.runId);   // "run_01JX..." — persist this in IncidentStore

// or block for the terminal result inline:
const done = await client.workflows.invoke('fix-incident', { input: {...}, wait: 'result' });
console.log(done.result);
```
**Runs** (poll/stream progress by `runId` — requires the workflow module to export `runs`):
```ts
const record = await client.runs.get(run.runId);              // GET /runs/:runId?meta
for await (const event of client.runs.stream(run.runId, { live: true })) {
  if (event.type === 'run_end') break;
}
```
**Agents** (continuing conversation, e.g. an interactive follow-up on a fix):
```ts
const result = await client.agents.prompt('fix-agent', incidentId, { message: 'retry with a narrower diff' });
client.agents.observe('fix-agent', incidentId, { live: 'sse' }); // materialized live conversation
await client.agents.abort('fix-agent', incidentId);              // cancel in-flight + queued work
```

Raw HTTP surface (what the SDK wraps), if you ever need to bypass the SDK: `POST /agents/:name/:id`
(`{ message, images? }` → `202 { streamUrl, offset, submissionId }`, or `200 { result, ... }` with
`?wait=result`), `POST /agents/:name/:id/abort`, `GET /agents/:name/:id` (history/updates),
`POST /workflows/:name` (→ `202 { runId }` or `200 { runId, result }` with `?wait=result`),
`GET /runs/:runId` (Durable Streams events) / `GET /runs/:runId?meta` (plain JSON record)
`[cli-docs, api/routing-api]`. Streaming/events use the [Durable Streams](https://durablestreams.com)
protocol over long-poll or SSE with resumable opaque offsets; `client.agents.observe()` /
`client.runs.stream()` already implement reconnect-and-resume — build on those rather than the raw
`Stream-Next-Offset`/`Stream-Cursor` headers directly `[cli-docs]`.

Events worth wiring into paperhanger's own observability (`FlueEvent`, all `v: 3` envelope,
`observe()` for in-process / `client.runs.stream()` for out-of-process): `run_start`/`run_resume`/
`run_end`, `agent_start`/`agent_end`/`idle`, `operation_start`/`operation`, `task_start`/`task`,
`turn_start`/`turn`/`turn_messages` (model turns), `tool_start`/`tool`, `compaction_start`/
`compaction`, `log`, `data`, `submission_settled` `[cli-docs, api/events-reference]`.

## 8. Models & providers

Model specifier = `"<provider-id>/<model-id>"`, e.g. `anthropic/claude-sonnet-4-6`,
`openai/gpt-5.5`, `openrouter/moonshotai/kimi-k2.6` `[cli-docs]`.

| Provider ID | Env var |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |

Built-in providers/models come from Flue's embedded [Pi](https://pi.dev/docs/latest/providers)
catalog (`@earendil-works/pi-ai` dependency) — set the expected env var and pick a catalog model
specifier; no registration call is needed for built-ins `[cli-docs]`. `thinkingLevel` (`'off'|
'minimal'|'low'|'medium'|'high'|'xhigh'`, default `'medium'`) sets reasoning effort per agent, per
profile, or per-operation override; unsupported provider paths silently ignore it `[cli-docs]`.

Custom/gateway providers via `registerProvider(providerId, registration)` (call once, in `app.ts`):
```ts
import { registerProvider } from '@flue/runtime';
registerProvider('anthropic', { baseUrl: process.env.ANTHROPIC_GATEWAY_URL, apiKey: process.env.ANTHROPIC_API_KEY });
// or a brand-new provider ID (requires api + baseUrl):
registerProvider('ollama', { api: 'openai-completions', baseUrl: 'http://localhost:11434/v1' });
```
Registering a known provider ID layers your options over its catalog defaults (cost, context window,
wire protocol preserved); a non-catalog ID throws `ProviderRegistrationError` without `api`+`baseUrl`
`[cli-docs, api/provider-api]`.

## 9. GitHub integration — scope and limits

`@flue/github`'s `createGitHubChannel({ webhookSecret, webhook })` verifies inbound webhook deliveries
(`X-Hub-Signature-256`), answers `ping` internally, and gives you `conversationKey()`/
`parseConversationKey()` to build a stable `{owner, repo, issueNumber}` ↔ string mapping for routing
events to an agent instance id. **It has no outbound API** — no PR-creation helper, no Octokit
wrapper `[verified from the installed `.d.ts`]`. paperhanger's existing `src/repo/github.ts` (GitHub
App auth + PR client, per `docs/architecture.md`) is the right place for actually opening the PR —
either as a `defineTool`/`defineAction` the fix agent calls, or as a plain post-workflow step in
`src/agent/runner.ts` after the workflow returns its diff/branch.

## 10. Bun compatibility verdict (evidence)

### What works fine under Bun 1.3.14, verified by import + execution

| Import | Result |
|---|---|
| `@flue/runtime` (`defineAgent`, `defineTool`, `defineWorkflow`, `defineAction`, `defineAgentProfile`) | Imports and runs; defined a tool + agent successfully |
| `@flue/sdk` (`createFlueClient`) | Imports; returns `{ agents, runs, workflows }` |
| `@flue/postgres` (`postgres()`) | Imports; only depends on `@flue/runtime/adapter`, no driver, no `node:*` |
| `@flue/github` (`createGitHubChannel`, error classes) | Imports cleanly |
| `bunx flue --help`, `bunx flue docs`, `bunx flue docs read <path>` | Full CLI + 97-page offline docs browser work |
| `bunx flue init/build --target node` | Builds successfully (uses Vite/rolldown under the hood) |
| `bunx flue dev --target node` (watch-mode dev server) | Starts and serves HTTP under Bun |

### What breaks under Bun 1.3.14, verified by running the actual output

`@flue/runtime/node` (imported at the top of every `--target node` build, unconditionally, to supply
the default persistence adapter — confirmed present with **and** without a custom `db.ts`) contains:
```
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
```
Bun 1.3.14 does not implement `node:sqlite` (it ships `bun:sqlite` instead). Running the generated
production server:
```
$ bun dist/server.mjs
error: No such built-in module: node:sqlite
Bun v1.3.14 (macOS arm64)
```
This reproduced identically on a fresh `flue init --target node` project both **with** and
**without** a `src/db.ts` (tested with `@flue/postgres`) — the import is baked into the production
bundle regardless of which persistence adapter you actually select. `node dist/server.mjs` (same
build) starts correctly and answers HTTP requests. **Curiously, `bunx flue dev --target node` (the
Vite-based dev server, not the production bundle) does *not* hit this wall** — its dev-mode module
graph appears to resolve differently than the rolldown production bundle — but `flue dev` is
documented as a watch-mode *development* tool, not a deployment artifact, so this is not something to
depend on for a production long-running process.

### Practical conclusion for paperhanger

- Do **not** try to run the Flue-generated Node server, or anything that imports
  `@flue/runtime/node` (i.e. `local()` sandbox or the built-in `sqlite()` adapter), inside the Bun
  process itself. That import fails immediately, before any agent logic even runs.
- The clean split, given the Bun-base container:
  1. Run the fix-agent's Flue app (`src/agent/fix-agent.ts` + its workflow) as a **Node.js** process
     — either a `node` binary added to the `oven/bun:1.3` image, or a small sibling
     container/process — built with `flue build --target node` and started with
     `node dist/server.mjs`. This satisfies the `>=22.19.0` engines requirement and avoids the
     `node:sqlite` wall entirely (Node has `node:sqlite` natively since 22.5).
  2. Drive it from the main Bun server (`src/agent/runner.ts`) via `@flue/sdk`'s
     `createFlueClient()` — `client.workflows.invoke(..., { wait: 'result' })` for a blocking call, or
     `client.workflows.invoke(...)` + `client.runs.stream(runId, { live: true })` /
     `client.agents.observe(...)` for progress streaming into paperhanger's own incident state
     machine. This half is fully Bun-native; no subprocess juggling needed on the calling side.
  3. If `local()` sandbox semantics are wanted (agent operates directly on a cloned checkout, no
     remote-sandbox provider), that's fine — it just has to run inside the Node sidecar process, not
     the Bun process. Alternatively use a remote sandbox adapter (Daytona/E2B) so the Node sidecar
     never touches the host filesystem at all.
  4. For persistence, prefer `@flue/postgres` over `sqlite()` even for the Node sidecar: since
     `postgres()` takes a driver-agnostic `{ query, transaction, close }` shape, the sidecar can point
     at the same Postgres paperhanger already uses (per `storage/postgres.ts`), without introducing a
     second SQLite file to operate.

This is a materially different, and more constraining, answer than "Flue requires Node.js ≥22.19.0"
taken at face value: the *library* surface (`@flue/runtime` core, `@flue/sdk`, `@flue/postgres`) is
largely runtime-agnostic and Bun-happy, but the *shipped server bootstrap* for the Node target is not
— it has a hard, unconditional dependency on a Node built-in Bun doesn't implement yet.

## 11. Version & stability caveats

- Everything above is against `1.0.0-beta.9` (`@flue/github` `1.0.0-beta.1`) — pin these exact
  versions; do not float on beta ranges given the framework's own admission that "there will still be
  the occasional breaking change" before stable 1.0 `[docs, blog/flue-1-0-beta]`.
  `AgentSubmissionStore`'s "turn-journal, settlement, and lease groups... remain subject to change
  until 1.0" `[cli-docs, api/data-persistence-api]`.
  The persisted schema is versioned and explicitly **reset-only pre-1.0** (`FLUE_SCHEMA_VERSION` = 7
  at time of writing) — there is no migration path across schema bumps, only a hard reset
  `[cli-docs]`.
- Detailed event message payloads (`message` on `message_start`/`message_end`, `turn_messages`,
  `agent_end.messages`) mirror the underlying `pi-agent-core` message shape and are explicitly **not
  yet stable** — build against the normalized fields (`turn`, `tool_start`/`tool`, `operation`,
  `run_*`) instead if building long-lived observability code `[cli-docs, api/events-reference]`.
  `FluePublicError` categories and exported `FlueError` subclass `type` fields are the stable
  contracts; everything else (CLI diagnostics, workflow-run error payload shape) is "subject to
  refinement" `[cli-docs, api/errors-reference]`.
- Multi-node/horizontally-scaled Node deployment is **not yet supported** by Flue itself — "we plan to
  support multi-node (horizontally scaled) deployments before the stable 1.0 release" `[docs,
  blog/flue-1-0-beta]`. Combined with §5's recovery table: route each agent instance to exactly one
  live Node-sidecar owner; do not round-robin the sidecar behind a naive load balancer if you run more
  than one replica.
- No sandbox network egress isolation is guaranteed by Flue itself for *any* built-in sandbox mode —
  the virtual sandbox explicitly still permits outbound network today, and `local()`/remote sandboxes
  push that responsibility to you/the provider `[cli-docs, guide/sandboxes]`. Given the fix agent
  clones third-party repos and runs model-directed shell commands, treat sandbox network/credential
  policy as paperhanger's own responsibility regardless of which sandbox mode is chosen.
- `docs/reference/durability`, `docs/reference/sandbox-adapter-api` (as guessed URLs) and a top-level
  `docs/reference/` index page **do not exist** on the site (404) — the real page for durability is
  `guide/durable-execution` (renamed from what site navigation elsewhere implies) and the real
  sandbox-adapter reference is `api/sandbox-api`; use `flue docs` (bundled with the CLI, 97 pages) as
  the authoritative page list rather than guessing URLs from the marketing site's nav, which is
  incomplete/inconsistent with the shipped docs bundle.

## 12. Open questions / not discoverable in this pass

- Exact behavior of `flue add sandbox daytona`/`e2b` blueprint output was not exercised (requires
  fetching a live blueprint over the network + a provider API key); the *shape* of the resulting
  adapter file is documented precisely in `api/sandbox-api` (§6) and is enough to hand-write an
  equivalent adapter without running `flue add`, but was not cross-checked against the concrete
  `@daytona/sdk`/`e2b` call sequence one gets from a real `flue add` run.
- Whether a future Bun release adds `node:sqlite` support (which would remove the §10 blocker for the
  *default* in-memory adapter path, though the `child_process`-based `local()` sandbox would still
  need Bun's `node:child_process` compat layer to be exercised end-to-end, which was not separately
  stress-tested here beyond confirming the import itself doesn't throw) was not investigated; treat
  the Node-sidecar recommendation as the durable answer rather than betting on an upstream Bun fix.
