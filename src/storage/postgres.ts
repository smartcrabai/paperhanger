/**
 * `Bun.sql`-backed PostgreSQL implementation of `IncidentStore`. Used for
 * replica deployments; single-instance deployments use `sqlite.ts` instead.
 * See docs/spec.md section 3.3.
 *
 * Schema mirrors sqlite.ts: JSONB columns for labels/annotations/raw
 * payloads, and a `schema_version` migration table. Timestamps are stored as
 * `TIMESTAMPTZ`, but every value crossing the `IncidentStore` interface is
 * normalized back to an ISO 8601 string (see `toIso`) so callers see an
 * identical surface regardless of which store implementation is in use.
 */

import { SQL } from "bun";
import { TERMINAL_INCIDENT_STATUSES } from "../core/types";
import type {
	AgentRun,
	CreateRepoDefinitionInput,
	Incident,
	IncidentEvent,
	IncidentStatus,
	RepoDefinition,
	UpdateRepoDefinitionInput,
} from "../core/types";
import {
	DuplicateOpenIncidentError,
	DuplicateRepoDefinitionError,
	RepoDefinitionNotFoundError,
	type CreateAgentRunInput,
	type CreateIncidentInput,
	type IncidentEventRecord,
	type IncidentStore,
	type RepoDefinitionStore,
	type UpdateAgentRunInput,
	type UpdateIncidentInput,
} from "./types";

/**
 * Current schema version. Migrations are applied incrementally (see
 * `migrateV1`/`migrateV2`) from whatever version is stored in
 * `schema_version`, so a fresh database still runs through the full chain
 * rather than jumping straight to the latest DDL. Add a new `migrateVN`
 * method (and a version check in `init()`) for future schema changes instead
 * of mutating an already-shipped migration in place.
 */
const SCHEMA_VERSION = 3;

/** SQL literal list of terminal statuses, safe to inline: sourced from our own constant, never user input. */
const TERMINAL_STATUS_LITERALS = TERMINAL_INCIDENT_STATUSES.map(
	(status) => `'${status}'`,
).join(", ");

/**
 * Postgres SQLSTATE for `unique_violation` (see
 * https://www.postgresql.org/docs/current/errcodes-appendix.html). Note this
 * is `PostgresError.errno`, not `.code`: Bun's `.code` is its own generic
 * `"ERR_POSTGRES_SERVER_ERROR"` for every server-side error, while `.errno`
 * carries the actual Postgres SQLSTATE as a string.
 */
const POSTGRES_UNIQUE_VIOLATION = "23505";

function isDuplicateOpenIncidentViolation(err: unknown): boolean {
	return (
		err instanceof SQL.PostgresError &&
		err.errno === POSTGRES_UNIQUE_VIOLATION &&
		(err.constraint?.includes("fingerprint") ?? false)
	);
}

/** Name of the unique index backing `DuplicateRepoDefinitionError` (see `migrateV3`). */
const REPO_DEFINITIONS_UNIQUE_INDEX = "idx_repo_definitions_owner_repo";

function isDuplicateRepoDefinitionViolation(err: unknown): boolean {
	return (
		err instanceof SQL.PostgresError &&
		err.errno === POSTGRES_UNIQUE_VIOLATION &&
		(err.constraint?.includes(REPO_DEFINITIONS_UNIQUE_INDEX) ?? false)
	);
}

interface IncidentRow {
	id: string;
	fingerprint: string;
	source: string;
	status: IncidentStatus;
	severity: string;
	title: string;
	labels: unknown;
	annotations: unknown;
	created_at: unknown;
	updated_at: unknown;
	resolved_at: unknown | null;
	pr_url: string | null;
	diagnosis: string | null;
	failure_reason: string | null;
}

interface IncidentEventRow {
	id: string;
	incident_id: string;
	received_at: unknown;
	event_json: unknown;
	raw_payload_json: unknown;
}

interface AgentRunRow {
	id: string;
	incident_id: string;
	started_at: unknown;
	finished_at: unknown | null;
	outcome: string | null;
	cost_usd: number | null;
	model: string;
}

interface RepoDefinitionRow {
	id: string;
	owner: string;
	repo: string;
	mappings: unknown;
	setup_script: string | null;
	test_command: string | null;
	enabled: boolean;
	created_at: unknown;
	updated_at: unknown;
}

/**
 * Normalizes a `TIMESTAMPTZ` value read back from Postgres into an ISO 8601
 * string. `Bun.sql` may return either a native `Date` or a text
 * representation depending on the column context, so both are handled.
 */
function toIso(value: unknown): string {
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === "string") {
		return new Date(value).toISOString();
	}
	throw new Error(`Expected a timestamp value, got: ${JSON.stringify(value)}`);
}

function toIsoOrUndefined(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : toIso(value);
}

/** JSONB columns are typically already parsed by the driver, but a raw string is handled too. */
function parseJsonColumn<T>(value: unknown): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

export function mapIncidentRow(row: IncidentRow): Incident {
	return {
		id: row.id,
		fingerprint: row.fingerprint,
		source: row.source,
		status: row.status,
		severity: row.severity,
		title: row.title,
		labels: parseJsonColumn<Record<string, string>>(row.labels),
		annotations: parseJsonColumn<Record<string, string>>(row.annotations),
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
		resolvedAt: toIsoOrUndefined(row.resolved_at),
		prUrl: row.pr_url ?? undefined,
		diagnosis: row.diagnosis ?? undefined,
		failureReason: row.failure_reason ?? undefined,
	};
}

export function mapAgentRunRow(row: AgentRunRow): AgentRun {
	return {
		id: row.id,
		incidentId: row.incident_id,
		startedAt: toIso(row.started_at),
		finishedAt: toIsoOrUndefined(row.finished_at),
		outcome: (row.outcome as AgentRun["outcome"]) ?? undefined,
		costUsd: row.cost_usd ?? undefined,
		model: row.model,
	};
}

export function mapIncidentEventRow(
	row: IncidentEventRow,
): IncidentEventRecord {
	return {
		id: row.id,
		incidentId: row.incident_id,
		receivedAt: toIso(row.received_at),
		event: parseJsonColumn<IncidentEvent>(row.event_json),
		rawPayload: parseJsonColumn<unknown>(row.raw_payload_json),
	};
}

export function mapRepoDefinitionRow(row: RepoDefinitionRow): RepoDefinition {
	return {
		id: row.id,
		owner: row.owner,
		repo: row.repo,
		mappings: parseJsonColumn<Array<Record<string, string>>>(row.mappings),
		setupScript: row.setup_script ?? undefined,
		testCommand: row.test_command ?? undefined,
		enabled: row.enabled,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

export interface PostgresIncidentStoreOptions {
	/** Injectable clock for `created_at`/`updated_at` stamping. Defaults to the real wall clock; tests use this to pin cooldown-window boundaries deterministically. */
	now?: () => Date;
}

export class PostgresIncidentStore
	implements IncidentStore, RepoDefinitionStore
{
	private readonly sql: SQL;
	private readonly now: () => Date;

	constructor(
		connectionString: string,
		options: PostgresIncidentStoreOptions = {},
	) {
		this.sql = new SQL(connectionString);
		this.now = options.now ?? (() => new Date());
	}

	async init(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS schema_version (
				version INTEGER NOT NULL
			)
		`;
		const existing = await this.sql<
			{ version: number }[]
		>`SELECT version FROM schema_version LIMIT 1`;
		let version = existing[0]?.version ?? 0;
		if (existing.length === 0) {
			await this.sql`INSERT INTO schema_version (version) VALUES (0)`;
		}

		if (version < 1) {
			await this.migrateV1();
			version = 1;
			await this.setSchemaVersion(version);
		}
		if (version < 2) {
			await this.migrateV2();
			version = 2;
			await this.setSchemaVersion(version);
		}
		if (version < 3) {
			await this.migrateV3();
			version = 3;
			await this.setSchemaVersion(version);
		}
		if (version !== SCHEMA_VERSION) {
			throw new Error(
				`Migration chain incomplete: ended at version ${version}, expected ${SCHEMA_VERSION}. Add a migrateV${version + 1} step.`,
			);
		}
	}

	/** Original v1 DDL: base tables and their indexes. Left unmodified; new schema changes are added as new `migrateVN` steps instead. */
	private async migrateV1(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS incidents (
				id TEXT PRIMARY KEY,
				seq BIGSERIAL NOT NULL,
				fingerprint TEXT NOT NULL,
				source TEXT NOT NULL,
				status TEXT NOT NULL,
				severity TEXT NOT NULL,
				title TEXT NOT NULL,
				labels JSONB NOT NULL,
				annotations JSONB NOT NULL,
				created_at TIMESTAMPTZ NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL,
				resolved_at TIMESTAMPTZ,
				pr_url TEXT,
				diagnosis TEXT,
				failure_reason TEXT
			)
		`;
		await this
			.sql`CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents (fingerprint)`;

		await this.sql`
			CREATE TABLE IF NOT EXISTS incident_events (
				id TEXT PRIMARY KEY,
				seq BIGSERIAL NOT NULL,
				incident_id TEXT NOT NULL REFERENCES incidents (id),
				received_at TIMESTAMPTZ NOT NULL,
				event_json JSONB NOT NULL,
				raw_payload_json JSONB NOT NULL
			)
		`;
		await this
			.sql`CREATE INDEX IF NOT EXISTS idx_incident_events_incident_id ON incident_events (incident_id)`;

		await this.sql`
			CREATE TABLE IF NOT EXISTS agent_runs (
				id TEXT PRIMARY KEY,
				incident_id TEXT NOT NULL REFERENCES incidents (id),
				started_at TIMESTAMPTZ NOT NULL,
				finished_at TIMESTAMPTZ,
				outcome TEXT,
				cost_usd DOUBLE PRECISION,
				model TEXT NOT NULL
			)
		`;
	}

	/**
	 * Adds a partial unique index enforcing at most one open (non-terminal)
	 * incident per fingerprint. This is the storage-layer defense-in-depth
	 * half of the dedup check-then-act race fix (see
	 * `DuplicateOpenIncidentError` in `./types.ts` and
	 * `IncidentManager.handleFiring`).
	 */
	private async migrateV2(): Promise<void> {
		await this.sql.unsafe(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_open_fingerprint
			ON incidents (fingerprint)
			WHERE status NOT IN (${TERMINAL_STATUS_LITERALS})
		`);
	}

	/**
	 * Adds `repo_definitions`, the dashboard-managed target-repository table
	 * (docs/spec.md). The unique index is keyed on lower(owner)/lower(repo) so
	 * case-variant duplicates (e.g. "Foo/Bar" vs "foo/bar") are rejected too;
	 * see `DuplicateRepoDefinitionError` in `./types.ts`.
	 */
	private async migrateV3(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS repo_definitions (
				id TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				repo TEXT NOT NULL,
				mappings JSONB NOT NULL,
				setup_script TEXT,
				test_command TEXT,
				enabled BOOLEAN NOT NULL,
				created_at TIMESTAMPTZ NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL
			)
		`;
		await this.sql.unsafe(`
			CREATE UNIQUE INDEX IF NOT EXISTS ${REPO_DEFINITIONS_UNIQUE_INDEX}
			ON repo_definitions (lower(owner), lower(repo))
		`);
	}

	private async setSchemaVersion(version: number): Promise<void> {
		await this.sql`UPDATE schema_version SET version = ${version}`;
	}

	async close(): Promise<void> {
		await this.sql.close();
	}

	async ping(): Promise<boolean> {
		try {
			await this.sql`SELECT 1`;
			return true;
		} catch {
			return false;
		}
	}

	async createIncident(input: CreateIncidentInput): Promise<Incident> {
		const now = this.now().toISOString();
		const id = crypto.randomUUID();
		try {
			await this.sql`
				INSERT INTO incidents
					(id, fingerprint, source, status, severity, title, labels, annotations, created_at, updated_at)
				VALUES
					(${id}, ${input.fingerprint}, ${input.source}, ${input.status}, ${input.severity}, ${input.title},
					 ${JSON.stringify(input.labels)}::jsonb, ${JSON.stringify(input.annotations)}::jsonb, ${now}, ${now})
			`;
		} catch (err) {
			if (isDuplicateOpenIncidentViolation(err)) {
				throw new DuplicateOpenIncidentError(input.fingerprint);
			}
			throw err;
		}
		const incident = await this.getIncident(id);
		if (!incident) {
			throw new Error(`Failed to read back created incident ${id}`);
		}
		return incident;
	}

	async getIncident(id: string): Promise<Incident | undefined> {
		const rows = await this.sql<IncidentRow[]>`
			SELECT * FROM incidents WHERE id = ${id}
		`;
		return rows[0] ? mapIncidentRow(rows[0]) : undefined;
	}

	async listIncidents(limit = 100): Promise<Incident[]> {
		const rows = await this.sql<IncidentRow[]>`
			SELECT * FROM incidents ORDER BY created_at DESC, seq DESC LIMIT ${limit}
		`;
		return rows.map(mapIncidentRow);
	}

	async findOpenIncidentByFingerprint(
		fingerprint: string,
	): Promise<Incident | undefined> {
		const rows = await this.sql<IncidentRow[]>`
			SELECT * FROM incidents
			WHERE fingerprint = ${fingerprint}
				AND status NOT IN ${this.sql([...TERMINAL_INCIDENT_STATUSES])}
			ORDER BY created_at DESC, seq DESC
			LIMIT 1
		`;
		return rows[0] ? mapIncidentRow(rows[0]) : undefined;
	}

	async findLatestTerminalByFingerprint(
		fingerprint: string,
	): Promise<Incident | undefined> {
		const rows = await this.sql<IncidentRow[]>`
			SELECT * FROM incidents
			WHERE fingerprint = ${fingerprint}
				AND status IN ${this.sql([...TERMINAL_INCIDENT_STATUSES])}
			ORDER BY updated_at DESC, seq DESC
			LIMIT 1
		`;
		return rows[0] ? mapIncidentRow(rows[0]) : undefined;
	}

	async listOpenIncidents(): Promise<Incident[]> {
		const rows = await this.sql<IncidentRow[]>`
			SELECT * FROM incidents
			WHERE status NOT IN ${this.sql([...TERMINAL_INCIDENT_STATUSES])}
			ORDER BY created_at ASC, seq ASC
		`;
		return rows.map(mapIncidentRow);
	}

	/**
	 * Updates only the columns present in `patch`, via a single atomic
	 * `UPDATE ... RETURNING *` using Bun's `sql(object, ...columns)` dynamic
	 * column helper. This fixes a lost-update race: the previous
	 * implementation read the full row, merged the patch in JS, and wrote
	 * every column back, so two concurrent patches touching different fields
	 * (e.g. `{ status }` from the pipeline and `{ resolvedAt }` from
	 * `IncidentManager.handleResolved`) could each overwrite the other's
	 * write with a stale value for the field they didn't intend to touch.
	 */
	async updateIncident(
		id: string,
		patch: UpdateIncidentInput,
	): Promise<Incident> {
		const columns: Record<string, unknown> = {
			updated_at: this.now().toISOString(),
		};
		const columnNames: string[] = ["updated_at"];

		if (patch.status !== undefined) {
			columns.status = patch.status;
			columnNames.push("status");
		}
		if ("resolvedAt" in patch) {
			columns.resolved_at = patch.resolvedAt ?? null;
			columnNames.push("resolved_at");
		}
		if ("prUrl" in patch) {
			columns.pr_url = patch.prUrl ?? null;
			columnNames.push("pr_url");
		}
		if ("diagnosis" in patch) {
			columns.diagnosis = patch.diagnosis ?? null;
			columnNames.push("diagnosis");
		}
		if ("failureReason" in patch) {
			columns.failure_reason = patch.failureReason ?? null;
			columnNames.push("failure_reason");
		}

		const rows = await this.sql<IncidentRow[]>`
			UPDATE incidents
			SET ${this.sql(columns, ...columnNames)}
			WHERE id = ${id}
			RETURNING *
		`;
		const row = rows[0];
		if (!row) {
			throw new Error(`Incident not found: ${id}`);
		}
		return mapIncidentRow(row);
	}

	async appendEvent(
		incidentId: string,
		event: IncidentEvent,
		rawPayload: unknown,
	): Promise<void> {
		await this.sql`
			INSERT INTO incident_events (id, incident_id, received_at, event_json, raw_payload_json)
			VALUES (${crypto.randomUUID()}, ${incidentId}, ${this.now().toISOString()},
				${JSON.stringify(event)}::jsonb, ${JSON.stringify(rawPayload)}::jsonb)
		`;
	}

	async listEvents(incidentId: string): Promise<IncidentEventRecord[]> {
		const rows = await this.sql<IncidentEventRow[]>`
			SELECT * FROM incident_events WHERE incident_id = ${incidentId} ORDER BY received_at ASC, seq ASC
		`;
		return rows.map(mapIncidentEventRow);
	}

	async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
		const id = crypto.randomUUID();
		await this.sql`
			INSERT INTO agent_runs (id, incident_id, started_at, model)
			VALUES (${id}, ${input.incidentId}, ${input.startedAt}, ${input.model})
		`;
		return {
			id,
			incidentId: input.incidentId,
			startedAt: input.startedAt,
			model: input.model,
		};
	}

	async updateAgentRun(
		id: string,
		patch: UpdateAgentRunInput,
	): Promise<AgentRun> {
		const rows = await this.sql<AgentRunRow[]>`
			SELECT * FROM agent_runs WHERE id = ${id}
		`;
		const row = rows[0];
		if (!row) {
			throw new Error(`Agent run not found: ${id}`);
		}
		const current = mapAgentRunRow(row);
		const next: AgentRun = { ...current, ...patch };
		await this.sql`
			UPDATE agent_runs
			SET finished_at = ${next.finishedAt ?? null}, outcome = ${next.outcome ?? null}, cost_usd = ${next.costUsd ?? null}
			WHERE id = ${id}
		`;
		return next;
	}

	async createRepoDefinition(
		input: CreateRepoDefinitionInput,
	): Promise<RepoDefinition> {
		const now = this.now().toISOString();
		const id = crypto.randomUUID();
		const mappings = input.mappings ?? [];
		const enabled = input.enabled ?? true;
		try {
			await this.sql`
				INSERT INTO repo_definitions
					(id, owner, repo, mappings, setup_script, test_command, enabled, created_at, updated_at)
				VALUES
					(${id}, ${input.owner}, ${input.repo}, ${JSON.stringify(mappings)}::jsonb,
					 ${input.setupScript ?? null}, ${input.testCommand ?? null}, ${enabled}, ${now}, ${now})
			`;
		} catch (err) {
			if (isDuplicateRepoDefinitionViolation(err)) {
				throw new DuplicateRepoDefinitionError(input.owner, input.repo);
			}
			throw err;
		}
		const definition = await this.getRepoDefinition(id);
		if (!definition) {
			throw new Error(`Failed to read back created repo definition ${id}`);
		}
		return definition;
	}

	async getRepoDefinition(id: string): Promise<RepoDefinition | undefined> {
		const rows = await this.sql<RepoDefinitionRow[]>`
			SELECT * FROM repo_definitions WHERE id = ${id}
		`;
		return rows[0] ? mapRepoDefinitionRow(rows[0]) : undefined;
	}

	async listRepoDefinitions(): Promise<RepoDefinition[]> {
		const rows = await this.sql<RepoDefinitionRow[]>`
			SELECT * FROM repo_definitions ORDER BY owner ASC, repo ASC
		`;
		return rows.map(mapRepoDefinitionRow);
	}

	async findRepoDefinitionByRepo(
		owner: string,
		repo: string,
	): Promise<RepoDefinition | undefined> {
		const rows = await this.sql<RepoDefinitionRow[]>`
			SELECT * FROM repo_definitions
			WHERE lower(owner) = lower(${owner}) AND lower(repo) = lower(${repo})
		`;
		return rows[0] ? mapRepoDefinitionRow(rows[0]) : undefined;
	}

	async updateRepoDefinition(
		id: string,
		patch: UpdateRepoDefinitionInput,
	): Promise<RepoDefinition> {
		const columns: Record<string, unknown> = {
			updated_at: this.now().toISOString(),
		};
		const columnNames: string[] = ["updated_at"];

		if (patch.owner !== undefined) {
			columns.owner = patch.owner;
			columnNames.push("owner");
		}
		if (patch.repo !== undefined) {
			columns.repo = patch.repo;
			columnNames.push("repo");
		}
		if (patch.mappings !== undefined) {
			columns.mappings = JSON.stringify(patch.mappings);
			columnNames.push("mappings");
		}
		if ("setupScript" in patch) {
			columns.setup_script = patch.setupScript ?? null;
			columnNames.push("setup_script");
		}
		if ("testCommand" in patch) {
			columns.test_command = patch.testCommand ?? null;
			columnNames.push("test_command");
		}
		if (patch.enabled !== undefined) {
			columns.enabled = patch.enabled;
			columnNames.push("enabled");
		}

		let rows: RepoDefinitionRow[];
		try {
			rows = await this.sql<RepoDefinitionRow[]>`
				UPDATE repo_definitions
				SET ${this.sql(columns, ...columnNames)}
				WHERE id = ${id}
				RETURNING *
			`;
		} catch (err) {
			if (isDuplicateRepoDefinitionViolation(err)) {
				const current = await this.getRepoDefinition(id);
				throw new DuplicateRepoDefinitionError(
					patch.owner ?? current?.owner ?? id,
					patch.repo ?? current?.repo ?? id,
				);
			}
			throw err;
		}
		const row = rows[0];
		if (!row) {
			throw new RepoDefinitionNotFoundError(id);
		}
		return mapRepoDefinitionRow(row);
	}

	async deleteRepoDefinition(id: string): Promise<boolean> {
		const rows = await this.sql<{ id: string }[]>`
			DELETE FROM repo_definitions WHERE id = ${id} RETURNING id
		`;
		return rows.length > 0;
	}
}
