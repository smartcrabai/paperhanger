/**
 * Zod validation and route handlers backing the dashboard's repo-definition
 * CRUD routes (`GET/POST /repo-definitions`, `GET/PUT/DELETE
 * /repo-definitions/:id`). Split out of `server.ts` to keep that file's
 * routing table readable -- see the design doc's "HTTP API" section.
 */

import { z } from "zod";
import type {
	CreateRepoDefinitionInput,
	UpdateRepoDefinitionInput,
} from "../core/types";
import {
	DuplicateRepoDefinitionError,
	RepoDefinitionNotFoundError,
	type RepoDefinitionStore,
} from "../storage/types";
import { parseJsonBody } from "./http-utils";

/** GitHub owner/repo names: letters, digits, `_`, `.`, `-` only. */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const OwnerOrRepoSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(GITHUB_NAME_PATTERN, "must match GitHub's owner/repo naming rules");

/**
 * One OR-branch of a repo definition's label matcher: it matches an incident
 * when EVERY key===value pair here equals the incident's labels (see
 * `RepoDefinition.mappings` in core/types.ts). An empty object would match
 * every incident, so it is rejected outright rather than silently accepted.
 * Key/value/pair-count caps bound the size of a single stored definition
 * (see docs/spec.md section 3.11).
 */
const MAPPING_KEY_MAX_LENGTH = 100;
const MAPPING_VALUE_MAX_LENGTH = 1_000;
const MAPPING_ENTRY_MAX_PAIRS = 50;
const MAPPINGS_ARRAY_MAX_LENGTH = 100;

const MappingEntrySchema = z
	.record(
		z.string().min(1).max(MAPPING_KEY_MAX_LENGTH),
		z.string().min(1).max(MAPPING_VALUE_MAX_LENGTH),
	)
	.refine((entry) => Object.keys(entry).length > 0, {
		message: "match entry must not be empty (it would match every incident)",
	})
	.refine((entry) => Object.keys(entry).length <= MAPPING_ENTRY_MAX_PAIRS, {
		message: `match entry must not have more than ${MAPPING_ENTRY_MAX_PAIRS} key/value pairs`,
	});

const SetupScriptSchema = z.string().max(100_000);

/**
 * Same convention as the common system prompt (see ./system-prompt.ts):
 * trimmed before the 20,000-character cap is enforced, so a whitespace-only
 * value normalizes to "" (which the fix-agent runner treats as "no per-repo
 * override -- inherit the common prompt") instead of being stored as if it
 * were configured. The cap is lower than `SetupScriptSchema`'s because this
 * text is sent to the model on every diagnosis and spends context budget.
 */
const SystemPromptSchema = z
	.string()
	.transform((value) => value.trim())
	.pipe(z.string().max(20_000));

const TestCommandSchema = z
	.string()
	.max(1_000)
	.refine((value) => !value.includes("\n"), {
		message: "must be a single line",
	})
	.refine((value) => value.trim().length > 0, {
		message: "must not be blank or whitespace-only",
	});

const CreateRepoDefinitionBodySchema = z
	.object({
		owner: OwnerOrRepoSchema,
		repo: OwnerOrRepoSchema,
		mappings: z
			.array(MappingEntrySchema)
			.max(MAPPINGS_ARRAY_MAX_LENGTH)
			.optional(),
		setupScript: SetupScriptSchema.optional(),
		testCommand: TestCommandSchema.optional(),
		systemPrompt: SystemPromptSchema.optional(),
		enabled: z.boolean().optional(),
	})
	.strict();

const UpdateRepoDefinitionBodySchema = z
	.object({
		owner: OwnerOrRepoSchema.optional(),
		repo: OwnerOrRepoSchema.optional(),
		mappings: z
			.array(MappingEntrySchema)
			.max(MAPPINGS_ARRAY_MAX_LENGTH)
			.optional(),
		// Present-with-null clears the field; absent leaves it untouched (see
		// UpdateRepoDefinitionInput / SqliteIncidentStore.updateRepoDefinition,
		// which both distinguish "key not in patch" from "key set to null").
		setupScript: SetupScriptSchema.nullable().optional(),
		testCommand: TestCommandSchema.nullable().optional(),
		systemPrompt: SystemPromptSchema.nullable().optional(),
		enabled: z.boolean().optional(),
	})
	.strict();

export async function handleListRepoDefinitions(
	store: Pick<RepoDefinitionStore, "listRepoDefinitions">,
): Promise<Response> {
	const repoDefinitions = await store.listRepoDefinitions();
	return Response.json({ repoDefinitions });
}

export async function handleCreateRepoDefinition(
	store: Pick<RepoDefinitionStore, "createRepoDefinition">,
	req: Request,
): Promise<Response> {
	const body = await parseJsonBody<CreateRepoDefinitionInput>(
		req,
		CreateRepoDefinitionBodySchema,
	);
	if (!body.ok) {
		return body.response;
	}
	try {
		const created = await store.createRepoDefinition(body.value);
		return Response.json(created, { status: 201 });
	} catch (err) {
		if (err instanceof DuplicateRepoDefinitionError) {
			return new Response(err.message, { status: 409 });
		}
		throw err;
	}
}

export async function handleGetRepoDefinition(
	store: Pick<RepoDefinitionStore, "getRepoDefinition">,
	id: string,
): Promise<Response> {
	const definition = await store.getRepoDefinition(id);
	if (!definition) {
		return new Response("repo definition not found", { status: 404 });
	}
	return Response.json(definition);
}

export async function handleUpdateRepoDefinition(
	store: Pick<RepoDefinitionStore, "updateRepoDefinition">,
	id: string,
	req: Request,
): Promise<Response> {
	const body = await parseJsonBody<UpdateRepoDefinitionInput>(
		req,
		UpdateRepoDefinitionBodySchema,
	);
	if (!body.ok) {
		return body.response;
	}
	try {
		const updated = await store.updateRepoDefinition(id, body.value);
		return Response.json(updated);
	} catch (err) {
		if (err instanceof RepoDefinitionNotFoundError) {
			return new Response("repo definition not found", { status: 404 });
		}
		if (err instanceof DuplicateRepoDefinitionError) {
			return new Response(err.message, { status: 409 });
		}
		throw err;
	}
}

export async function handleDeleteRepoDefinition(
	store: Pick<RepoDefinitionStore, "deleteRepoDefinition">,
	id: string,
): Promise<Response> {
	const deleted = await store.deleteRepoDefinition(id);
	return new Response(null, { status: deleted ? 204 : 404 });
}
