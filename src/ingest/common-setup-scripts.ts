import { z } from "zod";
import { formatZodError } from "../config/load";
import type {
	CreateCommonSetupScriptInput,
	UpdateCommonSetupScriptInput,
} from "../core/types";
import {
	CommonSetupScriptNotFoundError,
	type CommonSetupScriptStore,
} from "../storage/types";

const TriggerFileSchema = z
	.string()
	.min(1)
	.max(1_000)
	.refine((value) => !value.startsWith("/") && !value.includes("\\"), {
		message: "must be a repository-relative POSIX path",
	})
	.refine((value) => !value.includes("\0"), {
		message: "must not contain NUL characters",
	})
	.refine(
		(value) =>
			value
				.split("/")
				.every(
					(segment) =>
						segment.length > 0 && segment !== "." && segment !== "..",
				),
		{ message: "must not contain empty, '.' or '..' path segments" },
	);

const ScriptSchema = z
	.string()
	.min(1)
	.max(100_000)
	.refine((value) => value.trim().length > 0, {
		message: "must not be blank or whitespace-only",
	});

const CreateBodySchema = z
	.object({ triggerFile: TriggerFileSchema, script: ScriptSchema })
	.strict();
const UpdateBodySchema = z
	.object({
		triggerFile: TriggerFileSchema.optional(),
		script: ScriptSchema.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, {
		message: "must include triggerFile or script",
	});

type BodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

async function parseJsonBody<T>(
	req: Request,
	schema: z.ZodType<T>,
): Promise<BodyResult<T>> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return {
			ok: false,
			response: new Response("invalid JSON body", { status: 400 }),
		};
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			response: new Response(formatZodError(parsed.error), { status: 400 }),
		};
	}
	return { ok: true, value: parsed.data };
}

export async function handleListCommonSetupScripts(
	store: Pick<CommonSetupScriptStore, "listCommonSetupScripts">,
): Promise<Response> {
	return Response.json({ setupScripts: await store.listCommonSetupScripts() });
}

export async function handleCreateCommonSetupScript(
	store: Pick<CommonSetupScriptStore, "createCommonSetupScript">,
	req: Request,
): Promise<Response> {
	const body = await parseJsonBody<CreateCommonSetupScriptInput>(
		req,
		CreateBodySchema,
	);
	if (!body.ok) return body.response;
	return Response.json(await store.createCommonSetupScript(body.value), {
		status: 201,
	});
}

export async function handleUpdateCommonSetupScript(
	store: Pick<CommonSetupScriptStore, "updateCommonSetupScript">,
	id: string,
	req: Request,
): Promise<Response> {
	const body = await parseJsonBody<UpdateCommonSetupScriptInput>(
		req,
		UpdateBodySchema,
	);
	if (!body.ok) return body.response;
	try {
		return Response.json(await store.updateCommonSetupScript(id, body.value));
	} catch (error) {
		if (error instanceof CommonSetupScriptNotFoundError) {
			return new Response("common setup script not found", { status: 404 });
		}
		throw error;
	}
}

export async function handleDeleteCommonSetupScript(
	store: Pick<CommonSetupScriptStore, "deleteCommonSetupScript">,
	id: string,
): Promise<Response> {
	return (await store.deleteCommonSetupScript(id))
		? new Response(null, { status: 204 })
		: new Response("common setup script not found", { status: 404 });
}
