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
