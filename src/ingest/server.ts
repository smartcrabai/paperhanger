/**
 * HTTP ingest server. Routes: POST /webhooks/:source, GET /healthz, GET
 * /readyz, GET /incidents, GET /incidents/:id, GET /incidents/:id/events, plus
 * the dashboard's repo-definition CRUD routes (GET/POST /repo-definitions,
 * GET/PUT/DELETE /repo-definitions/:id -- see ./repo-definitions.ts). See
 * docs/spec.md section 3.1 and docs/architecture.md "Webhook authentication".
 *
 * `GET /incidents`, `GET /incidents/:id`, `GET /incidents/:id/events`, and
 * every `/repo-definitions` route additionally require `server.apiToken`
 * (Authorization: Bearer or X-Api-Token, constant-time compare via
 * `safeCompare`) since this data can carry sensitive diagnosis/failureReason
 * text or infrastructure setup scripts. Secure by default: when
 * `server.apiToken` is not configured, those endpoints refuse every request
 * with 401 rather than serving that data with no authentication at all.
 * `/healthz` and `/readyz` are never gated.
 */

import type { Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { IncidentManager } from "../core/incident-manager";
import type { IncidentEvent } from "../core/types";
import type { Logger } from "../observability/logger";
import type { IncidentStore, RepoDefinitionStore } from "../storage/types";
import type { SourceAdapter } from "./adapters/types";
import {
	handleCreateRepoDefinition,
	handleDeleteRepoDefinition,
	handleGetRepoDefinition,
	handleListRepoDefinitions,
	handleUpdateRepoDefinition,
} from "./repo-definitions";

const WEBHOOK_PATH_PREFIX = "/webhooks/";
const INCIDENTS_PATH_PREFIX = "/incidents/";
const INCIDENT_EVENTS_SUFFIX = "/events";
const REPO_DEFINITIONS_PATH = "/repo-definitions";
const REPO_DEFINITIONS_PATH_PREFIX = "/repo-definitions/";
/** Cap on `GET /incidents` regardless of what a caller asks for via `?limit=`. */
const MAX_INCIDENTS_LIST_LIMIT = 500;
const DEFAULT_INCIDENTS_LIST_LIMIT = 100;

export interface ServerConfig {
	server: { port: number; apiToken?: string };
	sources: Record<string, { secret: string }>;
}

export interface ServerDeps {
	config: ServerConfig;
	logger: Logger;
	manager: IncidentManager;
	/** Keyed by source name, e.g. "grafana", "generic". */
	adapters: Record<string, SourceAdapter>;
	store: Pick<
		IncidentStore,
		"ping" | "getIncident" | "listIncidents" | "listEvents"
	>;
	/**
	 * Backs the dashboard's repo-definition CRUD routes (see
	 * ./repo-definitions.ts). A separate field rather than folded into
	 * `store`'s Pick above, so that Pick stays an honest, narrow slice of
	 * `IncidentStore`.
	 */
	repoDefinitions: RepoDefinitionStore;
	/** Falls back to a no-op tracer (no global provider registered) when omitted. See docs/spec.md section 3.9. */
	tracer?: Tracer;
	/**
	 * Bun HTML-bundle routes (e.g. `{ "/dashboard": dashboardHtmlImport }`),
	 * passed straight through to `Bun.serve`'s `routes` option below -- Bun
	 * serves these ahead of the `fetch` fallback. Kept as an opaque,
	 * already-bundled value rather than an `.html` import in this file, so
	 * this module (and its unit tests) never need a bundler pass; the
	 * composition root (`src/index.ts`) is the only place that imports
	 * `.html`.
	 */
	htmlRoutes?: Record<string, Bun.HTMLBundle>;
}

/** `http.route` template values this server ever dispatches to (design section 6). */
type RouteTemplate =
	| "/healthz"
	| "/readyz"
	| "/webhooks/:source"
	| "/incidents"
	| "/incidents/:id"
	| "/incidents/:id/events"
	| "/repo-definitions"
	| "/repo-definitions/:id"
	| "unmatched";

/**
 * Extracts `:id` from a `/incidents/:id/events` path, or `undefined` if
 * `pathname` isn't that shape. Shared by `route()` and `deriveRouteTemplate()`
 * so the two never drift.
 */
function incidentEventsIdFromPath(pathname: string): string | undefined {
	if (
		!pathname.startsWith(INCIDENTS_PATH_PREFIX) ||
		!pathname.endsWith(INCIDENT_EVENTS_SUFFIX)
	) {
		return undefined;
	}
	const id = pathname.slice(
		INCIDENTS_PATH_PREFIX.length,
		pathname.length - INCIDENT_EVENTS_SUFFIX.length,
	);
	return id.length > 0 ? id : undefined;
}

/**
 * Extracts `:id` from a `/repo-definitions/:id` path, or `undefined` if
 * `pathname` isn't that shape. Shared by `route()` and `deriveRouteTemplate()`
 * so the two never drift.
 */
function repoDefinitionIdFromPath(pathname: string): string | undefined {
	if (!pathname.startsWith(REPO_DEFINITIONS_PATH_PREFIX)) {
		return undefined;
	}
	const id = pathname.slice(REPO_DEFINITIONS_PATH_PREFIX.length);
	return id.length > 0 ? id : undefined;
}

/**
 * Derives the `http.route` template for a request's path, mirroring the path
 * checks in `route()` below (independent of method — a template describes the
 * URL shape, and `route()` itself decides per-method whether it actually
 * matches or falls through to "not found").
 */
function deriveRouteTemplate(url: URL): RouteTemplate {
	if (url.pathname === "/healthz") {
		return "/healthz";
	}
	if (url.pathname === "/readyz") {
		return "/readyz";
	}
	if (url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
		return "/webhooks/:source";
	}
	if (url.pathname === REPO_DEFINITIONS_PATH) {
		return "/repo-definitions";
	}
	if (repoDefinitionIdFromPath(url.pathname) !== undefined) {
		return "/repo-definitions/:id";
	}
	if (incidentEventsIdFromPath(url.pathname) !== undefined) {
		return "/incidents/:id/events";
	}
	if (url.pathname === "/incidents") {
		return "/incidents";
	}
	if (
		url.pathname.startsWith(INCIDENTS_PATH_PREFIX) &&
		url.pathname.length > INCIDENTS_PATH_PREFIX.length
	) {
		return "/incidents/:id";
	}
	return "unmatched";
}

/** Parses the `?limit=` query param for `GET /incidents`; falls back/clamps to sane bounds on bad input. */
export function parseListLimit(url: URL): number {
	const raw = url.searchParams.get("limit");
	if (!raw) {
		return DEFAULT_INCIDENTS_LIST_LIMIT;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_INCIDENTS_LIST_LIMIT;
	}
	return Math.min(parsed, MAX_INCIDENTS_LIST_LIMIT);
}

/**
 * Constant-time-ish string comparison: bails out early only on length
 * mismatch (which is not sensitive), then compares every byte regardless of
 * where a difference occurs.
 */
function safeCompare(a: string, b: string): boolean {
	const aBytes = new TextEncoder().encode(a);
	const bBytes = new TextEncoder().encode(b);
	if (aBytes.length !== bBytes.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
	}
	return diff === 0;
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/** Extracts an API token from `Authorization: Bearer <token>` or `X-Api-Token: <token>`. */
function extractApiToken(req: Request): string | undefined {
	const authHeader = req.headers.get("authorization");
	if (authHeader) {
		const match = BEARER_PATTERN.exec(authHeader);
		if (match?.[1]) {
			return match[1];
		}
	}
	return req.headers.get("x-api-token") ?? undefined;
}

const UNCONFIGURED_API_TOKEN_MESSAGE =
	"unauthorized: server.apiToken is not configured; incident data is not served without it. Set server.apiToken (see paperhanger.example.yaml) to enable GET /incidents access.";

/**
 * Guards every data route: `GET /incidents`, `GET /incidents/:id`, `GET
 * /incidents/:id/events`, and the `/repo-definitions` routes. Returns a 401
 * `Response` when the request should be rejected, or `undefined` when it may
 * proceed. Secure by default: an unconfigured `server.apiToken` rejects
 * every request rather than serving that data unauthenticated.
 */
function checkApiToken(
	config: ServerConfig,
	req: Request,
): Response | undefined {
	const configuredToken = config.server.apiToken;
	if (!configuredToken) {
		return new Response(UNCONFIGURED_API_TOKEN_MESSAGE, { status: 401 });
	}
	const provided = extractApiToken(req);
	if (!provided || !safeCompare(provided, configuredToken)) {
		return new Response("unauthorized", { status: 401 });
	}
	return undefined;
}

export function createServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
	const {
		config,
		logger,
		manager,
		adapters,
		store,
		repoDefinitions,
		htmlRoutes,
	} = deps;
	const tracer = deps.tracer ?? trace.getTracer("server");

	async function handleWebhook(
		req: Request,
		url: URL,
		source: string,
	): Promise<Response> {
		const sourceConfig = config.sources[source];
		const adapter = adapters[source];
		if (!sourceConfig || !adapter) {
			return new Response("unknown source", { status: 404 });
		}

		const token =
			req.headers.get("x-webhook-token") ?? url.searchParams.get("token") ?? "";
		if (!token || !safeCompare(token, sourceConfig.secret)) {
			return new Response("unauthorized", { status: 401 });
		}

		let events: IncidentEvent[];
		try {
			events = await adapter.parse(req);
		} catch (err) {
			logger.warn("webhook.parse_failed", {
				source,
				error: (err as Error).message,
			});
			return new Response("invalid payload", { status: 400 });
		}

		// Enrich the active SERVER span (created in the `fetch` handler below)
		// rather than starting a child span — the design's v1 correlates
		// webhook handling with the request span via attributes only.
		const span = trace.getActiveSpan();
		span?.setAttribute("paperhanger.ingest.source", source);

		// A batch can carry multiple events; scalar span attributes can only
		// ever hold the LAST value written, so overwriting
		// paperhanger.ingest.action / paperhanger.incident.id on every
		// iteration would silently drop every event but the last from the
		// exported span. Record one span EVENT per ingest event so the full
		// per-event record survives, while ALSO keeping the two scalar
		// attributes in sync with the last event -- the common case is a
		// single-event batch, and simple span-attribute queries stay
		// ergonomic for that case. The event count is set once after the
		// loop.
		for (const event of events) {
			const result = await manager.handleEvent(event);
			span?.addEvent("ingest.event", {
				"paperhanger.ingest.action": result.action,
				...(result.incident
					? { "paperhanger.incident.id": result.incident.id }
					: {}),
			});
			span?.setAttribute("paperhanger.ingest.action", result.action);
			if (result.incident) {
				span?.setAttribute("paperhanger.incident.id", result.incident.id);
			}
		}
		span?.setAttribute("paperhanger.ingest.event_count", events.length);

		return Response.json({ accepted: events.length }, { status: 202 });
	}

	async function route(req: Request, url: URL): Promise<Response> {
		if (req.method === "GET" && url.pathname === "/healthz") {
			return new Response("ok", { status: 200 });
		}

		if (req.method === "GET" && url.pathname === "/readyz") {
			const ready = await store.ping().catch(() => false);
			return new Response(ready ? "ok" : "not ready", {
				status: ready ? 200 : 503,
			});
		}

		if (req.method === "POST" && url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
			const source = url.pathname.slice(WEBHOOK_PATH_PREFIX.length);
			return handleWebhook(req, url, source);
		}

		if (url.pathname === REPO_DEFINITIONS_PATH) {
			const authError = checkApiToken(config, req);
			if (authError) {
				return authError;
			}
			if (req.method === "GET") {
				return handleListRepoDefinitions(repoDefinitions);
			}
			if (req.method === "POST") {
				return handleCreateRepoDefinition(repoDefinitions, req);
			}
		}

		const repoDefinitionId = repoDefinitionIdFromPath(url.pathname);
		if (repoDefinitionId !== undefined) {
			const authError = checkApiToken(config, req);
			if (authError) {
				return authError;
			}
			if (req.method === "GET") {
				return handleGetRepoDefinition(repoDefinitions, repoDefinitionId);
			}
			if (req.method === "PUT") {
				return handleUpdateRepoDefinition(
					repoDefinitions,
					repoDefinitionId,
					req,
				);
			}
			if (req.method === "DELETE") {
				return handleDeleteRepoDefinition(repoDefinitions, repoDefinitionId);
			}
		}

		const incidentEventsId = incidentEventsIdFromPath(url.pathname);
		if (req.method === "GET" && incidentEventsId !== undefined) {
			const authError = checkApiToken(config, req);
			if (authError) {
				return authError;
			}
			const incident = await store.getIncident(incidentEventsId);
			if (!incident) {
				return new Response("incident not found", { status: 404 });
			}
			const events = await store.listEvents(incidentEventsId);
			return Response.json({ events });
		}

		if (req.method === "GET" && url.pathname === "/incidents") {
			const authError = checkApiToken(config, req);
			if (authError) {
				return authError;
			}
			const incidents = await store.listIncidents(parseListLimit(url));
			return Response.json({ incidents });
		}

		if (
			req.method === "GET" &&
			url.pathname.startsWith(INCIDENTS_PATH_PREFIX) &&
			url.pathname.length > INCIDENTS_PATH_PREFIX.length
		) {
			const authError = checkApiToken(config, req);
			if (authError) {
				return authError;
			}
			const id = url.pathname.slice(INCIDENTS_PATH_PREFIX.length);
			const incident = await store.getIncident(id);
			if (!incident) {
				return new Response("incident not found", { status: 404 });
			}
			return Response.json(incident);
		}

		return new Response("not found", { status: 404 });
	}

	return Bun.serve({
		port: config.server.port,
		routes: htmlRoutes,
		async fetch(req) {
			const start = Date.now();
			const url = new URL(req.url);
			const routeTemplate = deriveRouteTemplate(url);
			const span = tracer.startSpan(`${req.method} ${routeTemplate}`, {
				kind: SpanKind.SERVER,
				attributes: {
					"http.request.method": req.method,
					"url.path": url.pathname,
					"http.route": routeTemplate,
				},
			});

			// Make the span active for the duration of `route()` so everything
			// awaited in-request (manager.handleEvent -> store, etc.) nests under
			// it. This relies on a globally registered
			// AsyncLocalStorageContextManager to propagate across the `await`s
			// inside `route()` (see src/observability/tracing.ts); with no
			// context manager registered (tracing disabled), `context.with` is a
			// no-op wrapper around a no-op span, so behavior is unchanged.
			//
			// The `http.request` summary log is written from INSIDE this same
			// scope, once the response is known but before the scope (and the
			// span) closes -- `logger.info` correlates a line with
			// traceId/spanId only while `trace.getActiveSpan()` resolves to this
			// span, which is only true inside `context.with`. Logging after
			// `context.with` resolves (or after `span.end()`) would silently
			// drop that correlation.
			let response: Response;
			try {
				response = await context.with(
					trace.setSpan(context.active(), span),
					async () => {
						const res = await route(req, url);
						span.setAttribute("http.response.status_code", res.status);
						logger.info("http.request", {
							method: req.method,
							path: url.pathname,
							status: res.status,
							durationMs: Date.now() - start,
						});
						return res;
					},
				);
			} catch (err) {
				span.recordException(
					err instanceof Error ? err : new Error(String(err)),
				);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
				throw err;
			} finally {
				span.end();
			}

			return response;
		},
	});
}
