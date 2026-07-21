/**
 * Self-instrumentation: OpenTelemetry tracer provider setup for paperhanger's
 * own traces. Distinct from `src/telemetry/*`, which is where paperhanger
 * READS other services' telemetry from (GreptimeDB).
 *
 * Signal scope: traces only. No OTel logs export, no metrics -- see
 * `src/observability/logger.ts` for the trace/span correlation fields added
 * to paperhanger's existing structured JSON logs instead.
 */

import {
	context,
	type DiagLogFunction,
	type DiagLogger,
	DiagLogLevel,
	diag,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ObservabilityConfig } from "../config/schema";
import type { Logger } from "./logger";

/** Hard cap on flush+shutdown so process shutdown stays bounded even against an unreachable OTLP endpoint. */
const TRACING_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Per-request timeout for the OTLP exporter itself. The exporter's own
 * default (`timeoutMillis`, ~10s) exceeds `TRACING_SHUTDOWN_TIMEOUT_MS`: an
 * endpoint that accepts the connection but never responds would then have
 * its `forceFlush()` call still in flight when the shutdown race times out,
 * so `provider.shutdown()` below never even gets a chance to run inside the
 * budget. Keeping this comfortably under the shutdown deadline (with margin
 * left for `provider.shutdown()` itself to complete) ensures the exporter
 * gives up on its own before the outer race does.
 */
const OTLP_EXPORTER_TIMEOUT_MS = 4_000;

export interface Tracing {
	/** Tracer scoped to one component (mirrors `logger.child({ component })`). */
	getTracer(component: string): Tracer;
	/** Flushes pending spans and shuts the provider down. Never rejects. */
	shutdown(): Promise<void>;
}

/** Adapts an OTel DiagLogger onto the injected structured Logger, so OTel-internal warnings/errors (e.g. BatchSpanProcessor queue drops, exporter failures) surface in paperhanger's own JSON logs instead of vanishing into OTel's silent diag channel. */
function createDiagLoggerAdapter(logger: Logger): DiagLogger {
	const noop: DiagLogFunction = () => {};
	return {
		error: (message, ...args) => logger.error(message, { args }),
		warn: (message, ...args) => logger.warn(message, { args }),
		info: noop,
		debug: noop,
		verbose: noop,
	};
}

async function withTimeout(
	work: Promise<void>,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			onTimeout();
			resolve();
		}, timeoutMs);
	});
	try {
		await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Builds paperhanger's self-instrumentation tracer provider.
 *
 * `config === undefined` disables tracing: `getTracer` returns the
 * `@opentelemetry/api` no-op tracer (no global provider is ever registered,
 * so `trace.getTracer` is a safe no-op) and `shutdown` resolves immediately.
 * No context manager is registered in this path.
 *
 * @param options.shutdownTimeoutMs Overrides `TRACING_SHUTDOWN_TIMEOUT_MS`.
 * Primarily for tests that need to observe the timeout/failure paths of
 * `shutdown()` deterministically without waiting out the real 5s deadline.
 */
export function createTracing(
	config: ObservabilityConfig | undefined,
	logger: Logger,
	options?: { shutdownTimeoutMs?: number },
): Tracing {
	if (config === undefined) {
		return {
			getTracer: (component: string) => trace.getTracer(component),
			shutdown: async () => {},
		};
	}

	diag.setLogger(createDiagLoggerAdapter(logger), DiagLogLevel.WARN);

	// Register the global context manager exactly once per process. This is
	// the one documented exception to the no-global-singletons DI rule (see
	// docs/architecture.md "Dependency injection"): context propagation across
	// `await` boundaries has no non-global mechanism in the OTel API surface.
	//
	// IMPORTANT: this MUST be AsyncLocalStorageContextManager, not the
	// AsyncHooksContextManager used by tests/integration/helpers/otlp-seed.ts.
	// Empirically verified on this repo's Bun 1.3.14: AsyncHooksContextManager
	// loses the active context after any `await` (raw async_hooks is not fully
	// wired in Bun; the class is also deprecated upstream), while
	// AsyncLocalStorageContextManager propagates correctly across awaited
	// macrotasks. The seed helper never awaits inside `context.with` so it
	// never hit this. See the MANDATORY regression test below.
	const registered = context.setGlobalContextManager(
		new AsyncLocalStorageContextManager().enable(),
	);
	if (!registered) {
		logger.warn("tracing.context_manager_already_registered", {});
	}

	const shutdownTimeoutMs =
		options?.shutdownTimeoutMs ?? TRACING_SHUTDOWN_TIMEOUT_MS;

	const exporter = new OTLPTraceExporter({
		url: config.endpoint,
		headers: config.headers,
		// See OTLP_EXPORTER_TIMEOUT_MS above: keeps the exporter's own per-export
		// timeout inside the shutdown budget.
		timeoutMillis: OTLP_EXPORTER_TIMEOUT_MS,
	});
	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes({ "service.name": config.serviceName }),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	});

	// The provider is deliberately never installed as the global tracer
	// provider (no `trace.setGlobalTracerProvider` call) -- components only
	// ever receive a `Tracer` via constructor/factory injection, per
	// docs/architecture.md's DI rule. The context manager above is the sole
	// accepted exception to that rule.

	return {
		getTracer: (component: string) => provider.getTracer(component),
		shutdown: async () => {
			await withTimeout(
				(async () => {
					try {
						await provider.forceFlush();
					} catch (error) {
						logger.error("tracing.shutdown_failed", { error });
					}
					try {
						await provider.shutdown();
					} catch (error) {
						logger.error("tracing.shutdown_failed", { error });
					}
				})(),
				shutdownTimeoutMs,
				() => {
					logger.warn("tracing.shutdown_timeout", {
						timeoutMs: shutdownTimeoutMs,
					});
				},
			);
		},
	};
}
