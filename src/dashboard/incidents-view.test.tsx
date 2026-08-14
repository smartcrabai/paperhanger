import { describe, expect, jest, mock, test } from "bun:test";
import { IncidentsView } from "./incidents-view";
import {
	deferredResponse,
	errorResponse,
	jsonResponse,
	type RecordedRequest,
	stubFetch,
} from "./test-fetch";
import { incident, incidentEventRecord } from "./test-fixtures";
import {
	act,
	render,
	screen,
	setupDashboardTest,
	userEvent,
	waitFor,
	within,
} from "./test-setup";

setupDashboardTest();

/** Every handler below must reject unrecognized routes loudly (contract rule
 *  3) instead of the request just hanging. */
function unexpectedRoute(req: RecordedRequest) {
	return errorResponse(500, `unexpected route: ${req.route}`);
}

describe("IncidentsView list", () => {
	test("shows a loading placeholder, then replaces it with the fetched list", async () => {
		const deferred = deferredResponse();
		const http = stubFetch((req) =>
			req.route === "GET /incidents" ? deferred.promise : unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		expect(screen.getByText("Loading...")).toBeInTheDocument();

		await act(async () => {
			deferred.resolve(
				jsonResponse({ incidents: [incident({ title: "Boom" })] }),
			);
			await deferred.promise;
		});

		expect(await screen.findByText("Boom")).toBeInTheDocument();
		expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
		expect(http.calls[0]?.route).toBe("GET /incidents");
		expect(http.calls[0]?.token).toBe("tok");
	});

	test("shows the empty state when the API returns no incidents", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [] })
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);

		expect(await screen.findByText("No incidents yet.")).toBeInTheDocument();
	});

	test("renders rows in exactly the order the API returned, without re-sorting by date", async () => {
		// Deliberately oldest-first, the opposite of "newest first" -- proves
		// the view trusts IncidentStore.listIncidents' ordering rather than
		// imposing its own sort.
		const older = incident({
			id: "inc-older",
			title: "Older incident",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const newer = incident({
			id: "inc-newer",
			title: "Newer incident",
			createdAt: "2026-01-10T00:00:00.000Z",
		});
		stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [older, newer] })
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("Older incident");

		const [firstRow, secondRow] = screen.getAllByRole("button");
		if (!firstRow || !secondRow) {
			throw new Error("expected exactly two incident rows");
		}
		expect(screen.getAllByRole("button")).toHaveLength(2);
		expect(within(firstRow).getByText("Older incident")).toBeInTheDocument();
		expect(within(secondRow).getByText("Newer incident")).toBeInTheDocument();
	});

	test("renders each row's title, source, severity, status badge label, and formatted timestamp", async () => {
		const a = incident({
			id: "inc-a",
			title: "API 5xx rate high",
			source: "grafana",
			severity: "critical",
			status: "received",
			createdAt: "2026-02-03T04:05:06.000Z",
		});
		const b = incident({
			id: "inc-b",
			title: "DB pool exhausted",
			source: "pagerduty",
			severity: "warning",
			status: "pr_created",
			createdAt: "2026-03-04T05:06:07.000Z",
		});
		stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [a, b] })
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("API 5xx rate high");

		const rowA = screen.getByRole("button", { name: /API 5xx rate high/ });
		expect(within(rowA).getByText("grafana")).toBeInTheDocument();
		expect(within(rowA).getByText("critical")).toBeInTheDocument();
		expect(within(rowA).getByText("Received")).toBeInTheDocument();
		// Matches the component's own `new Date(...).toLocaleString()` call
		// rather than a hard-coded string, so the assertion doesn't depend on
		// the CI machine's locale/TZ.
		expect(
			within(rowA).getByText(new Date(a.createdAt).toLocaleString()),
		).toBeInTheDocument();

		const rowB = screen.getByRole("button", { name: /DB pool exhausted/ });
		expect(within(rowB).getByText("pagerduty")).toBeInTheDocument();
		expect(within(rowB).getByText("warning")).toBeInTheDocument();
		expect(within(rowB).getByText("PR created")).toBeInTheDocument();
		expect(
			within(rowB).getByText(new Date(b.createdAt).toLocaleString()),
		).toBeInTheDocument();
	});

	test("shows the PR flag only on rows that have a prUrl", async () => {
		const withPr = incident({
			id: "inc-with-pr",
			title: "Has a PR",
			prUrl: "https://github.com/acme/api/pull/42",
		});
		const withoutPr = incident({ id: "inc-without-pr", title: "No PR yet" });
		stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [withPr, withoutPr] })
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("Has a PR");

		const rowWithPr = screen.getByRole("button", { name: /Has a PR/ });
		const rowWithoutPr = screen.getByRole("button", { name: /No PR yet/ });
		expect(within(rowWithPr).getByText("PR")).toBeInTheDocument();
		expect(within(rowWithoutPr).queryByText("PR")).not.toBeInTheDocument();
	});

	test("shows the HTTP error message verbatim on a non-401 failure", async () => {
		// GET /incidents has no application-level non-401 error branch:
		// checkApiToken only ever returns 401, and the handler itself is
		// `Response.json({ incidents: await store.listIncidents(...) })` with
		// nothing catching a store failure (src/ingest/server.ts). The one
		// reachable non-401 failure is that exception escaping route() and
		// falling through to Bun.serve's own crash response -- verified with
		// Bun 1.3.14: an uncaught throw answers 500 with an HTML error page,
		// never a plain-text sentence (no dashboard route ever emits a 5xx
		// itself). The view must still show that text verbatim rather than
		// swallowing it.
		const CRASH_BODY =
			"<!doctype html><html><body>Internal Server Error</body></html>";
		const http = stubFetch((req) =>
			req.route === "GET /incidents"
				? errorResponse(500, CRASH_BODY)
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);

		expect(await screen.findByText(CRASH_BODY)).toBeInTheDocument();
		expect(http.calls[0]?.token).toBe("tok");
	});

	test("a single 401 response triggers exactly one onUnauthorized call and no error banner", async () => {
		const onUnauthorized = mock(() => {});
		stubFetch((req) =>
			req.route === "GET /incidents"
				? errorResponse(401, "unauthorized")
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={onUnauthorized} />);

		await screen.findByText("No incidents yet.");
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
		// 401 is handled distinctly from a generic failure (early return before
		// `setError`) -- the raw response text must never leak into the UI.
		expect(screen.queryByText("unauthorized")).not.toBeInTheDocument();

		// The sustained-401 case (dedupe/interval-stop across repeated ticks)
		// is covered separately below: "a sustained 401 backend triggers
		// onUnauthorized only once and stops polling".
	});

	test("keeps showing the previous list during a poll refresh instead of flashing back to Loading", async () => {
		jest.useFakeTimers();
		try {
			const first = incident({ id: "inc-1", title: "First fetch" });
			const secondFetch = deferredResponse();
			let callCount = 0;
			stubFetch((req) => {
				if (req.route !== "GET /incidents") return unexpectedRoute(req);
				callCount++;
				return callCount === 1
					? jsonResponse({ incidents: [first] })
					: secondFetch.promise;
			});

			render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
			await screen.findByText("First fetch");

			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
			});
			// The poll's second request is still pending -- the list must keep
			// rendering the last-known row, not revert to the loading placeholder
			// (only the mount effect sets `loading`, never the poll itself).
			expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
			expect(screen.getByText("First fetch")).toBeInTheDocument();

			await act(async () => {
				secondFetch.resolve(
					jsonResponse({
						incidents: [incident({ id: "inc-2", title: "Second fetch" })],
					}),
				);
				await secondFetch.promise;
			});
			expect(await screen.findByText("Second fetch")).toBeInTheDocument();
		} finally {
			jest.useRealTimers();
		}
	});

	test("clears a previous error banner once a later poll succeeds", async () => {
		jest.useFakeTimers();
		try {
			// The first poll's failure models GET /incidents' one reachable
			// non-401 failure -- an uncaught store error falling through to
			// Bun's own crash response (see "shows the HTTP error message
			// verbatim on a non-401 failure" above); no dashboard route emits
			// a 5xx with a prose body itself.
			const CRASH_BODY =
				"<!doctype html><html><body>Internal Server Error</body></html>";
			let callCount = 0;
			stubFetch((req) => {
				if (req.route !== "GET /incidents") return unexpectedRoute(req);
				callCount++;
				return callCount === 1
					? errorResponse(500, CRASH_BODY)
					: jsonResponse({ incidents: [incident({ title: "Recovered" })] });
			});

			render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
			await screen.findByText(CRASH_BODY);

			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});

			// A later successful poll must clear the stale error banner (the
			// success branch resets it), not just add the recovered list
			// underneath a banner that never gets torn down.
			expect(await screen.findByText("Recovered")).toBeInTheDocument();
			expect(screen.queryByText(CRASH_BODY)).not.toBeInTheDocument();
		} finally {
			jest.useRealTimers();
		}
	});

	test("re-fetches immediately when the token prop changes, not only on the next poll tick", async () => {
		const onUnauthorized = () => {};
		const http = stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [incident({ title: "Boom" })] })
				: unexpectedRoute(req),
		);

		const { rerender } = render(
			<IncidentsView token="tok-1" onUnauthorized={onUnauthorized} />,
		);
		await screen.findByText("Boom");
		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]?.token).toBe("tok-1");

		rerender(<IncidentsView token="tok-2" onUnauthorized={onUnauthorized} />);

		// `refresh` is recreated whenever `token` changes, and the mount effect
		// depends on `refresh` precisely so a rotated token (e.g. a refreshed
		// session elsewhere in the app) is picked up right away instead of
		// silently polling with the stale token until the next ~10s tick.
		await waitFor(() => expect(http.calls).toHaveLength(2));
		expect(http.calls[1]?.token).toBe("tok-2");
	});

	test("a sustained 401 backend triggers onUnauthorized only once and stops polling", async () => {
		jest.useFakeTimers();
		try {
			const onUnauthorized = mock(() => {});
			const http = stubFetch((req) =>
				req.route === "GET /incidents"
					? errorResponse(401, "unauthorized")
					: unexpectedRoute(req),
			);

			render(<IncidentsView token="tok" onUnauthorized={onUnauthorized} />);
			await screen.findByText("No incidents yet.");
			expect(onUnauthorized).toHaveBeenCalledTimes(1);
			expect(http.calls).toHaveLength(1);

			// Without a dedupe/interval-stop, a sustained-401 backend
			// re-invokes `onUnauthorized` (and re-polls) on every ~10s tick
			// forever -- 30s of ticks must add nothing beyond the one call
			// already recorded above.
			await act(async () => {
				jest.advanceTimersByTime(30_000);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(onUnauthorized).toHaveBeenCalledTimes(1);
			expect(http.calls).toHaveLength(1);
		} finally {
			jest.useRealTimers();
		}
	});

	test("resumes polling with a new token after a 401, because App keeps this view mounted through re-auth", async () => {
		jest.useFakeTimers();
		try {
			const onUnauthorized = mock(() => {});
			const http = stubFetch((req) => {
				if (req.route !== "GET /incidents") return unexpectedRoute(req);
				return req.token === "stale"
					? errorResponse(401, "unauthorized")
					: jsonResponse({
							incidents: [incident({ title: "Visible again" })],
						});
			});

			const { rerender } = render(
				<IncidentsView token="stale" onUnauthorized={onUnauthorized} />,
			);
			await screen.findByText("No incidents yet.");
			expect(onUnauthorized).toHaveBeenCalledTimes(1);

			// app.tsx's reauth overlay swaps the token in place instead of
			// unmounting the view (that is what preserves in-progress edits), so a
			// per-token stop is the only thing that lets polling recover here.
			rerender(<IncidentsView token="fresh" onUnauthorized={onUnauthorized} />);

			expect(await screen.findByText("Visible again")).toBeInTheDocument();
			expect(http.callsTo("GET /incidents")).toHaveLength(2);

			// And the resumed interval keeps polling with the new token.
			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(http.callsTo("GET /incidents")).toHaveLength(3);
			expect(onUnauthorized).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});

	test("resumes polling when the same token is resubmitted with a new onUnauthorized identity, and still reports a sustained failure only once per attempt", async () => {
		jest.useFakeTimers();
		try {
			const onUnauthorizedAttempt1 = mock(() => {});
			const http = stubFetch((req) =>
				req.route === "GET /incidents"
					? errorResponse(401, "unauthorized")
					: unexpectedRoute(req),
			);

			const { rerender } = render(
				<IncidentsView token="tok" onUnauthorized={onUnauthorizedAttempt1} />,
			);
			await screen.findByText("No incidents yet.");
			expect(onUnauthorizedAttempt1).toHaveBeenCalledTimes(1);
			expect(http.calls).toHaveLength(1);

			// Confirms this attempt is already stopped (mirrors "a sustained 401
			// backend..." above) before the re-submit below.
			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
			});
			expect(http.calls).toHaveLength(1);

			// App's reauth overlay bumps its auth epoch on every submit, so
			// `onUnauthorized`'s identity changes even when the operator
			// resubmits the SAME (still wrong) token string -- the only signal
			// available here that a new attempt happened. Before the fix, the
			// poll stop was keyed on `rejectedToken === token`, which stayed
			// true forever in this case: the view never fetched again, the
			// reported "frozen app" bug.
			const onUnauthorizedAttempt2 = mock(() => {});
			await act(async () => {
				rerender(
					<IncidentsView token="tok" onUnauthorized={onUnauthorizedAttempt2} />,
				);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(http.calls).toHaveLength(2);
			expect(onUnauthorizedAttempt2).toHaveBeenCalledTimes(1);
			expect(onUnauthorizedAttempt1).toHaveBeenCalledTimes(1);

			// And the new attempt stops again on its own sustained 401 -- no
			// spam for it either.
			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
			});
			expect(http.calls).toHaveLength(2);
			expect(onUnauthorizedAttempt2).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a stale poll response arriving after a fresher one does not overwrite the newer list", async () => {
		jest.useFakeTimers();
		try {
			const stalePoll = deferredResponse();
			let callCount = 0;
			stubFetch((req) => {
				if (req.route !== "GET /incidents") return unexpectedRoute(req);
				callCount++;
				return callCount === 1
					? stalePoll.promise
					: jsonResponse({
							incidents: [incident({ id: "inc-fresh", title: "Fresh poll" })],
						});
			});

			render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
			// Poll 1 (the mount fetch) is left pending so poll 2 can resolve
			// first, out of order.
			expect(screen.getByText("Loading...")).toBeInTheDocument();

			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(await screen.findByText("Fresh poll")).toBeInTheDocument();

			// Poll 1 finally resolves after poll 2 already rendered -- its
			// response must be dropped as stale, never overwrite the fresher
			// poll-2 list that already replaced the loading placeholder.
			await act(async () => {
				stalePoll.resolve(
					jsonResponse({
						incidents: [incident({ id: "inc-stale", title: "Stale poll" })],
					}),
				);
				await stalePoll.promise;
				await Promise.resolve();
			});

			expect(screen.getByText("Fresh poll")).toBeInTheDocument();
			expect(screen.queryByText("Stale poll")).not.toBeInTheDocument();
		} finally {
			jest.useRealTimers();
		}
	});

	test("a stale 401 arriving after a fresher successful poll is dropped by the generation guard, changing nothing", async () => {
		jest.useFakeTimers();
		try {
			const onUnauthorized = mock(() => {});
			const stalePoll = deferredResponse();
			let callCount = 0;
			const http = stubFetch((req) => {
				if (req.route !== "GET /incidents") return unexpectedRoute(req);
				callCount++;
				return callCount === 1
					? stalePoll.promise
					: jsonResponse({
							incidents: [incident({ id: "inc-fresh", title: "Fresh poll" })],
						});
			});

			render(<IncidentsView token="tok" onUnauthorized={onUnauthorized} />);
			// Poll 1 (mount fetch, generation 1) is left pending.
			expect(screen.getByText("Loading...")).toBeInTheDocument();

			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});
			// Poll 2 (generation 2) resolves first, with a 200.
			expect(await screen.findByText("Fresh poll")).toBeInTheDocument();

			// Poll 1 finally settles with a 401, after a fresher 200 already won.
			// The generation check sits in front of the 401 branch specifically
			// so this drops out before `onUnauthorized` or the rejected-attempt
			// bookkeeping ever sees it -- a naive ordering would otherwise stop
			// polling (or report a spurious 401) off a response nobody asked for
			// anymore.
			await act(async () => {
				stalePoll.resolve(errorResponse(401, "unauthorized"));
				await stalePoll.promise;
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(onUnauthorized).not.toHaveBeenCalled();
			expect(screen.getByText("Fresh poll")).toBeInTheDocument();

			// Polling must still be running -- a wrongly-applied stale 401 would
			// have stopped the interval.
			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(http.callsTo("GET /incidents")).toHaveLength(3);
			expect(onUnauthorized).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("IncidentsView selection", () => {
	test("renders no detail pane and issues no /events request before any row is selected", async () => {
		const http = stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [incident({ title: "Boom" })] })
				: unexpectedRoute(req),
		);

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("Boom");

		expect(
			screen.getByText("Select an incident to see its details."),
		).toBeInTheDocument();
		expect(http.calls.some((c) => c.route.includes("/events"))).toBe(false);
	});

	test("selecting a row fetches that incident's events and swaps in the detail pane", async () => {
		const user = userEvent.setup();
		const target = incident({ id: "inc-1", title: "Boom" });
		const http = stubFetch((req) => {
			if (req.route === "GET /incidents")
				return jsonResponse({ incidents: [target] });
			if (req.route === "GET /incidents/inc-1/events") {
				return jsonResponse({ events: [incidentEventRecord()] });
			}
			return unexpectedRoute(req);
		});

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await user.click(await screen.findByText("Boom"));

		await waitFor(() =>
			expect(
				screen.queryByText("Select an incident to see its details."),
			).not.toBeInTheDocument(),
		);
		const eventsCalls = http.callsTo("GET /incidents/inc-1/events");
		expect(eventsCalls).toHaveLength(1);
		expect(eventsCalls[0]?.token).toBe("tok");
	});

	test("switching the selected row re-fetches events for the newly selected id", async () => {
		const user = userEvent.setup();
		const one = incident({ id: "inc-1", title: "First incident" });
		const two = incident({ id: "inc-2", title: "Second incident" });
		const http = stubFetch((req) => {
			if (req.route === "GET /incidents")
				return jsonResponse({ incidents: [one, two] });
			if (req.route === "GET /incidents/inc-1/events") {
				return jsonResponse({ events: [] });
			}
			if (req.route === "GET /incidents/inc-2/events") {
				return jsonResponse({ events: [] });
			}
			return unexpectedRoute(req);
		});

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await user.click(await screen.findByText("First incident"));
		await waitFor(() =>
			expect(http.callsTo("GET /incidents/inc-1/events")).toHaveLength(1),
		);

		await user.click(screen.getByText("Second incident"));
		await waitFor(() =>
			expect(http.callsTo("GET /incidents/inc-2/events")).toHaveLength(1),
		);

		// Switching away must not re-request the previous incident's events.
		expect(http.callsTo("GET /incidents/inc-1/events")).toHaveLength(1);
	});

	test("marks only the selected row's button as selected", async () => {
		const user = userEvent.setup();
		const one = incident({ id: "inc-1", title: "First incident" });
		const two = incident({ id: "inc-2", title: "Second incident" });
		stubFetch((req) => {
			if (req.route === "GET /incidents")
				return jsonResponse({ incidents: [one, two] });
			if (req.route.endsWith("/events")) return jsonResponse({ events: [] });
			return unexpectedRoute(req);
		});

		render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("First incident");
		const rowOne = screen.getByRole("button", { name: /First incident/ });
		const rowTwo = screen.getByRole("button", { name: /Second incident/ });
		expect(rowOne).not.toHaveClass("selected");

		await user.click(rowOne);
		expect(rowOne).toHaveClass("selected");
		expect(rowTwo).not.toHaveClass("selected");

		await user.click(rowTwo);
		expect(rowTwo).toHaveClass("selected");
		expect(rowOne).not.toHaveClass("selected");
	});

	test("keeps the selection across a poll refresh and re-fetches events on the new tick", async () => {
		jest.useFakeTimers();
		try {
			const user = userEvent.setup({ delay: null });
			const target = incident({ id: "inc-1", title: "Boom" });
			const http = stubFetch((req) => {
				if (req.route === "GET /incidents")
					return jsonResponse({ incidents: [target] });
				if (req.route === "GET /incidents/inc-1/events") {
					return jsonResponse({ events: [] });
				}
				return unexpectedRoute(req);
			});

			render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
			await act(async () => {
				await Promise.resolve();
			});
			await user.click(screen.getByText("Boom"));
			await act(async () => {
				await Promise.resolve();
			});
			expect(http.callsTo("GET /incidents/inc-1/events")).toHaveLength(1);

			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});

			// The poll's second `GET /incidents` still lists the same incident,
			// so the selection (and the detail pane fetching it) must survive --
			// proven by a *second* /events call for the same id, carrying the
			// bumped refreshTick.
			expect(http.callsTo("GET /incidents")).toHaveLength(2);
			expect(http.callsTo("GET /incidents/inc-1/events")).toHaveLength(2);
			expect(
				screen.queryByText("Select an incident to see its details."),
			).not.toBeInTheDocument();
		} finally {
			jest.useRealTimers();
		}
	});

	test("does not crash when the selected incident disappears from a later poll response", async () => {
		jest.useFakeTimers();
		try {
			const user = userEvent.setup({ delay: null });
			const target = incident({ id: "inc-1", title: "Vanishing incident" });
			let incidentsResponse = [target];
			const http = stubFetch((req) => {
				if (req.route === "GET /incidents") {
					return jsonResponse({ incidents: incidentsResponse });
				}
				if (req.route === "GET /incidents/inc-1/events") {
					return jsonResponse({ events: [] });
				}
				return unexpectedRoute(req);
			});

			render(<IncidentsView token="tok" onUnauthorized={() => {}} />);
			await act(async () => {
				await Promise.resolve();
			});
			await user.click(screen.getByText("Vanishing incident"));
			await act(async () => {
				await Promise.resolve();
			});

			incidentsResponse = [];
			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});

			// The list itself must keep rendering (no thrown error tore down the
			// tree) even though `incidents.find(...)` for the still-selected id
			// now comes back `undefined`.
			expect(
				screen.getByRole("heading", { name: "Incidents" }),
			).toBeInTheDocument();
			expect(screen.getByText("No incidents yet.")).toBeInTheDocument();
			expect(screen.queryByText("Vanishing incident")).not.toBeInTheDocument();

			// `IncidentDetail` stays mounted (selectedId never clears itself) but
			// must stop re-fetching a timeline for an id no longer in the list --
			// only the initial selection's request should ever have gone out. A
			// missing `hasIncident` guard would instead keep issuing one more
			// `/events` request per poll tick forever.
			expect(http.callsTo("GET /incidents/inc-1/events")).toHaveLength(1);

			await act(async () => {
				jest.advanceTimersByTime(10_000);
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(http.callsTo("GET /incidents/inc-1/events")).toHaveLength(1);
		} finally {
			jest.useRealTimers();
		}
	});
});
