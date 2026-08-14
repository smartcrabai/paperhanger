import { describe, expect, test } from "bun:test";
import { SystemPromptView } from "./system-prompt-view";
import {
	deferredResponse,
	errorResponse,
	jsonResponse,
	stubFetch,
} from "./test-fetch";
import { commonSystemPrompt } from "./test-fixtures";
import {
	fireEvent,
	render,
	screen,
	setupDashboardTest,
	userEvent,
	waitFor,
} from "./test-setup";

setupDashboardTest();

const GET_ROUTE = "GET /system-prompt";
const PUT_ROUTE = "PUT /system-prompt";
const PLACEHOLDER = "e.g. Always write tests before implementing a fix.";
/** The exact 400 body `handleSetCommonSystemPrompt` sends for an over-cap
 *  prompt (src/ingest/system-prompt.ts's 20,000-character `PromptSchema`,
 *  formatted by `formatZodError`) -- verified against the real schema so this
 *  test doesn't drift from the server's actual wording. */
const OVER_CAP_MESSAGE =
	"  - prompt: Too big: expected string to have <=20000 characters";
/** Bun's default response when a route handler's promise rejects without
 *  being caught anywhere in `route()` -- verified against Bun 1.3.14
 *  (`Bun.serve({ fetch() { throw new Error("boom"); } })` answers with this
 *  status/body, never a caller-supplied sentence). Neither
 *  `handleGetCommonSystemPrompt` nor `handleSetCommonSystemPrompt` wraps its
 *  store call in a try/catch, so a store failure surfaces as this opaque
 *  crash page -- there is no code path in either route that returns a 5xx
 *  with a hand-written plain-text message. */
const CRASH_RESPONSE_BODY =
	"<!doctype html><html><body>Internal Server Error</body></html>";

async function findTextarea() {
	return screen.findByPlaceholderText(PLACEHOLDER);
}

/** Waits one macrotask so an already-settled promise's `.then` chain (e.g. a
 *  stale, aborted save's response) finishes running before assertions. Used
 *  at 3+ call sites that all need the same tick, hence the helper. */
function flushMicrotasks(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

describe("SystemPromptView", () => {
	test("shows a loading state, then the textarea prefilled with the fetched prompt", async () => {
		const prompt = commonSystemPrompt({ prompt: "Keep changes minimal." });
		const http = stubFetch((req) =>
			req.route === GET_ROUTE
				? jsonResponse({ systemPrompt: prompt })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

		expect(screen.getByText("Loading...")).toBeInTheDocument();

		const textarea = await findTextarea();
		expect(textarea).toHaveValue("Keep changes minimal.");
		expect(http.calls[0]).toMatchObject({ route: GET_ROUTE, token: "tok" });
	});

	test("a systemPrompt: null response renders an empty, editable textarea instead of crashing", async () => {
		stubFetch((req) =>
			req.route === GET_ROUTE
				? jsonResponse({ systemPrompt: null })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

		const textarea = await findTextarea();
		expect(textarea).toHaveValue("");
		expect(screen.getByText("Not configured yet.")).toBeInTheDocument();
	});

	test("an empty stored prompt renders the empty-state message (blank means no common prompt)", async () => {
		// `stored.prompt.trim()` gates "Not configured yet." vs the timestamp.
		// A whitespace-only value can never come back here: `PromptSchema`
		// (src/ingest/system-prompt.ts) trims before both the 20,000-char cap
		// and the store write, and `handleSetCommonSystemPrompt` is the only
		// writer of `common_system_prompt` -- so the reachable "cleared"
		// value from GET is "", not "   ".
		stubFetch((req) =>
			req.route === GET_ROUTE
				? jsonResponse({ systemPrompt: commonSystemPrompt({ prompt: "" }) })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

		const textarea = await findTextarea();
		expect(textarea).toHaveValue("");
		expect(screen.getByText("Not configured yet.")).toBeInTheDocument();
	});

	test("a load failure's body is shown verbatim -- even the framework's opaque crash page -- and Retry re-fetches successfully", async () => {
		// GET /system-prompt has no request body to validate, so its only
		// deliberate error branch is the 401 in `checkApiToken` (covered
		// below); a store failure is never caught, so it surfaces as Bun's
		// own crash response, not a hand-written sentence. The view has no
		// special handling for that shape either -- it renders `err.message`
		// as-is, whatever it is.
		const user = userEvent.setup();
		const prompt = commonSystemPrompt();
		let getCount = 0;
		const http = stubFetch((req) => {
			if (req.route !== GET_ROUTE) {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			getCount += 1;
			return getCount === 1
				? errorResponse(500, CRASH_RESPONSE_BODY)
				: jsonResponse({ systemPrompt: prompt });
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

		expect(await screen.findByText(CRASH_RESPONSE_BODY)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Retry" }));

		expect(await findTextarea()).toHaveValue(prompt.prompt);
		expect(http.callsTo(GET_ROUTE)).toHaveLength(2);
	});

	test("after a failed first load, Retry shows the loading placeholder again, and a superseded refresh can't clobber a newer one", async () => {
		// Before this fix, `hasLoadedOnceRef.current = true` ran in `finally`
		// even on a FAILED first load, so a later Retry skipped
		// `setLoading(true)` entirely -- the Retry button never disappeared,
		// which both hid the fact that a new request was in flight and made
		// it reachable to fire a second overlapping GET with no guard against
		// a stale response winning.
		const user = userEvent.setup();
		let getCount = 0;
		const retryResponse = deferredResponse();
		const concurrentResponse = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route !== GET_ROUTE) {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			getCount += 1;
			if (getCount === 1) return errorResponse(500, CRASH_RESPONSE_BODY);
			if (getCount === 2) return retryResponse.promise;
			return concurrentResponse.promise;
		});
		const { rerender } = render(
			<SystemPromptView token="tok" onUnauthorized={() => {}} />,
		);
		expect(await screen.findByText(CRASH_RESPONSE_BODY)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Retry" }));

		// The first load never succeeded, so Retry must show the loading
		// placeholder again -- not sit on the stale error with a Retry button
		// that looks clickable but silently does nothing new.
		expect(screen.getByText("Loading...")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();

		// A second, newer refresh starts concurrently -- e.g. a fresh auth
		// attempt changing `onUnauthorized`'s identity while Retry's GET is
		// still pending. Both requests are in flight at once.
		rerender(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		await waitFor(() => expect(http.callsTo(GET_ROUTE)).toHaveLength(3));

		// Resolve the NEWER request first, then the older (Retry's) one
		// late, to prove a stale response settling afterward can't overwrite
		// the newer result already applied.
		concurrentResponse.resolve(
			jsonResponse({ systemPrompt: commonSystemPrompt({ prompt: "FRESH" }) }),
		);
		const textarea = await findTextarea();
		expect(textarea).toHaveValue("FRESH");

		retryResponse.resolve(
			jsonResponse({ systemPrompt: commonSystemPrompt({ prompt: "STALE" }) }),
		);
		await flushMicrotasks();
		expect(textarea).toHaveValue("FRESH");
	});

	test("a refetch failure once content is already on screen surfaces the error inline and keeps the unsaved draft and form visible", async () => {
		const user = userEvent.setup();
		let getCount = 0;
		stubFetch((req) => {
			if (req.route !== GET_ROUTE) {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			getCount += 1;
			return getCount === 1
				? jsonResponse({
						systemPrompt: commonSystemPrompt({
							prompt: "Keep changes minimal.",
						}),
					})
				: errorResponse(500, CRASH_RESPONSE_BODY);
		});
		const { rerender } = render(
			<SystemPromptView token="tok" onUnauthorized={() => {}} />,
		);
		const textarea = await findTextarea();
		await user.type(textarea, " more");
		expect(textarea).toHaveValue("Keep changes minimal. more");

		// A refetch triggered by a prop-identity change (no user action) fails.
		rerender(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

		expect(await screen.findByText(CRASH_RESPONSE_BODY)).toBeInTheDocument();
		// Unlike an initial-load failure, this must NOT tear down the form:
		// the operator's unsaved edit stays visible and editable.
		expect(textarea).toBeInTheDocument();
		expect(textarea).toHaveValue("Keep changes minimal. more");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
	});

	test("a 401 on load calls onUnauthorized exactly once and never renders a load error", async () => {
		let unauthorizedCalls = 0;
		stubFetch((req) =>
			req.route === GET_ROUTE
				? errorResponse(401, "invalid token")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(
			<SystemPromptView
				token="bad"
				onUnauthorized={() => {
					unauthorizedCalls += 1;
				}}
			/>,
		);

		await waitFor(() => expect(unauthorizedCalls).toBe(1));
		// The 401 short-circuits before `setLoadError`, so nothing should ever
		// render the rejection text -- and a second effect run must not fire a
		// second callback.
		await flushMicrotasks();
		expect(unauthorizedCalls).toBe(1);
		expect(screen.queryByText("invalid token")).not.toBeInTheDocument();
	});

	test("a 401 on save calls onUnauthorized exactly once and doesn't surface a save error", async () => {
		const user = userEvent.setup();
		let unauthorizedCalls = 0;
		stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({ systemPrompt: commonSystemPrompt() });
			}
			if (req.route === PUT_ROUTE) return errorResponse(401, "token expired");
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(
			<SystemPromptView
				token="tok"
				onUnauthorized={() => {
					unauthorizedCalls += 1;
				}}
			/>,
		);
		const textarea = await findTextarea();
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(unauthorizedCalls).toBe(1));
		expect(screen.queryByText("token expired")).not.toBeInTheDocument();
	});

	test("saving persists the edited text via PUT and shows the server's updated confirmation", async () => {
		const user = userEvent.setup();
		const initial = commonSystemPrompt({ prompt: "Keep changes minimal." });
		const saved = commonSystemPrompt({
			prompt: "Keep changes minimal. Also write docs.",
			updatedAt: "2026-03-04T05:06:07.000Z",
		});
		const http = stubFetch((req) => {
			if (req.route === GET_ROUTE)
				return jsonResponse({ systemPrompt: initial });
			if (req.route === PUT_ROUTE) return jsonResponse(saved);
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		const textarea = await findTextarea();
		await user.type(textarea, " Also write docs.");
		await user.click(screen.getByRole("button", { name: "Save" }));

		// Save re-disables once the fetched `stored.prompt` matches the draft
		// again -- the surest sign the PUT's response was actually applied.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
		);
		const putCall = http.callsTo(PUT_ROUTE)[0];
		expect(putCall?.body).toEqual({
			prompt: "Keep changes minimal. Also write docs.",
		});
		expect(putCall?.token).toBe("tok");
		expect(
			screen.getByText(
				`Last updated: ${new Date(saved.updatedAt).toLocaleString()}`,
			),
		).toBeInTheDocument();
	});

	test("a save's HTTP failure is shown verbatim -- even the framework's opaque crash page -- and leaves the typed draft untouched", async () => {
		// `handleSetCommonSystemPrompt` never catches a store failure either,
		// so (like the load path) the only non-401, non-400 response PUT
		// /system-prompt can actually produce is Bun's crash response --
		// see `CRASH_RESPONSE_BODY`.
		const user = userEvent.setup();
		stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({
					systemPrompt: commonSystemPrompt({ prompt: "Keep changes minimal." }),
				});
			}
			if (req.route === PUT_ROUTE) {
				return errorResponse(500, CRASH_RESPONSE_BODY);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		const textarea = await findTextarea();
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText(CRASH_RESPONSE_BODY)).toBeInTheDocument();
		// A failed save must not revert, clear, or otherwise mutate the draft.
		expect(textarea).toHaveValue("Keep changes minimal. more");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	test("Reset also discards a stale save error, not just the unsaved edit", async () => {
		const user = userEvent.setup();
		stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({
					systemPrompt: commonSystemPrompt({ prompt: "Keep changes minimal." }),
				});
			}
			if (req.route === PUT_ROUTE) {
				return errorResponse(500, CRASH_RESPONSE_BODY);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		const textarea = await findTextarea();
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(CRASH_RESPONSE_BODY)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Reset" }));

		// Reset must clear ALL state left behind by the failed attempt, not
		// just the draft text -- a stale save error lingering after the user
		// backs out would misreport the (now-reverted) form as still broken.
		expect(screen.queryByText(CRASH_RESPONSE_BODY)).not.toBeInTheDocument();
		expect(textarea).toHaveValue("Keep changes minimal.");
	});

	test("an over-cap prompt is sent to the server uncapped, and its 400 is shown verbatim", async () => {
		const user = userEvent.setup();
		const overCap = "a".repeat(20_001);
		const http = stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({ systemPrompt: commonSystemPrompt() });
			}
			if (req.route === PUT_ROUTE) return errorResponse(400, OVER_CAP_MESSAGE);
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		const textarea = await findTextarea();
		// The component has no `maxLength` and no client-side length check --
		// it defers entirely to the server's 20,000-character cap.
		await user.clear(textarea);
		await user.click(textarea);
		await user.paste(overCap);
		expect(textarea).toHaveValue(overCap);

		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(http.callsTo(PUT_ROUTE)).toHaveLength(1));
		const body = http.callsTo(PUT_ROUTE)[0]?.body as { prompt: string };
		expect(body.prompt).toHaveLength(20_001);
		expect(
			await screen.findByText(OVER_CAP_MESSAGE.trim()),
		).toBeInTheDocument();
	});

	test("clearing the prompt to empty text is a legitimate save (blank means no common prompt)", async () => {
		const user = userEvent.setup();
		const http = stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({
					systemPrompt: commonSystemPrompt({ prompt: "Keep changes minimal." }),
				});
			}
			if (req.route === PUT_ROUTE) {
				return jsonResponse(
					commonSystemPrompt({
						prompt: "",
						updatedAt: "2026-05-06T00:00:00.000Z",
					}),
				);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		const textarea = await findTextarea();
		await user.clear(textarea);
		expect(textarea).toHaveValue("");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(http.callsTo(PUT_ROUTE)[0]?.body).toEqual({ prompt: "" }),
		);
		expect(await screen.findByText("Not configured yet.")).toBeInTheDocument();
	});

	describe("dirty tracking", () => {
		test("Save and Reset start disabled and enable once the draft diverges from the stored prompt", async () => {
			const user = userEvent.setup();
			stubFetch((req) =>
				req.route === GET_ROUTE
					? jsonResponse({ systemPrompt: commonSystemPrompt() })
					: errorResponse(500, `unexpected route: ${req.route}`),
			);
			render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
			const textarea = await findTextarea();
			const saveButton = screen.getByRole("button", { name: "Save" });
			const resetButton = screen.getByRole("button", { name: "Reset" });
			expect(saveButton).toBeDisabled();
			expect(resetButton).toBeDisabled();

			await user.type(textarea, " more");
			expect(saveButton).toBeEnabled();
			expect(resetButton).toBeEnabled();
		});

		test("Reset discards the local edit and restores the last-saved prompt without any request", async () => {
			const user = userEvent.setup();
			const http = stubFetch((req) =>
				req.route === GET_ROUTE
					? jsonResponse({
							systemPrompt: commonSystemPrompt({
								prompt: "Keep changes minimal.",
							}),
						})
					: errorResponse(500, `unexpected route: ${req.route}`),
			);
			render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
			const textarea = await findTextarea();
			await user.type(textarea, " more");
			expect(textarea).toHaveValue("Keep changes minimal. more");

			await user.click(screen.getByRole("button", { name: "Reset" }));

			expect(textarea).toHaveValue("Keep changes minimal.");
			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
			expect(http.calls).toHaveLength(1); // only the initial GET
		});

		test("Save re-disables after a successful save because the draft now matches the stored prompt", async () => {
			const user = userEvent.setup();
			stubFetch((req) => {
				if (req.route === GET_ROUTE) {
					return jsonResponse({
						systemPrompt: commonSystemPrompt({ prompt: "A" }),
					});
				}
				if (req.route === PUT_ROUTE) {
					return jsonResponse(commonSystemPrompt({ prompt: "AB" }));
				}
				return errorResponse(500, `unexpected route: ${req.route}`);
			});
			render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
			const textarea = await findTextarea();
			await user.type(textarea, "B");
			const saveButton = screen.getByRole("button", { name: "Save" });
			expect(saveButton).toBeEnabled();

			await user.click(saveButton);

			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
			);
		});
	});

	test("a save in flight disables the controls and never issues a duplicate PUT", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({ systemPrompt: commonSystemPrompt() });
			}
			if (req.route === PUT_ROUTE) return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SystemPromptView token="tok" onUnauthorized={() => {}} />);
		const textarea = await findTextarea();
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: "Save" }));

		const savingButton = await screen.findByRole("button", {
			name: "Saving...",
		});
		expect(savingButton).toBeDisabled();
		expect(textarea).toBeDisabled();
		expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();

		deferred.resolve(
			jsonResponse(
				commonSystemPrompt({ prompt: "Keep changes minimal. more" }),
			),
		);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
		);
		expect(textarea).toBeEnabled();
		// One click, one PUT: the disabled-while-saving state is what prevents a
		// second submit, so the call count is the assertion that would catch a
		// regression in that guard.
		expect(http.callsTo(PUT_ROUTE)).toHaveLength(1);
	});

	test("a stale save's aborted PUT rejects and can't clobber a newer save's result", async () => {
		// The Save button disables the instant a submit starts, so two
		// overlapping PUTs can't happen through a click. Dispatching `submit`
		// on the <form> directly bypasses that UI guard to exercise the
		// ref-level protection (`submitControllerRef.current?.abort()` before
		// each new submit) that is the last line of defense against a slow,
		// superseded request applying its stale result after a newer one has
		// already landed.
		//
		// `stubFetch` honors `init.signal`: once the second submit aborts the
		// first PUT's controller, that PUT's `fetch()` call rejects with the
		// abort reason immediately and can never resolve with `first`'s body,
		// no matter when (or whether) it's resolved. `submit`'s
		// `if (controller.signal.aborted) return;` catch-guard discards that
		// rejection silently -- no error banner, no state change.
		const user = userEvent.setup();
		const first = deferredResponse();
		const second = deferredResponse();
		let putCount = 0;
		const http = stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({
					systemPrompt: commonSystemPrompt({ prompt: "Keep changes minimal." }),
				});
			}
			if (req.route === PUT_ROUTE) {
				putCount += 1;
				return putCount === 1 ? first.promise : second.promise;
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const { container } = render(
			<SystemPromptView token="tok" onUnauthorized={() => {}} />,
		);
		const textarea = await findTextarea();
		await user.clear(textarea);
		await user.type(textarea, "First edit");
		const form = container.querySelector("form");
		if (!form) throw new Error("form not found");

		fireEvent.submit(form);
		fireEvent.submit(form);

		expect(http.callsTo(PUT_ROUTE)).toHaveLength(2);
		const staleSignal = http.callsTo(PUT_ROUTE)[0]?.signal;
		expect(staleSignal?.aborted).toBe(true);

		// The newer request resolves with the real result.
		second.resolve(
			jsonResponse(
				commonSystemPrompt({
					prompt: "First edit",
					updatedAt: "2025-02-02T00:00:00.000Z",
				}),
			),
		);
		await waitFor(() => expect(textarea).not.toBeDisabled());

		// The stale request's handler promise is left to resolve late,
		// proving it's inert: its `fetch()` already rejected via the abort
		// above, so nothing is left awaiting `first` -- this can't overwrite
		// the applied result or surface an error.
		first.resolve(
			jsonResponse(
				commonSystemPrompt({
					prompt: "STALE - must not apply",
					updatedAt: "2020-01-01T00:00:00.000Z",
				}),
			),
		);
		await flushMicrotasks();

		expect(textarea).toHaveValue("First edit");
		expect(
			screen.getByText(
				`Last updated: ${new Date("2025-02-02T00:00:00.000Z").toLocaleString()}`,
			),
		).toBeInTheDocument();
		expect(container.querySelector(".form-error")).toBeNull();
	});

	test("unmounting mid-save aborts the pending controller so a late response can't apply", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === GET_ROUTE) {
				return jsonResponse({ systemPrompt: commonSystemPrompt() });
			}
			if (req.route === PUT_ROUTE) return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const { unmount } = render(
			<SystemPromptView token="tok" onUnauthorized={() => {}} />,
		);
		const textarea = await findTextarea();
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		unmount();

		const put = http.callsTo(PUT_ROUTE)[0];
		expect(put?.signal?.aborted).toBe(true);

		// `unmount()`'s cleanup effect already aborted this PUT synchronously,
		// so `stubFetch` makes its `fetch()` call reject with the abort reason
		// before this `resolve()` can ever matter -- `submit`'s
		// `if (controller.signal.aborted) return;` catch-guard discards that
		// rejection silently. Resolving `deferred` here is inert; it's kept
		// only to prove a stale settle attempt still can't throw or touch
		// state on the unmounted component.
		deferred.resolve(jsonResponse(commonSystemPrompt({ prompt: "too late" })));
		await flushMicrotasks();
	});

	describe("refetch triggered by a prop-identity change (not a user action)", () => {
		// `refresh` is a `useCallback` keyed on `[token, onUnauthorized]`, and the
		// mount effect re-runs it whenever that identity changes -- which
		// happens on every parent re-render that doesn't memoize the callback.
		// That refetch must never blank a form the operator is typing in, and
		// must never throw away the unsaved edit just because the server was
		// asked again.
		test("an unsaved edit survives a refetch from a new onUnauthorized identity, keeps the textarea mounted, and Reset still adopts the freshly fetched prompt", async () => {
			const user = userEvent.setup();
			let getCount = 0;
			const second = deferredResponse();
			const http = stubFetch((req) => {
				if (req.route !== GET_ROUTE) {
					return errorResponse(500, `unexpected route: ${req.route}`);
				}
				getCount += 1;
				return getCount === 1
					? jsonResponse({
							systemPrompt: commonSystemPrompt({
								prompt: "Keep changes minimal.",
							}),
						})
					: second.promise;
			});
			const { rerender } = render(
				<SystemPromptView token="tok" onUnauthorized={() => {}} />,
			);
			const textarea = await findTextarea();
			await user.type(textarea, " more");
			expect(textarea).toHaveValue("Keep changes minimal. more");

			// A fresh arrow function each render is exactly what an unmemoized
			// parent produces -- no user action, just a re-render.
			rerender(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

			await waitFor(() => expect(http.callsTo(GET_ROUTE)).toHaveLength(2));
			// A refetch must not blank the form the operator is editing.
			expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
			expect(textarea).toBeInTheDocument();
			expect(textarea).toHaveValue("Keep changes minimal. more");

			second.resolve(
				jsonResponse({
					systemPrompt: commonSystemPrompt({
						prompt: "Server updated this.",
						updatedAt: "2026-07-08T00:00:00.000Z",
					}),
				}),
			);

			// The stored prompt/timestamp still update from the refetch even
			// though the dirty draft on screen doesn't.
			await screen.findByText(
				`Last updated: ${new Date("2026-07-08T00:00:00.000Z").toLocaleString()}`,
			);
			expect(textarea).toHaveValue("Keep changes minimal. more");

			await user.click(screen.getByRole("button", { name: "Reset" }));
			expect(textarea).toHaveValue("Server updated this.");
		});

		test("an unsaved edit survives a refetch from a new token, and Reset still adopts the freshly fetched prompt", async () => {
			const user = userEvent.setup();
			let getCount = 0;
			const http = stubFetch((req) => {
				if (req.route !== GET_ROUTE) {
					return errorResponse(500, `unexpected route: ${req.route}`);
				}
				getCount += 1;
				return jsonResponse({
					systemPrompt: commonSystemPrompt({
						prompt:
							getCount === 1 ? "Keep changes minimal." : "Server updated this.",
					}),
				});
			});
			const { rerender } = render(
				<SystemPromptView token="tok" onUnauthorized={() => {}} />,
			);
			const textarea = await findTextarea();
			await user.type(textarea, " more");
			expect(textarea).toHaveValue("Keep changes minimal. more");

			rerender(<SystemPromptView token="tok2" onUnauthorized={() => {}} />);

			await waitFor(() => expect(http.callsTo(GET_ROUTE)).toHaveLength(2));
			expect(http.callsTo(GET_ROUTE)[1]?.token).toBe("tok2");
			expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
			expect(textarea).toHaveValue("Keep changes minimal. more");

			await user.click(screen.getByRole("button", { name: "Reset" }));
			expect(textarea).toHaveValue("Server updated this.");
		});

		test("a refetch with a clean, unedited draft adopts the server's newer prompt", async () => {
			let getCount = 0;
			const http = stubFetch((req) => {
				if (req.route !== GET_ROUTE) {
					return errorResponse(500, `unexpected route: ${req.route}`);
				}
				getCount += 1;
				return jsonResponse({
					systemPrompt: commonSystemPrompt({
						prompt:
							getCount === 1 ? "Keep changes minimal." : "Server updated this.",
					}),
				});
			});
			const { rerender } = render(
				<SystemPromptView token="tok" onUnauthorized={() => {}} />,
			);
			const textarea = await findTextarea();
			expect(textarea).toHaveValue("Keep changes minimal.");

			rerender(<SystemPromptView token="tok" onUnauthorized={() => {}} />);

			await waitFor(() => expect(textarea).toHaveValue("Server updated this."));
			expect(http.callsTo(GET_ROUTE)).toHaveLength(2);
		});
	});
});
