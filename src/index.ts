/**
 * Composition root: loads config, wires dependencies, and starts the ingest
 * server. This is the only place allowed to construct concrete
 * implementations directly (see docs/architecture.md "Dependency injection").
 *
 * Wiring order (docs/spec.md section 2, docs/architecture.md):
 *
 *   config -> tracing (self-instrumentation, see src/observability/tracing.ts)
 *   -> store -> [telemetry source, if configured] -> GitHub App client
 *   -> repo resolver -> agent-host sidecar -> fix agent runner
 *   -> notifiers -> incident pipeline -> incident manager -> ingest server
 */

import type { Tracer } from "@opentelemetry/api";
import { FixAgentRunner } from "./agent/runner";
import { AgentHostSidecar } from "./agent/sidecar";
import { loadConfig } from "./config/load";
import type { Config, NotifierConfig } from "./config/schema";
import { IncidentManager } from "./core/incident-manager";
import { IncidentPipeline } from "./core/pipeline";
import { waitForDrain } from "./core/shutdown";
// The composition root is the only file allowed to import a `.html` bundle
// (see src/ingest/server.ts's `ServerDeps.htmlRoutes` doc comment) -- keeps
// server.ts, and its unit tests, free of a bundler dependency.
import dashboard from "./dashboard/index.html";
import { alertmanagerAdapter } from "./ingest/adapters/alertmanager";
import { genericAdapter } from "./ingest/adapters/generic";
import { grafanaAdapter } from "./ingest/adapters/grafana";
import { createServer } from "./ingest/server";
import { createLogger } from "./observability/logger";
import type { Logger } from "./observability/logger";
import { createTracing } from "./observability/tracing";
import { DiscordNotifier } from "./notify/discord";
import { SlackNotifier } from "./notify/slack";
import { CompositeNotifier, type Notifier } from "./notify/types";
import { WebhookNotifier } from "./notify/webhook";
import { GitHubAppClient } from "./repo/github";
import { RepoResolver } from "./repo/resolver";
import { PostgresIncidentStore } from "./storage/postgres";
import { SqliteIncidentStore } from "./storage/sqlite";
import type { IncidentStore, RepoDefinitionStore } from "./storage/types";
import { createTelemetrySource } from "./telemetry/factory";
import type { TelemetrySource } from "./telemetry/types";

/** Best-effort bound on how long shutdown waits for in-flight incidents to finish. */
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

const logger = createLogger({ fields: { component: "paperhanger" } });

function buildStore(config: Config): IncidentStore & RepoDefinitionStore {
	if (config.storage.driver === "postgres") {
		return new PostgresIncidentStore(config.storage.url);
	}
	return new SqliteIncidentStore(config.storage.path);
}

function buildNotifier(
	config: NotifierConfig,
	log: Logger,
	tracer: Tracer,
): Notifier {
	switch (config.type) {
		case "slack":
			return new SlackNotifier(config, log, { tracer });
		case "discord":
			return new DiscordNotifier(config, log, { tracer });
		case "webhook":
			return new WebhookNotifier(config, log, { tracer });
	}
}

async function main(): Promise<void> {
	const config = await loadConfig();

	// Registers the global context manager (when tracing is enabled) before
	// any component is constructed, so every span created below propagates
	// context correctly. See docs/architecture.md "Dependency injection" for
	// why the context manager is the sole accepted exception to the
	// no-globals DI rule.
	const tracing = createTracing(
		config.observability,
		logger.child({ component: "tracing" }),
	);

	const store = buildStore(config);
	await store.init();

	const telemetrySource: TelemetrySource | undefined = config.telemetry
		? createTelemetrySource(
				config.telemetry,
				logger.child({ component: `telemetry-${config.telemetry.source}` }),
				tracing.getTracer(`telemetry-${config.telemetry.source}`),
			)
		: undefined;

	const github = new GitHubAppClient(
		{ appId: config.github.appId, privateKey: config.github.privateKey },
		logger.child({ component: "github-app-client" }),
		undefined,
		tracing.getTracer("github-app-client"),
	);

	const resolver = new RepoResolver(
		config.repos,
		github,
		logger.child({ component: "repo-resolver" }),
		store,
	);

	// `AgentHostSidecar` handles both modes itself: `start()` spawns the Node
	// child process in the default (internal) mode, and is a no-op when
	// `agent.hostUrl` points at an externally deployed agent-host instead.
	const sidecar = new AgentHostSidecar({
		config,
		logger: logger.child({ component: "agent-host-sidecar" }),
		serverPath: Bun.env.AGENT_HOST_SERVER_PATH,
		nodeBinPath: Bun.env.AGENT_HOST_NODE_PATH,
	});
	try {
		await sidecar.start();
	} catch (err) {
		// Non-fatal: the sidecar's own crash-restart supervision keeps retrying
		// in the background (see sidecar.ts), so webhooks/telemetry collection
		// still work even while the fix agent itself is unavailable.
		logger.error("sidecar.start_failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const agentRunner = new FixAgentRunner({
		flue: { baseUrl: sidecar.baseUrl },
		github,
		store,
		repoDefinitions: store,
		config,
		logger: logger.child({ component: "fix-agent-runner" }),
		tracer: tracing.getTracer("fix-agent-runner"),
	});

	const notifyTracer = tracing.getTracer("notify");
	const notifier = new CompositeNotifier(
		config.notifiers.map((n) =>
			buildNotifier(n, logger.child({ component: "notify" }), notifyTracer),
		),
		logger.child({ component: "notify" }),
	);

	const pipeline = new IncidentPipeline({
		store,
		telemetrySource,
		resolver,
		github,
		agentRunner,
		notifier,
		config,
		logger: logger.child({ component: "incident-pipeline" }),
		tracer: tracing.getTracer("incident-pipeline"),
	});

	const manager = new IncidentManager({
		store,
		logger: logger.child({ component: "incident-manager" }),
		config,
		processor: pipeline,
		notifier,
	});

	// Re-enqueue any incident left mid-pipeline by a crash/restart, before the
	// server starts accepting webhooks (see `IncidentManager.recoverOpenIncidents`).
	await manager.recoverOpenIncidents();

	const adapters = {
		[grafanaAdapter.name]: grafanaAdapter,
		[genericAdapter.name]: genericAdapter,
		[alertmanagerAdapter.name]: alertmanagerAdapter,
	};

	const server = createServer({
		config,
		logger: logger.child({ component: "server" }),
		manager,
		adapters,
		store,
		repoDefinitions: store,
		tracer: tracing.getTracer("server"),
		htmlRoutes: { "/": dashboard, "/dashboard": dashboard },
	});

	logger.info("startup", {
		port: server.port,
		storageDriver: config.storage.driver,
		telemetryConfigured: telemetrySource !== undefined,
		agentHostMode: sidecar.isExternal ? "external" : "internal",
		notifierCount: config.notifiers.length,
		tracingEnabled: config.observability !== undefined,
	});

	let shuttingDown = false;
	async function shutdown(signal: string): Promise<void> {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.info("shutdown.start", { signal });

		server.stop();
		logger.info("shutdown.server_stopped", {});

		await waitForDrain(
			() => manager.pendingCount,
			DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
			logger,
		);

		await sidecar.stop();
		logger.info("shutdown.sidecar_stopped", {});

		await tracing.shutdown();
		logger.info("shutdown.tracing_stopped", {});

		await store.close();
		logger.info("shutdown.complete", { signal });
		process.exit(0);
	}

	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
}

main().catch((err) => {
	logger.error("startup.failed", {
		error: err instanceof Error ? err.message : String(err),
	});
	process.exit(1);
});
