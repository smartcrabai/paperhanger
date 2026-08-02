/**
 * Deterministic secret extraction and redaction helpers used by the fix
 * agent. They stay free of Flue imports for direct unit testing.
 *
 * The clone-URL token is derived deterministically from
 * `input.repo.cloneUrl`, never by pattern-matching arbitrary error text.
 */
const CLONE_TOKEN_PATTERN = /x-access-token:([^@]+)@/;

/**
 * Extracts the installation-token credential embedded in an authenticated
 * HTTPS clone URL (`https://x-access-token:TOKEN@host/owner/repo.git`), if
 * present.
 */
export function extractCloneToken(cloneUrl: string): string | undefined {
	return CLONE_TOKEN_PATTERN.exec(cloneUrl)?.[1];
}

/**
 * Returns `cloneUrl` with any embedded `x-access-token:...@` credential
 * removed -- safe to persist as a git remote URL, or to include in an error
 * message/log line.
 */
export function tokenlessCloneUrl(cloneUrl: string): string {
	return cloneUrl.replace(CLONE_TOKEN_PATTERN, "");
}

const REDACTED = "***REDACTED***";

/**
 * Strips every occurrence of each known secret out of `text`, one secret at
 * a time. Entries that are `undefined` or empty are skipped (nothing to
 * redact for that entry) -- callers can pass a fixed-shape list like
 * `[cloneToken, greptimeAuth]` without checking which ones are actually
 * configured for a given incident.
 */
export function redactSecrets(
	text: string,
	secrets: ReadonlyArray<string | undefined>,
): string {
	let result = text;
	for (const secret of secrets) {
		if (secret) {
			result = result.split(secret).join(REDACTED);
		}
	}
	return result;
}
