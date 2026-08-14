/**
 * `IncidentDetail` renders straight from its `incident` prop (no fetch of its
 * own for that) but owns one side effect: `GET /incidents/:id/events`,
 * re-run on `incidentId` *and* `refreshTick` changes (see the component's own
 * doc comment). These tests render it directly with hand-built props rather
 * than through `IncidentsView`, so they can drive `refreshTick` and
 * `incidentId` independently of the list's own polling.
 */

import { describe, expect, test } from "bun:test";
import { IncidentDetail } from "./incident-detail";
import {
	deferredResponse,
	errorResponse,
	jsonResponse,
	stubFetch,
} from "./test-fetch";
import { incident, incidentEventRecord } from "./test-fixtures";
import { act, render, screen, setupDashboardTest, waitFor } from "./test-setup";

setupDashboardTest();

/** Base event payload every test starts from and overrides by field, so a
 *  test naming only "title" or "status" doesn't have to restate the rest of
 *  `IncidentEvent`. */
const baseEvent = incidentEventRecord().event;

/** Flushes pending microtasks (fetch -> res.json() -> the component's .then
 *  chain) without a real timer, so a response that was deliberately left
 *  pending (`deferredResponse()`) gets a chance to run its continuation
 *  before the test asserts on the result. */
async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}
	});
}

describe("IncidentDetail", () => {
	test("keys each event row by its own record id so a refresh doesn't warn React about ambiguous list identity", async () => {
		const eventA = incidentEventRecord({
			id: "event-a",
			event: { ...baseEvent, title: "CPU spike" },
		});
		const eventB = incidentEventRecord({
			id: "event-b",
			event: { ...baseEvent, title: "CPU spike resolved" },
		});
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [eventA, eventB] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const consoleErrors: unknown[][] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			consoleErrors.push(args);
		};

		try {
			render(
				<IncidentDetail
					incidentId="incident-1"
					incident={incident()}
					token="tok"
					onUnauthorized={() => {}}
					refreshTick={0}
				/>,
			);
			await screen.findAllByRole("listitem");
		} finally {
			console.error = originalConsoleError;
		}

		// A missing/duplicate `key` on the mapped `<li>` surfaces as a React
		// console.error ("Each child in a list should have a unique key
		// prop"), not a thrown exception or a visible DOM difference.
		expect(consoleErrors).toEqual([]);
	});

	test("fetches the timeline from GET /incidents/:id/events, percent-encoding the id", async () => {
		const rawId = "grp/inc 1";
		const encoded = encodeURIComponent(rawId);
		const http = stubFetch((req) =>
			req.route === `GET /incidents/${encoded}/events`
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(
			<IncidentDetail
				incidentId={rawId}
				incident={incident({ id: rawId })}
				token="tok-1"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("No events recorded.");

		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]?.path).toBe(`/incidents/${encoded}/events`);
		expect(http.calls[0]?.token).toBe("tok-1");
	});

	test("shows a loading placeholder before the timeline fetch resolves", async () => {
		const deferred = deferredResponse();
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? deferred.promise
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident()}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		expect(screen.getByText("Loading events...")).toBeInTheDocument();

		deferred.resolve(jsonResponse({ events: [] }));
		await screen.findByText("No events recorded.");
	});

	test("renders the incident's own fields without swapping or mismatching them", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents/incident-42/events"
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		const record = incident({
			id: "incident-42",
			fingerprint: "fp-42",
			source: "datadog",
			severity: "warning",
			title: "Latency spike",
			createdAt: "2026-02-01T00:00:00.000Z",
			updatedAt: "2026-02-02T00:00:00.000Z",
		});

		render(
			<IncidentDetail
				incidentId={record.id}
				incident={record}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Latency spike" }),
		).toBeInTheDocument();
		// Selector-scoped, not just presence: `incident-severity` is the
		// element the UI styles/queries as the severity indicator, so a swap
		// with the plain `source` span must fail here even though both
		// strings still appear somewhere in the document.
		expect(
			screen.getByText("warning", { selector: "span.incident-severity" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("datadog", { selector: "span.muted" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("ID", { selector: "dt" }).nextElementSibling,
		).toHaveTextContent("incident-42");
		expect(
			screen.getByText("Fingerprint", { selector: "dt" }).nextElementSibling,
		).toHaveTextContent("fp-42");
		expect(
			screen.getByText("Created", { selector: "dt" }).nextElementSibling,
		).toHaveTextContent(new Date(record.createdAt).toLocaleString());
		expect(
			screen.getByText("Updated", { selector: "dt" }).nextElementSibling,
		).toHaveTextContent(new Date(record.updatedAt).toLocaleString());

		await screen.findByText("No events recorded.");
	});

	test("renders labels and annotations as their JSON snapshot", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		const record = incident({
			labels: { service: "checkout", region: "us-east" },
			annotations: { runbook_url: "https://runbook.example.com/checkout" },
		});

		render(
			<IncidentDetail
				incidentId={record.id}
				incident={record}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("No events recorded.");

		// Exact textContent equality (not the whitespace-normalizing
		// toHaveTextContent) because JSON.stringify(..., null, 2)'s indentation
		// is the thing being asserted, not incidental formatting.
		const labelsPre = screen.getByText("Labels", {
			selector: "h3",
		}).nextElementSibling;
		expect(labelsPre?.textContent).toBe(JSON.stringify(record.labels, null, 2));
		const annotationsPre = screen.getByText("Annotations", {
			selector: "h3",
		}).nextElementSibling;
		expect(annotationsPre?.textContent).toBe(
			JSON.stringify(record.annotations, null, 2),
		);
	});

	test("shows resolvedAt, prUrl, diagnosis, and failureReason when the incident has them", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		const record = incident({
			resolvedAt: "2026-01-03T00:00:00.000Z",
			prUrl: "https://github.com/acme/api/pull/42",
			diagnosis: "Root cause: connection pool exhaustion.",
			failureReason: "Agent timed out after 3 retries.",
		});

		render(
			<IncidentDetail
				incidentId={record.id}
				incident={record}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("No events recorded.");

		expect(
			screen.getByText("Resolved", { selector: "dt" }).nextElementSibling,
		).toHaveTextContent(new Date(record.resolvedAt as string).toLocaleString());
		const prLink = screen.getByRole("link", { name: record.prUrl });
		expect(prLink).toHaveAttribute("href", record.prUrl);
		expect(prLink).toHaveAttribute("target", "_blank");
		expect(
			screen.getByText("Diagnosis", { selector: "h3" }).nextElementSibling,
		).toHaveTextContent(record.diagnosis as string);
		expect(
			screen.getByText("Failure reason", { selector: "h3" }).nextElementSibling,
		).toHaveTextContent(record.failureReason as string);
	});

	test('omits resolvedAt, prUrl, diagnosis, and failureReason when absent -- no empty row, no literal "undefined"', async () => {
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		// The default fixture sets none of these four optional fields.
		const record = incident();

		render(
			<IncidentDetail
				incidentId={record.id}
				incident={record}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("No events recorded.");

		expect(
			screen.queryByText("Resolved", { selector: "dt" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Pull request", { selector: "dt" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Diagnosis", { selector: "h3" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Failure reason", { selector: "h3" }),
		).not.toBeInTheDocument();
		// Guards against `{incident.diagnosis && <pre>{incident.diagnosis}</pre>}`
		// -style conditions ever regressing into rendering the literal string
		// "undefined" instead of skipping the block.
		expect(document.body.textContent).not.toContain("undefined");
	});

	test("renders each event's status, title, and received time from the timeline fetch", async () => {
		const eventA = incidentEventRecord({
			id: "event-a",
			receivedAt: "2026-01-05T10:00:00.000Z",
			event: { ...baseEvent, status: "firing", title: "CPU spike" },
		});
		const eventB = incidentEventRecord({
			id: "event-b",
			receivedAt: "2026-01-05T10:05:00.000Z",
			event: { ...baseEvent, status: "resolved", title: "CPU spike resolved" },
		});
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [eventA, eventB] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident()}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		const items = await screen.findAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("firing");
		expect(items[0]).toHaveTextContent("CPU spike");
		expect(items[0]).toHaveTextContent(
			new Date(eventA.receivedAt).toLocaleString(),
		);
		expect(items[1]).toHaveTextContent("resolved");
		expect(items[1]).toHaveTextContent("CPU spike resolved");
	});

	test("shows the empty-state placeholder for an incident with no events, without crashing", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident()}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		expect(await screen.findByText("No events recorded.")).toBeInTheDocument();
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});

	test("shows the server's error message verbatim on a non-401 failure", async () => {
		// GET /incidents/:id/events has exactly one non-401 failure mode with a
		// body -- the incident row disappearing between the list fetch and
		// this request (server.ts: `if (!incident) return new Response(
		// "incident not found", { status: 404 })`); the route never emits a 5xx.
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? errorResponse(404, "incident not found")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident()}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		expect(await screen.findByText("incident not found")).toBeInTheDocument();
	});

	test("calls onUnauthorized exactly once on a 401 and does not also render an error message", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? errorResponse(401, "unauthorized")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		let unauthorizedCalls = 0;

		render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident()}
				token="tok"
				onUnauthorized={() => {
					unauthorizedCalls += 1;
				}}
				refreshTick={0}
			/>,
		);

		// `finally` still flips `loading` off on the 401 path, landing on the
		// empty-state placeholder -- waiting for it proves the whole handler,
		// including the onUnauthorized branch above it, has already run.
		expect(await screen.findByText("No events recorded.")).toBeInTheDocument();
		expect(unauthorizedCalls).toBe(1);
		expect(screen.queryByText("unauthorized")).not.toBeInTheDocument();
	});

	test("re-fetches when incidentId changes and does not show the previous incident's events while the new fetch is pending", async () => {
		const deferredB = deferredResponse();
		const http = stubFetch((req) => {
			if (req.path === "/incidents/incident-1/events") {
				return jsonResponse({
					events: [
						incidentEventRecord({
							id: "event-a",
							event: { ...baseEvent, title: "Incident A event" },
						}),
					],
				});
			}
			if (req.path === "/incidents/incident-2/events") {
				return deferredB.promise;
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("Incident A event");

		rerender(
			<IncidentDetail
				incidentId="incident-2"
				incident={incident({ id: "incident-2" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		// A new incidentId must flip back to loading immediately rather than
		// leave incident-1's timeline on screen under incident-2's header.
		expect(screen.queryByText("Incident A event")).not.toBeInTheDocument();
		expect(screen.getByText("Loading events...")).toBeInTheDocument();

		deferredB.resolve(
			jsonResponse({
				events: [
					incidentEventRecord({
						id: "event-b",
						event: { ...baseEvent, title: "Incident B event" },
					}),
				],
			}),
		);
		await screen.findByText("Incident B event");
		expect(screen.queryByText("Incident A event")).not.toBeInTheDocument();
		expect(http.callsTo("GET /incidents/incident-1/events")).toHaveLength(1);
		expect(http.callsTo("GET /incidents/incident-2/events")).toHaveLength(1);
	});

	test("clears the previous incident's events when incidentId changes and the new fetch fails, instead of leaving a stale timeline under the error", async () => {
		const http = stubFetch((req) => {
			if (req.path === "/incidents/incident-1/events") {
				return jsonResponse({
					events: [
						incidentEventRecord({
							id: "event-a",
							event: { ...baseEvent, title: "Incident A event" },
						}),
					],
				});
			}
			if (req.path === "/incidents/incident-2/events") {
				return errorResponse(404, "incident not found");
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("Incident A event");

		rerender(
			<IncidentDetail
				incidentId="incident-2"
				incident={incident({ id: "incident-2" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		// The failed fetch for incident-2 still lands on the empty-state
		// branch of the loading/events ternary (`events.length === 0`) once
		// the stale incident-1 events are cleared; if they aren't, this would
		// instead render incident-1's `<ol>` underneath the error message.
		await screen.findByText("incident not found");
		expect(screen.queryByText("Incident A event")).not.toBeInTheDocument();
		expect(http.callsTo("GET /incidents/incident-2/events")).toHaveLength(1);
	});

	test("re-fetches on a refreshTick bump for the same incidentId without flashing back to the loading placeholder", async () => {
		const deferredPoll = deferredResponse();
		let callCount = 0;
		const http = stubFetch((req) => {
			if (req.path !== "/incidents/incident-1/events") {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			callCount += 1;
			return callCount === 1
				? jsonResponse({
						events: [
							incidentEventRecord({
								id: "event-a",
								event: { ...baseEvent, title: "First poll event" },
							}),
						],
					})
				: deferredPoll.promise;
		});

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		await screen.findByText("First poll event");

		rerender(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={1}
			/>,
		);

		// This is the entire reason refreshTick exists instead of just
		// re-fetching on a plain interval inside this component: the same
		// incident's poll must not blank the timeline while it re-fetches.
		expect(screen.getByText("First poll event")).toBeInTheDocument();
		expect(screen.queryByText("Loading events...")).not.toBeInTheDocument();

		deferredPoll.resolve(
			jsonResponse({
				events: [
					incidentEventRecord({
						id: "event-b",
						event: { ...baseEvent, title: "Second poll event" },
					}),
				],
			}),
		);
		await screen.findByText("Second poll event");
		expect(screen.queryByText("First poll event")).not.toBeInTheDocument();
		expect(http.callsTo("GET /incidents/incident-1/events")).toHaveLength(2);
	});

	test("re-fetches on a refreshTick bump even when every other prop is referentially stable", async () => {
		let callCount = 0;
		const http = stubFetch((req) => {
			if (req.path !== "/incidents/incident-1/events") {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			callCount += 1;
			return jsonResponse({ events: [] });
		});
		// A fresh `() => {}` per render (as the refreshTick test above uses)
		// itself churns the effect's dependency array and would mask a
		// `refreshTick` omission from that array -- hold every other prop
		// referentially fixed so only `refreshTick` differs between renders.
		const stableOnUnauthorized = () => {};
		const stableIncident = incident({ id: "incident-1" });

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={stableIncident}
				token="tok"
				onUnauthorized={stableOnUnauthorized}
				refreshTick={0}
			/>,
		);
		await screen.findByText("No events recorded.");
		expect(http.callsTo("GET /incidents/incident-1/events")).toHaveLength(1);

		rerender(
			<IncidentDetail
				incidentId="incident-1"
				incident={stableIncident}
				token="tok"
				onUnauthorized={stableOnUnauthorized}
				refreshTick={1}
			/>,
		);

		await waitFor(() =>
			expect(http.callsTo("GET /incidents/incident-1/events")).toHaveLength(2),
		);
		expect(callCount).toBe(2);
	});

	test("ignores a stale response that resolves after a newer one for the same incident", async () => {
		const deferredFirst = deferredResponse();
		const deferredSecond = deferredResponse();
		let callCount = 0;
		stubFetch((req) => {
			if (req.path !== "/incidents/incident-1/events") {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			callCount += 1;
			return callCount === 1 ? deferredFirst.promise : deferredSecond.promise;
		});

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		// Bump the tick before the first request has settled: both requests
		// are now in flight for the same incident.
		rerender(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={1}
			/>,
		);

		// The newer (second) request settles first.
		deferredSecond.resolve(
			jsonResponse({
				events: [
					incidentEventRecord({
						id: "event-new",
						event: { ...baseEvent, title: "Fresh event" },
					}),
				],
			}),
		);
		await screen.findByText("Fresh event");

		// The older, now-superseded request settles late; its cleanup already
		// flagged it `cancelled`, so it must not clobber the fresher view.
		deferredFirst.resolve(
			jsonResponse({
				events: [
					incidentEventRecord({
						id: "event-stale",
						event: { ...baseEvent, title: "Stale event" },
					}),
				],
			}),
		);
		await flush();

		expect(screen.getByText("Fresh event")).toBeInTheDocument();
		expect(screen.queryByText("Stale event")).not.toBeInTheDocument();
	});

	test("does not fetch the timeline while incident is undefined, even after a refreshTick bump", async () => {
		// Regression test: the timeline effect used to depend on `incidentId` /
		// `refreshTick` only, so once a poll dropped this incident from the
		// list (incident undefined) the component kept issuing authenticated
		// GET /incidents/:id/events requests on every refreshTick bump and
		// threw the result away, since only the fallback message below is
		// ever rendered in this state. No route should be hit at all.
		const http = stubFetch((req) =>
			errorResponse(500, `unexpected route: ${req.route}`),
		);

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={undefined}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		expect(
			screen.getByText("Incident no longer in the current list."),
		).toBeInTheDocument();
		expect(http.calls).toHaveLength(0);

		rerender(
			<IncidentDetail
				incidentId="incident-1"
				incident={undefined}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={1}
			/>,
		);
		await flush();

		expect(http.calls).toHaveLength(0);
	});

	test("fetches the timeline once the incident reappears after being undefined", async () => {
		const http = stubFetch((req) =>
			req.route === "GET /incidents/incident-1/events"
				? jsonResponse({ events: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const { rerender } = render(
			<IncidentDetail
				incidentId="incident-1"
				incident={undefined}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);
		expect(
			screen.getByText("Incident no longer in the current list."),
		).toBeInTheDocument();
		expect(http.calls).toHaveLength(0);

		rerender(
			<IncidentDetail
				incidentId="incident-1"
				incident={incident({ id: "incident-1" })}
				token="tok"
				onUnauthorized={() => {}}
				refreshTick={0}
			/>,
		);

		await screen.findByText("No events recorded.");
		expect(http.callsTo("GET /incidents/incident-1/events")).toHaveLength(1);
	});
});
