/**
 * Thin fetch wrapper for the dashboard's HTTP API calls (see
 * src/ingest/server.ts and src/ingest/repo-definitions.ts for the routes this
 * mirrors). Every function takes the API token explicitly rather than
 * reading it from module state, so the token always flows from React state
 * down through props/args -- no module-level singleton to fall out of sync
 * with a token the user just changed or cleared.
 */

import type {
	CreateRepoDefinitionInput,
	Incident,
	RepoDefinition,
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
		const text = (await res.text().catch(() => "")) || res.statusText;
		throw new ApiError(res.status, text);
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
