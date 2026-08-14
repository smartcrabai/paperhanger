/**
 * Root dashboard component. Mounting lives in ./main.tsx (index.html's entry)
 * so this module stays side-effect free and testable. Auth model (design doc
 * "Auth UX"): the API token lives only in localStorage and React state -- the
 * static page itself is unauthenticated and carries no data, so there is
 * nothing to protect before a token is supplied. A 401 from any view clears
 * the *stored* token and shows the prompt as an overlay on top of the still-
 * mounted view -- unmounting it here would destroy whatever the operator was
 * mid-edit on (e.g. a half-written setup script). React `token` state is only
 * cleared by an explicit sign-out or a fresh submit.
 */

import { useCallback, useState } from "react";
import { IncidentsView } from "./incidents-view";
import { RepositoriesView } from "./repositories-view";
import { SetupScriptsView } from "./setup-scripts-view";
import { SystemPromptView } from "./system-prompt-view";
import { TokenPrompt } from "./token-prompt";

const TOKEN_STORAGE_KEY = "paperhanger.apiToken";

type View = "repositories" | "setup-scripts" | "system-prompt" | "incidents";

function readStoredToken(): string | null {
	try {
		return window.localStorage.getItem(TOKEN_STORAGE_KEY);
	} catch {
		return null;
	}
}

function clearStoredToken(): void {
	try {
		window.localStorage.removeItem(TOKEN_STORAGE_KEY);
	} catch {
		// localStorage unavailable (e.g. private browsing); clearing the
		// React state below still re-shows the prompt.
	}
}

const INVALID_TOKEN_MESSAGE =
	"That API token was rejected. Enter a valid token to continue.";

export function App() {
	const [token, setToken] = useState<string | null>(() => readStoredToken());
	const [view, setView] = useState<View>("repositories");
	// True whenever a request 401s mid-session; drives the reauth overlay.
	// Deliberately separate from `token` -- clearing `token` would unmount
	// the view underneath instead of just overlaying it.
	const [needsReauth, setNeedsReauth] = useState(false);
	// Set whenever a stored or submitted token turns out to be invalid, so the
	// prompt can explain why it reappeared instead of silently reverting.
	const [authError, setAuthError] = useState<string | undefined>();
	// Bumped on every submit through the prompt (see handleTokenSubmit), even
	// when the resubmitted string is identical to the rejected one. Every
	// view's `refresh` depends on `onUnauthorized` (below), so a new epoch
	// gives that callback a new identity and forces every view to refetch --
	// without it, resubmitting the SAME rejected token changes no prop at
	// all and the app stays frozen: no refetch, no way to ever recover.
	const [authEpoch, setAuthEpoch] = useState(0);

	// Passed to the views as `onUnauthorized`: any 401 lands here. Only the
	// *stored* token is cleared -- `token` state stays put so the view (and
	// its in-progress draft) remains mounted under the reauth overlay.
	// Depends on `authEpoch` purely so its identity changes on every auth
	// ATTEMPT (see above), not because its body reads it.
	const handleUnauthorized = useCallback(() => {
		clearStoredToken();
		setNeedsReauth(true);
		setAuthError(INVALID_TOKEN_MESSAGE);
		// biome-ignore lint/correctness/useExhaustiveDependencies: authEpoch is
		// an identity trigger, not a value read here -- see comment above.
	}, [authEpoch]);

	// The header's manual "Sign out" button: an intentional action, not a
	// rejection, so it clears the token without alarming the user and drops
	// back to the full-screen prompt.
	const handleSignOut = useCallback(() => {
		clearStoredToken();
		setToken(null);
		setNeedsReauth(false);
		setAuthError(undefined);
	}, []);

	const handleTokenSubmit = useCallback((value: string) => {
		try {
			window.localStorage.setItem(TOKEN_STORAGE_KEY, value);
		} catch {
			// Best effort; the token still works for this session via React state.
		}
		setAuthError(undefined);
		setToken(value);
		setNeedsReauth(false);
		setAuthEpoch((epoch) => epoch + 1);
	}, []);

	if (!token) {
		return <TokenPrompt onSubmit={handleTokenSubmit} error={authError} />;
	}

	const renderView = () => {
		switch (view) {
			case "repositories":
				return (
					<RepositoriesView token={token} onUnauthorized={handleUnauthorized} />
				);
			case "setup-scripts":
				return (
					<SetupScriptsView token={token} onUnauthorized={handleUnauthorized} />
				);
			case "system-prompt":
				return (
					<SystemPromptView token={token} onUnauthorized={handleUnauthorized} />
				);
			case "incidents":
				return (
					<IncidentsView token={token} onUnauthorized={handleUnauthorized} />
				);
		}
	};

	return (
		<>
			<div className="app">
				<header className="app-header">
					<h1>Paperhanger</h1>
					<nav className="tabs">
						<button
							type="button"
							className={view === "repositories" ? "tab active" : "tab"}
							onClick={() => setView("repositories")}
						>
							Repositories
						</button>
						<button
							type="button"
							className={view === "setup-scripts" ? "tab active" : "tab"}
							onClick={() => setView("setup-scripts")}
						>
							Setup scripts
						</button>
						<button
							type="button"
							className={view === "system-prompt" ? "tab active" : "tab"}
							onClick={() => setView("system-prompt")}
						>
							System prompt
						</button>
						<button
							type="button"
							className={view === "incidents" ? "tab active" : "tab"}
							onClick={() => setView("incidents")}
						>
							Incidents
						</button>
					</nav>
					<button type="button" className="link-button" onClick={handleSignOut}>
						Sign out
					</button>
				</header>
				<main>{renderView()}</main>
			</div>
			{needsReauth && (
				<TokenPrompt
					overlay
					onSubmit={handleTokenSubmit}
					onSignOut={handleSignOut}
					error={authError}
				/>
			)}
		</>
	);
}
