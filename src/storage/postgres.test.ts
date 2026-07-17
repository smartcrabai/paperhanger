import { describe, expect, test } from "bun:test";
import {
	mapAgentRunRow,
	mapIncidentEventRow,
	mapIncidentRow,
} from "./postgres";

/**
 * Unit tests for the pure row-mapping helpers in `postgres.ts`. These don't
 * touch a real database: they simulate the two shapes `Bun.sql` might hand
 * back for a given column (a native `Date`/parsed object, or the text
 * representation), which the mapper must normalize into the same
 * `IncidentStore` surface `sqlite.ts` exposes. See
 * `tests/integration/postgres.test.ts` for the real-database behavioral
 * suite.
 */

describe("mapIncidentRow", () => {
	test("normalizes Date timestamps and already-parsed JSONB columns", () => {
		const createdAt = new Date("2026-07-17T10:00:00.000Z");
		const updatedAt = new Date("2026-07-17T10:05:00.000Z");

		const incident = mapIncidentRow({
			id: "incident-1",
			fingerprint: "fp-1",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "High error rate",
			labels: { service: "my-api" },
			annotations: { runbook_url: "https://example.com/runbook" },
			created_at: createdAt,
			updated_at: updatedAt,
			resolved_at: null,
			pr_url: null,
			diagnosis: null,
			failure_reason: null,
		});

		expect(incident).toEqual({
			id: "incident-1",
			fingerprint: "fp-1",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "High error rate",
			labels: { service: "my-api" },
			annotations: { runbook_url: "https://example.com/runbook" },
			createdAt: "2026-07-17T10:00:00.000Z",
			updatedAt: "2026-07-17T10:05:00.000Z",
			resolvedAt: undefined,
			prUrl: undefined,
			diagnosis: undefined,
			failureReason: undefined,
		});
	});

	test("normalizes string timestamps and stringified JSONB columns", () => {
		const incident = mapIncidentRow({
			id: "incident-2",
			fingerprint: "fp-2",
			source: "alertmanager",
			status: "report_only",
			severity: "warning",
			title: "Latency spike",
			labels: JSON.stringify({ service: "my-api" }),
			annotations: JSON.stringify({}),
			created_at: "2026-07-17T10:00:00+00:00",
			updated_at: "2026-07-17T10:05:00+00:00",
			resolved_at: "2026-07-17T10:10:00+00:00",
			pr_url: null,
			diagnosis: "Root cause: config drift",
			failure_reason: null,
		});

		expect(incident.labels).toEqual({ service: "my-api" });
		expect(incident.annotations).toEqual({});
		expect(incident.createdAt).toBe("2026-07-17T10:00:00.000Z");
		expect(incident.resolvedAt).toBe("2026-07-17T10:10:00.000Z");
		expect(incident.diagnosis).toBe("Root cause: config drift");
	});

	test("maps null optional columns to undefined", () => {
		const incident = mapIncidentRow({
			id: "incident-3",
			fingerprint: "fp-3",
			source: "grafana",
			status: "failed",
			severity: "critical",
			title: "Boom",
			labels: {},
			annotations: {},
			created_at: new Date("2026-07-17T10:00:00.000Z"),
			updated_at: new Date("2026-07-17T10:00:00.000Z"),
			resolved_at: null,
			pr_url: null,
			diagnosis: null,
			failure_reason: "agent crashed",
		});

		expect(incident.resolvedAt).toBeUndefined();
		expect(incident.prUrl).toBeUndefined();
		expect(incident.diagnosis).toBeUndefined();
		expect(incident.failureReason).toBe("agent crashed");
	});

	test("throws a clear error when a timestamp column has an unexpected type", () => {
		expect(() =>
			mapIncidentRow({
				id: "incident-4",
				fingerprint: "fp-4",
				source: "grafana",
				status: "received",
				severity: "critical",
				title: "Boom",
				labels: {},
				annotations: {},
				created_at: 12345,
				updated_at: new Date(),
				resolved_at: null,
				pr_url: null,
				diagnosis: null,
				failure_reason: null,
			}),
		).toThrow();
	});
});

describe("mapAgentRunRow", () => {
	test("normalizes timestamps and maps null fields to undefined", () => {
		const run = mapAgentRunRow({
			id: "run-1",
			incident_id: "incident-1",
			started_at: new Date("2026-07-17T10:00:00.000Z"),
			finished_at: null,
			outcome: null,
			cost_usd: null,
			model: "anthropic/claude-sonnet-4-6",
		});

		expect(run).toEqual({
			id: "run-1",
			incidentId: "incident-1",
			startedAt: "2026-07-17T10:00:00.000Z",
			finishedAt: undefined,
			outcome: undefined,
			costUsd: undefined,
			model: "anthropic/claude-sonnet-4-6",
		});
	});

	test("round-trips a completed run", () => {
		const run = mapAgentRunRow({
			id: "run-2",
			incident_id: "incident-2",
			started_at: "2026-07-17T10:00:00+00:00",
			finished_at: "2026-07-17T10:20:00+00:00",
			outcome: "pr_created",
			cost_usd: 0.42,
			model: "anthropic/claude-sonnet-4-6",
		});

		expect(run.finishedAt).toBe("2026-07-17T10:20:00.000Z");
		expect(run.outcome).toBe("pr_created");
		expect(run.costUsd).toBe(0.42);
	});
});

describe("mapIncidentEventRow", () => {
	test("parses JSON columns and normalizes the timestamp", () => {
		const event = {
			fingerprint: "fp-1",
			source: "grafana",
			status: "firing" as const,
			severity: "critical",
			title: "High error rate",
			labels: {},
			annotations: {},
			startsAt: "2026-07-17T10:00:00Z",
			raw: { hello: "world" },
		};

		const record = mapIncidentEventRow({
			id: "event-1",
			incident_id: "incident-1",
			received_at: new Date("2026-07-17T10:00:01.000Z"),
			event_json: event,
			raw_payload_json: JSON.stringify({ original: true }),
		});

		expect(record.receivedAt).toBe("2026-07-17T10:00:01.000Z");
		expect(record.event).toEqual(event);
		expect(record.rawPayload).toEqual({ original: true });
	});
});
