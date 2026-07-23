/**
 * Color-coded incident status pill (design doc "Views" section): terminal
 * outcomes get their own color, in-flight statuses share amber (queued) /
 * blue (actively working) so the operator can tell "waiting" from "running"
 * at a glance.
 */

import type { IncidentStatus } from "../core/types";

type Tone = "amber" | "blue" | "green" | "purple" | "gray" | "red";

const STATUS_LABEL: Record<IncidentStatus, string> = {
	received: "Received",
	collecting: "Collecting",
	resolving_repo: "Resolving repo",
	diagnosing: "Diagnosing",
	fixing: "Fixing",
	pr_created: "PR created",
	report_only: "Report only",
	failed: "Failed",
	skipped: "Skipped",
};

const STATUS_TONE: Record<IncidentStatus, Tone> = {
	received: "amber",
	collecting: "amber",
	resolving_repo: "amber",
	diagnosing: "blue",
	fixing: "blue",
	pr_created: "green",
	report_only: "purple",
	failed: "red",
	skipped: "gray",
};

export function StatusBadge({ status }: { status: IncidentStatus }) {
	return (
		<span className={`badge badge-${STATUS_TONE[status]}`}>
			{STATUS_LABEL[status]}
		</span>
	);
}
