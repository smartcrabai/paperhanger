/**
 * Formatting helpers shared by the chat-style notifiers (Slack, Discord).
 * Kept separate from `types.ts` so both implementations render identical
 * copy for the same `NotificationEvent`.
 */

import type { NotificationEvent } from "./types";

export function emojiForKind(kind: NotificationEvent["kind"]): string {
	switch (kind) {
		case "diagnosis_started":
			return "🔍";
		case "pr_created":
			return "✅";
		case "report_only":
			return "📋";
		case "failed":
			return "❌";
		case "skipped":
			return "⏭️";
	}
}

export function titleForKind(kind: NotificationEvent["kind"]): string {
	switch (kind) {
		case "diagnosis_started":
			return "Diagnosis started";
		case "pr_created":
			return "Fix PR created";
		case "report_only":
			return "Report only";
		case "failed":
			return "Diagnosis failed";
		case "skipped":
			return "Skipped";
	}
}

/** Discord embed colors (decimal RGB), one per notification kind. */
export function colorForKind(kind: NotificationEvent["kind"]): number {
	switch (kind) {
		case "diagnosis_started":
			return 0x3498db; // blue
		case "pr_created":
			return 0x2ecc71; // green
		case "report_only":
			return 0x95a5a6; // gray
		case "failed":
			return 0xe74c3c; // red
		case "skipped":
			return 0xf1c40f; // yellow
	}
}

/** Main free-form text body for an event: PR summary, report, or reason. */
export function bodyForEvent(event: NotificationEvent): string {
	switch (event.kind) {
		case "diagnosis_started":
			return "Diagnosis in progress for this incident.";
		case "pr_created":
			return event.summary;
		case "report_only":
			return event.report;
		case "failed":
		case "skipped":
			return event.reason;
	}
}

/** Extra key/value fields specific to a kind, beyond the common incident fields. */
export function extraFields(
	event: NotificationEvent,
): Array<{ name: string; value: string }> {
	if (event.kind === "pr_created") {
		return [{ name: "Pull Request", value: event.prUrl }];
	}
	return [];
}

/** Single-line fallback text, used for push notification previews. */
export function fallbackLine(event: NotificationEvent): string {
	const emoji = emojiForKind(event.kind);
	const title = titleForKind(event.kind);
	return `${emoji} ${title}: ${event.incident.title} [${event.incident.severity}]`;
}

/**
 * Truncates `text` to at most `maxLength` characters, appending a marker so
 * it's clear the text was cut. Safe to call with text already under the
 * limit (returned unchanged). The result never exceeds `maxLength`: when
 * `maxLength` is smaller than the marker itself, the marker is sliced down
 * rather than appended in full (which would otherwise overshoot the limit).
 */
export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	if (maxLength <= 0) {
		return "";
	}
	const suffix = "… (truncated)";
	if (maxLength <= suffix.length) {
		return suffix.slice(0, maxLength);
	}
	const cutoff = maxLength - suffix.length;
	return `${text.slice(0, cutoff)}${suffix}`;
}
