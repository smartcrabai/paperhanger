/**
 * Supervises the Flue agent-host (see docs/architecture.md "Flue agent host
 * (Node sidecar)" and docs/research/flue.md section 10 for why it must run
 * under Node rather than Bun).
 *
 * Two modes, selected by `config.agent.hostUrl`:
 *
 * - **External**: a URL is configured. `start()`/`stop()` are no-ops; `baseUrl`
 *   just exposes the configured URL. Nothing is spawned.
 * - **Internal** (default): spawns `node <serverPath>` (the `flue build
 *   --target node` output), waits for its `/healthz` route to respond, and
 *   restarts it with capped exponential backoff if it exits before `stop()`
 *   is called. `start()` rejects if the *initial* spawn does not become ready
 *   within `readinessTimeoutMs`, but the crash-restart supervision registered
 *   during that attempt keeps retrying in the background regardless — the
 *   caller decides how to react to a slow/failed initial start (log and keep
 *   serving webhooks vs. exit), while the sidecar keeps trying to recover.
 */

import type { Logger } from "../observability/logger";

/** Structural subset of `Bun.Subprocess` this module depends on. */
export interface SidecarProcess {
	readonly pid: number;
	readonly exited: Promise<number>;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	kill(signal?: number | NodeJS.Signals): void;
}

export type SpawnFn = (
	cmd: string[],
	options: { env: Record<string, string> },
) => SidecarProcess;

/**
 * Minimal callable subset of the global `fetch`, used instead of `typeof
 * fetch` so a plain test fake (which lacks `fetch`'s `preconnect` static
 * property) can be assigned without an unsound cast.
 */
export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** Narrow config slice this module needs; keeps it decoupled from the full `Config`. */
export interface AgentHostSidecarConfig {
	agent: {
		/** External agent-host URL. When set, nothing is spawned. */
		hostUrl?: string;
		/** Port the spawned server listens on (internal mode only). */
		hostPort: number;
		/** Flue model identifier, passed through as `FLUE_MODEL`. */
		model: string;
	};
	/**
	 * Omitted when no telemetry backend is configured; the `query_telemetry`
	 * tool is then unavailable to the agent (see agent-host/README.md).
	 * `source`-discriminated union mirroring `src/config/schema.ts`'s
	 * `TelemetryConfig` -- `greptimedb` is the only member today.
	 */
	telemetry?: {
		source: "greptimedb";
		url: string;
		database: string;
		auth?: string;
	};
}

/**
 * Schedules `callback` to run after `delayMs`, returning an opaque handle
 * `CancelScheduleFn` can later cancel. Used for restart backoff so tests can
 * inject deterministic, immediately-firable scheduling instead of asserting
 * on wall-clock sleeps.
 */
export type ScheduleFn = (
	callback: () => Promise<void>,
	delayMs: number,
) => unknown;

/** Cancels a handle previously returned by a `ScheduleFn`. */
export type CancelScheduleFn = (handle: unknown) => void;

const defaultScheduleFn: ScheduleFn = (callback, delayMs) =>
	setTimeout(() => {
		void callback();
	}, delayMs);

const defaultCancelScheduleFn: CancelScheduleFn = (handle) =>
	clearTimeout(handle as ReturnType<typeof setTimeout>);

export interface AgentHostSidecarOptions {
	config: AgentHostSidecarConfig;
	logger: Logger;
	/** Path to the built agent-host Node server entrypoint (`flue build --target node` output). */
	serverPath?: string;
	/** Injectable for tests; defaults to a thin `Bun.spawn` wrapper. */
	spawn?: SpawnFn;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: FetchLike;
	/** Source of provider API keys / other passthrough env vars. Defaults to `Bun.env`. */
	env?: Record<string, string | undefined>;
	/** Milliseconds between readiness polls. */
	readinessPollIntervalMs?: number;
	/** Total time to wait for the server to become ready before `start()` rejects. */
	readinessTimeoutMs?: number;
	/** Initial restart backoff delay, in milliseconds. */
	restartBaseDelayMs?: number;
	/** Restart backoff cap, in milliseconds. */
	restartMaxDelayMs?: number;
	/** Injectable for tests; defaults to a `setTimeout`-backed scheduler. Used for restart-backoff scheduling only (readiness polling still uses `Bun.sleep`). */
	scheduleRestart?: ScheduleFn;
	/** Pairs with `scheduleRestart`; defaults to `clearTimeout`. */
	cancelScheduledRestart?: CancelScheduleFn;
	/** Injectable clock for crash-uptime bookkeeping; defaults to `Date.now`. */
	now?: () => number;
}

const DEFAULT_SERVER_PATH = "./agent-host/dist/server.mjs";
const DEFAULT_READINESS_POLL_INTERVAL_MS = 250;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;

/** Provider API key env vars passed through to the agent-host child, when set. */
const PROVIDER_API_KEY_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"KIMI_API_KEY",
] as const;

/**
 * Host env vars passed through verbatim to the agent-host child process, when
 * set. `Bun.spawn`'s `env` option *replaces* the child's environment rather
 * than merging with the current process's, so without this the child would
 * have no `PATH` at all and fail to resolve `node`, `git`, or any repo-local
 * build/test toolchain by name.
 */
const PASSTHROUGH_ENV_VARS = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
] as const;

function defaultSpawn(
	cmd: string[],
	options: { env: Record<string, string> },
): SidecarProcess {
	return Bun.spawn(cmd, {
		env: options.env,
		stdout: "pipe",
		stderr: "pipe",
	});
}

/** Reads a child stream line-by-line, invoking `onLine` for each complete line. Never throws. */
async function pumpLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => void,
): Promise<void> {
	if (!stream) {
		return;
	}
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk as Uint8Array, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.length > 0) {
					onLine(line);
				}
			}
		}
	} catch {
		// Stream torn down (process killed mid-read); nothing more to log.
	}
	if (buffer.length > 0) {
		onLine(buffer);
	}
}

export class AgentHostSidecar {
	readonly baseUrl: string;
	private readonly mode: "external" | "internal";
	private readonly logger: Logger;
	private readonly serverPath: string;
	private readonly spawnFn: SpawnFn;
	private readonly fetchImpl: FetchLike;
	private readonly readinessPollIntervalMs: number;
	private readonly readinessTimeoutMs: number;
	private readonly restartBaseDelayMs: number;
	private readonly restartMaxDelayMs: number;
	private readonly spawnEnv: Record<string, string>;
	private readonly scheduleFn: ScheduleFn;
	private readonly cancelScheduleFn: CancelScheduleFn;
	private readonly now: () => number;

	private process: SidecarProcess | undefined;
	private stopping = false;
	private restartDelayMs: number;
	private restartTimerHandle: unknown;

	constructor(options: AgentHostSidecarOptions) {
		const { config } = options;
		this.logger = options.logger.child({ component: "agent-host-sidecar" });
		this.serverPath = options.serverPath ?? DEFAULT_SERVER_PATH;
		this.spawnFn = options.spawn ?? defaultSpawn;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.readinessPollIntervalMs =
			options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS;
		this.readinessTimeoutMs =
			options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
		this.restartBaseDelayMs =
			options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
		this.restartMaxDelayMs =
			options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
		this.restartDelayMs = this.restartBaseDelayMs;
		this.scheduleFn = options.scheduleRestart ?? defaultScheduleFn;
		this.cancelScheduleFn =
			options.cancelScheduledRestart ?? defaultCancelScheduleFn;
		this.now = options.now ?? Date.now;

		if (config.agent.hostUrl) {
			this.mode = "external";
			this.baseUrl = config.agent.hostUrl.replace(/\/+$/, "");
		} else {
			this.mode = "internal";
			this.baseUrl = `http://127.0.0.1:${config.agent.hostPort}`;
		}

		this.spawnEnv = buildSpawnEnv(config, options.env ?? Bun.env);
	}

	/** Whether this sidecar spawns a child process ("internal") or only points at an external URL. */
	get isExternal(): boolean {
		return this.mode === "external";
	}

	async start(): Promise<void> {
		if (this.mode === "external") {
			this.logger.info("sidecar.external_mode", { baseUrl: this.baseUrl });
			return;
		}
		this.stopping = false;
		await this.spawnAndWaitForReadiness();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.restartTimerHandle !== undefined) {
			this.cancelScheduleFn(this.restartTimerHandle);
			this.restartTimerHandle = undefined;
		}
		const child = this.process;
		if (!child) {
			return;
		}
		this.logger.info("sidecar.stop", { pid: child.pid });
		child.kill();
		await child.exited;
		this.process = undefined;
	}

	private async spawnAndWaitForReadiness(): Promise<void> {
		const startedAt = this.now();
		const child = this.spawnFn(["node", this.serverPath], {
			env: this.spawnEnv,
		});
		this.process = child;
		this.logger.info("sidecar.spawn", {
			pid: child.pid,
			serverPath: this.serverPath,
		});

		void pumpLines(child.stdout, (line) =>
			this.logger.info("sidecar.stdout", { line }),
		);
		void pumpLines(child.stderr, (line) =>
			this.logger.warn("sidecar.stderr", { line }),
		);

		void child.exited.then((code) => this.handleExit(child, code, startedAt));

		await this.waitForReady(child);
	}

	private async waitForReady(child: SidecarProcess): Promise<void> {
		let exited = false;
		void child.exited.then(() => {
			exited = true;
		});

		const deadline = this.now() + this.readinessTimeoutMs;
		while (this.now() < deadline) {
			if (exited) {
				throw new Error(
					`agent-host process exited before becoming ready (pid ${child.pid})`,
				);
			}
			try {
				const res = await this.fetchImpl(`${this.baseUrl}/healthz`);
				if (res.ok) {
					this.logger.info("sidecar.ready", { baseUrl: this.baseUrl });
					return;
				}
			} catch {
				// Not accepting connections yet; keep polling.
			}
			await Bun.sleep(this.readinessPollIntervalMs);
		}

		// Timed out without the process ever exiting on its own: it may be
		// wedged, so tear it down rather than leaving an orphaned process
		// behind (its `exited` handler still fires and schedules a restart).
		if (!exited) {
			child.kill();
		}
		throw new Error(
			`agent-host did not become ready within ${this.readinessTimeoutMs}ms`,
		);
	}

	private handleExit(
		child: SidecarProcess,
		code: number,
		startedAt: number,
	): void {
		if (this.process === child) {
			this.process = undefined;
		}
		if (this.stopping) {
			this.logger.info("sidecar.exited", { code, expected: true });
			return;
		}
		this.logger.error("sidecar.crashed", { code, pid: child.pid });

		const uptimeMs = this.now() - startedAt;
		// A process that ran for a while before crashing earns a fresh
		// backoff; one that crash-loops immediately keeps climbing toward the
		// cap so we don't hammer a permanently broken agent-host.
		if (uptimeMs > this.restartMaxDelayMs) {
			this.restartDelayMs = this.restartBaseDelayMs;
		}
		const delay = this.restartDelayMs;
		this.restartDelayMs = Math.min(
			this.restartDelayMs * 2,
			this.restartMaxDelayMs,
		);

		this.logger.info("sidecar.restart_scheduled", { delayMs: delay });
		this.restartTimerHandle = this.scheduleFn(async () => {
			this.restartTimerHandle = undefined;
			try {
				await this.spawnAndWaitForReadiness();
			} catch (err) {
				this.logger.error("sidecar.restart_failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}, delay);
	}
}

function buildSpawnEnv(
	config: AgentHostSidecarConfig,
	sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
	const env: Record<string, string> = {
		PORT: String(config.agent.hostPort),
		FLUE_MODEL: config.agent.model,
		// Never hang the sandboxed git commands (clone/push) on an interactive
		// credential prompt; the installation token is always embedded in the
		// clone URL itself (see repo/github.ts `cloneUrlWithToken`).
		GIT_TERMINAL_PROMPT: "0",
	};
	for (const key of PASSTHROUGH_ENV_VARS) {
		const value = sourceEnv[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const key of PROVIDER_API_KEY_ENV_VARS) {
		const value = sourceEnv[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	if (config.telemetry) {
		// A single serialized JSON env var carries the whole telemetry config,
		// rather than one bespoke env var per field (the previous GREPTIMEDB_*
		// vars): agent-host/src/tools.ts parses this and dispatches on
		// `source`, so adding a future telemetry backend never requires adding
		// more env var plumbing here.
		env.PAPERHANGER_TELEMETRY = JSON.stringify(config.telemetry);
	}
	return env;
}
