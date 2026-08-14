import { describe, expect, mock, test } from "bun:test";
import type { CommonSetupScript } from "../core/types";
import { SetupScriptsView } from "./setup-scripts-view";
import {
	deferredResponse,
	errorResponse,
	jsonResponse,
	stubFetch,
} from "./test-fetch";
import { commonSetupScript } from "./test-fixtures";
import {
	render,
	screen,
	setupDashboardTest,
	userEvent,
	waitFor,
	within,
} from "./test-setup";

setupDashboardTest();

/** Every route this view can hit; a handler that doesn't recognize one of
 *  these should fall through to the caller's 500 default rather than special-
 *  casing here, so a stray request surfaces loudly instead of hanging. */
const LIST_ROUTE = "GET /setup-scripts";

/** The exact wire format of a TriggerFileSchema rejection -- formatZodError
 *  prefixes every issue with two spaces and "- ", joined by newlines (see
 *  src/config/load.ts's formatZodError and src/ingest/common-setup-scripts.ts's
 *  TriggerFileSchema). Used to stub the real 400 body instead of a paraphrase. */
const TRIGGER_FILE_PATH_ERROR =
	"  - triggerFile: must be a repository-relative POSIX path";

describe("SetupScriptsView", () => {
	test("shows the loading state, then the fetched list with the token attached", async () => {
		const script = commonSetupScript({
			triggerFile: "package.json",
			// Multi-line script: the table must show only the first line, with
			// the full script kept as the tooltip -- not the other way round.
			script: "bun install\necho done",
		});
		const http = stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ setupScripts: [script] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		expect(screen.getByText("Loading...")).toBeInTheDocument();

		expect(await screen.findByText("package.json")).toBeInTheDocument();
		expect(screen.getByText("bun install")).toBeInTheDocument();
		expect(screen.queryByText("echo done")).not.toBeInTheDocument();
		expect(screen.getByTitle("bun install echo done")).toBeInTheDocument();
		expect(http.calls[0]?.route).toBe(LIST_ROUTE);
		expect(http.calls[0]?.token).toBe("tok");
	});

	test("shows the empty-state message when the list is empty", async () => {
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ setupScripts: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		expect(
			await screen.findByText("No common setup scripts yet."),
		).toBeInTheDocument();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
	});

	test("re-fetches the list when the token prop changes", async () => {
		const http = stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ setupScripts: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const { rerender } = render(
			<SetupScriptsView token="tok1" onUnauthorized={() => {}} />,
		);
		await screen.findByText("No common setup scripts yet.");
		expect(http.calls[0]?.token).toBe("tok1");

		// `refresh` is a useCallback keyed on `token`; a new token must produce a
		// new effect run, not reuse the closure captured with the old one.
		rerender(<SetupScriptsView token="tok2" onUnauthorized={() => {}} />);

		await waitFor(() => expect(http.calls).toHaveLength(2));
		expect(http.calls[1]?.token).toBe("tok2");
	});

	test("shows the fetch's error message verbatim when the initial request fails", async () => {
		// GET /setup-scripts can only ever answer 200 or 401 -- checkApiToken is
		// the only guard in front of handleListCommonSetupScripts, which has no
		// other error branch, and an uncaught store failure propagates past
		// route() as an uncaught exception, landing on Bun's own HTML error page
		// rather than a plain-text body a stub could emit. The only other way
		// `refresh()`'s catch branch fires is a network-level failure (fetch
		// itself rejecting), which this simulates.
		stubFetch(() => Promise.reject(new Error("network unreachable")));

		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		expect(await screen.findByText("network unreachable")).toBeInTheDocument();
	});

	test("calls onUnauthorized exactly once on a 401 and never renders the rejection text", async () => {
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? errorResponse(401, "token expired")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		let unauthorizedCalls = 0;

		render(
			<SetupScriptsView
				token="tok"
				onUnauthorized={() => {
					unauthorizedCalls++;
				}}
			/>,
		);

		await waitFor(() => expect(unauthorizedCalls).toBe(1));
		// The 401 branch returns before setError, so the raw server text must
		// never leak into the UI (it's not meant for the user to read).
		expect(screen.queryByText("token expired")).not.toBeInTheDocument();
		// Re-check after a real macrotask, not another `waitFor` -- `waitFor`
		// resolves the instant its callback first passes, so a second
		// `waitFor` on the same already-true condition can't observe a
		// duplicate call that would only fire on a later tick.
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 0);
		await tick.promise;
		expect(unauthorizedCalls).toBe(1);
	});

	test("opening a new script after canceling an edit starts from a blank draft", async () => {
		const user = userEvent.setup();
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({
						setupScripts: [commonSetupScript({ triggerFile: "package.json" })],
					})
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		const triggerInput = screen.getByLabelText(
			"Run when this repository-relative file exists",
		);
		await user.type(triggerInput, "-unsaved");
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);

		// A stale draft here would silently resurrect the abandoned edit's text
		// under the "New setup script" heading.
		expect(
			screen.getByLabelText("Run when this repository-relative file exists"),
		).toHaveValue("");
		expect(screen.getByLabelText("Setup script")).toHaveValue("");
	});

	test("keeps Save disabled and issues no request until both fields hold non-whitespace content", async () => {
		const user = userEvent.setup();
		const http = stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ setupScripts: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		const saveButton = screen.getByRole("button", { name: "Save" });
		const triggerInput = screen.getByLabelText(
			"Run when this repository-relative file exists",
		);
		const scriptInput = screen.getByLabelText("Setup script");

		expect(saveButton).toBeDisabled();

		await user.type(triggerInput, "bun.lock");
		expect(saveButton).toBeDisabled();

		// Whitespace-only content must not count as a script -- .trim() gates it.
		await user.type(scriptInput, "   ");
		expect(saveButton).toBeDisabled();

		await user.type(scriptInput, "bun install");
		expect(saveButton).toBeEnabled();

		// The only network traffic for this whole test is the initial list fetch.
		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]?.route).toBe(LIST_ROUTE);
	});

	test("creates a setup script with trimmed fields and refreshes the list from the server", async () => {
		const user = userEvent.setup();
		let scripts: CommonSetupScript[] = [];
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ setupScripts: scripts });
			}
			if (req.route === "POST /setup-scripts") {
				const body = req.body as { triggerFile: string; script: string };
				const created = commonSetupScript({
					id: "script-2",
					triggerFile: body.triggerFile,
					script: body.script,
				});
				scripts = [...scripts, created];
				return jsonResponse(created, 201);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"  new.txt  ",
		);
		await user.type(screen.getByLabelText("Setup script"), "  echo hi  ");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("new.txt")).toBeInTheDocument();
		expect(screen.queryByText("New setup script")).not.toBeInTheDocument();

		const post = http.callsTo("POST /setup-scripts")[0];
		expect(post?.token).toBe("tok");
		expect(post?.body).toEqual({ triggerFile: "new.txt", script: "echo hi" });
		// The view re-fetches the list rather than appending the create response
		// locally -- two GETs, not one.
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(2);
	});

	test("edits a setup script, PUTting the full trimmed draft (not a partial patch)", async () => {
		const user = userEvent.setup();
		let scripts = [
			commonSetupScript({
				id: "script-1",
				triggerFile: "package.json",
				script: "bun install",
			}),
		];
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ setupScripts: scripts });
			}
			if (req.route === "PUT /setup-scripts/script-1") {
				const body = req.body as { triggerFile: string; script: string };
				scripts = [{ ...scripts[0]!, ...body }];
				return jsonResponse(scripts[0]);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		const triggerInput = screen.getByLabelText(
			"Run when this repository-relative file exists",
		);
		await user.clear(triggerInput);
		await user.type(triggerInput, "  bun.lock  ");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("bun.lock")).toBeInTheDocument();
		const put = http.callsTo("PUT /setup-scripts/script-1")[0];
		expect(put?.token).toBe("tok");
		// The component always sends both fields, even the one the user never
		// touched -- a `Partial` PUT body would be a behavior change, not a bug
		// this test should paper over.
		expect(put?.body).toEqual({
			triggerFile: "bun.lock",
			script: "bun install",
		});
	});

	test("percent-encodes an id containing reserved URL characters in the PUT path", async () => {
		const user = userEvent.setup();
		const RAW_ID = "a/b c#1";
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({
					setupScripts: [
						commonSetupScript({
							id: RAW_ID,
							triggerFile: "package.json",
							script: "bun install",
						}),
					],
				});
			}
			if (req.method === "PUT") {
				return jsonResponse(
					commonSetupScript({ id: RAW_ID, triggerFile: "package.json" }),
				);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(http.calls.some((call) => call.method === "PUT")).toBe(true),
		);
		const put = http.calls.find((call) => call.method === "PUT");
		expect(put?.path).toBe(`/setup-scripts/${encodeURIComponent(RAW_ID)}`);
	});

	test("a 400 response keeps the editor open with the server's message and the typed content", async () => {
		const user = userEvent.setup();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ setupScripts: [] });
			}
			if (req.route === "POST /setup-scripts") {
				return errorResponse(400, TRIGGER_FILE_PATH_ERROR);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"/abs/path",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByText(
				/triggerFile: must be a repository-relative POSIX path/,
			),
		).toBeInTheDocument();
		// Editor stays open with what the user typed, and the form isn't stuck
		// in a permanently-submitting state.
		expect(
			screen.getByRole("heading", { name: "New setup script" }),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("Run when this repository-relative file exists"),
		).toHaveValue("/abs/path");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(1);
	});

	test("disables Save and issues only one POST while the create request is in flight", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"bun.lock",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));

		const savingButton = await screen.findByRole("button", {
			name: "Saving...",
		});
		expect(savingButton).toBeDisabled();

		// Only the one Save click has been sent so far; the disabled button
		// checked above is what stops a second one, not this count.
		expect(http.callsTo("POST /setup-scripts")).toHaveLength(1);

		deferred.resolve(jsonResponse(commonSetupScript({ id: "script-2" }), 201));
		await waitFor(() =>
			expect(screen.queryByText("New setup script")).not.toBeInTheDocument(),
		);
	});

	test("Cancel aborts an in-flight submit and closes the editor immediately", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"bun.lock",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByText("New setup script")).not.toBeInTheDocument();
		const post = http.callsTo("POST /setup-scripts")[0];
		expect(post?.signal?.aborted).toBe(true);
	});

	test("Cancel during an in-flight create still refreshes the list so a write that already landed doesn't vanish", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"bun.lock",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByText("New setup script")).not.toBeInTheDocument();
		// The POST is only aborted client-side; the server may already have
		// created the script by the time the client gave up on the response.
		// Abandoning that abort without a re-fetch (the pre-fix behavior)
		// left the new script invisible until a manual reload.
		await waitFor(() => expect(http.callsTo(LIST_ROUTE)).toHaveLength(2));
	});

	test("Cancel during an in-flight edit still refreshes the list so a write that already landed doesn't vanish", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({
					setupScripts: [
						commonSetupScript({
							id: "script-1",
							triggerFile: "package.json",
							script: "bun install",
						}),
					],
				});
			}
			if (req.route === "PUT /setup-scripts/script-1") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByText("Edit setup script")).not.toBeInTheDocument();
		// Same defect as the create path: a PUT that lands after the client
		// aborts must not leave the list stuck showing the pre-edit row.
		await waitFor(() => expect(http.callsTo(LIST_ROUTE)).toHaveLength(2));
	});

	test("aborts the in-flight submit request when the component unmounts", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const { unmount } = render(
			<SetupScriptsView token="tok" onUnauthorized={() => {}} />,
		);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"bun.lock",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		unmount();

		const post = http.callsTo("POST /setup-scripts")[0];
		expect(post?.signal?.aborted).toBe(true);
	});

	test("skips the background refresh when the abort comes from unmounting, not Cancel", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const { unmount } = render(
			<SetupScriptsView token="tok" onUnauthorized={() => {}} />,
		);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"bun.lock",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		unmount();

		// The unmount cleanup aborts the same controller Cancel would, and
		// `submit`'s catch branch can't tell the two apart from the rejection
		// alone -- it needs an explicit unmounted flag. Without one, this
		// fires an authenticated GET (and a setState) against a dead tree.
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 0);
		await tick.promise;
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(1);
	});

	test("a background refresh triggered by Cancel keeps the list visible instead of flashing Loading", async () => {
		const user = userEvent.setup();
		const putDeferred = deferredResponse();
		const backgroundListDeferred = deferredResponse();
		let listCalls = 0;
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				listCalls++;
				return listCalls === 1
					? jsonResponse({
							setupScripts: [
								commonSetupScript({ triggerFile: "package.json" }),
							],
						})
					: backgroundListDeferred.promise;
			}
			if (req.route === "PUT /setup-scripts/script-1")
				return putDeferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("package.json");

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		// Cancel's abort starts a second, still-pending GET. The regression
		// this background mode fixes is `refresh` setting `loading` before
		// that fetch settles, which blanks the table behind "Loading..."
		// even though the previously-fetched rows are still valid to show.
		await waitFor(() => expect(listCalls).toBe(2));
		expect(screen.getByText("package.json")).toBeInTheDocument();
		expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

		backgroundListDeferred.resolve(
			jsonResponse({
				setupScripts: [commonSetupScript({ triggerFile: "package.json" })],
			}),
		);
		await waitFor(() => expect(http.callsTo(LIST_ROUTE)).toHaveLength(2));
	});

	test("a background refresh's failure surfaces on the list, not on an editor opened afterward", async () => {
		const user = userEvent.setup();
		const putDeferred = deferredResponse();
		const backgroundListDeferred = deferredResponse();
		let listCalls = 0;
		stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				listCalls++;
				return listCalls === 1
					? jsonResponse({
							setupScripts: [
								commonSetupScript({ triggerFile: "package.json" }),
							],
						})
					: backgroundListDeferred.promise;
			}
			if (req.route === "PUT /setup-scripts/script-1")
				return putDeferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("package.json");

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(listCalls).toBe(2));

		// A second form session starts before the background refresh
		// (started by Cancel above, still pending) has settled.
		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);

		backgroundListDeferred.resolve(errorResponse(500, "warehouse offline"));

		// The list-level failure belongs on the list, not smuggled into
		// whatever form happens to be open when it lands -- a failed
		// background refresh must not read to the operator as "your new
		// draft failed to save".
		expect(await screen.findByText("warehouse offline")).toBeInTheDocument();
		const newScriptHeading = screen.getByRole("heading", {
			name: "New setup script",
		});
		expect(newScriptHeading).toBeInTheDocument();
		const form = newScriptHeading.closest("form");
		if (!form) throw new Error("expected the form element to be present");
		expect(
			within(form).queryByText("warehouse offline"),
		).not.toBeInTheDocument();
	});

	test("does not delete when the confirmation dialog is dismissed", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		const confirmSpy = mock(() => false);
		globalThis.confirm = confirmSpy as typeof confirm;
		try {
			const http = stubFetch((req) =>
				req.route === LIST_ROUTE
					? jsonResponse({
							setupScripts: [
								commonSetupScript({ triggerFile: "package.json" }),
							],
						})
					: errorResponse(500, `unexpected route: ${req.route}`),
			);
			render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

			await user.click(await screen.findByRole("button", { name: "Delete" }));

			expect(confirmSpy).toHaveBeenCalledWith(
				'Delete setup script for "package.json"?',
			);
			expect(http.callsTo("DELETE /setup-scripts/script-1")).toHaveLength(0);
			expect(screen.getByText("package.json")).toBeInTheDocument();
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("deletes the setup script and refreshes the list once confirmed", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = mock(() => true) as typeof confirm;
		try {
			let scripts = [commonSetupScript({ triggerFile: "package.json" })];
			const http = stubFetch((req) => {
				if (req.route === LIST_ROUTE) {
					return jsonResponse({ setupScripts: scripts });
				}
				if (req.route === "DELETE /setup-scripts/script-1") {
					scripts = [];
					return new Response(null, { status: 204 });
				}
				return errorResponse(500, `unexpected route: ${req.route}`);
			});
			render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

			await user.click(await screen.findByRole("button", { name: "Delete" }));

			expect(
				await screen.findByText("No common setup scripts yet."),
			).toBeInTheDocument();
			expect(http.callsTo("DELETE /setup-scripts/script-1")).toHaveLength(1);
			expect(http.callsTo(LIST_ROUTE)).toHaveLength(2);
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("calls onUnauthorized exactly once when the create request returns 401, without leaking the raw server text", async () => {
		const user = userEvent.setup();
		let unauthorizedCalls = 0;
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") {
				return errorResponse(401, "token expired");
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(
			<SetupScriptsView
				token="tok"
				onUnauthorized={() => {
					unauthorizedCalls++;
				}}
			/>,
		);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"bun.lock",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(unauthorizedCalls).toBe(1));
		// This only pins what SetupScriptsView itself does on a 401: it never
		// calls setEditingId(null), so in isolation the raw server text simply
		// never leaks into the UI. It is NOT proof that the operator's typed
		// script survives end to end -- onUnauthorized is wired to App's
		// handleUnauthorized, which overlays the reauth prompt on top of this
		// view (rather than unmounting it), so this view -- and its `draft`
		// state -- stays mounted underneath and reappears untouched once the
		// operator re-authenticates. See app.test.tsx, which pins that
		// end-to-end behavior directly.
		expect(screen.queryByText("token expired")).not.toBeInTheDocument();
		expect(http.callsTo("POST /setup-scripts")).toHaveLength(1);
	});

	test("disables Save and keeps the edit modal open while the PUT is in flight", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({
					setupScripts: [
						commonSetupScript({
							id: "script-1",
							triggerFile: "package.json",
							script: "bun install",
						}),
					],
				});
			}
			if (req.route === "PUT /setup-scripts/script-1") return deferred.promise;
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));

		// The PUT must be awaited before the editor closes and the list is
		// refreshed -- an un-awaited update would close the modal and re-fetch
		// the list before the server had actually applied the edit.
		const savingButton = await screen.findByRole("button", {
			name: "Saving...",
		});
		expect(savingButton).toBeDisabled();
		expect(
			screen.getByRole("heading", { name: "Edit setup script" }),
		).toBeInTheDocument();
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(1);

		deferred.resolve(
			jsonResponse(
				commonSetupScript({ id: "script-1", triggerFile: "package.json" }),
			),
		);
		await waitFor(() =>
			expect(screen.queryByText("Edit setup script")).not.toBeInTheDocument(),
		);
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(2);
	});

	test("keeps Save disabled when the trigger file is whitespace-only, even with a real script", async () => {
		const user = userEvent.setup();
		const http = stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ setupScripts: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		const saveButton = screen.getByRole("button", { name: "Save" });

		// Whitespace-only content must not count as a trigger file either --
		// both sides of `canSubmit` are gated by .trim(), not just the script.
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"   ",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		expect(saveButton).toBeDisabled();

		// No network traffic beyond the initial list fetch.
		expect(http.calls).toHaveLength(1);
	});

	test("calls onUnauthorized when a delete returns 401, and does not show the raw server text", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = mock(() => true) as typeof confirm;
		let unauthorizedCalls = 0;
		try {
			const http = stubFetch((req) => {
				if (req.route === LIST_ROUTE) {
					return jsonResponse({
						setupScripts: [commonSetupScript({ triggerFile: "package.json" })],
					});
				}
				if (req.route === "DELETE /setup-scripts/script-1") {
					return errorResponse(401, "token expired");
				}
				return errorResponse(500, `unexpected route: ${req.route}`);
			});
			render(
				<SetupScriptsView
					token="tok"
					onUnauthorized={() => {
						unauthorizedCalls++;
					}}
				/>,
			);

			await user.click(await screen.findByRole("button", { name: "Delete" }));

			// `remove` must special-case a 401 the same way `refresh` and `submit`
			// do -- surfacing it as a plain error message would leak the raw
			// server text and skip the sign-out flow.
			await waitFor(() => expect(unauthorizedCalls).toBe(1));
			expect(screen.queryByText("token expired")).not.toBeInTheDocument();
			expect(http.callsTo(LIST_ROUTE)).toHaveLength(1);
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("Cancel clears a stale form error instead of leaking it into the next form session", async () => {
		const user = userEvent.setup();
		stubFetch((req) => {
			if (req.route === LIST_ROUTE) return jsonResponse({ setupScripts: [] });
			if (req.route === "POST /setup-scripts") {
				return errorResponse(400, TRIGGER_FILE_PATH_ERROR);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<SetupScriptsView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No common setup scripts yet.");

		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(
			screen.getByLabelText("Run when this repository-relative file exists"),
			"/abs/path",
		);
		await user.type(screen.getByLabelText("Setup script"), "bun install");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText(
			/triggerFile: must be a repository-relative POSIX path/,
		);

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);

		// `formError` is scoped to the form, not the list -- but it's still one
		// piece of state shared by every form session, so opening a new one
		// without clearing it would resurrect the previous session's rejection
		// under an unrelated, blank draft.
		expect(
			screen.queryByText(
				/triggerFile: must be a repository-relative POSIX path/,
			),
		).not.toBeInTheDocument();
	});
});
