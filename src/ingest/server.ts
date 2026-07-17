/**
 * HTTP ingest server. Routes: POST /webhooks/:source, GET /healthz, GET
 * /readyz, GET /incidents, GET /incidents/:id. See docs/spec.md section 3.1
 * and docs/architecture.md "Webhook authentication".
 *
 * `GET /incidents` and `GET /incidents/:id` additionally require
 * `server.apiToken` (Authorization: Bearer or X-Api-Token, constant-time
 * compare via `safeCompare`) since incident records can carry sensitive
 * diagnosis/failureReason text. Secure by default: when `server.apiToken`
 * is not configured, both endpoints refuse every request with 401 rather
 * than serving that data with no authentication at all. `/healthz` and
 * `/readyz` are never gated.
 */

import type { IncidentManager } from "../core/incident-manager";
import type { IncidentEvent } from "../core/types";
import type { Logger } from "../observability/logger";
import type { IncidentStore } from "../storage/types";
import type { SourceAdapter } from "./adapters/types";

const WEBHOOK_PATH_PREFIX = "/webhooks/";
const INCIDENTS_PATH_PREFIX = "/incidents/";
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
	store: Pick<IncidentStore, "ping" | "getIncident" | "listIncidents">;
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
 * Guards `GET /incidents` and `GET /incidents/:id`. Returns a 401 `Response`
 * when the request should be rejected, or `undefined` when it may proceed.
 * Secure by default: an unconfigured `server.apiToken` rejects every
 * request rather than serving incident data unauthenticated.
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
	const { config, logger, manager, adapters, store } = deps;

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

		for (const event of events) {
			await manager.handleEvent(event);
		}

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
		async fetch(req) {
			const start = Date.now();
			const url = new URL(req.url);
			const response = await route(req, url);
			logger.info("http.request", {
				method: req.method,
				path: url.pathname,
				status: response.status,
				durationMs: Date.now() - start,
			});
			return response;
		},
	});
}
