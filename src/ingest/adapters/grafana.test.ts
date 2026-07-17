import { describe, expect, test } from "bun:test";
import { grafanaAdapter } from "./grafana";

/**
 * Captured shape of a real Grafana Alerting webhook notifier payload.
 * See https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/
 */
const firingPayload = {
	receiver: "paperhanger",
	status: "firing",
	orgId: 1,
	alerts: [
		{
			status: "firing",
			labels: {
				alertname: "HighErrorRate",
				severity: "critical",
				service: "my-api",
				namespace: "prod",
			},
			annotations: {
				summary: "Error rate above threshold",
				description: "5xx rate exceeded 5% for 5 minutes",
				runbook_url: "https://runbooks.example.com/high-error-rate",
			},
			startsAt: "2026-07-17T10:00:00Z",
			endsAt: "0001-01-01T00:00:00Z",
			generatorURL: "https://grafana.example.com/alerting/grafana/abc123/view",
			fingerprint: "57c6d9296de2ad39",
			silenceURL: "https://grafana.example.com/alerting/silence/new",
			dashboardURL: "",
			panelURL: "",
			valueString: "[ metric='errors' labels={service=my-api} value=10 ]",
		},
	],
	groupLabels: { alertname: "HighErrorRate" },
	commonLabels: { alertname: "HighErrorRate", severity: "critical" },
	commonAnnotations: { summary: "Error rate above threshold" },
	externalURL: "https://grafana.example.com/",
	version: "1",
	groupKey: "test-57c6d9296de2ad39-1744036972",
	numFiring: 1,
	numResolved: 0,
	truncatedAlerts: 0,
};

function requestWithJson(body: unknown): Request {
	return new Request("http://localhost/webhooks/grafana", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("grafanaAdapter", () => {
	test("has name 'grafana'", () => {
		expect(grafanaAdapter.name).toBe("grafana");
	});

	test("maps a firing alert to an IncidentEvent", async () => {
		const events = await grafanaAdapter.parse(requestWithJson(firingPayload));

		expect(events.length).toBe(1);
		const event = events[0];
		expect(event).toMatchObject({
			fingerprint: "57c6d9296de2ad39",
			source: "grafana",
			status: "firing",
			severity: "critical",
			title: "Error rate above threshold",
			description: "5xx rate exceeded 5% for 5 minutes",
			startsAt: "2026-07-17T10:00:00Z",
			generatorUrl: "https://grafana.example.com/alerting/grafana/abc123/view",
		});
		expect(event?.endsAt).toBeUndefined();
		expect(event?.labels.service).toBe("my-api");
		expect(event?.annotations.runbook_url).toBe(
			"https://runbooks.example.com/high-error-rate",
		);
	});

	test("maps a resolved alert and preserves a real endsAt", async () => {
		const resolvedPayload = {
			...firingPayload,
			status: "resolved",
			alerts: [
				{
					...firingPayload.alerts[0],
					status: "resolved",
					endsAt: "2026-07-17T10:30:00Z",
				},
			],
		};

		const events = await grafanaAdapter.parse(requestWithJson(resolvedPayload));

		expect(events[0]?.status).toBe("resolved");
		expect(events[0]?.endsAt).toBe("2026-07-17T10:30:00Z");
	});

	test("falls back to alertname when summary annotation is missing", async () => {
		const payload = {
			...firingPayload,
			alerts: [
				{
					...firingPayload.alerts[0],
					annotations: {},
				},
			],
		};

		const events = await grafanaAdapter.parse(requestWithJson(payload));
		expect(events[0]?.title).toBe("HighErrorRate");
	});

	test("falls back to 'unknown' severity when the label is missing", async () => {
		const payload = {
			...firingPayload,
			alerts: [
				{
					...firingPayload.alerts[0],
					labels: { alertname: "HighErrorRate" },
				},
			],
		};

		const events = await grafanaAdapter.parse(requestWithJson(payload));
		expect(events[0]?.severity).toBe("unknown");
	});

	test("maps multiple alerts in a single webhook call to multiple events", async () => {
		const payload = {
			...firingPayload,
			alerts: [
				firingPayload.alerts[0],
				{ ...firingPayload.alerts[0], fingerprint: "another-fingerprint" },
			],
		};

		const events = await grafanaAdapter.parse(requestWithJson(payload));
		expect(events.length).toBe(2);
		expect(events.map((e) => e.fingerprint)).toEqual([
			"57c6d9296de2ad39",
			"another-fingerprint",
		]);
	});

	test("throws on invalid JSON body", async () => {
		const req = new Request("http://localhost/webhooks/grafana", {
			method: "POST",
			body: "not json",
		});
		await expect(grafanaAdapter.parse(req)).rejects.toThrow();
	});

	test("throws when 'alerts' is missing", async () => {
		await expect(
			grafanaAdapter.parse(requestWithJson({ status: "firing" })),
		).rejects.toThrow();
	});

	test("throws when an alert is missing its fingerprint", async () => {
		const payload = {
			...firingPayload,
			alerts: [{ ...firingPayload.alerts[0], fingerprint: undefined }],
		};
		await expect(
			grafanaAdapter.parse(requestWithJson(payload)),
		).rejects.toThrow();
	});
});
