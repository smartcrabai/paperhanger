import { describe, expect, test } from "bun:test";
import { fingerprintFromLabels, genericAdapter } from "./generic";

function requestWithJson(body: unknown): Request {
	return new Request("http://localhost/webhooks/generic", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("genericAdapter", () => {
	test("has name 'generic'", () => {
		expect(genericAdapter.name).toBe("generic");
	});

	test("accepts a single IncidentEvent-shaped object", async () => {
		const payload = {
			fingerprint: "fp-abc",
			source: "custom-system",
			status: "firing",
			severity: "warning",
			title: "Disk almost full",
			labels: { host: "db-1" },
			annotations: {},
			startsAt: "2026-07-17T09:00:00Z",
		};

		const events = await genericAdapter.parse(requestWithJson(payload));
		expect(events.length).toBe(1);
		expect(events[0]).toMatchObject({
			fingerprint: "fp-abc",
			source: "custom-system",
			status: "firing",
			severity: "warning",
			title: "Disk almost full",
		});
	});

	test("accepts an array of IncidentEvent-shaped objects", async () => {
		const payload = [
			{
				fingerprint: "fp-1",
				status: "firing",
				title: "First",
				labels: {},
				annotations: {},
				startsAt: "2026-07-17T09:00:00Z",
			},
			{
				fingerprint: "fp-2",
				status: "resolved",
				title: "Second",
				labels: {},
				annotations: {},
				startsAt: "2026-07-17T09:00:00Z",
			},
		];

		const events = await genericAdapter.parse(requestWithJson(payload));
		expect(events.length).toBe(2);
		expect(events.map((e) => e.fingerprint)).toEqual(["fp-1", "fp-2"]);
	});

	test("defaults source to 'generic' when not provided", async () => {
		const payload = {
			status: "firing",
			title: "No source given",
			labels: {},
			annotations: {},
			startsAt: "2026-07-17T09:00:00Z",
			fingerprint: "fp-x",
		};

		const events = await genericAdapter.parse(requestWithJson(payload));
		expect(events[0]?.source).toBe("generic");
	});

	test("defaults severity to 'unknown' when neither severity nor labels.severity is set", async () => {
		const payload = {
			status: "firing",
			title: "No severity",
			labels: {},
			annotations: {},
			startsAt: "2026-07-17T09:00:00Z",
			fingerprint: "fp-y",
		};

		const events = await genericAdapter.parse(requestWithJson(payload));
		expect(events[0]?.severity).toBe("unknown");
	});

	test("falls back to labels.severity when top-level severity is absent", async () => {
		const payload = {
			status: "firing",
			title: "Label severity",
			labels: { severity: "info" },
			annotations: {},
			startsAt: "2026-07-17T09:00:00Z",
			fingerprint: "fp-z",
		};

		const events = await genericAdapter.parse(requestWithJson(payload));
		expect(events[0]?.severity).toBe("info");
	});

	test("derives a stable fingerprint from sorted labels when fingerprint is omitted", async () => {
		const payload = {
			status: "firing",
			title: "No fingerprint",
			labels: { service: "my-api", region: "us-east-1" },
			annotations: {},
			startsAt: "2026-07-17T09:00:00Z",
		};

		const events = await genericAdapter.parse(requestWithJson(payload));
		expect(events[0]?.fingerprint).toBe(
			fingerprintFromLabels({ region: "us-east-1", service: "my-api" }),
		);
	});

	test("fingerprintFromLabels is stable regardless of key order", () => {
		const a = fingerprintFromLabels({ service: "my-api", region: "us-east-1" });
		const b = fingerprintFromLabels({ region: "us-east-1", service: "my-api" });
		expect(a).toBe(b);
	});

	test("throws on invalid JSON body", async () => {
		const req = new Request("http://localhost/webhooks/generic", {
			method: "POST",
			body: "not json",
		});
		await expect(genericAdapter.parse(req)).rejects.toThrow();
	});

	test("throws when required fields are missing", async () => {
		await expect(
			genericAdapter.parse(requestWithJson({ status: "firing" })),
		).rejects.toThrow();
	});

	test("throws on an invalid status value", async () => {
		const payload = {
			status: "unknown-status",
			title: "Bad status",
			labels: {},
			annotations: {},
			startsAt: "2026-07-17T09:00:00Z",
		};
		await expect(
			genericAdapter.parse(requestWithJson(payload)),
		).rejects.toThrow();
	});
});
