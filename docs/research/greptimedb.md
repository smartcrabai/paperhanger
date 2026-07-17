# GreptimeDB Integration Reference

Research notes for paperhanger's `telemetry/greptimedb.ts` client (`TelemetrySource` implementation,
see `docs/spec.md` §3.4 and `docs/architecture.md`). paperhanger only ever **reads** from an
already-populated GreptimeDB instance (data arrives via OTLP from other services); it never
ingests data itself in production. All ingestion details below exist so the integration-test
suite (testcontainers) can seed realistic data and so the client code understands the schemas
it must query against.

Every section is labeled **[DOCS]** (from `docs.greptime.com` / Context7, not independently
re-run) or **[VERIFIED]** (empirically reproduced in this session against a real
`greptime/greptimedb` container — commands and raw responses are inlined). Where docs and
reality diverged, the divergence is called out explicitly.

**Environment used for verification**: Docker Desktop 29.4.0 (macOS, arm64), image
`greptime/greptimedb:latest`, which resolved to **GreptimeDB v1.1.2** (`git_commit
8ad2d2414ce107c56b2e0371fd8380ca78ddd101`). Note that most of `docs.greptime.com`'s indexed
content (via Context7) is pinned to the `/0.14/` and `/0.15/` doc revisions, but the
version-less (`latest`) pages already describe v1.1.2 behavior. Nothing observed in this
session contradicted the 0.14/0.15 docs for the topics covered — GreptimeDB kept the HTTP/OTLP
surface stable across that jump — but pin your dependency on `greptime/greptimedb:v1.1.2` (or
newer) rather than 0.x if you match this report against the live docs later.

---

## 1. HTTP SQL API

**[DOCS + VERIFIED]**

### Endpoint

```
POST /v1/sql
```

Query parameters:

| Param | Required | Description |
|---|---|---|
| `db` | optional, default `public` | Database (schema) to run the query against. Catalog is always `greptime`, so `db=public` really targets `greptime.public`. |
| `format` | optional | Output shape: `greptimedb_v1` (default, shown below), `influxdb_v1`, `csv`, `csvWithNames`, `csvWithNamesAndTypes`, `arrow`, `table`. |
| `epoch` | optional | Only with `format=influxdb_v1`; timestamp precision (`ms`, `s`, ...). |

Request body: `application/x-www-form-urlencoded`, single field `sql=<statement>`.

Headers:

| Header | Purpose |
|---|---|
| `Authorization` or `x-greptime-auth` | `Basic <base64(username:password)>` — see §2. |
| `X-Greptime-Timeout` | Per-request timeout, e.g. `120s`. |
| `X-Greptime-Timezone` | Timezone for timestamp interpretation/rendering, e.g. `+1:00`. |
| `X-Greptime-DB-Name` | Alternative to the `db` query param (headers work for `/v1/sql` too, not just OTLP). |

### curl example (verified)

```bash
curl -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'sql=SELECT * FROM monitor LIMIT 10' \
  'http://127.0.0.1:4000/v1/sql?db=public'
```

### Success response shape (verified, `SELECT`)

```json
{
  "output": [
    {
      "records": {
        "schema": {
          "column_schemas": [
            { "name": "host", "data_type": "String" },
            { "name": "ts", "data_type": "TimestampMillisecond" },
            { "name": "cpu", "data_type": "Float64" }
          ]
        },
        "rows": [["127.0.0.1", 1720728000000, 0.5]],
        "total_rows": 1
      }
    }
  ],
  "execution_time_ms": 7
}
```

Note `rows` are plain JSON arrays positional to `column_schemas` — there is no per-row object
with field names; the client must zip `column_schemas[i].name` with `rows[r][i]` itself.
`output` is an array because a single request body may contain multiple `;`-separated
statements — each gets one entry. For DML/DDL (e.g. `INSERT`), the entry is
`{"affectedrows": N}` instead of `{"records": ...}` (verified: `{"output":[{"affectedrows":3}],"execution_time_ms":11}`).

### Error response shape (verified)

Non-2xx status (400 observed for both syntax errors and semantic/planning errors; 401 for auth
failures — see §2). Body:

```json
{ "code": 1001, "error": "SQL statement is not supported, keyword: SELEKT", "execution_time_ms": 2 }
```

The same `code`/`error` are echoed as response headers `x-greptime-err-code` and
`x-greptime-err-msg`, so a client can short-circuit on headers without parsing the body if it
prefers. Verified codes seen in this session:

| HTTP status | `code` | Example `error` | Cause |
|---|---|---|---|
| 400 | 1001 | `SQL statement is not supported, keyword: SELEKT` | Parser/syntax error |
| 400 | 4001 | `Failed to plan SQL: Table not found: greptime.public.table_does_not_exist` | Planning error (missing table, bad column, etc.) |
| 401 | 7003 | `Not found http or grpc authorization header` | Missing `Authorization` header when auth is enabled |
| 401 | 7002 | `Username and password does not match, username: <user>` | Bad credentials |

Recommendation for the client: treat any non-2xx as an error, surface `error` (and `code`) in
the thrown exception, and special-case 401 distinctly (config/secret problem) from 400
(query-shape bug) since the incident pipeline may want to alert differently.

---

## 2. Authentication

**[DOCS + VERIFIED]**

GreptimeDB HTTP APIs use plain HTTP Basic auth: base64-encode `username:password` and send it
in either `Authorization: Basic <b64>` or the GreptimeDB-specific alias
`x-greptime-auth: Basic <b64>`. Both header names are accepted for every HTTP endpoint
(`/v1/sql`, `/v1/prometheus/...`, `/v1/otlp/...`).

```bash
curl -X POST \
  -H 'Authorization: Basic Z3JlcHRpbWVfdXNlcjpncmVwdGltZV9wd2Q=' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'sql=show tables' \
  http://localhost:4000/v1/sql
```

**Standalone mode ships with authentication *disabled* by default** — verified: every query in
this session against the plain `standalone start` container succeeded with zero `Authorization`
header. To require credentials, the server must be started with a `--user-provider` flag
pointing at a credentials file, e.g.:

```bash
greptime standalone start --user-provider=static_user_provider:file:/auth/users.txt
```

where `/auth/users.txt` has one `username=password` pair per line:

```
greptime_user=greptime_pwd
alice=aaa
```

Verified behavior with this enabled (container `greptime-research-auth`, `-p 14010:4000`):

```bash
# no header -> 401, code 7003 "Not found http or grpc authorization header"
curl -i -X POST --data-urlencode 'sql=show tables;' http://127.0.0.1:14010/v1/sql?db=public

# wrong password -> 401, code 7002 "Username and password does not match, username: greptime_user"
curl -i -X POST -H "Authorization: Basic $(printf 'greptime_user:wrongpass' | base64)" \
  --data-urlencode 'sql=show tables;' http://127.0.0.1:14010/v1/sql?db=public

# correct -> 200
curl -i -X POST -H "Authorization: Basic $(printf 'greptime_user:greptime_pwd' | base64)" \
  --data-urlencode 'sql=show tables;' http://127.0.0.1:14010/v1/sql?db=public
```

For paperhanger's config (`telemetry.greptimedb.auth: ${GREPTIMEDB_AUTH}` per `docs/spec.md`),
the simplest contract is: `GREPTIMEDB_AUTH` holds `username:password` (unencoded), and the
client base64-encodes it itself when building the `Authorization` header — this avoids forcing
operators to pre-encode a secret in their env store. If unset, omit the header entirely (works
fine against an unauthenticated instance, and a real 401 will surface clearly if auth turns out
to be required).

There is also LDAP support (`--user-provider=ldap_user_provider:<config>`) [DOCS, not verified]
— irrelevant to a fetch-based client since it's still HTTP Basic on the wire either way.

---

## 3. PromQL-compatible HTTP API

**[DOCS + VERIFIED]**

Base prefix: `/v1/prometheus/api/v1/...`, mirroring the real Prometheus HTTP API.

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/prometheus/api/v1/query` | GET/POST | Instant query |
| `/v1/prometheus/api/v1/query_range` | GET/POST | Range query |
| `/v1/prometheus/api/v1/series` | GET | Series matching a label selector |
| `/v1/prometheus/api/v1/labels`, `/label/<name>/values` | GET | Label discovery [DOCS, not verified] |

Common parameters:

- `db` — query parameter, or `x-greptime-db-name` header (either works; verified via header form below).
- `query` — the PromQL expression.
- `query_range` additionally needs `start`, `end` (RFC3339 or unix seconds), `step` (duration, e.g. `15s`).
- `Authorization` — same Basic auth as §2 when enabled.

### Verified instant query

Correct usage is a real HTTP GET with the query in the query string (a GET with a body, e.g.
`curl -X GET --data-urlencode`, is **silently wrong** — it produces `{"status":"error","error":"no expression found in input","errorType":"InvalidArguments"}` because the server only reads GET params from the URL, not the body):

```bash
curl -G 'http://127.0.0.1:4000/v1/prometheus/api/v1/query' \
  --data-urlencode 'query=http_requests_total' \
  --data-urlencode 'time=1784258942' \
  --data-urlencode 'db=public'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": { "__name__": "http_requests_total", "job": "paperhanger-test-svc",
                     "route": "/api/orders", "service_name": "paperhanger-test-svc", "status": "200" },
        "value": [1784258942.0, "5"]
      }
    ]
  }
}
```

### Verified range query (recent window for a metric)

```bash
curl -X POST \
  -H 'Authorization: Basic <base64-encoded-credentials>' \
  --data-urlencode 'query=rate(http_requests_total[1m])' \
  --data-urlencode 'start=1784258620' \
  --data-urlencode 'end=1784258920' \
  --data-urlencode 'step=15s' \
  'http://127.0.0.1:4000/v1/prometheus/api/v1/query_range?db=public'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "matrix",
    "result": [
      {
        "metric": { "__name__": "http_requests_total", "job": "paperhanger-test-svc",
                     "route": "/api/orders", "service_name": "paperhanger-test-svc", "status": "200" },
        "values": [[1784258920.0, "0"], [1784258935.0, "0"]]
      }
    ]
  }
}
```

Response shape is byte-for-byte standard Prometheus (`status`, `data.resultType`
`vector`/`matrix`, `data.result[].metric` label map, `.value`/`.values` as
`[unixSeconds, "stringNumber"]` pairs — values are strings, not numbers, exactly like upstream
Prometheus).

---

## 4. OTLP ingestion and the resulting table schemas

**[VERIFIED]** — reproduced by writing small Bun/TypeScript scripts using the official
`@opentelemetry/exporter-{logs,trace,metrics}-otlp-proto` packages (targeting the container's
`/v1/otlp/v1/{logs,traces,metrics}` endpoints), then inspecting the result with `SHOW TABLES` /
`DESC TABLE` / `SHOW CREATE TABLE` over `/v1/sql`. This matters for paperhanger because these
are the exact tables/columns the query layer (§5) reads from, and it's what the
testcontainers-based integration tests should seed.

### 4.1 Endpoints and required headers

| Endpoint | Content-Type | Notes |
|---|---|---|
| `POST /v1/otlp/v1/logs` | `application/x-protobuf` only | JSON is rejected — see below. |
| `POST /v1/otlp/v1/traces` | `application/x-protobuf` only | **Requires** `x-greptime-pipeline-name: greptime_trace_v1` — see below. |
| `POST /v1/otlp/v1/metrics` | `application/x-protobuf` only | |

Common headers: `X-Greptime-DB-Name` (database), `Authorization` (§2 if enabled).

**Verified: JSON payloads are rejected outright**, even though the generic OTLP/HTTP spec
allows JSON encoding. Posting a hand-built OTLP-JSON logs payload with
`Content-Type: application/json` returns:

```
HTTP/1.1 400 Bad Request
{"error":"Unsupported content type 'application/json'. OTLP endpoint only supports 'application/x-protobuf'. Please configure your OTLP exporter to use protobuf encoding."}
```

So a from-scratch client (or the integration-test seeder) must send real protobuf-encoded
`ExportLogsServiceRequest` / `ExportTraceServiceRequest` / `ExportMetricsServiceRequest` bytes —
plain `fetch` with a hand-rolled JSON body will not work against this endpoint. In practice this
is a non-issue for paperhanger (it only queries, never ingests), but it matters for the
integration-test seed script, which should use the official OTel SDK exporters (as this
research did) rather than crafting JSON.

**Verified: the traces pipeline-name header is mandatory.** Omitting
`x-greptime-pipeline-name: greptime_trace_v1` produces:

```
HTTP/1.1 400 Bad Request
server log: "Pipeline error ... Pipeline is required for this API."
```

The logs and metrics endpoints did **not** require any pipeline header in this session (a
default/implicit pipeline is applied); only traces did.

### 4.2 Logs → `opentelemetry_logs` (default table name)

Default table name is `opentelemetry_logs`; override via request header
`X-Greptime-Log-Table-Name` [DOCS]. Verified schema (`DESC TABLE opentelemetry_logs`):

| Column | Type | Key | Semantic Type |
|---|---|---|---|
| `timestamp` | TimestampNanosecond | PRI (time index) | TIMESTAMP |
| `trace_id` | String | | FIELD |
| `span_id` | String | | FIELD |
| `severity_text` | String | | FIELD |
| `severity_number` | Int32 | | FIELD |
| `body` | String | | FIELD |
| `log_attributes` | Json | | FIELD |
| `trace_flags` | UInt32 | | FIELD |
| `scope_name` | String | PRI (tag) | TAG |
| `scope_version` | String | | FIELD |
| `scope_attributes` | Json | | FIELD |
| `scope_schema_url` | String | | FIELD |
| `resource_attributes` | Json | | FIELD |
| `resource_schema_url` | String | | FIELD |

Key facts confirmed from actual row data:

- **`service.name` is NOT a top-level column.** It lives inside the `resource_attributes` JSON
  blob, keyed literally as `"service.name"` (with the dot, as OTel resource attribute keys are
  written verbatim into the JSON object) — e.g.
  `{"deployment.environment":"test","service.name":"paperhanger-test-svc"}`. Any query filtering
  by service must use a JSON extraction function (§5).
- `trace_id`/`span_id` are populated **only if the log record was emitted with a real, valid
  active span context** (see the OTel SDK caveat below) — otherwise they are empty strings
  (`""`), not `NULL`.
- `severity_number` follows the standard OTel severity number scale (verified: `ERROR` → `17`,
  `INFO` → `9`).
- `SHOW CREATE TABLE opentelemetry_logs` reveals the table is created with `append_mode='true'`,
  tagged `'greptime.semantic.signal_type' = 'log'`, and — notably — **`body` has a `FULLTEXT
  INDEX`** by default (`analyzer = 'English', backend = 'bloom'`), enabling `matches_term(body,
  'timeout')` / `body @@ 'timeout'` full-text queries (§5, §6).

**OTel SDK caveat (verified the hard way):** hand-constructing a Bun script with
`@opentelemetry/sdk-logs` + `@opentelemetry/sdk-trace-base` does **not** automatically populate
`trace_id`/`span_id` on emitted logs unless a `ContextManager` is registered. Without calling
`context.setGlobalContextManager(new AsyncHooksContextManager().enable())` (from
`@opentelemetry/context-async-hooks`), `context.active()` always returns the empty root
context — even inside a `context.with(spanCtx, () => logger.emit(...))` block — so every log
record exports with empty trace/span IDs. This is purely a test-fixture concern (a full
`NodeSDK` normally wires the context manager for you); it's called out here because it silently
produces schema-valid but semantically-empty correlation columns, which would be confusing if
hit while writing the integration-test seed script.

### 4.3 Traces → `opentelemetry_traces` (default table name), plus two derived tables

Default table name `opentelemetry_traces`, override via `X-Greptime-Trace-Table-Name` [DOCS].
Verified schema (`DESC TABLE opentelemetry_traces`) — one row per span:

| Column | Type | Key | Semantic Type |
|---|---|---|---|
| `timestamp` | TimestampNanosecond | PRI (time index) | TIMESTAMP — span **start** time |
| `timestamp_end` | TimestampNanosecond | | FIELD — span end time |
| `duration_nano` | UInt64 | | FIELD |
| `parent_span_id` | String | | FIELD (`NULL` for root spans) |
| `trace_id` | String | | FIELD |
| `span_id` | String | | FIELD |
| `span_kind` | String | | FIELD, e.g. `SPAN_KIND_INTERNAL`, `SPAN_KIND_CLIENT` |
| `span_name` | String | | FIELD |
| `span_status_code` | String | | FIELD, e.g. `STATUS_CODE_OK`, `STATUS_CODE_ERROR`, `STATUS_CODE_UNSET` |
| `span_status_message` | String | | FIELD |
| `trace_state` | String | | FIELD |
| `scope_name` | String | | FIELD |
| `scope_version` | String | | FIELD |
| `service_name` | String | **PRI (tag)** | TAG |
| `resource_attributes.<key>` | String/Int/... | | FIELD — one physical column per **distinct** resource attribute key seen (flattened, not JSON!) |
| `span_attributes.<key>` | String/Int/... | | FIELD — same flattening for span attributes |
| `span_events` | Json | | FIELD |
| `span_links` | Json | | FIELD |

**Important divergence from the logs table's JSON-blob approach:** for traces,
`resource_attributes` and `span_attributes` are **not** stored as a single `Json` column each.
Instead GreptimeDB dynamically adds one physical column per distinct attribute key it has ever
seen, named literally `resource_attributes.deployment.environment`,
`span_attributes.http.request.method`, etc. (verified: our test's
`deployment.environment` resource attribute showed up as its own column
`"resource_attributes.deployment.environment"` with type `String`). This means the traces table
schema is **not static** — it grows new columns as new attribute keys are ingested. Only
`span_events` and `span_links` remain `Json` (they're structurally repeated/nested, not
flat key-value).

`service_name` **is** a first-class top-level column here (unlike logs, where it's buried in
`resource_attributes` JSON) — it's populated straight from the OTel resource's `service.name`
attribute and used as the table's tag/primary key. `SHOW CREATE TABLE` confirms
`PRIMARY KEY ("service_name")` and a partition scheme on `trace_id` (16-way, split by leading
hex character — `trace_id < '1'`, `trace_id >= '1' AND trace_id < '2'`, ... `trace_id >= 'f'`;
[DOCS] says this is the default and is tuned for efficient single-trace lookup with 3–5
datanodes in a cluster — irrelevant for a standalone single-node dev/test instance but worth
knowing before assuming trace_id lookups don't scale).

Verified sample rows (2 spans in one trace, parent OK / child ERROR):

```json
[1784258863219000000, 1784258863342776166, 123557166, null,
 "3d4b2df34204eb410b75a498e9a53090", "effaab75e5a7621a",
 "SPAN_KIND_INTERNAL", "GET /api/orders", "STATUS_CODE_OK", "", "paperhanger-test-svc", "test"],
[1784258863347000000, 1784258863702875500, 355875500, "effaab75e5a7621a",
 "3d4b2df34204eb410b75a498e9a53090", "6b495731395880b7",
 "SPAN_KIND_INTERNAL", "db.query orders_table", "STATUS_CODE_ERROR", "connection timeout",
 "paperhanger-test-svc", "test"]
```

**Two extra tables were auto-created alongside `opentelemetry_traces`** the moment trace data
was ingested — apparently maintained by GreptimeDB's internal "flow" (continuous
materialized-view) engine, likely to power fast service/operation pickers in a trace-explorer
UI:

- `opentelemetry_traces_services` — columns `timestamp` (PRI/TIMESTAMP), `service_name`
  (PRI/TAG). Distinct service names seen, bucketed by time.
- `opentelemetry_traces_operations` — columns `timestamp`, `service_name`, `span_name`,
  `span_kind` (all PRI/TAG). Distinct (service, operation, kind) tuples.

Neither is documented in the pages retrieved for this report; they're mentioned here purely
because `SHOW TABLES` surfaced them unprompted and a naive client iterating "all tables" could
be surprised by them. They're harmless to ignore.

### 4.4 Metrics → one table per metric name

**[VERIFIED]** — confirms the docs' "one table per metric" model precisely. Ingesting a
Histogram (`http_request_duration_seconds`) and a Counter (`http_requests_total`) via
`@opentelemetry/sdk-metrics` + `OTLPMetricExporter` produced:

```
http_request_duration_seconds_bucket
http_request_duration_seconds_count
http_request_duration_seconds_sum
http_requests_total
greptime_physical_table            <- shared physical storage table (metric engine internals)
```

i.e. a **Histogram becomes three logical tables** (`_bucket`, `_count`, `_sum` suffixes, exactly
like the Prometheus text-exposition convention), while a **Counter/Gauge becomes exactly one
table** named after the metric. All of these logical tables are backed by one shared physical
storage table (`greptime_physical_table`) under GreptimeDB's "metric engine" — this is an
internal storage-layout optimization; queries still address the per-metric logical table names
normally.

Verified schema of `http_requests_total`:

| Column | Type | Key | Semantic Type |
|---|---|---|---|
| `greptime_timestamp` | TimestampMillisecond | PRI (time index) | TIMESTAMP |
| `greptime_value` | Float64 | | FIELD |
| `job` | String | PRI | TAG |
| `route` | String | PRI | TAG |
| `service_name` | String | PRI | TAG |
| `status` | String | PRI | TAG |

- `greptime_timestamp` / `greptime_value` are the fixed column names for the sample time/value
  (matches [DOCS]: Gauge/Sum → `greptime_value`; Summary quantiles → `greptime_pN` columns per
  quantile instead — not independently verified, [DOCS] only).
- Every metric attribute (both the OTel `Resource`'s `service.name` and every data-point
  attribute, e.g. `route`, `status`) is promoted to its own tag column. `job` was auto-added
  equal to `service_name` (Prometheus-compatibility convention: OTel's `service.name` resource
  attribute is mapped to Prometheus's conventional `job` label in addition to being kept as
  `service_name`).
- Histogram/ExponentialHistogram support: [DOCS] states ExponentialHistogram specifically is
  **not supported** by OTLP metrics ingestion; regular Histogram clearly works (verified above).

---

## 5. Example SQL queries

**[VERIFIED]** — all three run successfully against the schemas in §4 (using the sample data
from that section: service `paperhanger-test-svc`, trace_id
`3d4b2df34204eb410b75a498e9a53090`).

### (a) Error-level logs for a given `service.name` within a time range

`resource_attributes` is `Json`; `service.name` (the literal key, including the dot) must be
pulled out with `json_get_string(json, path)`. Because the key itself contains a dot, the JSON
path needs the key quoted: `'$."service.name"'`.

```sql
SELECT timestamp, severity_text, body, trace_id, span_id
FROM opentelemetry_logs
WHERE json_get_string(resource_attributes, '$."service.name"') = 'paperhanger-test-svc'
  AND severity_text = 'ERROR'
  AND timestamp BETWEEN '2026-07-17 00:00:00' AND '2026-07-17 23:59:59'
ORDER BY timestamp DESC
LIMIT 100;
```

```bash
curl -X POST --data-urlencode "sql=$(cat <<'SQL'
SELECT timestamp, severity_text, body, trace_id, span_id
FROM opentelemetry_logs
WHERE json_get_string(resource_attributes, '$."service.name"') = 'paperhanger-test-svc'
  AND severity_text = 'ERROR'
ORDER BY timestamp DESC LIMIT 100
SQL
)" 'http://127.0.0.1:4000/v1/sql?db=public'
```

Verified result: returned exactly the one seeded ERROR row
(`"database connection timeout after 30s"` with its correct `trace_id`/`span_id`).

For a keyword search instead of an exact service filter, combine with the full-text index noted
in §4.2: `AND body @@ 'timeout'` (or `matches_term(body, 'timeout')`).

### (b) All spans for a given `trace_id`

```sql
SELECT timestamp, span_id, parent_span_id, span_name, span_kind,
       duration_nano, span_status_code, span_status_message
FROM opentelemetry_traces
WHERE trace_id = '3d4b2df34204eb410b75a498e9a53090'
ORDER BY timestamp;
```

Verified: returned both spans (parent `GET /api/orders`, child `db.query orders_table`) in
start-time order, with `parent_span_id` correctly `NULL` on the root span and populated on the
child.

### (c) Slowest / error spans for a service within a window

```sql
SELECT timestamp, trace_id, span_id, span_name, duration_nano, span_status_code
FROM opentelemetry_traces
WHERE service_name = 'paperhanger-test-svc'
  AND timestamp > '2026-07-01 00:00:00'
  AND (span_status_code = 'STATUS_CODE_ERROR' OR duration_nano > 50000000) -- 50ms
ORDER BY duration_nano DESC
LIMIT 20;
```

Verified: returned both spans ordered slowest-first (the 355.9ms ERROR child span, then the
123.6ms OK parent span) — useful directly as the "representative slow/error trace" query
described in `docs/spec.md`'s collection strategy (§3.4, step 2–3).

### PromQL: a metric's recent range

See §3's verified range-query example — reproduced here for the metric produced in §4.4:

```bash
curl -X POST \
  -H 'Authorization: Basic <base64-encoded-credentials>' \
  --data-urlencode 'query=rate(http_requests_total{service_name="paperhanger-test-svc"}[1m])' \
  --data-urlencode 'start=1784258620' \
  --data-urlencode 'end=1784258920' \
  --data-urlencode 'step=15s' \
  'http://127.0.0.1:4000/v1/prometheus/api/v1/query_range?db=public'
```

---

## 6. Notes for the `TelemetrySource` client implementation

Not empirically load-tested, but derived directly from the verified findings above — worth
keeping in mind while implementing `src/telemetry/greptimedb.ts`:

- Build the client on plain `fetch`, `URLSearchParams`/`application/x-www-form-urlencoded` body
  for `/v1/sql`, and `URL` query params for the PromQL endpoints — no SDK dependency needed for
  the *query* side (only the integration-test seeder needs real OTel SDK exporters, because of
  the protobuf-only OTLP ingestion requirement from §4.1).
  - GET requests to `/v1/prometheus/api/v1/query*` must put parameters in the URL query string,
    not the body — confirmed the "GET with body" mistake produces a confusing but real 400.
- Centralize the `Authorization: Basic <base64>` header construction in one place; treat
  `GREPTIMEDB_AUTH` as optional (omit header cleanly when unset) since standalone dev/test
  instances typically run without auth.
- Any query filtering logs by `service.name` needs `json_get_string(resource_attributes,
  '$."service.name"')` — build this as a small helper/constant in the client rather than
  inlining the JSON path string everywhere, since the quoting-around-a-dotted-key detail is easy
  to get wrong.
- Trace queries can filter directly on the top-level `service_name` column (no JSON needed) —
  logs and traces are asymmetric here; don't assume the same filter expression works for both.
- Treat any HTTP status outside 2xx as an error and parse `{code, error}` from the body (or the
  `x-greptime-err-code`/`x-greptime-err-msg` headers, which carry the same info and are cheaper
  to read if the client wants to avoid buffering the body on error paths).
- The traces table's `resource_attributes.*`/`span_attributes.*` flattened-column schema means
  `SELECT *` against `opentelemetry_traces` is schema-fragile across different services/SDKs
  (each contributes different columns). Prefer explicit column lists (as in the examples above)
  over `SELECT *` in the collector code.
- `severity_number` uses the standard OTel numeric severity scale (1–24; `ERROR` starts at 17,
  `INFO` at 9, etc.) if the client wants numeric threshold filtering instead of matching
  `severity_text` strings literally.

---

## 7. Docker / testcontainers facts

**[VERIFIED]** unless noted.

- **Image**: `greptime/greptimedb` (Docker Hub / `docker.io`). Verified working tag:
  `greptime/greptimedb:latest` → resolves to v1.1.2 at the time of this research. [DOCS] shows
  pinned examples like `greptime/greptimedb:v1.1.2`, `v0.15.5`, `v0.14.4` — pin an explicit
  version for reproducible integration tests rather than `latest`.
- **Standalone start command** (verified working, binds all HTTP/gRPC/MySQL/Postgres to
  `0.0.0.0` so Docker's port mapping works from the host):

  ```bash
  docker run -d \
    -p 4000-4003:4000-4003 \
    -v "$(pwd)/greptimedb_data:/greptimedb_data" \
    --name greptime \
    greptime/greptimedb:v1.1.2 standalone start \
    --http-addr 0.0.0.0:4000 \
    --rpc-bind-addr 0.0.0.0:4001 \
    --mysql-addr 0.0.0.0:4002 \
    --postgres-addr 0.0.0.0:4003
  ```

  (`--rpc-bind-addr` is the flag name for the gRPC port in the 0.14/0.15-era docs; verified this
  flag name still works against the v1.1.2 image. Some newer doc pages show `--grpc-bind-addr`
  as a synonym/rename — both were accepted in testing via the older flag name, but if a future
  image rejects `--rpc-bind-addr`, fall back to `--grpc-bind-addr`.)

- **Exposed ports** (verified all four listening and independently reachable):

  | Port | Protocol |
  |---|---|
  | 4000 | HTTP (SQL API, PromQL API, OTLP ingestion, `/health`, `/dashboard`) |
  | 4001 | gRPC (native GreptimeDB protocol, used by non-HTTP clients/ingesters) |
  | 4002 | MySQL wire protocol |
  | 4003 | PostgreSQL wire protocol |

- **Health / readiness**: `GET /health` on the HTTP port. Verified: returns `200 OK` with body
  `{}` once the server has finished starting. A `GET /ready` path also verified to return `200`
  with the same empty-object body on this version — either can be used as the testcontainers
  wait-strategy target (e.g. Bun testcontainers' `Wait.forHttp("/health", 4000)`); `/health` is
  the one consistently documented across doc revisions, so prefer it.
- **Startup log line** to additionally wait on if not using an HTTP wait strategy:
  `HTTP server is bound to 0.0.0.0:4000` (verified present in container logs right before the
  server becomes reachable) — useful as a `Wait.forLogMessage(...)` fallback.
- **seccomp caveat** [DOCS, not independently reproduced since local Docker was v29]: on Docker
  Engine versions below v23.0, GreptimeDB's container may fail to start due to a Docker Engine
  bug; the documented workaround is adding `--security-opt seccomp=unconfined` to `docker run`.
  Worth guarding for in CI if the CI runner's Docker is old.
- **Volume**: mount a host directory (or a testcontainers-managed volume) at
  `/greptimedb_data` to persist data across restarts; for integration tests this is usually
  *not* wanted (each test run should start from an empty instance), so omitting the volume (or
  using an ephemeral bind mount) is fine — the container works with an anonymous/no-op data dir
  too since region storage just gets created fresh, as seen in the log line `going to open 0
  region(s)` on a clean start.
- **ulimit / nofile**: no explicit `ulimit`/`nofile` requirement was documented on the retrieved
  install/config pages, and the plain `docker run` in this session worked fine against the
  host's default (`ulimit -n` inside the container reported `20480`) for the small amount of
  data ingested here. This is a **known gap**: production GreptimeDB deployments generally
  benefit from a raised `nofile` (SST/region files scale with active regions and can be
  numerous under load), but no specific recommended number is stated in the docs surfaced by
  this research. For testcontainers usage (short-lived, low-volume) this is unlikely to matter;
  if flakiness related to "too many open files" appears in CI, raise the container's `ulimits`
  (`{ name: "nofile", soft: 65536, hard: 65536 }` in testcontainers' `HostConfig`) as a
  precaution rather than chasing an exact documented number.
- **Anonymous telemetry**: GreptimeDB standalone prints a notice on startup that it collects
  anonymous usage telemetry by default (`common_greptimedb_telemetry`, points to
  `docs.greptime.com/reference/telemetry` for opt-out). Not functionally relevant to paperhanger,
  but worth knowing for CI hygiene / network-egress-restricted runners — the opt-out is a config
  flag ([DOCS], not verified in this session).

### Suggested testcontainers sketch (not implemented — for the eventual integration test author)

```ts
import { GenericContainer, Wait } from "testcontainers";

const container = await new GenericContainer("greptime/greptimedb:v1.1.2")
  .withExposedPorts(4000, 4001, 4002, 4003)
  .withCommand([
    "standalone", "start",
    "--http-addr", "0.0.0.0:4000",
    "--rpc-bind-addr", "0.0.0.0:4001",
    "--mysql-addr", "0.0.0.0:4002",
    "--postgres-addr", "0.0.0.0:4003",
  ])
  .withWaitStrategy(Wait.forHttp("/health", 4000))
  .start();

const httpPort = container.getMappedPort(4000);
// seed via a real OTel SDK OTLPLogExporter/OTLPTraceExporter/OTLPMetricExporter
// pointed at http://localhost:${httpPort}/v1/otlp/v1/{logs,traces,metrics}
// (protobuf-only — see §4.1), then exercise the client's queryLogs/queryTraces/queryMetrics
// against http://localhost:${httpPort}/v1/sql and /v1/prometheus/api/v1/*.
```

---

## Sources

- Context7 `/websites/greptime` (indexed from `docs.greptime.com`, mixed `/0.14/`, `/0.15/`,
  and version-less "latest" pages, plus `docs.greptime.com/llms-full.txt` and
  `docs.greptime.com/SKILL.md`) — HTTP SQL API, authentication, PromQL API, OTLP ingestion
  headers/table docs, Docker standalone install docs, static user-provider auth docs, full-text
  search docs.
- `https://docs.greptime.com/getting-started/installation/greptimedb-standalone` (WebFetch) —
  current (v1.1.2-era) docker run command and seccomp caveat confirmation.
- Empirical verification: `greptime/greptimedb:latest` (resolved v1.1.2) standalone container
  run locally via Docker Desktop in this session; `@opentelemetry/sdk-logs`,
  `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-metrics` plus their
  `*-otlp-proto` exporters and `@opentelemetry/context-async-hooks`, run under Bun, used to
  produce real protobuf OTLP payloads; all schemas/responses quoted from actual `curl`/SQL
  output captured during this session, then containers removed (`docker rm -f`).
