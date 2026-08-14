/**
 * Fixture builders for the dashboard's tests: minimal, valid API payloads that
 * each test overrides field-by-field, so a test names only what it is about
 * (`repoDefinition({ enabled: false })`) and stays unaffected when an unrelated
 * field is added to the domain types in ../core/types.
 */

import type {
	CommonSetupScript,
	CommonSystemPrompt,
	Incident,
	RepoDefinition,
} from "../core/types";
import type { IncidentEventRecord } from "../storage/types";

const CREATED_AT = "2026-01-02T03:04:05.000Z";
const UPDATED_AT = "2026-01-02T03:04:06.000Z";

export function repoDefinition(
	overrides: Partial<RepoDefinition> = {},
): RepoDefinition {
	return {
		id: "repo-1",
		owner: "acme",
		repo: "api",
		mappings: [{ service: "api" }],
		enabled: true,
		createdAt: CREATED_AT,
		updatedAt: UPDATED_AT,
		...overrides,
	};
}

export function commonSetupScript(
	overrides: Partial<CommonSetupScript> = {},
): CommonSetupScript {
	return {
		id: "script-1",
		triggerFile: "package.json",
		script: "bun install",
		createdAt: CREATED_AT,
		updatedAt: UPDATED_AT,
		...overrides,
	};
}

export function commonSystemPrompt(
	overrides: Partial<CommonSystemPrompt> = {},
): CommonSystemPrompt {
	return {
		prompt: "Keep changes minimal.",
		createdAt: CREATED_AT,
		updatedAt: UPDATED_AT,
		...overrides,
	};
}

export function incident(overrides: Partial<Incident> = {}): Incident {
	return {
		id: "incident-1",
		fingerprint: "fp-1",
		source: "grafana",
		status: "received",
		severity: "critical",
		title: "API 5xx rate high",
		labels: { service: "api" },
		annotations: { runbook_url: "https://runbook.example.com" },
		createdAt: CREATED_AT,
		updatedAt: UPDATED_AT,
		...overrides,
	};
}

export function incidentEventRecord(
	overrides: Partial<IncidentEventRecord> = {},
): IncidentEventRecord {
	return {
		id: "event-1",
		incidentId: "incident-1",
		receivedAt: CREATED_AT,
		event: {
			fingerprint: "fp-1",
			source: "grafana",
			status: "firing",
			severity: "critical",
			title: "API 5xx rate high",
			labels: { service: "api" },
			annotations: {},
			startsAt: CREATED_AT,
			raw: { alert: "raw payload" },
		},
		rawPayload: { alert: "raw payload" },
		...overrides,
	};
}
