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

	test("never exceeds maxLength around the suffix-length boundary (13)", () => {
		for (const n of [SUFFIX_LENGTH - 1, SUFFIX_LENGTH, SUFFIX_LENGTH + 1]) {
			const text = "x".repeat(n + 50);
			const result = truncate(text, n);
			expect(result.length).toBeLessThanOrEqual(n);
		}
	});

	test("never exceeds maxLength for small limits (5, 10)", () => {
		for (const n of [5, 10]) {
			const text = "x".repeat(n + 50);
			const result = truncate(text, n);
			expect(result.length).toBeLessThanOrEqual(n);
		}
	});

	test("slices the suffix itself when maxLength is smaller than the suffix", () => {
		const text = "x".repeat(50);
		const result = truncate(text, 5);
		expect(result.length).toBe(5);
		expect(result).toBe("… (tr");
	});

	test("returns the full suffix, unsliced, when maxLength equals the suffix length exactly", () => {
		const text = "x".repeat(50);
		const result = truncate(text, SUFFIX_LENGTH);
		expect(result.length).toBe(SUFFIX_LENGTH);
		expect(result).toBe("… (truncated)");
	});

	test("cuts the source text (not the suffix) once maxLength exceeds the suffix length", () => {
		const text = "a".repeat(50);
		const result = truncate(text, SUFFIX_LENGTH + 1);
		expect(result.length).toBe(SUFFIX_LENGTH + 1);
		expect(result).toBe("a… (truncated)");
	});

	test("returns an empty string for a non-positive maxLength when text is non-empty", () => {
		expect(truncate("hello", 0)).toBe("");
	});
});
