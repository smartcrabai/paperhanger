import { describe, expect, test } from "bun:test";
import { alertmanagerAdapter } from "./alertmanager";

/**
 * Captured shape of a real Prometheus Alertmanager webhook receiver payload.
 * See https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
 */
const firingPayload = {
	version: "4",
	groupKey: '{}/{severity="critical"}:{alertname="HighErrorRate"}',
	truncatedAlerts: 0,
	status: "firing",
	receiver: "paperhanger",
	groupLabels: { alertname: "HighErrorRate" },
	commonLabels: {
		alertname: "HighErrorRate",
		severity: "critical",
	},
	commonAnnotations: { summary: "Error rate above threshold" },
	externalURL: "http://alertmanager.example.com",
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
			generatorURL:
				"http://prometheus.example.com/graph?g0.expr=rate%28errors%5B5m%5D%29",
			fingerprint: "abc123def456",
		},
	],
};

function requestWithJson(body: unknown): Request {
	return new Request("http://localhost/webhooks/alertmanager", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("alertmanagerAdapter", () => {
	test("has name 'alertmanager'", () => {
		expect(alertmanagerAdapter.name).toBe("alertmanager");
	});

	test("maps a firing alert to an IncidentEvent", async () => {
		const events = await alertmanagerAdapter.parse(
			requestWithJson(firingPayload),
		);

		expect(events.length).toBe(1);
		const event = events[0];
		expect(event).toMatchObject({
			fingerprint: "abc123def456",
			source: "alertmanager",
			status: "firing",
			severity: "critical",
			title: "Error rate above threshold",
			description: "5xx rate exceeded 5% for 5 minutes",
			startsAt: "2026-07-17T10:00:00Z",
			generatorUrl:
				"http://prometheus.example.com/graph?g0.expr=rate%28errors%5B5m%5D%29",
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

		const events = await alertmanagerAdapter.parse(
			requestWithJson(resolvedPayload),
		);

		expect(events[0]?.status).toBe("resolved");
		expect(events[0]?.endsAt).toBe("2026-07-17T10:30:00Z");
	});

	test("treats the zero-value sentinel endsAt as unset", async () => {
		const events = await alertmanagerAdapter.parse(
			requestWithJson(firingPayload),
		);
		expect(events[0]?.endsAt).toBeUndefined();
	});

	test("falls back to alertname when the summary annotation is missing", async () => {
		const payload = {
			...firingPayload,
			alerts: [
				{
					...firingPayload.alerts[0],
					annotations: {},
				},
			],
		};

		const events = await alertmanagerAdapter.parse(requestWithJson(payload));
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

		const events = await alertmanagerAdapter.parse(requestWithJson(payload));
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

		const events = await alertmanagerAdapter.parse(requestWithJson(payload));
		expect(events.length).toBe(2);
		expect(events.map((e) => e.fingerprint)).toEqual([
			"abc123def456",
			"another-fingerprint",
		]);
	});

	test("throws on invalid JSON body", async () => {
		const req = new Request("http://localhost/webhooks/alertmanager", {
			method: "POST",
			body: "not json",
		});
		await expect(alertmanagerAdapter.parse(req)).rejects.toThrow();
	});

	test("throws when 'alerts' is missing", async () => {
		await expect(
			alertmanagerAdapter.parse(requestWithJson({ status: "firing" })),
		).rejects.toThrow();
	});

	test("throws when an alert is missing its fingerprint", async () => {
		const payload = {
			...firingPayload,
			alerts: [{ ...firingPayload.alerts[0], fingerprint: undefined }],
		};
		await expect(
			alertmanagerAdapter.parse(requestWithJson(payload)),
		).rejects.toThrow();
	});
});
