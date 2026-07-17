import { describe, expect, test } from "bun:test";
import { checkForTamper, type TamperCheckInput } from "./tamper-check";

const BASE: TamperCheckInput = {
	actualRemoteUrl: "https://github.com/acme/widgets.git",
	expectedRemoteUrl: "https://github.com/acme/widgets.git",
	actualBranch: "paperhanger/incident-1",
	expectedBranch: "paperhanger/incident-1",
};

describe("checkForTamper", () => {
	test("passes when the remote and branch both match expectations", () => {
		expect(checkForTamper(BASE)).toEqual({ ok: true });
	});

	test("tolerates surrounding whitespace from raw git command output", () => {
		expect(
			checkForTamper({
				...BASE,
				actualRemoteUrl: `${BASE.actualRemoteUrl}\n`,
				actualBranch: `${BASE.actualBranch}\n`,
			}),
		).toEqual({ ok: true });
	});

	test("fails when the origin remote was repointed", () => {
		const result = checkForTamper({
			...BASE,
			actualRemoteUrl: "https://github.com/attacker/evil.git",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("git remote 'origin' changed");
			expect(result.reason).toContain("https://github.com/attacker/evil.git");
		}
	});

	test("fails when the current branch was switched", () => {
		const result = checkForTamper({ ...BASE, actualBranch: "main" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("current branch changed");
			expect(result.reason).toContain("main");
		}
	});

	test("reports the remote mismatch first when both remote and branch changed", () => {
		const result = checkForTamper({
			...BASE,
			actualRemoteUrl: "https://github.com/attacker/evil.git",
			actualBranch: "main",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("git remote 'origin' changed");
		}
	});
});
