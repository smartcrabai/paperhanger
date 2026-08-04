/**
 * Shared HTTP request-body parsing helper for the dashboard's CRUD route
 * handlers (repo-definitions, common-setup-scripts, system-prompt).
 */

import type { z } from "zod";
import { formatZodError } from "../config/load";

export type BodyResult<T> =
	| { ok: true; value: T }
	| { ok: false; response: Response };

export async function parseJsonBody<T>(
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
