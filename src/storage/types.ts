/**
 * Storage abstraction. Two implementations are planned: `sqlite.ts` (this
 * milestone) and `postgres.ts` (M6). See docs/spec.md section 3.3.
 */

import type {
	AgentRun,
	AgentRunOutcome,
	Incident,
	IncidentEvent,
	IncidentStatus,
} from "../core/types";

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
