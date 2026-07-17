/**
 * Read-only, single-statement guard for the `query_telemetry` tool's SQL
 * path (`../telemetry-client.ts`). Pure logic, no `@flue/*` or network
 * dependency, so it is unit-testable directly by the main paperhanger
 * repo's `bun test` (see the root `package.json` "test" script).
 */

const ALLOWED_SQL_VERBS = ["select", "show", "desc", "describe"];

/**
 * Rejects anything that isn't a single read-only statement. This is a
 * pragmatic guard (verb allowlist + single-statement check), not a full SQL
 * parser -- sufficient for a model-driven follow-up query tool where the goal
 * is to prevent accidental/malicious mutation, not to sandbox arbitrary SQL.
 *
 * Deliberately conservative about a few edge cases:
 * - A leading line comment or block comment before the real verb (e.g. a
 *   `--`-style line comment, or a slash-star block comment, immediately
 *   followed by `select`/`delete`/etc.) makes the "first word" the comment
 *   token itself, which is not in the allowlist -- such input is rejected
 *   outright rather than having the comment stripped and the verb
 *   underneath inspected. This is deliberately strict: a comment-prefixed
 *   statement is unusual for this tool's use case (ad hoc follow-up
 *   queries), so it costs little to disallow, and it removes an entire
 *   class of "hide the verb behind a comment" bypass attempts.
 * - `WITH`-prefixed CTEs (`WITH x AS (SELECT ...) SELECT * FROM x`) are
 *   rejected, even though a read-only CTE is technically safe: reliably
 *   distinguishing that from a data-modifying CTE (`WITH x AS (DELETE ...
 *   RETURNING ...) ...`, which Postgres-family engines support) would
 *   require real SQL parsing. Rejecting the whole `WITH` prefix is the safe
 *   default; this is intentional, not a gap to fix.
 */
export function assertReadOnlySingleStatement(query: string): void {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		throw new Error("Empty SQL query");
	}
	const withoutTrailingSemicolon = trimmed.endsWith(";")
		? trimmed.slice(0, -1)
		: trimmed;
	if (withoutTrailingSemicolon.includes(";")) {
		throw new Error(
			"Only a single SQL statement is allowed for telemetry follow-up queries",
		);
	}
	const firstWord = (
		withoutTrailingSemicolon.split(/\s+/)[0] ?? ""
	).toLowerCase();
	if (!ALLOWED_SQL_VERBS.includes(firstWord)) {
		throw new Error(
			`Only SELECT/SHOW/DESC statements are allowed for telemetry follow-up queries (got: ${firstWord || "<empty>"})`,
		);
	}
}
