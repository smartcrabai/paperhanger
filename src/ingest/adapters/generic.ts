/**
 * Adapter for the "generic" source: accepts a single `IncidentEvent`-shaped
 * JSON object, or an array of them, as-is (an internal / pass-through
 * format). See docs/spec.md section 3.1.
 */

import { z } from "zod";
import type { IncidentEvent } from "../../core/types";
import type { SourceAdapter } from "./types";

const labelsSchema = z.record(z.string(), z.string());

const incidentEventInputSchema = z.object({
	fingerprint: z.string().min(1).optional(),
	source: z.string().min(1).optional(),
	status: z.enum(["firing", "resolved"]),
	severity: z.string().min(1).optional(),
	title: z.string().min(1),
	description: z.string().optional(),
	labels: labelsSchema.default({}),
	annotations: labelsSchema.default({}),
	startsAt: z.string().min(1),
	endsAt: z.string().optional(),
	generatorUrl: z.string().optional(),
});

const payloadSchema = z.union([
	incidentEventInputSchema,
	z.array(incidentEventInputSchema),
]);

/** Stable fingerprint derived from sorted labels, used when none is provided. */
export function fingerprintFromLabels(labels: Record<string, string>): string {
	const sorted = Object.keys(labels)
		.sort()
		.map((key) => `${key}=${labels[key]}`)
		.join(",");
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(sorted);
	return hasher.digest("hex");
}

function toIncidentEvent(
	input: z.infer<typeof incidentEventInputSchema>,
): IncidentEvent {
	return {
		fingerprint: input.fingerprint ?? fingerprintFromLabels(input.labels),
		source: input.source ?? "generic",
		status: input.status,
		severity: input.severity ?? input.labels.severity ?? "unknown",
		title: input.title,
		description: input.description,
		labels: input.labels,
		annotations: input.annotations,
		startsAt: input.startsAt,
		endsAt: input.endsAt,
		generatorUrl: input.generatorUrl,
		raw: input,
	};
}

export const genericAdapter: SourceAdapter = {
	name: "generic",

	async parse(req: Request): Promise<IncidentEvent[]> {
		let body: unknown;
		try {
			body = await req.json();
		} catch (err) {
			throw new Error(`Invalid JSON body: ${(err as Error).message}`);
		}

		const result = payloadSchema.safeParse(body);
		if (!result.success) {
			throw new Error(
				`Invalid incident event payload: ${result.error.message}`,
			);
		}

		const inputs = Array.isArray(result.data) ? result.data : [result.data];
		return inputs.map(toIncidentEvent);
	},
};
