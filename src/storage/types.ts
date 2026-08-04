/**
 * Storage abstraction. Two implementations are provided: `sqlite.ts`
 * (single-instance deployments) and `postgres.ts` (replicated deployments).
 * See docs/spec.md section 3.3.
 */

import type {
	AgentRun,
	AgentRunOutcome,
	CommonSetupScript,
	CommonSystemPrompt,
	CreateCommonSetupScriptInput,
	CreateRepoDefinitionInput,
	Incident,
	IncidentEvent,
	IncidentStatus,
	RepoDefinition,
	SetCommonSystemPromptInput,
	UpdateCommonSetupScriptInput,
	UpdateRepoDefinitionInput,
} from "../core/types";
// Type-only, so `verbatimModuleSyntax` erases both of these entirely at
// build time -- there is no runtime import, hence no runtime circularity,
// even though `repo/resolver.ts` itself imports `RepoDefinitionStore` (below)
// from this same file. This is the one accepted exception to
// docs/architecture.md's storage-sits-below-repo/telemetry layering: an
// `IncidentCheckpoint` is pipeline working state (`ResolvedRepo`,
// `IncidentContext`) that storage must be able to name in order to persist
// it, and duplicating those shapes here would drift from the originals
// instead.
import type { ResolvedRepo } from "../repo/resolver";
import type { IncidentContext } from "../telemetry/types";

export interface CreateIncidentInput {
	fingerprint: string;
	source: string;
	status: IncidentStatus;
	severity: string;
	title: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

export interface UpdateIncidentInput {
	status?: IncidentStatus;
	resolvedAt?: string;
	prUrl?: string;
	diagnosis?: string;
	failureReason?: string;
}

/** A stored, normalized event tied to an incident, alongside its raw payload. */
export interface IncidentEventRecord {
	id: string;
	incidentId: string;
	receivedAt: string;
	event: IncidentEvent;
	rawPayload: unknown;
}

export interface CreateAgentRunInput {
	incidentId: string;
	startedAt: string;
	model: string;
}

export interface UpdateAgentRunInput {
	finishedAt?: string;
	outcome?: AgentRunOutcome;
	costUsd?: number;
}

/**
 * Enough state to resume an incident from its last completed pipeline stage
 * after a crash/restart, instead of re-running telemetry collection and repo
 * resolution (docs/spec.md section 3.2 and 3.10; see `IncidentPipeline.process`
 * in `core/pipeline.ts`). One row per incident: upserted as each stage
 * completes and deleted once the incident reaches a terminal status -- see
 * `saveIncidentCheckpoint`/`deleteIncidentCheckpoint` on `IncidentStore` below.
 *
 * Deliberately its own small, explicit record rather than repurposing
 * `Incident`'s own columns: `incidentContext` and `resolvedRepo` are
 * pipeline-internal working state, not part of the incident's public shape
 * (docs/spec.md section 3.1), and packing them onto `Incident` would leak
 * that shape into every reader of `GET /incidents`.
 */
export interface IncidentCheckpoint {
	incidentId: string;
	/** The `IncidentContext` built while collecting telemetry -- present once that stage has completed. */
	incidentContext: IncidentContext;
	/**
	 * The repo resolved by repo resolution, once it has succeeded with usable
	 * (non-"low") confidence. `undefined` while the incident has only
	 * completed telemetry collection.
	 */
	resolvedRepo?: ResolvedRepo;
	createdAt: string;
	updatedAt: string;
}

export interface SaveIncidentCheckpointInput {
	incidentContext: IncidentContext;
	resolvedRepo?: ResolvedRepo;
}

export interface IncidentStore {
	/** Creates tables/indexes if needed. Must be called before any other method. */
	init(): Promise<void>;
	close(): Promise<void>;
	/** Used by GET /readyz. Returns false instead of throwing on failure. */
	ping(): Promise<boolean>;

	/**
	 * Throws `DuplicateOpenIncidentError` when a partial unique index rejects
	 * the insert because an open incident already exists for this
	 * fingerprint (defense-in-depth against the check-then-act race between
	 * `findOpenIncidentByFingerprint` and this call; see
	 * `IncidentManager.handleFiring`).
	 */
	createIncident(input: CreateIncidentInput): Promise<Incident>;
	getIncident(id: string): Promise<Incident | undefined>;
	/**
	 * Most recently created incidents first. Backs the read-only `GET
	 * /incidents` operator/smoke-test endpoint (`src/ingest/server.ts`); not
	 * used by the pipeline itself.
	 */
	listIncidents(limit?: number): Promise<Incident[]>;
	/** "Open" means status is not one of the terminal statuses (see core/types.ts). */
	findOpenIncidentByFingerprint(
		fingerprint: string,
	): Promise<Incident | undefined>;
	/**
	 * Every open (non-terminal) incident, regardless of fingerprint. Used by
	 * `IncidentManager.recoverOpenIncidents()` at startup to re-enqueue
	 * incidents left mid-pipeline by a crash/restart. Ordering is oldest
	 * first (creation order) so recovery processes incidents in the order
	 * they originally arrived.
	 */
	listOpenIncidents(): Promise<Incident[]>;
	/** Most recently updated terminal incident for this fingerprint, used for cooldown checks. */
	findLatestTerminalByFingerprint(
		fingerprint: string,
	): Promise<Incident | undefined>;
	updateIncident(id: string, patch: UpdateIncidentInput): Promise<Incident>;

	appendEvent(
		incidentId: string,
		event: IncidentEvent,
		rawPayload: unknown,
	): Promise<void>;
	listEvents(incidentId: string): Promise<IncidentEventRecord[]>;

	createAgentRun(input: CreateAgentRunInput): Promise<AgentRun>;
	updateAgentRun(id: string, patch: UpdateAgentRunInput): Promise<AgentRun>;

	/**
	 * Upserts the single checkpoint row for `incidentId`. `IncidentPipeline`
	 * calls this once telemetry collection completes (`incidentContext` only)
	 * and again once repo resolution succeeds with usable confidence (adding
	 * `resolvedRepo`); `createdAt` is preserved across the second call,
	 * mirroring `setCommonSystemPrompt`'s upsert semantics. Throws if
	 * `incidentId` does not name an existing incident (foreign key
	 * enforcement, same convention as `appendEvent`/`createAgentRun`).
	 */
	saveIncidentCheckpoint(
		incidentId: string,
		input: SaveIncidentCheckpointInput,
	): Promise<IncidentCheckpoint>;
	/**
	 * `undefined` when the incident has never completed telemetry collection,
	 * or its checkpoint has already been cleaned up (see
	 * `deleteIncidentCheckpoint`). Read once by `IncidentPipeline.process` at
	 * the start of every run -- including a fresh, never-crashed one -- to
	 * decide how much of the pipeline to skip.
	 */
	getIncidentCheckpoint(
		incidentId: string,
	): Promise<IncidentCheckpoint | undefined>;
	/**
	 * Deletes the checkpoint row, if any. Called once an incident reaches a
	 * terminal status, so a checkpoint can never be read back for an incident
	 * that has already finished (defense-in-depth against stale-checkpoint
	 * reuse) and the table doesn't grow unboundedly. A no-op (not an error)
	 * when no checkpoint row exists.
	 */
	deleteIncidentCheckpoint(incidentId: string): Promise<void>;
}

/**
 * Thrown by `createIncident` when the partial unique index on
 * `incidents(fingerprint) WHERE status NOT IN (<terminal statuses>)` rejects
 * the insert because an open incident for this fingerprint already exists.
 * This is the storage-layer half of the dedup check-then-act race fix (see
 * docs/architecture.md and `IncidentManager.handleFiring`): the in-process
 * half serializes `handleEvent` calls per fingerprint, and this error is the
 * cross-process/defense-in-depth backstop. `IncidentManager` catches it,
 * re-fetches the open incident via `findOpenIncidentByFingerprint`, and
 * treats the event as a dedup instead of failing the request.
 */
export class DuplicateOpenIncidentError extends Error {
	constructor(public readonly fingerprint: string) {
		super(`An open incident already exists for fingerprint: ${fingerprint}`);
		this.name = "DuplicateOpenIncidentError";
	}
}

export interface RepoDefinitionStore {
	createRepoDefinition(
		input: CreateRepoDefinitionInput,
	): Promise<RepoDefinition>;
	getRepoDefinition(id: string): Promise<RepoDefinition | undefined>;
	/** ALL rows (including disabled ones), ordered by owner, then repo. */
	listRepoDefinitions(): Promise<RepoDefinition[]>;
	/** Case-insensitive match on both owner and repo. */
	findRepoDefinitionByRepo(
		owner: string,
		repo: string,
	): Promise<RepoDefinition | undefined>;
	updateRepoDefinition(
		id: string,
		patch: UpdateRepoDefinitionInput,
	): Promise<RepoDefinition>;
	/** Returns true if a row was deleted, false if `id` did not exist. */
	deleteRepoDefinition(id: string): Promise<boolean>;
}

export interface CommonSetupScriptStore {
	createCommonSetupScript(
		input: CreateCommonSetupScriptInput,
	): Promise<CommonSetupScript>;
	getCommonSetupScript(id: string): Promise<CommonSetupScript | undefined>;
	/** Ordered by creation time so matching scripts execute deterministically. */
	listCommonSetupScripts(): Promise<CommonSetupScript[]>;
	updateCommonSetupScript(
		id: string,
		patch: UpdateCommonSetupScriptInput,
	): Promise<CommonSetupScript>;
	/** Returns true if a row was deleted, false if `id` did not exist. */
	deleteCommonSetupScript(id: string): Promise<boolean>;
}

export class CommonSetupScriptNotFoundError extends Error {
	constructor(public readonly id: string) {
		super(`Common setup script not found: ${id}`);
		this.name = "CommonSetupScriptNotFoundError";
	}
}

export interface CommonSystemPromptStore {
	/** `undefined` when the operator has never saved one. */
	getCommonSystemPrompt(): Promise<CommonSystemPrompt | undefined>;
	/** Upsert of the single row; `createdAt` is preserved across updates. */
	setCommonSystemPrompt(
		input: SetCommonSystemPromptInput,
	): Promise<CommonSystemPrompt>;
}

/**
 * Thrown by `createRepoDefinition`/`updateRepoDefinition` when the unique
 * index on `repo_definitions(lower(owner), lower(repo))` rejects the write
 * because another definition already claims that owner/repo (case-
 * insensitively).
 */
export class DuplicateRepoDefinitionError extends Error {
	constructor(
		public readonly owner: string,
		public readonly repo: string,
	) {
		super(`A repo definition already exists for: ${owner}/${repo}`);
		this.name = "DuplicateRepoDefinitionError";
	}
}

/**
 * Thrown by `updateRepoDefinition` when `id` does not match any row. This is
 * the typed counterpart to `updateIncident`'s plain-`Error` not-found
 * convention: `updateRepoDefinition` is reachable from the HTTP layer (`PUT
 * /repo-definitions/:id`), which needs to tell this apart from an unexpected
 * failure and map it to a 404 instead of a 500 -- including the race where
 * the row is deleted between a caller's existence check and this call.
 */
export class RepoDefinitionNotFoundError extends Error {
	constructor(public readonly id: string) {
		super(`Repo definition not found: ${id}`);
		this.name = "RepoDefinitionNotFoundError";
	}
}
