import { describe, expect, test } from "bun:test";
import {
	extractCloneToken,
	redactSecrets,
	tokenlessCloneUrl,
} from "./redaction";

describe("extractCloneToken", () => {
	test("extracts the token from an authenticated clone URL", () => {
		expect(
			extractCloneToken(
				"https://x-access-token:ghs_abc123@github.com/acme/widgets.git",
			),
		).toBe("ghs_abc123");
	});

	test("returns undefined when the URL has no embedded credential", () => {
		expect(
			extractCloneToken("https://github.com/acme/widgets.git"),
		).toBeUndefined();
	});

	test("extracts a token containing URL-safe special characters", () => {
		const token = "abc-123_DEF.456~xyz";
		expect(
			extractCloneToken(
				`https://x-access-token:${token}@github.com/acme/widgets.git`,
			),
		).toBe(token);
	});
});

describe("tokenlessCloneUrl", () => {
	test("strips the embedded credential", () => {
		expect(
			tokenlessCloneUrl(
				"https://x-access-token:ghs_abc123@github.com/acme/widgets.git",
			),
		).toBe("https://github.com/acme/widgets.git");
	});

	test("is a no-op when there is no embedded credential", () => {
		expect(tokenlessCloneUrl("https://github.com/acme/widgets.git")).toBe(
			"https://github.com/acme/widgets.git",
		);
	});
});

describe("redactSecrets", () => {
	test("returns the text unchanged when the only secret is absent", () => {
		expect(redactSecrets("hello world", [undefined])).toBe("hello world");
	});

	test("redacts a single occurrence", () => {
		expect(redactSecrets("token=ghs_abc123 in the log", ["ghs_abc123"])).toBe(
			"token=***REDACTED*** in the log",
		);
	});

	test("redacts multiple occurrences of the same secret", () => {
		const text = "first ghs_abc123 then again ghs_abc123 done";
		expect(redactSecrets(text, ["ghs_abc123"])).toBe(
			"first ***REDACTED*** then again ***REDACTED*** done",
		);
	});

	test("redacts a secret containing URL-safe special characters", () => {
		const secret = "abc-123_DEF.456~xyz";
		expect(redactSecrets(`leaked: ${secret}`, [secret])).toBe(
			"leaked: ***REDACTED***",
		);
	});

	test("redacts multiple distinct secrets in the same text", () => {
		const text = "clone token ghs_abc123 and greptime auth basicauth:pw";
		expect(redactSecrets(text, ["ghs_abc123", "basicauth:pw"])).toBe(
			"clone token ***REDACTED*** and greptime auth ***REDACTED***",
		);
	});

	test("skips undefined/empty entries in a mixed secrets list", () => {
		expect(
			redactSecrets("token=ghs_abc123", [undefined, "ghs_abc123", ""]),
		).toBe("token=***REDACTED***");
	});

	test("is a no-op for text containing none of the secrets", () => {
		expect(redactSecrets("nothing sensitive here", ["ghs_abc123"])).toBe(
			"nothing sensitive here",
		);
	});
});
