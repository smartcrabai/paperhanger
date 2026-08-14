/**
 * Thin fetch wrapper for the dashboard's HTTP API calls (see
 * src/ingest/server.ts and src/ingest/repo-definitions.ts for the routes this
 * mirrors). Every function takes the API token explicitly rather than
 * reading it from module state, so the token always flows from React state
 * down through props/args -- no module-level singleton to fall out of sync
 * with a token the user just changed or cleared.
 */

import type {
	CommonSetupScript,
	CommonSystemPrompt,
	CreateCommonSetupScriptInput,
	CreateRepoDefinitionInput,
	Incident,
	RepoDefinition,
	UpdateCommonSetupScriptInput,
	UpdateRepoDefinitionInput,
} from "../core/types";
import type { IncidentEventRecord } from "../storage/types";

/** Thrown on any non-2xx response; `status` lets callers special-case 401 (expired/wrong token). */
export class ApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/** Longest response body kept verbatim in an `ApiError` message; anything past
 *  this is sliced and marked with an ellipsis so a runaway body can't flood
 *  the UI. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * The dashboard's own route handlers (see src/ingest/*.ts, e.g.
 * `repo-definitions.ts`'s `new Response("repo definition not found", { status:
 * 404 })`) answer failures with a plain-text body meant to be read by the
 * operator. Per the fetch spec, `new Response("message", { status })` ships
 * with `Content-Type: text/plain;charset=utf-8` by default (verified over an
 * actual request/response round trip under Bun), so the
 * `startsWith("text/plain")` branch below is what keeps every 400/404/409
 * operator message intact -- deleting it would send them all through the
 * `statusText` fallback instead. `contentType === ""` only covers a truly
 * bodyless response that never set the header at all (e.g. `new
 * Response(null, { status: 404 })`). Anything else -- a different or JSON
 * content type, most notably Bun's default HTML error page when a store call
 * throws inside the handler -- is a transport/runtime failure page rather
 * than a message for a human, so it falls back to `statusText` (or `HTTP
 * <status>` when even that is blank) instead of being rendered verbatim.
 */
async function errorMessage(res: Response): Promise<string> {
	const contentType = (res.headers.get("Content-Type") ?? "").toLowerCase();
	const isOperatorMessage =
		contentType === "" || contentType.startsWith("text/plain");
	const statusFallback = res.statusText || `HTTP ${res.status}`;
	if (!isOperatorMessage) {
		return statusFallback;
	}
	const text = await res.text().catch(() => "");
	if (!text.trim()) {
		return statusFallback;
	}
	return text.length > MAX_ERROR_MESSAGE_LENGTH
		? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
		: text;
}

async function request(
	path: string,
	token: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("X-Api-Token", token);
	if (init.body !== undefined && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	const res = await fetch(path, { ...init, headers });
	if (!res.ok) {
		throw new ApiError(res.status, await errorMessage(res));
	}
	return res;
}

export async function listRepoDefinitions(
	token: string,
): Promise<RepoDefinition[]> {
	const res = await request("/repo-definitions", token);
	const body = (await res.json()) as { repoDefinitions: RepoDefinition[] };
	return body.repoDefinitions;
}

export async function createRepoDefinition(
	token: string,
	input: CreateRepoDefinitionInput,
	signal?: AbortSignal,
): Promise<RepoDefinition> {
	const res = await request("/repo-definitions", token, {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
	return (await res.json()) as RepoDefinition;
}

export async function updateRepoDefinition(
	token: string,
	id: string,
	patch: UpdateRepoDefinitionInput,
	signal?: AbortSignal,
): Promise<RepoDefinition> {
	const res = await request(
		`/repo-definitions/${encodeURIComponent(id)}`,
		token,
		{ method: "PUT", body: JSON.stringify(patch), signal },
	);
	return (await res.json()) as RepoDefinition;
}

export async function deleteRepoDefinition(
	token: string,
	id: string,
): Promise<void> {
	await request(`/repo-definitions/${encodeURIComponent(id)}`, token, {
		method: "DELETE",
	});
}

export async function listCommonSetupScripts(
	token: string,
): Promise<CommonSetupScript[]> {
	const res = await request("/setup-scripts", token);
	const body = (await res.json()) as { setupScripts: CommonSetupScript[] };
	return body.setupScripts;
}

export async function createCommonSetupScript(
	token: string,
	input: CreateCommonSetupScriptInput,
	signal?: AbortSignal,
): Promise<CommonSetupScript> {
	const res = await request("/setup-scripts", token, {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
	return (await res.json()) as CommonSetupScript;
}

export async function updateCommonSetupScript(
	token: string,
	id: string,
	patch: UpdateCommonSetupScriptInput,
	signal?: AbortSignal,
): Promise<CommonSetupScript> {
	const res = await request(`/setup-scripts/${encodeURIComponent(id)}`, token, {
		method: "PUT",
		body: JSON.stringify(patch),
		signal,
	});
	return (await res.json()) as CommonSetupScript;
}

export async function deleteCommonSetupScript(
	token: string,
	id: string,
): Promise<void> {
	await request(`/setup-scripts/${encodeURIComponent(id)}`, token, {
		method: "DELETE",
	});
}

export async function getCommonSystemPrompt(
	token: string,
): Promise<CommonSystemPrompt | null> {
	const res = await request("/system-prompt", token);
	const body = (await res.json()) as {
		systemPrompt: CommonSystemPrompt | null;
	};
	return body.systemPrompt;
}

export async function saveCommonSystemPrompt(
	token: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<CommonSystemPrompt> {
	const res = await request("/system-prompt", token, {
		method: "PUT",
		body: JSON.stringify({ prompt }),
		signal,
	});
	return (await res.json()) as CommonSystemPrompt;
}

export async function listIncidents(token: string): Promise<Incident[]> {
	const res = await request("/incidents", token);
	const body = (await res.json()) as { incidents: Incident[] };
	return body.incidents;
}

export async function getIncidentEvents(
	token: string,
	incidentId: string,
): Promise<IncidentEventRecord[]> {
	const res = await request(
		`/incidents/${encodeURIComponent(incidentId)}/events`,
		token,
	);
	const body = (await res.json()) as { events: IncidentEventRecord[] };
	return body.events;
}
