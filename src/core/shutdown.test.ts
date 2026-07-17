import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { waitForDrain } from "./shutdown";

/**
 * A controllable fake clock/sleep pair: `sleep(ms)` advances the fake clock
 * by `ms` and resolves immediately, instead of actually waiting -- so these
 * tests exercise many polling iterations without any real wall-clock delay.
 */
function fakeClock(startAt = 0): {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
} {
	let current = startAt;
	return {
		now: () => current,
		sleep: async (ms: number) => {
			current += ms;
		},
	};
}

function loggerWithLines(): {
	logger: ReturnType<typeof createLogger>;
	lines: string[];
} {
	const lines: string[] = [];
	return { logger: createLogger({ sink: (line) => lines.push(line) }), lines };
}

describe("waitForDrain", () => {
	test("returns once pendingCount reaches zero, before the deadline, and logs 'drained'", async () => {
		const clock = fakeClock();
		const { logger, lines } = loggerWithLines();
		let pending = 3;
		const pendingCount = () => pending;

		// Each poll (simulated via `sleep`) drains one more pending incident.
		const sleep = async (ms: number) => {
			pending = Math.max(0, pending - 1);
			await clock.sleep(ms);
		};

		await waitForDrain(pendingCount, 10_000, logger, {
			sleep,
			now: clock.now,
			pollIntervalMs: 100,
		});

		expect(pendingCount()).toBe(0);
		const parsed = lines.map((line) => JSON.parse(line));
		expect(parsed.some((entry) => entry.msg === "shutdown.drained")).toBe(true);
		expect(parsed.some((entry) => entry.msg === "shutdown.drain_timeout")).toBe(
			false,
		);
	});

	test("times out with pending incidents remaining, logs 'drain_timeout', and returns without hanging", async () => {
		const clock = fakeClock();
		const { logger, lines } = loggerWithLines();
		// Never drains: always 2 pending, no matter how many times we poll.
		const pendingCount = () => 2;

		await waitForDrain(pendingCount, 1_000, logger, {
			sleep: clock.sleep,
			now: clock.now,
			pollIntervalMs: 100,
		});

		const parsed = lines.map((line) => JSON.parse(line));
		const timeoutEntry = parsed.find(
			(entry) => entry.msg === "shutdown.drain_timeout",
		);
		expect(timeoutEntry).toBeDefined();
		expect(timeoutEntry?.pending).toBe(2);
		expect(timeoutEntry?.timeoutMs).toBe(1_000);
		expect(parsed.some((entry) => entry.msg === "shutdown.drained")).toBe(
			false,
		);
	});

	test("resolves immediately (no polling at all) when already drained", async () => {
		const { logger, lines } = loggerWithLines();
		let sleepCalls = 0;

		await waitForDrain(() => 0, 5_000, logger, {
			sleep: async () => {
				sleepCalls++;
			},
			now: () => 0,
		});

		expect(sleepCalls).toBe(0);
		const parsed = lines.map((line) => JSON.parse(line));
		expect(parsed.some((entry) => entry.msg === "shutdown.drained")).toBe(true);
	});
});
