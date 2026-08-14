import { describe, expect, mock, test } from "bun:test";
import type { RepoDefinition } from "../core/types";
import { RepositoriesView } from "./repositories-view";
import {
	deferredResponse,
	errorResponse,
	jsonResponse,
	stubFetch,
} from "./test-fetch";
import { repoDefinition } from "./test-fixtures";
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
const LIST_ROUTE = "GET /repo-definitions";

/** Locates the `<tr>` for an "owner/repo" cell so multi-row assertions don't
 *  accidentally match a cell in the wrong row (e.g. two rows both showing
 *  "yes" in different columns). */
async function rowFor(ownerSlashRepo: string): Promise<HTMLElement> {
	const cell = await screen.findByText(ownerSlashRepo);
	const row = cell.closest("tr");
	if (!row) {
		throw new Error(`expected an ancestor <tr> for "${ownerSlashRepo}"`);
	}
	return row as HTMLElement;
}

describe("RepositoriesView", () => {
	test("shows the loading state, then the fetched list with the token attached", async () => {
		const definition = repoDefinition({
			owner: "acme",
			repo: "api",
			enabled: true,
			mappings: [{ service: "api" }],
		});
		const http = stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [definition] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		expect(screen.getByText("Loading...")).toBeInTheDocument();

		const row = within(await rowFor("acme/api"));
		expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
		// Scoped by cell position, not bare text -- "yes"/"no" both appear in
		// this row (setup-script and enabled columns), so an unscoped query
		// would stay green even if repositories-view.tsx swapped those two
		// <td>s.
		const cells = row.getAllByRole("cell");
		expect(cells[1]).toHaveTextContent("1 group");
		expect(cells[2]).toHaveTextContent("no"); // no setup script
		expect(cells[3]).toHaveTextContent("auto-detect"); // no test command override
		expect(cells[4]).toHaveTextContent("inherit"); // no system prompt override
		expect(cells[5]).toHaveTextContent("yes"); // enabled
		expect(cells[6]).toHaveTextContent(
			new Date(definition.updatedAt).toLocaleString(),
		);
		expect(http.calls[0]?.route).toBe(LIST_ROUTE);
		expect(http.calls[0]?.token).toBe("tok");
	});

	test("distinguishes disabled state, multiple mapping groups, and field overrides across rows", async () => {
		const withOverrides = repoDefinition({
			id: "repo-2",
			owner: "beta",
			repo: "worker",
			enabled: false,
			mappings: [{ service: "worker" }, { team: "infra" }],
			setupScript: "#!/bin/sh\nnpm ci",
			testCommand: "npm run test:worker",
			systemPrompt: "Be careful with migrations.",
		});
		const bare = repoDefinition({
			id: "repo-3",
			owner: "gamma",
			repo: "empty",
			mappings: [],
		});
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [withOverrides, bare] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);

		const overrideCells = within(await rowFor("beta/worker")).getAllByRole(
			"cell",
		);
		expect(overrideCells[1]).toHaveTextContent("2 groups");
		expect(overrideCells[2]).toHaveTextContent("yes"); // has a setup script
		expect(overrideCells[3]).toHaveTextContent("npm run test:worker");
		expect(overrideCells[4]).toHaveTextContent("override");
		expect(overrideCells[5]).toHaveTextContent("no"); // disabled

		const bareRow = within(await rowFor("gamma/empty"));
		expect(bareRow.getByText("none")).toBeInTheDocument(); // zero mapping groups
	});

	test("shows the empty-state message when there are no repo definitions", async () => {
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);

		expect(
			await screen.findByText("No repository definitions yet."),
		).toBeInTheDocument();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
	});

	test("re-fetches the list when the token prop changes", async () => {
		const onUnauthorized = () => {};
		const http = stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const { rerender } = render(
			<RepositoriesView token="tok1" onUnauthorized={onUnauthorized} />,
		);
		await screen.findByText("No repository definitions yet.");
		expect(http.calls[0]?.token).toBe("tok1");

		// `refresh` is a useCallback keyed on `token`; a new token must produce a
		// new effect run, not reuse the closure captured with the old one.
		rerender(<RepositoriesView token="tok2" onUnauthorized={onUnauthorized} />);

		await waitFor(() => expect(http.calls).toHaveLength(2));
		expect(http.calls[1]?.token).toBe("tok2");
	});

	test("shows the crash page's statusText, not its markup, as the list error", async () => {
		// handleListRepoDefinitions has no try/catch of its own, and the
		// outer Bun.serve `fetch` wrapper in server.ts re-throws after
		// recording the span -- it never turns a thrown error into a
		// Response -- so a real store failure reaches the client as Bun's
		// own default HTML crash page, not an app-authored sentence.
		// api.ts's `errorMessage` treats anything other than a `text/plain`
		// body as transport noise rather than an operator message and falls
		// back to `statusText` instead of rendering the markup, so that's
		// what `ApiError.message` -- and this view's
		// `<p className="form-error">` -- actually show.
		const crashPageBody =
			"<!doctype html><html><body>Internal Server Error</body></html>";
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? errorResponse(500, crashPageBody, {
						contentType: "text/html;charset=utf-8",
						statusText: "Internal Server Error",
					})
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);

		expect(
			await screen.findByText("Internal Server Error"),
		).toBeInTheDocument();
		expect(screen.queryByText(crashPageBody)).not.toBeInTheDocument();
	});

	test("shows a genuine plain-text server error message verbatim as the list error", async () => {
		// Contrast with the crash-page case above: a real handler-authored
		// plain-text body (`Content-Type: text/plain`, `errorResponse`'s
		// default -- matching what `new Response(message)` actually ships)
		// is exactly the kind of message `errorMessage` is designed to let
		// through unmodified, even when it isn't a curated one-liner.
		const serverMessage = "database connection pool exhausted";
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? errorResponse(500, serverMessage)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);

		expect(await screen.findByText(serverMessage)).toBeInTheDocument();
	});

	test("a successful edit's background refresh keeps the existing table visible instead of blanking it to the loading placeholder", async () => {
		// Unlike the very first mount, the list is already populated when
		// `refresh()` runs again after a write succeeds. If `refresh`
		// unconditionally flips `loading` back to `true`, the operator sees
		// the whole table vanish and "Loading..." reappear on every save,
		// even though nothing about the rows already on screen is stale or
		// wrong -- only the background GET is in flight.
		const user = userEvent.setup();
		const original = repoDefinition({
			id: "repo-1",
			owner: "acme",
			repo: "api",
		});
		const deferredList = deferredResponse();
		let listCalls = 0;
		stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				listCalls++;
				return listCalls === 1
					? jsonResponse({ repoDefinitions: [original] })
					: deferredList.promise;
			}
			if (req.route === "PUT /repo-definitions/repo-1") {
				return jsonResponse({ ...original, owner: "acme2" });
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const row = within(await rowFor("acme/api"));
		await user.click(row.getByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Edit repository" }),
			).not.toBeInTheDocument(),
		);
		// The second (background) GET is still pending here.
		await waitFor(() => expect(listCalls).toBe(2));
		expect(screen.getByText("acme/api")).toBeInTheDocument();
		expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

		deferredList.resolve(
			jsonResponse({ repoDefinitions: [{ ...original, owner: "acme2" }] }),
		);
		expect(await screen.findByText("acme2/api")).toBeInTheDocument();
	});
	test("calls onUnauthorized exactly once on a 401 and never renders the rejection text", async () => {
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? errorResponse(401, "token expired")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		let unauthorizedCalls = 0;

		render(
			<RepositoriesView
				token="tok"
				onUnauthorized={() => {
					unauthorizedCalls++;
				}}
			/>,
		);

		// The 401 branch returns before setListError, but `finally` still runs,
		// so loading settles on the (still-empty) list's empty state.
		expect(
			await screen.findByText("No repository definitions yet."),
		).toBeInTheDocument();
		expect(unauthorizedCalls).toBe(1);
		expect(screen.queryByText("token expired")).not.toBeInTheDocument();
	});

	test("'+ New repository' opens a blank create form", async () => {
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No repository definitions yet.");

		await user.click(screen.getByRole("button", { name: "+ New repository" }));

		expect(
			screen.getByRole("heading", { name: "New repository" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Owner")).toHaveValue("");
		expect(screen.getByLabelText("Repo")).toHaveValue("");
		expect(screen.getByLabelText("Enabled")).toBeChecked();
	});

	test("submits a new definition to POST /repo-definitions and refetches the list", async () => {
		let currentList: RepoDefinition[] = [];
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ repoDefinitions: currentList });
			}
			if (req.route === "POST /repo-definitions") {
				const created = repoDefinition({
					id: "repo-new",
					owner: "octo",
					repo: "site",
					mappings: [],
				});
				currentList = [created];
				return jsonResponse(created, 201);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No repository definitions yet.");

		await user.click(screen.getByRole("button", { name: "+ New repository" }));
		await user.type(screen.getByLabelText("Owner"), "octo");
		await user.type(screen.getByLabelText("Repo"), "site");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "New repository" }),
			).not.toBeInTheDocument(),
		);
		expect(await screen.findByText("octo/site")).toBeInTheDocument();

		const post = http.callsTo("POST /repo-definitions")[0];
		expect(post?.token).toBe("tok");
		// Blank optional fields are omitted entirely on create (contrast the
		// edit path below, which sends them as explicit `null`).
		expect(post?.body).toEqual({
			owner: "octo",
			repo: "site",
			mappings: [],
			enabled: true,
		});
		// The view always re-fetches after a write rather than splicing the
		// response into local state.
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(2);
	});

	test("Edit opens the form pre-filled from the clicked row", async () => {
		const definition = repoDefinition({
			id: "repo-9",
			owner: "acme",
			repo: "api",
			enabled: false,
			mappings: [{ team: "x" }],
			setupScript: "echo hi",
			testCommand: "npm test",
			systemPrompt: "custom prompt",
		});
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [definition] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const row = within(await rowFor("acme/api"));

		await user.click(row.getByRole("button", { name: "Edit" }));

		expect(
			screen.getByRole("heading", { name: "Edit repository" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Owner")).toHaveValue("acme");
		expect(screen.getByLabelText("Repo")).toHaveValue("api");
		expect(screen.getByLabelText("Enabled")).not.toBeChecked();
		expect(screen.getByLabelText("Setup script")).toHaveValue("echo hi");
		expect(screen.getByLabelText("Test command override")).toHaveValue(
			"npm test",
		);
		expect(screen.getByLabelText("System prompt override")).toHaveValue(
			"custom prompt",
		);
	});

	test("submits PUT /repo-definitions/:id with the full draft, nulling cleared optional fields, and refetches", async () => {
		const original = repoDefinition({
			id: "repo-9",
			owner: "acme",
			repo: "api",
			enabled: true,
			mappings: [{ team: "x" }],
			setupScript: "echo hi",
			testCommand: "npm test",
			systemPrompt: "custom prompt",
		});
		let currentList: RepoDefinition[] = [original];
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ repoDefinitions: currentList });
			}
			if (req.route === "PUT /repo-definitions/repo-9") {
				const updated: RepoDefinition = {
					...original,
					owner: "acme2",
					testCommand: undefined,
				};
				currentList = [updated];
				return jsonResponse(updated);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const row = within(await rowFor("acme/api"));
		await user.click(row.getByRole("button", { name: "Edit" }));

		const ownerInput = screen.getByLabelText("Owner");
		await user.clear(ownerInput);
		await user.type(ownerInput, "acme2");
		await user.clear(screen.getByLabelText("Test command override"));

		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "Edit repository" }),
			).not.toBeInTheDocument(),
		);
		const updatedRow = within(await rowFor("acme2/api"));
		expect(updatedRow.getByText("auto-detect")).toBeInTheDocument();

		const put = http.callsTo("PUT /repo-definitions/repo-9")[0];
		expect(put?.token).toBe("tok");
		// The edit path always sends the full draft (not a diff), and a
		// cleared optional field becomes an explicit `null` -- distinguishing
		// "clear this field" from "leave it untouched" the way
		// UpdateRepoDefinitionInput requires (see src/core/types.ts).
		expect(put?.body).toEqual({
			owner: "acme2",
			repo: "api",
			mappings: [{ team: "x" }],
			enabled: true,
			setupScript: "echo hi",
			testCommand: null,
			systemPrompt: "custom prompt",
		});
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(2);
	});

	test("deletes the definition once confirmed and refetches the list", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		const confirmSpy = mock(() => true);
		globalThis.confirm = confirmSpy as typeof confirm;
		try {
			let currentList: RepoDefinition[] = [
				repoDefinition({ id: "repo-1", owner: "acme", repo: "api" }),
			];
			const http = stubFetch((req) => {
				if (req.route === LIST_ROUTE) {
					return jsonResponse({ repoDefinitions: currentList });
				}
				if (req.route === "DELETE /repo-definitions/repo-1") {
					currentList = [];
					return new Response(null, { status: 204 });
				}
				return errorResponse(500, `unexpected route: ${req.route}`);
			});
			render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
			const row = within(await rowFor("acme/api"));

			await user.click(row.getByRole("button", { name: "Delete" }));

			expect(confirmSpy).toHaveBeenCalledWith(
				'Delete repo definition "acme/api"? This cannot be undone.',
			);
			expect(
				await screen.findByText("No repository definitions yet."),
			).toBeInTheDocument();
			expect(http.callsTo("DELETE /repo-definitions/repo-1")).toHaveLength(1);
			expect(http.callsTo(LIST_ROUTE)).toHaveLength(2);
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("does not delete when the confirmation dialog is dismissed", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = mock(() => false) as typeof confirm;
		try {
			const http = stubFetch((req) =>
				req.route === LIST_ROUTE
					? jsonResponse({
							repoDefinitions: [
								repoDefinition({ id: "repo-1", owner: "acme", repo: "api" }),
							],
						})
					: errorResponse(500, `unexpected route: ${req.route}`),
			);
			render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
			const row = within(await rowFor("acme/api"));

			await user.click(row.getByRole("button", { name: "Delete" }));

			expect(http.callsTo("DELETE /repo-definitions/repo-1")).toHaveLength(0);
			expect(screen.getByText("acme/api")).toBeInTheDocument();
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("a failed delete shows the server's fallback status text as the list error", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = mock(() => true) as typeof confirm;
		try {
			stubFetch((req) => {
				if (req.route === LIST_ROUTE) {
					return jsonResponse({
						repoDefinitions: [
							repoDefinition({ id: "repo-1", owner: "acme", repo: "api" }),
						],
					});
				}
				if (req.route === "DELETE /repo-definitions/repo-1") {
					// handleDeleteRepoDefinition (src/ingest/repo-definitions.ts) has
					// no conflict/referential-integrity check at all; a missing id
					// is its only non-204 outcome, and that response is bodyless.
					// api.ts's `res.text() || res.statusText` fallback then
					// surfaces the transport's reason phrase for the status code
					// (verified: Bun fills in "Not Found" for a bodyless 404 over
					// the wire even though `new Response(null, { status: 404 })`
					// has an empty `statusText` at the JS-object level).
					return new Response(null, { status: 404, statusText: "Not Found" });
				}
				return errorResponse(500, `unexpected route: ${req.route}`);
			});
			render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
			const row = within(await rowFor("acme/api"));

			await user.click(row.getByRole("button", { name: "Delete" }));

			expect(await screen.findByText("Not Found")).toBeInTheDocument();
			// The row must survive a failed delete -- nothing was actually removed.
			expect(screen.getByText("acme/api")).toBeInTheDocument();
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("disables Save and issues only one POST while the create request is in flight", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		let currentList: RepoDefinition[] = [];
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ repoDefinitions: currentList });
			}
			if (req.route === "POST /repo-definitions") {
				return deferred.promise;
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No repository definitions yet.");

		await user.click(screen.getByRole("button", { name: "+ New repository" }));
		await user.type(screen.getByLabelText("Owner"), "octo");
		await user.type(screen.getByLabelText("Repo"), "site");
		await user.click(screen.getByRole("button", { name: "Save" }));

		const savingButton = await screen.findByRole("button", {
			name: "Saving...",
		});
		expect(savingButton).toBeDisabled();

		// A disabled submit button must not fire a second submit.
		await user.click(savingButton);
		expect(http.callsTo("POST /repo-definitions")).toHaveLength(1);

		currentList = [
			repoDefinition({ id: "repo-new", owner: "octo", repo: "site" }),
		];
		deferred.resolve(jsonResponse(currentList[0]));
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "New repository" }),
			).not.toBeInTheDocument(),
		);
		expect(await screen.findByText("octo/site")).toBeInTheDocument();
	});

	test("a 400 rejection keeps the form open with the server's message and the typed input intact", async () => {
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ repoDefinitions: [] });
			}
			if (req.route === "POST /repo-definitions") {
				return errorResponse(
					400,
					"  - owner: must match GitHub's owner/repo naming rules",
				);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No repository definitions yet.");

		await user.click(screen.getByRole("button", { name: "+ New repository" }));
		await user.type(screen.getByLabelText("Owner"), "bad owner!");
		await user.type(screen.getByLabelText("Repo"), "site");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByText(
				"- owner: must match GitHub's owner/repo naming rules",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "New repository" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Owner")).toHaveValue("bad owner!");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		// A rejected submit must not trigger a refetch -- nothing was written.
		expect(http.callsTo(LIST_ROUTE)).toHaveLength(1);
	});

	test("Cancel aborts an in-flight PUT and closes the editor immediately, then refreshes the list in the background", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({
					repoDefinitions: [
						repoDefinition({ id: "repo-1", owner: "acme", repo: "api" }),
					],
				});
			}
			if (req.route === "PUT /repo-definitions/repo-1") {
				return deferred.promise;
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const row = within(await rowFor("acme/api"));
		await user.click(row.getByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(
			screen.queryByRole("heading", { name: "Edit repository" }),
		).not.toBeInTheDocument();
		const put = http.callsTo("PUT /repo-definitions/repo-1")[0];
		expect(put?.signal?.aborted).toBe(true);

		// stubFetch honors the signal: the aborted PUT rejects instead of
		// ever delivering `deferred`'s value, landing in handleSubmit's
		// catch. The write may already have landed server-side before the
		// abort reached it, so the generation-mismatch branch there must
		// re-fetch the list in the background instead of leaving stale data
		// visible until a manual reload.
		await waitFor(() => expect(http.callsTo(LIST_ROUTE)).toHaveLength(2));
	});

	test("Cancel aborts an in-flight POST and closes the editor immediately, then refreshes the list in the background", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({ repoDefinitions: [] });
			}
			if (req.route === "POST /repo-definitions") {
				return deferred.promise;
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No repository definitions yet.");

		await user.click(screen.getByRole("button", { name: "+ New repository" }));
		await user.type(screen.getByLabelText("Owner"), "octo");
		await user.type(screen.getByLabelText("Repo"), "site");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(
			screen.queryByRole("heading", { name: "New repository" }),
		).not.toBeInTheDocument();
		const post = http.callsTo("POST /repo-definitions")[0];
		expect(post?.signal?.aborted).toBe(true);

		// Same gap as the PUT case above, on the create path: an abandoned
		// POST that already landed server-side must not leave the list
		// showing pre-write data until a manual reload.
		await waitFor(() => expect(http.callsTo(LIST_ROUTE)).toHaveLength(2));
	});

	test("switching the edited row aborts the previous row's in-flight submit", async () => {
		const user = userEvent.setup();
		const deferred = deferredResponse();
		const http = stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({
					repoDefinitions: [
						repoDefinition({ id: "repo-a", owner: "acme", repo: "api" }),
						repoDefinition({ id: "repo-b", owner: "beta", repo: "worker" }),
					],
				});
			}
			if (req.route === "PUT /repo-definitions/repo-a") {
				return deferred.promise;
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const rowA = within(await rowFor("acme/api"));
		await user.click(rowA.getByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByRole("button", { name: "Saving..." });

		const rowB = within(await rowFor("beta/worker"));
		await user.click(rowB.getByRole("button", { name: "Edit" }));

		// The still-open modal now belongs to a fresh "edit B" session -- the
		// abandoned "edit A" request must not be able to clobber it later.
		expect(screen.getByLabelText("Owner")).toHaveValue("beta");
		const put = http.callsTo("PUT /repo-definitions/repo-a")[0];
		expect(put?.signal?.aborted).toBe(true);
	});

	test("treats an empty (cleared) system prompt override as unset", async () => {
		// SystemPromptSchema trims the override before storing it
		// (src/ingest/repo-definitions.ts), and sqlite/postgres persist the
		// trimmed value verbatim, so GET /repo-definitions can only ever
		// return a real string or an absent field -- never whitespace-only.
		// "" is the reachable "cleared" value: what a user who blanks the
		// override field and saves actually gets back.
		const definition = repoDefinition({
			owner: "acme",
			repo: "api",
			systemPrompt: "",
		});
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [definition] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const row = within(await rowFor("acme/api"));

		expect(row.getByText("inherit")).toBeInTheDocument();
		expect(row.queryByText("override")).not.toBeInTheDocument();
	});

	test("does not truncate a setup script preview exactly at the boundary length", async () => {
		// Off-by-one guard on the tooltip preview: a script whose length equals
		// the cap must render verbatim, only gaining the "..." suffix once it
		// actually exceeds the cap.
		const boundaryScript = "x".repeat(200);
		const definition = repoDefinition({
			owner: "acme",
			repo: "api",
			setupScript: boundaryScript,
		});
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [definition] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const row = within(await rowFor("acme/api"));

		expect(row.getByTitle(boundaryScript)).toBeInTheDocument();
	});

	test("calls onUnauthorized exactly once when a delete is rejected as unauthorized", async () => {
		const user = userEvent.setup();
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = mock(() => true) as typeof confirm;
		try {
			let unauthorizedCalls = 0;
			stubFetch((req) => {
				if (req.route === LIST_ROUTE) {
					return jsonResponse({
						repoDefinitions: [
							repoDefinition({ id: "repo-1", owner: "acme", repo: "api" }),
						],
					});
				}
				if (req.route === "DELETE /repo-definitions/repo-1") {
					return errorResponse(401, "token expired");
				}
				return errorResponse(500, `unexpected route: ${req.route}`);
			});
			render(
				<RepositoriesView
					token="tok"
					onUnauthorized={() => {
						unauthorizedCalls++;
					}}
				/>,
			);
			const row = within(await rowFor("acme/api"));

			await user.click(row.getByRole("button", { name: "Delete" }));

			// The 401 branch must short-circuit before setListError, exactly
			// like the list-fetch path -- never surface the rejection text.
			await waitFor(() => expect(unauthorizedCalls).toBe(1));
			expect(screen.queryByText("token expired")).not.toBeInTheDocument();
			expect(screen.getByText("acme/api")).toBeInTheDocument();
		} finally {
			globalThis.confirm = originalConfirm;
		}
	});

	test("opening a different row's editor clears a stale form error from the previous session", async () => {
		// `startEdit` must reset `formError` the same way `startCreate` and
		// `cancelForm` do -- otherwise a rejection left over from row A's
		// session bleeds into row B's freshly opened form.
		stubFetch((req) => {
			if (req.route === LIST_ROUTE) {
				return jsonResponse({
					repoDefinitions: [
						repoDefinition({ id: "repo-a", owner: "acme", repo: "api" }),
						repoDefinition({ id: "repo-b", owner: "beta", repo: "worker" }),
					],
				});
			}
			if (req.route === "PUT /repo-definitions/repo-a") {
				return errorResponse(
					400,
					"  - owner: must match GitHub's owner/repo naming rules",
				);
			}
			return errorResponse(500, `unexpected route: ${req.route}`);
		});
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		const rowA = within(await rowFor("acme/api"));
		await user.click(rowA.getByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText(
			"- owner: must match GitHub's owner/repo naming rules",
		);

		const rowB = within(await rowFor("beta/worker"));
		await user.click(rowB.getByRole("button", { name: "Edit" }));

		expect(
			screen.getByRole("heading", { name: "Edit repository" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Owner")).toHaveValue("beta");
		expect(
			screen.queryByText(
				"- owner: must match GitHub's owner/repo naming rules",
			),
		).not.toBeInTheDocument();
	});

	test("pressing Escape closes the open editor like Cancel", async () => {
		// The Escape listener is (re)installed by an effect keyed on
		// `[editingId, cancelForm]`; if that dependency array were emptied the
		// effect would only ever run once while `editingId` was still `null`,
		// so it would never actually attach the listener.
		stubFetch((req) =>
			req.route === LIST_ROUTE
				? jsonResponse({ repoDefinitions: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);
		const user = userEvent.setup();
		render(<RepositoriesView token="tok" onUnauthorized={() => {}} />);
		await screen.findByText("No repository definitions yet.");

		await user.click(screen.getByRole("button", { name: "+ New repository" }));
		expect(
			screen.getByRole("heading", { name: "New repository" }),
		).toBeInTheDocument();

		await user.keyboard("{Escape}");

		expect(
			screen.queryByRole("heading", { name: "New repository" }),
		).not.toBeInTheDocument();
	});
});
