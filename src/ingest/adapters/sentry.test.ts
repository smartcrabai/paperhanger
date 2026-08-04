import { describe, expect, test } from "bun:test";
import { sentryAdapter } from "./sentry";

/**
 * Captured shape of a real Sentry Integration Platform `event_alert` webhook.
 * See https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issue-alerts/
 */
const eventAlertPayload = {
	action: "triggered",
	actor: { id: "sentry", name: "Sentry", type: "application" },
	data: {
		event: {
			_ref: 1,
			_ref_version: 2,
			contexts: {
				browser: { name: "Chrome", type: "browser", version: "75.0.3770" },
				os: { name: "Mac OS X", type: "os", version: "10.14.0" },
			},
			culprit: "?(<anonymous>)",
			datetime: "2019-08-19T21:06:17.677000Z",
			dist: null,
			event_id: "e4874d664c3540c1a32eab185f12c5ab",
			exception: {
				values: [
					{
						type: "ReferenceError",
						value: "heck is not defined",
					},
				],
			},
			fingerprint: ["{{ default }}"],
			hashes: ["29f7ffc4903a8a990408b80a3b4c95a2"],
			issue_url: "https://sentry.io/api/0/issues/1117540176/",
			issue_id: "1117540176",
			key_id: "667532",
			level: "error",
			location: "<anonymous>",
			logger: "",
			message: "",
			metadata: {
				filename: "<anonymous>",
				type: "ReferenceError",
				value: "heck is not defined",
			},
			platform: "javascript",
			project: 1,
			received: 1566248777.677,
			release: null,
			sdk: { name: "sentry.javascript.browser", version: "5.5.0" },
			tags: [
				["browser", "Chrome 75.0.3770"],
				["browser.name", "Chrome"],
				["handled", "no"],
				["level", "error"],
				["environment", "production"],
				["service", "front-end"],
			],
			time_spent: null,
			timestamp: 1566248777.677,
			title: "ReferenceError: heck is not defined",
			type: "error",
			url: "https://sentry.io/api/0/projects/test-org/front-end/events/e4874d664c3540c1a32eab185f12c5ab/",
			version: "7",
			web_url:
				"https://sentry.io/organizations/test-org/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/",
		},
		triggered_rule: "Very Important Alert!",
	},
	installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
};

/**
 * Captured shape of a real Sentry Integration Platform `issue` webhook.
 * See https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/
 */
const issueCreatedPayload = {
	action: "created",
	installation: { uuid: "24b397fc-a86e-43ef-9297-949e21b82480" },
	data: {
		issue: {
			url: "https://sentry.io/api/0/organizations/example-org/issues/1234567890/",
			web_url: "https://example-org.sentry.io/issues/1234567890/",
			project_url:
				"https://example-org.sentry.io/issues/?project=4509877862268928",
			id: "1234567890",
			shareId: null,
			shortId: "PYTHON-Y",
			title: "Error generated with event_id: 495d375a(Priority: HIGH)",
			culprit: "test-transaction-0-41e49cd3-7252-441f-8d27-63a9ad697b0a",
			permalink: "https://example-org.sentry.io/issues/1234567890/",
			logger: "edge-function",
			level: "fatal",
			status: "unresolved",
			statusDetails: {},
			substatus: "new",
			isPublic: false,
			platform: "javascript",
			project: {
				id: "112313123123134",
				name: "python",
				slug: "python",
				platform: "python",
			},
			type: "default",
			metadata: {
				title: "Error generated with event_id: 495d375a(Priority: HIGH)",
				sdk: { name: "edge-function", name_normalized: "other" },
				severity: 1,
				severity_reason: "log_level_fatal",
				initial_priority: 75,
			},
			numComments: 0,
			assignedTo: null,
			isBookmarked: false,
			isSubscribed: false,
			subscriptionDetails: null,
			hasSeen: false,
			annotations: [],
			issueType: "error",
			issueCategory: "error",
			priority: "high",
			isUnhandled: false,
			count: "3",
			userCount: 3,
			firstSeen: "2025-11-10T20:56:00.679000+00:00",
			lastSeen: "2025-11-10T20:56:00.738000+00:00",
		},
	},
	actor: { type: "application", id: "example-app", name: "Example App" },
};

function requestWithJson(
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request("http://localhost/webhooks/sentry", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

const EVENT_ALERT_HEADERS = { "sentry-hook-resource": "event_alert" };
const ISSUE_HEADERS = { "sentry-hook-resource": "issue" };

describe("sentryAdapter", () => {
	test("has name 'sentry'", () => {
		expect(sentryAdapter.name).toBe("sentry");
	});

	describe("event_alert resource", () => {
		test("maps a triggered issue alert to a firing IncidentEvent", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(eventAlertPayload, EVENT_ALERT_HEADERS),
			);

			expect(events.length).toBe(1);
			const event = events[0];
			expect(event).toMatchObject({
				fingerprint: "1117540176",
				source: "sentry",
				status: "firing",
				severity: "critical",
				title: "ReferenceError: heck is not defined",
				startsAt: "2019-08-19T21:06:17.677000Z",
				generatorUrl:
					"https://sentry.io/organizations/test-org/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/",
			});
			expect(event?.endsAt).toBeUndefined();
			expect(event?.labels.project).toBe("1");
			expect(event?.labels.platform).toBe("javascript");
			expect(event?.labels.culprit).toBe("?(<anonymous>)");
			expect(event?.labels.level).toBe("error");
			expect(event?.labels.rule).toBe("Very Important Alert!");
			expect(event?.annotations.event_id).toBe(
				"e4874d664c3540c1a32eab185f12c5ab",
			);
			expect(event?.annotations.issue_url).toBe(
				"https://sentry.io/api/0/issues/1117540176/",
			);
		});

		test("promotes event tags into labels so repo resolution can match on them", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(eventAlertPayload, EVENT_ALERT_HEADERS),
			);

			expect(events[0]?.labels.service).toBe("front-end");
			expect(events[0]?.labels.environment).toBe("production");
			expect(events[0]?.labels["browser.name"]).toBe("Chrome");
			// Curated fields win over the auto-added "level" tag on conflicts.
			expect(events[0]?.labels.level).toBe("error");
		});

		test("description falls back to metadata.value when message is empty", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(eventAlertPayload, EVENT_ALERT_HEADERS),
			);
			expect(events[0]?.description).toBe("heck is not defined");
		});

		test("falls back to the triggered rule label when the event has no title", async () => {
			const payload = structuredClone(eventAlertPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.event.title;

			const events = await sentryAdapter.parse(
				requestWithJson(payload, EVENT_ALERT_HEADERS),
			);
			expect(events[0]?.title).toBe("Very Important Alert!");
		});

		test("falls back to 'Sentry alert' when both title and rule are missing", async () => {
			const payload = structuredClone(eventAlertPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.event.title;
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.triggered_rule;

			const events = await sentryAdapter.parse(
				requestWithJson(payload, EVENT_ALERT_HEADERS),
			);
			expect(events[0]?.title).toBe("Sentry alert");
		});

		test.each([
			["fatal", "critical"],
			["error", "critical"],
			["warning", "warning"],
			["info", "info"],
			["debug", "info"],
			["sample", "unknown"],
		])("maps level %s to severity %s", async (level, severity) => {
			const payload = structuredClone(eventAlertPayload);
			payload.data.event.level = level;

			const events = await sentryAdapter.parse(
				requestWithJson(payload, EVENT_ALERT_HEADERS),
			);
			expect(events[0]?.severity).toBe(severity);
		});

		test("falls back to 'unknown' severity when the level is missing", async () => {
			const payload = structuredClone(eventAlertPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.event.level;

			const events = await sentryAdapter.parse(
				requestWithJson(payload, EVENT_ALERT_HEADERS),
			);
			expect(events[0]?.severity).toBe("unknown");
		});

		test("keeps the full payload (exception data included) in raw for audit", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(eventAlertPayload, EVENT_ALERT_HEADERS),
			);
			const raw = events[0]?.raw as typeof eventAlertPayload;
			expect(raw.data.event.exception.values[0]?.type).toBe("ReferenceError");
			expect(raw.installation.uuid).toBe(
				"a8e5d37a-696c-4c54-adb5-b3f28d64c7de",
			);
		});

		test("returns zero events for a non-'triggered' action", async () => {
			const payload = { ...eventAlertPayload, action: "resolved" };
			const events = await sentryAdapter.parse(
				requestWithJson(payload, EVENT_ALERT_HEADERS),
			);
			expect(events).toEqual([]);
		});

		test("throws when issue_id is missing", async () => {
			const payload = structuredClone(eventAlertPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.event.issue_id;

			await expect(
				sentryAdapter.parse(requestWithJson(payload, EVENT_ALERT_HEADERS)),
			).rejects.toThrow();
		});

		test("throws when datetime is missing", async () => {
			const payload = structuredClone(eventAlertPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.event.datetime;

			await expect(
				sentryAdapter.parse(requestWithJson(payload, EVENT_ALERT_HEADERS)),
			).rejects.toThrow();
		});

		test("detects the resource from the body when the header is missing", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(eventAlertPayload),
			);
			expect(events.length).toBe(1);
			expect(events[0]?.fingerprint).toBe("1117540176");
		});
	});

	describe("issue resource", () => {
		test("maps a created issue to a firing IncidentEvent", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(issueCreatedPayload, ISSUE_HEADERS),
			);

			expect(events.length).toBe(1);
			const event = events[0];
			expect(event).toMatchObject({
				fingerprint: "1234567890",
				source: "sentry",
				status: "firing",
				severity: "critical",
				title: "Error generated with event_id: 495d375a(Priority: HIGH)",
				startsAt: "2025-11-10T20:56:00.679000+00:00",
				generatorUrl: "https://example-org.sentry.io/issues/1234567890/",
			});
			expect(event?.endsAt).toBeUndefined();
			expect(event?.labels.project).toBe("python");
			expect(event?.labels.platform).toBe("javascript");
			expect(event?.labels.logger).toBe("edge-function");
			expect(event?.labels.issue_category).toBe("error");
			expect(event?.annotations.short_id).toBe("PYTHON-Y");
			expect(event?.annotations.issue_url).toBe(
				"https://sentry.io/api/0/organizations/example-org/issues/1234567890/",
			);
		});

		test("maps an unresolved (regressed) issue to firing", async () => {
			const payload = { ...issueCreatedPayload, action: "unresolved" };
			const events = await sentryAdapter.parse(
				requestWithJson(payload, ISSUE_HEADERS),
			);
			expect(events[0]?.status).toBe("firing");
			expect(events[0]?.endsAt).toBeUndefined();
		});

		test("maps a resolved issue to resolved with endsAt from the hook timestamp", async () => {
			const payload = { ...issueCreatedPayload, action: "resolved" };
			const events = await sentryAdapter.parse(
				requestWithJson(payload, {
					...ISSUE_HEADERS,
					"sentry-hook-timestamp": "1762814400",
				}),
			);
			expect(events[0]?.status).toBe("resolved");
			expect(events[0]?.endsAt).toBe(new Date(1762814400 * 1000).toISOString());
		});

		test("tolerates an ISO 8601 hook timestamp", async () => {
			const payload = { ...issueCreatedPayload, action: "resolved" };
			const events = await sentryAdapter.parse(
				requestWithJson(payload, {
					...ISSUE_HEADERS,
					"sentry-hook-timestamp": "2025-11-10T21:30:00Z",
				}),
			);
			expect(events[0]?.endsAt).toBe("2025-11-10T21:30:00.000Z");
		});

		test("leaves endsAt unset when the hook timestamp is missing or invalid", async () => {
			const payload = { ...issueCreatedPayload, action: "resolved" };

			const withoutHeader = await sentryAdapter.parse(
				requestWithJson(payload, ISSUE_HEADERS),
			);
			expect(withoutHeader[0]?.endsAt).toBeUndefined();

			const withGarbage = await sentryAdapter.parse(
				requestWithJson(payload, {
					...ISSUE_HEADERS,
					"sentry-hook-timestamp": "not-a-timestamp",
				}),
			);
			expect(withGarbage[0]?.endsAt).toBeUndefined();
		});

		test("maps an archived issue to resolved", async () => {
			const payload = { ...issueCreatedPayload, action: "archived" };
			const events = await sentryAdapter.parse(
				requestWithJson(payload, {
					...ISSUE_HEADERS,
					"sentry-hook-timestamp": "1762814400",
				}),
			);
			expect(events[0]?.status).toBe("resolved");
		});

		test("returns zero events for an assignment (no alert-state change)", async () => {
			const payload = { ...issueCreatedPayload, action: "assigned" };
			const events = await sentryAdapter.parse(
				requestWithJson(payload, ISSUE_HEADERS),
			);
			expect(events).toEqual([]);
		});

		test("falls back to permalink when web_url is missing", async () => {
			const payload = structuredClone(issueCreatedPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.issue.web_url;

			const events = await sentryAdapter.parse(
				requestWithJson(payload, ISSUE_HEADERS),
			);
			expect(events[0]?.generatorUrl).toBe(
				"https://example-org.sentry.io/issues/1234567890/",
			);
		});

		test("falls back to 'Sentry issue' when the title is missing", async () => {
			const payload = structuredClone(issueCreatedPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.issue.title;

			const events = await sentryAdapter.parse(
				requestWithJson(payload, ISSUE_HEADERS),
			);
			expect(events[0]?.title).toBe("Sentry issue");
		});

		test("throws when the issue id is missing", async () => {
			const payload = structuredClone(issueCreatedPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.issue.id;

			await expect(
				sentryAdapter.parse(requestWithJson(payload, ISSUE_HEADERS)),
			).rejects.toThrow();
		});

		test("throws when firstSeen is missing", async () => {
			const payload = structuredClone(issueCreatedPayload);
			// @ts-expect-error -- intentionally removing a field for the test
			delete payload.data.issue.firstSeen;

			await expect(
				sentryAdapter.parse(requestWithJson(payload, ISSUE_HEADERS)),
			).rejects.toThrow();
		});
	});

	describe("other resources and malformed requests", () => {
		test("accepts and ignores resources paperhanger does not act on", async () => {
			const events = await sentryAdapter.parse(
				requestWithJson(
					{ action: "created", data: { installation: {} } },
					{ "sentry-hook-resource": "installation" },
				),
			);
			expect(events).toEqual([]);
		});

		test("throws on invalid JSON body", async () => {
			const req = new Request("http://localhost/webhooks/sentry", {
				method: "POST",
				body: "not json",
			});
			await expect(sentryAdapter.parse(req)).rejects.toThrow();
		});

		test("throws when the resource is unknown and the body shape is unrecognized", async () => {
			await expect(
				sentryAdapter.parse(requestWithJson({ hello: "world" })),
			).rejects.toThrow(/Unrecognized Sentry webhook/);
		});
	});
});
