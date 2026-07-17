import { describe, expect, test } from "bun:test";
import { assertReadOnlySingleStatement } from "./sql-guard";

function rejects(query: string): void {
	expect(() => assertReadOnlySingleStatement(query)).toThrow();
}

function allows(query: string): void {
	expect(() => assertReadOnlySingleStatement(query)).not.toThrow();
}

describe("assertReadOnlySingleStatement", () => {
	test("allows a plain SELECT", () => {
		allows("select * from logs");
	});

	test("allows SHOW/DESC/DESCRIBE", () => {
		allows("SHOW TABLES");
		allows("DESC logs");
		allows("DESCRIBE logs");
	});

	test("allows a trailing semicolon on an otherwise single statement", () => {
		allows("select 1;");
	});

	test("is case-insensitive on the verb", () => {
		allows("SeLeCt 1");
	});

	test("rejects an empty string", () => {
		rejects("");
	});

	test("rejects a whitespace-only string", () => {
		rejects("   \n\t  ");
	});

	test("rejects a bare mutating verb", () => {
		rejects("delete from incidents");
		rejects("DROP TABLE incidents");
		rejects("insert into incidents values (1)");
		rejects("update incidents set status = 'x'");
	});

	test("rejects an embedded semicolon (stacked statement disguised as one)", () => {
		rejects("select 1; drop table incidents");
	});

	test("rejects stacked SELECT statements", () => {
		rejects("select 1; select 2");
	});

	test("rejects a leading line comment before a mutating verb", () => {
		rejects("-- comment\ndelete from incidents");
	});

	test("rejects a leading line comment before a SELECT (comment token wins, strict by design)", () => {
		rejects("-- comment\nselect 1");
	});

	test("rejects a leading block comment before the verb", () => {
		rejects("/* comment */ delete from incidents");
	});

	test("rejects a leading block comment immediately followed by SELECT", () => {
		rejects("/* comment */select 1");
	});

	test("rejects WITH-prefixed CTEs (current allowlist rejects them; keep it that way)", () => {
		rejects("WITH x AS (SELECT 1) SELECT * FROM x");
	});

	test("rejects an unrecognized verb", () => {
		rejects("explain select 1");
	});
});
