import { z } from "zod";
import type { SetCommonSystemPromptInput } from "../core/types";
import type { CommonSystemPromptStore } from "../storage/types";
import { parseJsonBody } from "./http-utils";

// Trimmed *before* the length cap is enforced, for two reasons: (1)
// `CommonSystemPrompt.prompt`'s contract (src/core/types.ts) treats "" as "no
// common prompt", so a whitespace-only value must normalize to "" rather than
// be stored as if it were configured; (2) the 20,000-character cap is meant
// to bound the meaningful content sent to the model, so padding-only
// whitespace shouldn't count against it.
const PromptSchema = z
	.string()
	.transform((value) => value.trim())
	.pipe(z.string().max(20_000));
const SetBodySchema = z.object({ prompt: PromptSchema }).strict();

export async function handleGetCommonSystemPrompt(
	store: Pick<CommonSystemPromptStore, "getCommonSystemPrompt">,
): Promise<Response> {
	const systemPrompt = (await store.getCommonSystemPrompt()) ?? null;
	return Response.json({ systemPrompt });
}

export async function handleSetCommonSystemPrompt(
	store: Pick<CommonSystemPromptStore, "setCommonSystemPrompt">,
	req: Request,
): Promise<Response> {
	const body = await parseJsonBody<SetCommonSystemPromptInput>(
		req,
		SetBodySchema,
	);
	if (!body.ok) return body.response;
	return Response.json(await store.setCommonSystemPrompt(body.value));
}
