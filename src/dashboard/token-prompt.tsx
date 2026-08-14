/**
 * Full-screen gate shown whenever the dashboard has no usable API token
 * (app.tsx: no stored token at all). The same component is also reused as an
 * overlay (see `overlay` below) on top of the still-mounted app shell when a
 * request comes back 401 mid-session, so an operator's in-progress draft in
 * the view underneath survives re-authentication.
 */

import type { FormEvent } from "react";
import { useState } from "react";

export function TokenPrompt({
	onSubmit,
	error,
	overlay,
	onSignOut,
}: {
	onSubmit: (token: string) => void;
	error?: string;
	/** Renders as a fixed overlay above the app shell instead of full-screen. */
	overlay?: boolean;
	/** When set, renders a secondary "Sign out" button so a user stuck behind
	 * the overlay without a valid token isn't trapped there. */
	onSignOut?: () => void;
}) {
	const [value, setValue] = useState("");

	function handleSubmit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			onSubmit(trimmed);
		}
	}

	return (
		<div
			className={overlay ? "token-gate token-gate-overlay" : "token-gate"}
			// While the overlay sits on top of a mounted view, that view may own
			// a window-level Escape (or other key) listener of its own (e.g.
			// RepositoriesView's form-close shortcut). The overlay exists to
			// protect whatever is underneath, so it owns the keyboard while
			// rendered: React attaches this handler on the root container, so
			// stopping propagation here keeps the keydown from ever reaching a
			// `window` listener.
			onKeyDown={(event) => event.stopPropagation()}
		>
			<form className="token-form" onSubmit={handleSubmit}>
				<h1>Paperhanger</h1>
				<p className="token-form-hint">
					Enter the server's API token to view incidents and manage repository
					definitions.
				</p>
				{error && <p className="form-error">{error}</p>}
				<input
					type="password"
					placeholder="API token"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				{onSignOut ? (
					<div className="form-actions">
						<button type="submit" disabled={value.trim().length === 0}>
							Continue
						</button>
						<button type="button" className="secondary" onClick={onSignOut}>
							Sign out
						</button>
					</div>
				) : (
					<button type="submit" disabled={value.trim().length === 0}>
						Continue
					</button>
				)}
			</form>
		</div>
	);
}
