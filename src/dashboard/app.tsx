/**
 * Dashboard entry point: mounts <App/> into index.html's #root. Auth model
 * (design doc "Auth UX"): the API token lives only in localStorage and
 * React state -- the static page itself is unauthenticated and carries no
 * data, so there is nothing to protect before a token is supplied. Any 401
 * from any view clears the token and re-shows the prompt.
 */

import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { IncidentsView } from "./incidents-view";
import { RepositoriesView } from "./repositories-view";
import { TokenPrompt } from "./token-prompt";

const TOKEN_STORAGE_KEY = "paperhanger.apiToken";

type View = "repositories" | "incidents";

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

function App() {
	const [token, setToken] = useState<string | null>(() => readStoredToken());
	const [view, setView] = useState<View>("repositories");
	// Set whenever a stored or submitted token turns out to be invalid, so the
	// prompt can explain why it reappeared instead of silently reverting.
	const [authError, setAuthError] = useState<string | undefined>();

	// Passed to the views as `onUnauthorized`: any 401 lands here, so the
	// prompt reappears WITH an explanation instead of silently reverting.
	const handleUnauthorized = useCallback(() => {
		clearStoredToken();
		setToken(null);
		setAuthError(INVALID_TOKEN_MESSAGE);
	}, []);

	// The header's manual "Sign out" button: an intentional action, not a
	// rejection, so it clears the token without alarming the user.
	const handleSignOut = useCallback(() => {
		clearStoredToken();
		setToken(null);
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
	}, []);

	if (!token) {
		return <TokenPrompt onSubmit={handleTokenSubmit} error={authError} />;
	}

	return (
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
			<main>
				{view === "repositories" ? (
					<RepositoriesView token={token} onUnauthorized={handleUnauthorized} />
				) : (
					<IncidentsView token={token} onUnauthorized={handleUnauthorized} />
				)}
			</main>
		</div>
	);
}

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing #root element in dashboard/index.html");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
