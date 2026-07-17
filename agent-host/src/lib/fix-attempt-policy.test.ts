import { describe, expect, test } from "bun:test";
import { decideFixAttempt } from "./fix-attempt-policy";

describe("decideFixAttempt", () => {
	test("commits an untested fix when no test suite was found, regardless of attempt number", () => {
		const decision = decideFixAttempt({
			attempt: 1,
			maxFixAttempts: 3,
			testRun: { found: false, passed: false },
		});
		expect(decision).toEqual({ action: "commit", tested: false });
	});

	test("commits a tested fix as soon as tests pass", () => {
		const decision = decideFixAttempt({
			attempt: 1,
			maxFixAttempts: 3,
			testRun: { found: true, passed: true },
		});
		expect(decision).toEqual({ action: "commit", tested: true });
	});

	test("retries when tests failed and attempts remain", () => {
		const decision = decideFixAttempt({
			attempt: 1,
			maxFixAttempts: 3,
			testRun: { found: true, passed: false },
		});
		expect(decision).toEqual({ action: "retry" });
	});

	test("retries on the second-to-last attempt", () => {
		const decision = decideFixAttempt({
			attempt: 2,
			maxFixAttempts: 3,
			testRun: { found: true, passed: false },
		});
		expect(decision).toEqual({ action: "retry" });
	});

	test("gives up once the attempt reaches maxFixAttempts with tests still failing", () => {
		const decision = decideFixAttempt({
			attempt: 3,
			maxFixAttempts: 3,
			testRun: { found: true, passed: false },
		});
		expect(decision).toEqual({ action: "give_up" });
	});

	test("gives up (rather than retrying past the limit) if attempt somehow exceeds maxFixAttempts", () => {
		const decision = decideFixAttempt({
			attempt: 4,
			maxFixAttempts: 3,
			testRun: { found: true, passed: false },
		});
		expect(decision).toEqual({ action: "give_up" });
	});

	test("gives up immediately when maxFixAttempts is 1 and the first attempt's tests fail", () => {
		const decision = decideFixAttempt({
			attempt: 1,
			maxFixAttempts: 1,
			testRun: { found: true, passed: false },
		});
		expect(decision).toEqual({ action: "give_up" });
	});

	test("a passing test takes priority over the attempt count even on the last attempt", () => {
		const decision = decideFixAttempt({
			attempt: 3,
			maxFixAttempts: 3,
			testRun: { found: true, passed: true },
		});
		expect(decision).toEqual({ action: "commit", tested: true });
	});
});
