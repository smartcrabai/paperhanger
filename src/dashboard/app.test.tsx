/**
 * `App` shell: the auth gate (design doc "Auth UX") and tab router that sit
 * above the four views. Each view's own data-fetching/error-handling is
 * covered by its own test file -- this file only exercises what `App` itself
 * owns: which token (if any) reaches a view, when the prompt appears instead,
 * and which tab is mounted.
 */

import { describe, expect, test } from "bun:test";
import { App } from "./app";
import {
	errorResponse,
	jsonResponse,
	type RecordedRequest,
	stubFetch,
} from "./test-fetch";
import {
	render,
	screen,
	setupDashboardTest,
	userEvent,
	waitFor,
	within,
} from "./test-setup";

setupDashboardTest();

const TOKEN_STORAGE_KEY = "paperhanger.apiToken";
const REJECTION_MESSAGE =
	"That API token was rejected. Enter a valid token to continue.";

type RouteHandler = (req: RecordedRequest) => Response | Promise<Response>;

/**
 * Default "everything is empty" response for all four views' initial GETs,
 * with per-test overrides for the route(s) a test actually cares about.
 * Any route outside this set still fails loudly per the harness contract.
 */
function viewRoutes(overrides: Partial<Record<string, RouteHandler>> = {}) {
	const routes: Record<string, RouteHandler> = {
		"GET /repo-definitions": () => jsonResponse({ repoDefinitions: [] }),
		"GET /setup-scripts": () => jsonResponse({ setupScripts: [] }),
		"GET /system-prompt": () => jsonResponse({ systemPrompt: null }),
		"GET /incidents": () => jsonResponse({ incidents: [] }),
		...overrides,
	};
	return (req: RecordedRequest) =>
		(
			routes[req.route] ??
			(() => errorResponse(500, `unexpected route: ${req.route}`))
		)(req);
}

describe("App", () => {
	test("with no stored token, shows only the prompt and issues no request", () => {
		const http = stubFetch(viewRoutes());
		const { container } = render(<App />);

		expect(screen.getByPlaceholderText("API token")).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "Repositories" }),
		).not.toBeInTheDocument();
		// First run is the pre-existing full-screen gate, not the reauth
		// overlay -- it must not carry the overlay's fixed/backdrop styling.
		expect(container.querySelector(".token-gate-overlay")).toBeNull();
		// The static page carries no data of its own -- nothing should hit the
		// network before a token exists to authenticate with.
		expect(http.calls).toEqual([]);
	});

	test("submitting a token persists it and mounts the Repositories view", async () => {
		const user = userEvent.setup();
		const http = stubFetch(viewRoutes());
		render(<App />);

		await user.type(screen.getByPlaceholderText("API token"), "fresh-token");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(
			await screen.findByRole("heading", { name: "Repositories" }),
		).toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("fresh-token");
		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]?.route).toBe("GET /repo-definitions");
		expect(http.calls[0]?.token).toBe("fresh-token");
	});

	test("a token already in localStorage is used on first render, skipping the prompt", async () => {
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-token");
		const http = stubFetch(viewRoutes());
		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "Repositories" }),
		).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("API token")).not.toBeInTheDocument();
		expect(http.calls[0]?.token).toBe("stored-token");
		// Repositories is the default `view` state; nothing has been clicked yet.
		expect(screen.getByRole("button", { name: "Repositories" })).toHaveClass(
			"active",
		);
		expect(screen.getByRole("button", { name: "Incidents" })).not.toHaveClass(
			"active",
		);
	});

	test("a throwing localStorage.getItem does not break the first render", () => {
		const originalGetItem = window.localStorage.getItem.bind(
			window.localStorage,
		);
		window.localStorage.getItem = () => {
			throw new Error("blocked by browser policy");
		};
		try {
			const http = stubFetch(viewRoutes());
			render(<App />);

			// readStoredToken()'s try/catch must swallow this and fall back to
			// "no token" rather than crashing the whole tree.
			expect(screen.getByPlaceholderText("API token")).toBeInTheDocument();
			expect(http.calls).toEqual([]);
		} finally {
			window.localStorage.getItem = originalGetItem;
		}
	});

	test("a throwing localStorage.setItem still signs the user in for the session", async () => {
		const user = userEvent.setup();
		const originalSetItem = window.localStorage.setItem.bind(
			window.localStorage,
		);
		window.localStorage.setItem = () => {
			throw new Error("quota exceeded");
		};
		try {
			const http = stubFetch(viewRoutes());
			render(<App />);

			await user.type(
				screen.getByPlaceholderText("API token"),
				"session-token",
			);
			await user.click(screen.getByRole("button", { name: "Continue" }));

			// handleTokenSubmit's try/catch swallows the persistence failure --
			// the token still reaches React state, so the view still mounts.
			expect(
				await screen.findByRole("heading", { name: "Repositories" }),
			).toBeInTheDocument();
			expect(http.calls[0]?.token).toBe("session-token");
		} finally {
			window.localStorage.setItem = originalSetItem;
		}
	});

	test("a 401 from the initially rendered view clears the token and shows the rejection message", async () => {
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		const http = stubFetch(
			viewRoutes({
				"GET /repo-definitions": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);

		expect(await screen.findByText(REJECTION_MESSAGE)).toBeInTheDocument();
		expect(screen.getByPlaceholderText("API token")).toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
		expect(http.calls[0]?.token).toBe("stale-token");
	});

	test("after a 401 clears the prompt, a later valid token submit recovers the view", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		let repoCalls = 0;
		const http = stubFetch(
			viewRoutes({
				"GET /repo-definitions": () => {
					repoCalls += 1;
					return repoCalls === 1
						? errorResponse(401, "invalid token")
						: jsonResponse({ repoDefinitions: [] });
				},
			}),
		);
		render(<App />);
		await screen.findByText(REJECTION_MESSAGE);

		await user.type(screen.getByPlaceholderText("API token"), "fresh-token");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(
			await screen.findByRole("heading", { name: "Repositories" }),
		).toBeInTheDocument();
		expect(screen.queryByText(REJECTION_MESSAGE)).not.toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("fresh-token");
		expect(http.calls.map((call) => call.token)).toEqual([
			"stale-token",
			"fresh-token",
		]);
	});

	test('"Sign out" clears the stored token and re-shows the prompt without an error message', async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "signed-in-token");
		stubFetch(viewRoutes());
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "Sign out" }));

		expect(screen.getByPlaceholderText("API token")).toBeInTheDocument();
		// Signing out is a deliberate action, not a rejection -- the app's only
		// error copy for this gate is the 401 rejection message, and it must
		// not appear here.
		expect(screen.queryByText(REJECTION_MESSAGE)).not.toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
	});

	test("the Setup scripts tab fetches its own view and becomes the only active tab", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		const http = stubFetch(viewRoutes());
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "Setup scripts" }));

		expect(
			await screen.findByRole("heading", { name: "Common setup scripts" }),
		).toBeInTheDocument();
		expect(http.callsTo("GET /setup-scripts")).toHaveLength(1);
		expect(http.callsTo("GET /setup-scripts")[0]?.token).toBe("tok");
		expect(screen.getByRole("button", { name: "Setup scripts" })).toHaveClass(
			"active",
		);
		expect(
			screen.getByRole("button", { name: "Repositories" }),
		).not.toHaveClass("active");
		expect(
			screen.getByRole("button", { name: "System prompt" }),
		).not.toHaveClass("active");
		expect(screen.getByRole("button", { name: "Incidents" })).not.toHaveClass(
			"active",
		);
	});

	test("the System prompt tab fetches its own view and becomes the only active tab", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		const http = stubFetch(viewRoutes());
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "System prompt" }));

		expect(
			await screen.findByRole("heading", { name: "System prompt" }),
		).toBeInTheDocument();
		expect(http.callsTo("GET /system-prompt")).toHaveLength(1);
		expect(http.callsTo("GET /system-prompt")[0]?.token).toBe("tok");
		expect(screen.getByRole("button", { name: "System prompt" })).toHaveClass(
			"active",
		);
		expect(
			screen.getByRole("button", { name: "Repositories" }),
		).not.toHaveClass("active");
	});

	test("the Incidents tab fetches its own view and becomes the only active tab", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		const http = stubFetch(viewRoutes());
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "Incidents" }));

		expect(
			await screen.findByRole("heading", { name: "Incidents" }),
		).toBeInTheDocument();
		expect(http.callsTo("GET /incidents")).toHaveLength(1);
		expect(http.callsTo("GET /incidents")[0]?.token).toBe("tok");
		expect(screen.getByRole("button", { name: "Incidents" })).toHaveClass(
			"active",
		);
		expect(
			screen.getByRole("button", { name: "Repositories" }),
		).not.toHaveClass("active");
	});

	test("clicking back to the Repositories tab re-fetches it and re-marks it active", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		const http = stubFetch(viewRoutes());
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "Incidents" }));
		await screen.findByRole("heading", { name: "Incidents" });
		await user.click(screen.getByRole("button", { name: "Repositories" }));

		expect(
			await screen.findByRole("heading", { name: "Repositories" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Repositories" })).toHaveClass(
			"active",
		);
		expect(screen.getByRole("button", { name: "Incidents" })).not.toHaveClass(
			"active",
		);
		// Once on mount, once on the return visit -- switching tabs and back
		// must re-run the view's own effect, not reuse stale state.
		expect(http.callsTo("GET /repo-definitions")).toHaveLength(2);
	});

	test("a 401 from a view reached via tab navigation also re-shows the prompt", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		stubFetch(
			viewRoutes({
				"GET /incidents": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "Incidents" }));

		// `onUnauthorized` is the same `handleUnauthorized` regardless of which
		// tab triggered the 401 -- not just the view that happened to be first.
		expect(await screen.findByText(REJECTION_MESSAGE)).toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
	});

	test("a 401 from the Setup scripts view also re-shows the prompt", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		stubFetch(
			viewRoutes({
				"GET /setup-scripts": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "Setup scripts" }));

		// `App` must wire the same `onUnauthorized` into every view it routes
		// to, not just Repositories/Incidents -- a view rendered without it
		// would throw instead of re-showing the prompt on a 401.
		expect(await screen.findByText(REJECTION_MESSAGE)).toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
	});

	test("a 401 from the System prompt view also re-shows the prompt", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "tok");
		stubFetch(
			viewRoutes({
				"GET /system-prompt": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });

		await user.click(screen.getByRole("button", { name: "System prompt" }));

		expect(await screen.findByText(REJECTION_MESSAGE)).toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
	});

	test("a 401 while editing a setup script keeps the draft mounted and shows the overlay prompt", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		stubFetch(
			viewRoutes({
				"POST /setup-scripts": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });
		await user.click(screen.getByRole("button", { name: "Setup scripts" }));
		await screen.findByRole("heading", { name: "Common setup scripts" });
		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(screen.getByPlaceholderText("bun.lock"), "bun.lock");
		await user.type(
			screen.getByPlaceholderText("bun install --frozen-lockfile"),
			"bun install",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));

		// The 401 must not unmount the view underneath -- the operator's
		// half-written setup script is still there once the overlay appears.
		expect(await screen.findByText(REJECTION_MESSAGE)).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Common setup scripts" }),
		).toBeInTheDocument();
		expect(screen.getByPlaceholderText("bun.lock")).toHaveValue("bun.lock");
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
	});

	test("submitting a fresh token after a 401 dismisses the overlay, keeps the view mounted, and re-fetches with the new token", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		const http = stubFetch(
			viewRoutes({
				"POST /setup-scripts": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });
		await user.click(screen.getByRole("button", { name: "Setup scripts" }));
		await screen.findByRole("heading", { name: "Common setup scripts" });
		await user.click(
			screen.getByRole("button", { name: "+ New setup script" }),
		);
		await user.type(screen.getByPlaceholderText("bun.lock"), "bun.lock");
		await user.type(
			screen.getByPlaceholderText("bun install --frozen-lockfile"),
			"bun install",
		);
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText(REJECTION_MESSAGE);

		await user.type(screen.getByPlaceholderText("API token"), "fresh-token");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(screen.queryByText(REJECTION_MESSAGE)).not.toBeInTheDocument();
		expect(screen.queryByPlaceholderText("API token")).not.toBeInTheDocument();
		// The draft survives dismissal: it was overlaid, never unmounted.
		expect(screen.getByPlaceholderText("bun.lock")).toHaveValue("bun.lock");
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("fresh-token");
		// The view's own effect re-fetches because `token` changed underneath it.
		const setupScriptCalls = http.callsTo("GET /setup-scripts");
		expect(setupScriptCalls.at(-1)?.token).toBe("fresh-token");
	});

	test("the overlay's Sign out returns to the full-screen prompt with no error message", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		stubFetch(
			viewRoutes({
				"GET /repo-definitions": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByText(REJECTION_MESSAGE);

		const overlayForm = screen
			.getByText(REJECTION_MESSAGE)
			.closest("form") as HTMLFormElement;
		await user.click(
			within(overlayForm).getByRole("button", { name: "Sign out" }),
		);

		expect(screen.getByPlaceholderText("API token")).toBeInTheDocument();
		expect(screen.queryByText(REJECTION_MESSAGE)).not.toBeInTheDocument();
		// A deliberate sign-out reverts to the pre-existing full-screen gate,
		// unmounting the shell -- unlike a 401, which only overlays it.
		expect(
			screen.queryByRole("heading", { name: "Repositories" }),
		).not.toBeInTheDocument();
		expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
	});

	test("re-submitting the SAME rejected token re-issues the view's request instead of freezing it, and re-shows the rejection on a second 401", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "bad-token");
		let repoCalls = 0;
		const http = stubFetch(
			viewRoutes({
				"GET /repo-definitions": () => {
					repoCalls += 1;
					return errorResponse(401, "invalid token");
				},
			}),
		);
		render(<App />);
		await screen.findByText(REJECTION_MESSAGE);
		expect(repoCalls).toBe(1);

		// The operator may have just fixed the token server-side; typing the
		// identical string back in must still trigger a real attempt, not a
		// silent no-op (no prop changed => nothing used to refetch).
		await user.type(screen.getByPlaceholderText("API token"), "bad-token");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(repoCalls).toBe(2));
		expect(await screen.findByText(REJECTION_MESSAGE)).toBeInTheDocument();
		expect(http.calls.map((call) => call.token)).toEqual([
			"bad-token",
			"bad-token",
		]);
	});

	test("Escape typed in the reauth overlay's token input does not reach the view's own Escape handler underneath", async () => {
		const user = userEvent.setup();
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		stubFetch(
			viewRoutes({
				"POST /repo-definitions": () => errorResponse(401, "invalid token"),
			}),
		);
		render(<App />);
		await screen.findByRole("heading", { name: "Repositories" });
		await user.click(screen.getByRole("button", { name: "+ New repository" }));
		await user.type(screen.getByLabelText("Owner"), "acme");
		await user.type(screen.getByLabelText("Repo"), "widgets");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText(REJECTION_MESSAGE);

		// RepositoriesView listens for Escape on `window` to close its form
		// (mirrors the Cancel button). The overlay sits on top specifically to
		// protect that in-progress draft, so its own Escape must not bubble
		// past it and trigger that handler.
		await user.type(screen.getByPlaceholderText("API token"), "{Escape}");

		expect(
			screen.getByRole("heading", { name: "New repository" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Owner")).toHaveValue("acme");
	});

	test("the reauth overlay actually renders with the overlay class (not the first-run gate's markup)", async () => {
		window.localStorage.setItem(TOKEN_STORAGE_KEY, "stale-token");
		stubFetch(
			viewRoutes({
				"GET /repo-definitions": () => errorResponse(401, "invalid token"),
			}),
		);
		const { container } = render(<App />);
		await screen.findByText(REJECTION_MESSAGE);

		// Regression: nothing else here distinguishes the reauth prompt from
		// the first-run gate -- dropping App's `overlay` prop would keep every
		// other assertion in this file green while losing the fixed/backdrop
		// styling that makes the view underneath visible.
		expect(container.querySelector(".token-gate-overlay")).not.toBeNull();
	});
});
