import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import {
	AgentHostSidecar,
	type AgentHostSidecarConfig,
	type CancelScheduleFn,
	type FetchLike,
	type ScheduleFn,
	type SidecarProcess,
	type SpawnFn,
} from "./sidecar";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

function baseConfig(
	overrides: Partial<AgentHostSidecarConfig["agent"]> = {},
): AgentHostSidecarConfig {
	return {
		agent: {
			hostPort: 8700,
			model: "anthropic/claude-sonnet-4-6",
			...overrides,
		},
		telemetry: {
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
			auth: "user:pass",
		},
	};
}

/** A controllable fake child process: exit is driven manually via `resolveExit`. */
function createFakeProcess(pid = 111) {
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const state = { killCalls: 0 };
	const process: SidecarProcess = {
		pid,
		exited,
		stdout: null,
		stderr: null,
		kill: () => {
			state.killCalls++;
			// Real subprocesses eventually settle `exited` once killed; simulate
			// that immediately so `stop()`'s `await child.exited` doesn't hang.
			// `resolveExit` is idempotent (a second call is a no-op).
			resolveExit(143);
		},
	};
	return {
		process,
		resolveExit: (code: number) => resolveExit(code),
		get killCalls(): number {
			return state.killCalls;
		},
	};
}

function okFetch(): FetchLike {
	return async () => new Response(null, { status: 200 });
}

function alwaysFailingFetch(): FetchLike {
	return async () => {
		throw new Error("connection refused");
	};
}

/**
 * A fully controlled restart scheduler: `scheduleFn` records the requested
 * delay instead of actually waiting, and the test drives progress explicitly
 * via `fireNext()`. This replaces asserting on real timers/`Bun.sleep`, which
 * was prone to flakiness (the restart + readiness-poll cycle racing a fixed
 * wall-clock wait).
 */
function createControlledScheduler(): {
	scheduleFn: ScheduleFn;
	cancelFn: CancelScheduleFn;
	pendingDelays(): number[];
	/** Runs the oldest still-pending scheduled callback to completion. */
	fireNext(): Promise<void>;
} {
	const scheduled: {
		delayMs: number;
		run: () => Promise<void>;
		cancelled: boolean;
	}[] = [];
	const scheduleFn: ScheduleFn = (callback, delayMs) => {
		const entry = { delayMs, run: callback, cancelled: false };
		scheduled.push(entry);
		return entry;
	};
	const cancelFn: CancelScheduleFn = (handle) => {
		(handle as { cancelled: boolean }).cancelled = true;
	};
	return {
		scheduleFn,
		cancelFn,
		pendingDelays: () =>
			scheduled.filter((e) => !e.cancelled).map((e) => e.delayMs),
		async fireNext(): Promise<void> {
			const next = scheduled.shift();
			if (!next) {
				throw new Error("no scheduled restart to fire");
			}
			if (next.cancelled) {
				return;
			}
			await next.run();
		},
	};
}

describe("AgentHostSidecar - external mode", () => {
	test("does not spawn and exposes the configured hostUrl as baseUrl", async () => {
		let spawnCalls = 0;
		const spawn: SpawnFn = () => {
			spawnCalls++;
			throw new Error("should not be called in external mode");
		};
		const sidecar = new AgentHostSidecar({
			config: baseConfig({ hostUrl: "http://external-agent-host:9000/" }),
			logger: silentLogger(),
			spawn,
		});

		expect(sidecar.isExternal).toBe(true);
		expect(sidecar.baseUrl).toBe("http://external-agent-host:9000");

		await sidecar.start();
		await sidecar.stop();

		expect(spawnCalls).toBe(0);
	});
});

describe("AgentHostSidecar - internal mode spawn arguments", () => {
	test("spawns node with the server path and expected env, and computes baseUrl from hostPort", async () => {
		const fake = createFakeProcess();
		let capturedCmd: string[] | undefined;
		let capturedEnv: Record<string, string> | undefined;
		const spawn: SpawnFn = (cmd, options) => {
			capturedCmd = cmd;
			capturedEnv = options.env;
			return fake.process;
		};

		const sidecar = new AgentHostSidecar({
			config: baseConfig({ hostPort: 8765 }),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			serverPath: "./agent-host/dist/server.mjs",
			env: {
				ANTHROPIC_API_KEY: "sk-test",
				KIMI_API_KEY: "sk-kimi-test",
				GEMINI_API_KEY: "sk-gemini-test",
				UNRELATED_VAR: "nope",
				PATH: "/usr/local/bin:/usr/bin",
				HOME: "/home/paperhanger",
			},
		});

		expect(sidecar.isExternal).toBe(false);
		expect(sidecar.baseUrl).toBe("http://127.0.0.1:8765");

		await sidecar.start();

		expect(capturedCmd).toEqual(["node", "./agent-host/dist/server.mjs"]);
		expect(capturedEnv).toMatchObject({
			PORT: "8765",
			FLUE_MODEL: "anthropic/claude-sonnet-4-6",
			ANTHROPIC_API_KEY: "sk-test",
			KIMI_API_KEY: "sk-kimi-test",
			GEMINI_API_KEY: "sk-gemini-test",
			// `Bun.spawn`'s `env` replaces (not merges with) the child's
			// environment, so PATH/HOME must be explicitly passed through --
			// otherwise the child process cannot resolve `node`/`git` by name.
			PATH: "/usr/local/bin:/usr/bin",
			HOME: "/home/paperhanger",
			GIT_TERMINAL_PROMPT: "0",
		});
		expect(
			capturedEnv?.PAPERHANGER_TELEMETRY &&
				JSON.parse(capturedEnv.PAPERHANGER_TELEMETRY),
		).toEqual({
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
			auth: "user:pass",
		});
		expect(capturedEnv?.UNRELATED_VAR).toBeUndefined();
		expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined();

		await sidecar.stop();
		expect(fake.killCalls).toBe(1);
	});

	test("uses an absolute nodeBinPath when provided, instead of bare `node`", async () => {
		const fake = createFakeProcess();
		let capturedCmd: string[] | undefined;
		const spawn: SpawnFn = (cmd, options) => {
			capturedCmd = cmd;
			void options;
			return fake.process;
		};

		const sidecar = new AgentHostSidecar({
			config: baseConfig({ hostPort: 8765 }),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			serverPath: "./agent-host/dist/server.mjs",
			nodeBinPath: "/usr/bin/node",
			env: { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/paperhanger" },
		});

		await sidecar.start();

		expect(capturedCmd).toEqual([
			"/usr/bin/node",
			"./agent-host/dist/server.mjs",
		]);
	});

	test("omits an unset provider key; serializes telemetry without an auth field when absent", async () => {
		const fake = createFakeProcess();
		let capturedEnv: Record<string, string> | undefined;
		const spawn: SpawnFn = (_cmd, options) => {
			capturedEnv = options.env;
			return fake.process;
		};

		const config = baseConfig();
		config.telemetry = {
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
		};
		const sidecar = new AgentHostSidecar({
			config,
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			env: {},
		});

		await sidecar.start();

		expect(
			capturedEnv?.PAPERHANGER_TELEMETRY &&
				JSON.parse(capturedEnv.PAPERHANGER_TELEMETRY),
		).toEqual({
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
		});
		expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined();

		await sidecar.stop();
	});

	test("omits PAPERHANGER_TELEMETRY entirely when no telemetry is configured at all", async () => {
		const fake = createFakeProcess();
		let capturedEnv: Record<string, string> | undefined;
		const spawn: SpawnFn = (_cmd, options) => {
			capturedEnv = options.env;
			return fake.process;
		};

		const config = baseConfig();
		config.telemetry = undefined;
		const sidecar = new AgentHostSidecar({
			config,
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			env: {},
		});

		await sidecar.start();

		expect(capturedEnv?.PAPERHANGER_TELEMETRY).toBeUndefined();
		expect(capturedEnv).toMatchObject({
			PORT: "8700",
			FLUE_MODEL: "anthropic/claude-sonnet-4-6",
		});

		await sidecar.stop();
	});
});

describe("AgentHostSidecar - readiness", () => {
	test("resolves start() once the health check succeeds", async () => {
		const fake = createFakeProcess();
		const spawn: SpawnFn = () => fake.process;
		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			readinessPollIntervalMs: 1,
		});

		await expect(sidecar.start()).resolves.toBeUndefined();
		await sidecar.stop();
	});

	test("rejects and kills the process when readiness times out", async () => {
		const fake = createFakeProcess();
		const spawn: SpawnFn = () => fake.process;
		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: alwaysFailingFetch(),
			readinessPollIntervalMs: 1,
			readinessTimeoutMs: 20,
		});

		await expect(sidecar.start()).rejects.toThrow(/did not become ready/);
		expect(fake.killCalls).toBe(1);
		await sidecar.stop();
	});

	test("rejects immediately when the process exits before becoming ready", async () => {
		const fake = createFakeProcess();
		const spawn: SpawnFn = () => fake.process;
		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: alwaysFailingFetch(),
			readinessPollIntervalMs: 5,
			readinessTimeoutMs: 5_000,
		});

		const startPromise = sidecar.start();
		fake.resolveExit(1);

		await expect(startPromise).rejects.toThrow(/exited before becoming ready/);
		await sidecar.stop();
	});
});

describe("AgentHostSidecar - crash restart", () => {
	test("respawns after an unexpected exit, using the scheduled backoff delay", async () => {
		const first = createFakeProcess(1);
		const second = createFakeProcess(2);
		const processes = [first, second];
		let spawnCalls = 0;
		const spawn: SpawnFn = () => {
			const next = processes[spawnCalls];
			spawnCalls++;
			if (!next) {
				throw new Error("unexpected extra spawn");
			}
			return next.process;
		};
		const scheduler = createControlledScheduler();

		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			readinessPollIntervalMs: 1,
			restartBaseDelayMs: 5,
			restartMaxDelayMs: 40,
			scheduleRestart: scheduler.scheduleFn,
			cancelScheduledRestart: scheduler.cancelFn,
		});

		await sidecar.start();
		expect(spawnCalls).toBe(1);

		// Simulate an unexpected crash (not via stop()).
		first.resolveExit(1);
		await first.process.exited; // flush the microtask that runs handleExit()

		expect(scheduler.pendingDelays()).toEqual([5]);
		await scheduler.fireNext();

		expect(spawnCalls).toBe(2);

		await sidecar.stop();
		expect(second.killCalls).toBe(1);
	});

	test("does not restart after a graceful stop()", async () => {
		const fake = createFakeProcess();
		let spawnCalls = 0;
		const spawn: SpawnFn = () => {
			spawnCalls++;
			return fake.process;
		};
		const scheduler = createControlledScheduler();

		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			readinessPollIntervalMs: 1,
			restartBaseDelayMs: 5,
			restartMaxDelayMs: 40,
			scheduleRestart: scheduler.scheduleFn,
			cancelScheduledRestart: scheduler.cancelFn,
		});

		await sidecar.start();
		expect(spawnCalls).toBe(1);

		const stopPromise = sidecar.stop();
		fake.resolveExit(0);
		await stopPromise;

		// A graceful exit must never schedule a restart at all.
		expect(scheduler.pendingDelays()).toEqual([]);
		expect(spawnCalls).toBe(1);
	});

	test("doubles the restart backoff on each consecutive fast crash, capped at restartMaxDelayMs", async () => {
		const processes = [
			createFakeProcess(1),
			createFakeProcess(2),
			createFakeProcess(3),
			createFakeProcess(4),
		];
		let spawnCalls = 0;
		const spawn: SpawnFn = () => {
			const next = processes[spawnCalls];
			spawnCalls++;
			if (!next) {
				throw new Error("unexpected extra spawn");
			}
			return next.process;
		};
		const scheduler = createControlledScheduler();
		let currentTime = 1_000_000;

		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			readinessPollIntervalMs: 1,
			restartBaseDelayMs: 100,
			restartMaxDelayMs: 800,
			scheduleRestart: scheduler.scheduleFn,
			cancelScheduledRestart: scheduler.cancelFn,
			now: () => currentTime,
		});

		await sidecar.start();
		expect(spawnCalls).toBe(1);

		// Four consecutive crashes, each shortly (10ms) after its spawn -- well
		// under restartMaxDelayMs, so none of them resets the backoff.
		const expectedDelays = [100, 200, 400, 800];
		for (const [i, expectedDelay] of expectedDelays.entries()) {
			const current = processes[i];
			if (!current) {
				throw new Error("missing fake process");
			}
			currentTime += 10;
			current.resolveExit(1);
			await current.process.exited;

			expect(scheduler.pendingDelays()).toEqual([expectedDelay]);
			await scheduler.fireNext();
			expect(spawnCalls).toBe(i + 2);
		}

		await sidecar.stop();
	});

	test("resets the backoff to the base delay after a long uptime", async () => {
		const processes = [
			createFakeProcess(1),
			createFakeProcess(2),
			createFakeProcess(3),
		];
		let spawnCalls = 0;
		const spawn: SpawnFn = () => {
			const next = processes[spawnCalls];
			spawnCalls++;
			if (!next) {
				throw new Error("unexpected extra spawn");
			}
			return next.process;
		};
		const scheduler = createControlledScheduler();
		let currentTime = 1_000_000;

		const sidecar = new AgentHostSidecar({
			config: baseConfig(),
			logger: silentLogger(),
			spawn,
			fetchImpl: okFetch(),
			readinessPollIntervalMs: 1,
			restartBaseDelayMs: 100,
			restartMaxDelayMs: 800,
			scheduleRestart: scheduler.scheduleFn,
			cancelScheduledRestart: scheduler.cancelFn,
			now: () => currentTime,
		});

		await sidecar.start(); // spawns process 1 at currentTime
		expect(spawnCalls).toBe(1);

		// First crash after a short uptime: schedules the base delay (100) and
		// doubles the running counter to 200 for next time.
		const first = processes[0];
		if (!first) {
			throw new Error("missing fake process");
		}
		currentTime += 10;
		first.resolveExit(1);
		await first.process.exited;
		expect(scheduler.pendingDelays()).toEqual([100]);
		await scheduler.fireNext();
		expect(spawnCalls).toBe(2);

		// Second crash after a *long* uptime (> restartMaxDelayMs): the running
		// backoff counter must reset to the base delay instead of doubling to 200.
		const second = processes[1];
		if (!second) {
			throw new Error("missing fake process");
		}
		currentTime += 5_000;
		second.resolveExit(1);
		await second.process.exited;
		expect(scheduler.pendingDelays()).toEqual([100]);
		await scheduler.fireNext();
		expect(spawnCalls).toBe(3);

		await sidecar.stop();
	});
});
