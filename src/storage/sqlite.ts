/**
 * bun:sqlite implementation of `IncidentStore`. Single-instance deployments
 * use this with a volume-mounted file path; see docs/spec.md section 3.3.
 */

import { Database } from "bun:sqlite";
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
 * bun:sqlite's `SQLiteError` code for a UNIQUE constraint violation. See
 * https://www.sqlite.org/rescode.html#constraint_unique.
 */
const SQLITE_CONSTRAINT_UNIQUE = "SQLITE_CONSTRAINT_UNIQUE";

function isDuplicateOpenIncidentViolation(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err as { code?: string }).code === SQLITE_CONSTRAINT_UNIQUE &&
		err.message.includes("fingerprint")
	);
}

/** Name of the unique index backing `DuplicateRepoDefinitionError` (see `migrateV3`). */
const REPO_DEFINITIONS_UNIQUE_INDEX = "idx_repo_definitions_owner_repo";

function isDuplicateRepoDefinitionViolation(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err as { code?: string }).code === SQLITE_CONSTRAINT_UNIQUE &&
		err.message.includes(REPO_DEFINITIONS_UNIQUE_INDEX)
	);
}

interface IncidentRow {
	id: string;
	fingerprint: string;
	source: string;
	status: IncidentStatus;
	severity: string;
	title: string;
	labels: string;
	annotations: string;
	created_at: string;
	updated_at: string;
	resolved_at: string | null;
	pr_url: string | null;
	diagnosis: string | null;
	failure_reason: string | null;
}

interface IncidentEventRow {
	id: string;
	incident_id: string;
	received_at: string;
	event_json: string;
	raw_payload_json: string;
}

interface AgentRunRow {
	id: string;
	incident_id: string;
	started_at: string;
	finished_at: string | null;
	outcome: string | null;
	cost_usd: number | null;
	model: string;
}

interface RepoDefinitionRow {
	id: string;
	owner: string;
	repo: string;
	mappings: string;
	setup_script: string | null;
	test_command: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
}

function rowToIncident(row: IncidentRow): Incident {
	return {
		id: row.id,
		fingerprint: row.fingerprint,
		source: row.source,
		status: row.status,
		severity: row.severity,
		title: row.title,
		labels: JSON.parse(row.labels) as Record<string, string>,
		annotations: JSON.parse(row.annotations) as Record<string, string>,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at ?? undefined,
		prUrl: row.pr_url ?? undefined,
		diagnosis: row.diagnosis ?? undefined,
		failureReason: row.failure_reason ?? undefined,
	};
}

function rowToRepoDefinition(row: RepoDefinitionRow): RepoDefinition {
	return {
		id: row.id,
		owner: row.owner,
		repo: row.repo,
		mappings: JSON.parse(row.mappings) as Array<Record<string, string>>,
		setupScript: row.setup_script ?? undefined,
		testCommand: row.test_command ?? undefined,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
	return {
		id: row.id,
		incidentId: row.incident_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at ?? undefined,
		outcome: (row.outcome as AgentRun["outcome"]) ?? undefined,
		costUsd: row.cost_usd ?? undefined,
		model: row.model,
	};
}

export interface SqliteIncidentStoreOptions {
	/** Injectable clock for `created_at`/`updated_at` stamping. Defaults to the real wall clock; tests use this to pin cooldown-window boundaries deterministically. */
	now?: () => Date;
}

export class SqliteIncidentStore implements IncidentStore, RepoDefinitionStore {
	private readonly db: Database;
	private readonly now: () => Date;

	constructor(path: string, options: SqliteIncidentStoreOptions = {}) {
		this.db = new Database(path);
		this.now = options.now ?? (() => new Date());
	}

	async init(): Promise<void> {
		// WAL mode has no meaning for in-memory databases and Bun rejects it there.
		if (this.db.filename !== ":memory:") {
			this.db.run("PRAGMA journal_mode = WAL;");
		}
		// SQLite does not enforce declared FOREIGN KEY clauses unless this
		// pragma is set on every connection (it is not a persisted database
		// setting). Without it, orphan incident_events/agent_runs rows insert
		// silently, diverging from Postgres which always enforces its
		// REFERENCES constraints.
		this.db.run("PRAGMA foreign_keys = ON;");

		this.db.run(`
			CREATE TABLE IF NOT EXISTS schema_version (
				version INTEGER NOT NULL
			);
		`);
		const existing = this.db
			.query<{ version: number }, []>(
				"SELECT version FROM schema_version LIMIT 1",
			)
			.get();
		let version = existing?.version ?? 0;
		if (!existing) {
			this.db.run("INSERT INTO schema_version (version) VALUES (?);", [0]);
		}

		if (version < 1) {
			this.migrateV1();
			version = 1;
			this.setSchemaVersion(version);
		}
		if (version < 2) {
			this.migrateV2();
			version = 2;
			this.setSchemaVersion(version);
		}
		if (version < 3) {
			this.migrateV3();
			version = 3;
			this.setSchemaVersion(version);
		}
		if (version !== SCHEMA_VERSION) {
			throw new Error(
				`Migration chain incomplete: ended at version ${version}, expected ${SCHEMA_VERSION}. Add a migrateV${version + 1} step.`,
			);
		}
	}

	/** Original v1 DDL: base tables and their indexes. Left unmodified; new schema changes are added as new `migrateVN` steps instead. */
	private migrateV1(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS incidents (
				id TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				source TEXT NOT NULL,
				status TEXT NOT NULL,
				severity TEXT NOT NULL,
				title TEXT NOT NULL,
				labels TEXT NOT NULL,
				annotations TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				resolved_at TEXT,
				pr_url TEXT,
				diagnosis TEXT,
				failure_reason TEXT
			);
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents (fingerprint);",
		);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS incident_events (
				id TEXT PRIMARY KEY,
				incident_id TEXT NOT NULL,
				received_at TEXT NOT NULL,
				event_json TEXT NOT NULL,
				raw_payload_json TEXT NOT NULL,
				FOREIGN KEY (incident_id) REFERENCES incidents (id)
			);
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_incident_events_incident_id ON incident_events (incident_id);",
		);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS agent_runs (
				id TEXT PRIMARY KEY,
				incident_id TEXT NOT NULL,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				outcome TEXT,
				cost_usd REAL,
				model TEXT NOT NULL,
				FOREIGN KEY (incident_id) REFERENCES incidents (id)
			);
		`);
	}

	/**
	 * Adds a partial unique index enforcing at most one open (non-terminal)
	 * incident per fingerprint. This is the storage-layer defense-in-depth
	 * half of the dedup check-then-act race fix (see
	 * `DuplicateOpenIncidentError` in `./types.ts` and
	 * `IncidentManager.handleFiring`).
	 */
	private migrateV2(): void {
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_open_fingerprint
			ON incidents (fingerprint)
			WHERE status NOT IN (${TERMINAL_STATUS_LITERALS});
		`);
	}

	/**
	 * Adds `repo_definitions`, the dashboard-managed target-repository table
	 * (docs/spec.md). The unique index is keyed on lower(owner)/lower(repo) so
	 * case-variant duplicates (e.g. "Foo/Bar" vs "foo/bar") are rejected too;
	 * see `DuplicateRepoDefinitionError` in `./types.ts`.
	 */
	private migrateV3(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS repo_definitions (
				id TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				repo TEXT NOT NULL,
				mappings TEXT NOT NULL,
				setup_script TEXT,
				test_command TEXT,
				enabled INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS ${REPO_DEFINITIONS_UNIQUE_INDEX}
			ON repo_definitions (lower(owner), lower(repo));
		`);
	}

	private setSchemaVersion(version: number): void {
		this.db.run("UPDATE schema_version SET version = ?;", [version]);
	}

	async close(): Promise<void> {
		this.db.close();
	}

	async ping(): Promise<boolean> {
		try {
			this.db.query<{ 1: number }, []>("SELECT 1;").get();
			return true;
		} catch {
			return false;
		}
	}

	async createIncident(input: CreateIncidentInput): Promise<Incident> {
		const now = this.now().toISOString();
		const id = crypto.randomUUID();
		try {
			this.db.run(
				`INSERT INTO incidents
					(id, fingerprint, source, status, severity, title, labels, annotations, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
				[
					id,
					input.fingerprint,
					input.source,
					input.status,
					input.severity,
					input.title,
					JSON.stringify(input.labels),
					JSON.stringify(input.annotations),
					now,
					now,
				],
			);
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
		const row = this.db
			.query<IncidentRow, [string]>("SELECT * FROM incidents WHERE id = ?;")
			.get(id);
		return row ? rowToIncident(row) : undefined;
	}

	async listIncidents(limit = 100): Promise<Incident[]> {
		const rows = this.db
			.query<IncidentRow, [number]>(
				"SELECT * FROM incidents ORDER BY created_at DESC, rowid DESC LIMIT ?;",
			)
			.all(limit);
		return rows.map(rowToIncident);
	}

	async findOpenIncidentByFingerprint(
		fingerprint: string,
	): Promise<Incident | undefined> {
		const placeholders = TERMINAL_INCIDENT_STATUSES.map(() => "?").join(", ");
		// rowid is a secondary tie-breaker: timestamps have millisecond
		// resolution and can collide when incidents are created back-to-back
		// (e.g. in tests), but rowid always reflects insertion order.
		const row = this.db
			.query<IncidentRow, string[]>(
				`SELECT * FROM incidents WHERE fingerprint = ? AND status NOT IN (${placeholders}) ORDER BY created_at DESC, rowid DESC LIMIT 1;`,
			)
			.get(fingerprint, ...TERMINAL_INCIDENT_STATUSES);
		return row ? rowToIncident(row) : undefined;
	}

	async findLatestTerminalByFingerprint(
		fingerprint: string,
	): Promise<Incident | undefined> {
		const placeholders = TERMINAL_INCIDENT_STATUSES.map(() => "?").join(", ");
		const row = this.db
			.query<IncidentRow, string[]>(
				`SELECT * FROM incidents WHERE fingerprint = ? AND status IN (${placeholders}) ORDER BY updated_at DESC, rowid DESC LIMIT 1;`,
			)
			.get(fingerprint, ...TERMINAL_INCIDENT_STATUSES);
		return row ? rowToIncident(row) : undefined;
	}

	async listOpenIncidents(): Promise<Incident[]> {
		const placeholders = TERMINAL_INCIDENT_STATUSES.map(() => "?").join(", ");
		const rows = this.db
			.query<IncidentRow, string[]>(
				`SELECT * FROM incidents WHERE status NOT IN (${placeholders}) ORDER BY created_at ASC, rowid ASC;`,
			)
			.all(...TERMINAL_INCIDENT_STATUSES);
		return rows.map(rowToIncident);
	}

	/**
	 * Updates only the columns present in `patch`, in a single atomic
	 * statement (bun:sqlite's `run`/`query` execute synchronously, and
	 * nothing here awaits before issuing it, so no other call can interleave
	 * between decision and write). This fixes a lost-update race: the
	 * previous implementation read the full row, merged the patch in JS, and
	 * wrote every column back, so two concurrent patches touching different
	 * fields (e.g. `{ status }` from the pipeline and `{ resolvedAt }` from
	 * `IncidentManager.handleResolved`) could each overwrite the other's
	 * write with a stale value for the field they didn't intend to touch.
	 */
	async updateIncident(
		id: string,
		patch: UpdateIncidentInput,
	): Promise<Incident> {
		const sets: string[] = ["updated_at = ?"];
		const values: (string | null)[] = [this.now().toISOString()];

		if (patch.status !== undefined) {
			sets.push("status = ?");
			values.push(patch.status);
		}
		if ("resolvedAt" in patch) {
			sets.push("resolved_at = ?");
			values.push(patch.resolvedAt ?? null);
		}
		if ("prUrl" in patch) {
			sets.push("pr_url = ?");
			values.push(patch.prUrl ?? null);
		}
		if ("diagnosis" in patch) {
			sets.push("diagnosis = ?");
			values.push(patch.diagnosis ?? null);
		}
		if ("failureReason" in patch) {
			sets.push("failure_reason = ?");
			values.push(patch.failureReason ?? null);
		}
		values.push(id);

		const row = this.db
			.query<IncidentRow, (string | null)[]>(
				`UPDATE incidents SET ${sets.join(", ")} WHERE id = ? RETURNING *;`,
			)
			.get(...values);
		if (!row) {
			throw new Error(`Incident not found: ${id}`);
		}
		return rowToIncident(row);
	}

	async appendEvent(
		incidentId: string,
		event: IncidentEvent,
		rawPayload: unknown,
	): Promise<void> {
		this.db.run(
			`INSERT INTO incident_events (id, incident_id, received_at, event_json, raw_payload_json)
			VALUES (?, ?, ?, ?, ?);`,
			[
				crypto.randomUUID(),
				incidentId,
				this.now().toISOString(),
				JSON.stringify(event),
				JSON.stringify(rawPayload),
			],
		);
	}

	async listEvents(incidentId: string): Promise<IncidentEventRecord[]> {
		const rows = this.db
			.query<IncidentEventRow, [string]>(
				// rowid tiebreaker keeps this consistent with Postgres's `seq`
				// ordering: same-millisecond events (e.g. inserted in a tight
				// loop) would otherwise sort nondeterministically here.
				"SELECT * FROM incident_events WHERE incident_id = ? ORDER BY received_at ASC, rowid ASC;",
			)
			.all(incidentId);
		return rows.map((row) => ({
			id: row.id,
			incidentId: row.incident_id,
			receivedAt: row.received_at,
			event: JSON.parse(row.event_json) as IncidentEvent,
			rawPayload: JSON.parse(row.raw_payload_json) as unknown,
		}));
	}

	async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
		const id = crypto.randomUUID();
		this.db.run(
			`INSERT INTO agent_runs (id, incident_id, started_at, model)
			VALUES (?, ?, ?, ?);`,
			[id, input.incidentId, input.startedAt, input.model],
		);
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
		const row = this.db
			.query<AgentRunRow, [string]>("SELECT * FROM agent_runs WHERE id = ?;")
			.get(id);
		if (!row) {
			throw new Error(`Agent run not found: ${id}`);
		}
		const current = rowToAgentRun(row);
		const next: AgentRun = { ...current, ...patch };
		this.db.run(
			`UPDATE agent_runs SET finished_at = ?, outcome = ?, cost_usd = ? WHERE id = ?;`,
			[next.finishedAt ?? null, next.outcome ?? null, next.costUsd ?? null, id],
		);
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
			this.db.run(
				`INSERT INTO repo_definitions
					(id, owner, repo, mappings, setup_script, test_command, enabled, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
				[
					id,
					input.owner,
					input.repo,
					JSON.stringify(mappings),
					input.setupScript ?? null,
					input.testCommand ?? null,
					enabled ? 1 : 0,
					now,
					now,
				],
			);
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
		const row = this.db
			.query<RepoDefinitionRow, [string]>(
				"SELECT * FROM repo_definitions WHERE id = ?;",
			)
			.get(id);
		return row ? rowToRepoDefinition(row) : undefined;
	}

	async listRepoDefinitions(): Promise<RepoDefinition[]> {
		const rows = this.db
			.query<RepoDefinitionRow, []>(
				"SELECT * FROM repo_definitions ORDER BY owner ASC, repo ASC;",
			)
			.all();
		return rows.map(rowToRepoDefinition);
	}

	async findRepoDefinitionByRepo(
		owner: string,
		repo: string,
	): Promise<RepoDefinition | undefined> {
		const row = this.db
			.query<RepoDefinitionRow, [string, string]>(
				"SELECT * FROM repo_definitions WHERE lower(owner) = lower(?) AND lower(repo) = lower(?);",
			)
			.get(owner, repo);
		return row ? rowToRepoDefinition(row) : undefined;
	}

	async updateRepoDefinition(
		id: string,
		patch: UpdateRepoDefinitionInput,
	): Promise<RepoDefinition> {
		const sets: string[] = ["updated_at = ?"];
		const values: (string | number | null)[] = [this.now().toISOString()];

		if (patch.owner !== undefined) {
			sets.push("owner = ?");
			values.push(patch.owner);
		}
		if (patch.repo !== undefined) {
			sets.push("repo = ?");
			values.push(patch.repo);
		}
		if (patch.mappings !== undefined) {
			sets.push("mappings = ?");
			values.push(JSON.stringify(patch.mappings));
		}
		if ("setupScript" in patch) {
			sets.push("setup_script = ?");
			values.push(patch.setupScript ?? null);
		}
		if ("testCommand" in patch) {
			sets.push("test_command = ?");
			values.push(patch.testCommand ?? null);
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			values.push(patch.enabled ? 1 : 0);
		}
		values.push(id);

		let row: RepoDefinitionRow | null;
		try {
			row = this.db
				.query<RepoDefinitionRow, (string | number | null)[]>(
					`UPDATE repo_definitions SET ${sets.join(", ")} WHERE id = ? RETURNING *;`,
				)
				.get(...values);
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
		if (!row) {
			throw new RepoDefinitionNotFoundError(id);
		}
		return rowToRepoDefinition(row);
	}

	async deleteRepoDefinition(id: string): Promise<boolean> {
		const result = this.db.run("DELETE FROM repo_definitions WHERE id = ?;", [
			id,
		]);
		return result.changes > 0;
	}
}
