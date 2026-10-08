import { describe, expect, test } from "bun:test";
import { truncate } from "./format";

/** Length of the "… (truncated)" marker `truncate()` appends. */
const SUFFIX_LENGTH = 13;

describe("truncate", () => {
	test("returns text unchanged when at or under maxLength", () => {
		expect(truncate("hello", 5)).toBe("hello");
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("", 0)).toBe("");
	});

	test("never exceeds maxLength around small and suffix-length boundaries", () => {
		for (const n of [5, 10]) {
			const text = "x".repeat(n + 50);
			const result = truncate(text, n);
			expect(result.length).toBeLessThanOrEqual(n);
		}
		const slicedSuffix = truncate("x".repeat(50), 5);
		expect(slicedSuffix.length).toBe(5);
		expect(slicedSuffix).toBe("… (tr");

		for (const n of [SUFFIX_LENGTH - 1, SUFFIX_LENGTH, SUFFIX_LENGTH + 1]) {
			const text = "x".repeat(n + 50);
			const result = truncate(text, n);
			expect(result.length).toBeLessThanOrEqual(n);
		}

		const text = "x".repeat(50);
		const result = truncate(text, SUFFIX_LENGTH);
		expect(result.length).toBe(SUFFIX_LENGTH);
		expect(result).toBe("… (truncated)");

		const sourceText = "a".repeat(50);
		const sourceCutResult = truncate(sourceText, SUFFIX_LENGTH + 1);
		expect(sourceCutResult.length).toBe(SUFFIX_LENGTH + 1);
		expect(sourceCutResult).toBe("a… (truncated)");
	});

	test("returns an empty string for a non-positive maxLength when text is non-empty", () => {
		expect(truncate("hello", 0)).toBe("");
	});
});
