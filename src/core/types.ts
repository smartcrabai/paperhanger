/**
 * Core domain types shared across the ingest, storage, and (future) agent
 * layers. Canonical field definitions live in docs/spec.md section 3.1-3.3;
 * this file must stay in sync with that contract.
 */

/** Normalized alert lifecycle status, as reported by a source adapter. */
export type EventStatus = "firing" | "resolved";

/**
 * A single normalized alert event produced by a `SourceAdapter`. One webhook
 * call may contain multiple alerts, each mapped to its own `IncidentEvent`.
 */
export interface IncidentEvent {
	/** Source-provided identifier, or a stable hash of sorted labels. */
	fingerprint: string;
	/** Name of the source adapter that produced this event, e.g. "grafana". */
	source: string;
	status: EventStatus;
	/** Normalized severity, e.g. "critical" / "warning" / "info" / "unknown". */
	severity: string;
	title: string;
	description?: string;
	/** e.g. service, namespace, pod. */
	labels: Record<string, string>;
	/** e.g. runbook_url, repository. */
	annotations: Record<string, string>;
	/** ISO 8601 timestamp. */
	startsAt: string;
	/** ISO 8601 timestamp, present once the alert has resolved. */
	endsAt?: string;
	/** Link to the alert rule / dashboard that generated this event. */
	generatorUrl?: string;
	/** Original payload, kept for audit purposes. */
	raw: unknown;
}

/**
 * Incident lifecycle state. See docs/spec.md section 2 for the full state
 * machine diagram.
 *
 * Terminal states: "pr_created", "report_only", "failed", "skipped".
 */
export type IncidentStatus =
	| "received"
	| "collecting"
	| "resolving_repo"
	| "diagnosing"
	| "fixing"
	| "pr_created"
	| "report_only"
	| "failed"
	| "skipped";

/** Incident statuses that mean "no further processing will happen". */
export const TERMINAL_INCIDENT_STATUSES: readonly IncidentStatus[] = [
	"pr_created",
	"report_only",
	"failed",
	"skipped",
];

/**
 * A persisted incident: the deduplication/lifecycle unit keyed by
 * `fingerprint`.
 */
export interface Incident {
	id: string;
	fingerprint: string;
	source: string;
	status: IncidentStatus;
	severity: string;
	title: string;
	/** Snapshot of labels from the event that created this incident. */
	labels: Record<string, string>;
	/** Snapshot of annotations from the event that created this incident. */
	annotations: Record<string, string>;
	createdAt: string;
	updatedAt: string;
	resolvedAt?: string;
	prUrl?: string;
	diagnosis?: string;
	failureReason?: string;
}

/** Outcome classification for a completed agent run. */
export type AgentRunOutcome = "pr_created" | "report_only" | "failed";

/** A single invocation of the fix agent against an incident. */
export interface AgentRun {
	id: string;
	incidentId: string;
	startedAt: string;
	finishedAt?: string;
	outcome?: AgentRunOutcome;
	costUsd?: number;
	model: string;
}

/** Dashboard-managed target repository definition (docs/spec.md). */
export interface RepoDefinition {
	/** Store-generated UUID (crypto.randomUUID, same as incidents). */
	id: string;
	/** GitHub owner/org. */
	owner: string;
	/** GitHub repo name. */
	repo: string;
	/**
	 * Label matchers: an entry matches when EVERY key===labels[key]; entries
	 * are OR'd. Empty array = never used for resolution (the definition still
	 * supplies setupScript/testCommand when the repo is resolved another way).
	 */
	mappings: Array<Record<string, string>>;
	/** Shell script executed in the cloned repo before diagnosis. */
	setupScript?: string;
	/** Overrides agent-host test auto-detection. */
	testCommand?: string;
	/** Disabled definitions are ignored by resolver AND runner lookup. */
	enabled: boolean;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

export interface CreateRepoDefinitionInput {
	owner: string;
	repo: string;
	/** Defaults to `[]`. */
	mappings?: Array<Record<string, string>>;
	setupScript?: string;
	testCommand?: string;
	/** Defaults to `true`. */
	enabled?: boolean;
}

/** Partial patch, same semantics as UpdateIncidentInput. Optional string fields
 *  accept null to clear (setupScript/testCommand). */
export interface UpdateRepoDefinitionInput {
	owner?: string;
	repo?: string;
	mappings?: Array<Record<string, string>>;
	setupScript?: string | null;
	testCommand?: string | null;
	enabled?: boolean;
}
