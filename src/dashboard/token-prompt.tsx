/**
 * Full-screen gate shown whenever the dashboard has no usable API token (see
 * app.tsx: no stored token, or the most recent request came back 401). The
 * static page itself carries no data, so this form is the only thing that
 * ever gets rendered before a valid token is supplied.
 */

import type { FormEvent } from "react";
import { useState } from "react";

export function TokenPrompt({
	onSubmit,
	error,
}: {
	onSubmit: (token: string) => void;
	error?: string;
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
		<div className="token-gate">
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
				<button type="submit" disabled={value.trim().length === 0}>
					Continue
				</button>
			</form>
		</div>
	);
}
