/**
 * Adapter for Sentry Integration Platform webhooks (SaaS and self-hosted).
 *
 * Reference: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
 *
 * One internal/public integration exposes a single webhook URL; Sentry POSTs
 * every subscribed resource to it, distinguished by the
 * `Sentry-Hook-Resource` header. Two resources map onto paperhanger's alert
 * lifecycle (everything else -- `metric_alert`, `installation`, `error`,
 * `comment`, ... -- is accepted and ignored, yielding zero events):
 *
 * - `event_alert` (issue alert rule fired): `{ action: "triggered",
 *   data: { event: {...}, triggered_rule } }`. Maps to one firing event.
 * - `issue` (issue state change): `{ action, data: { issue: {...} } }`.
 *   `created`/`unresolved` map to firing, `resolved`/`archived` to resolved,
 *   and anything else (e.g. `assigned`) carries no alert-state change and
 *   yields zero events.
 *
 * Authentication uses the same shared-secret token check as every other
 * source (`X-Webhook-Token` header or `?token=` query param, enforced in
 * `src/ingest/server.ts` before dispatch); the operator embeds the token in
 * the integration's webhook URL. Sentry's native `Sentry-Hook-Signature`
 * (HMAC-SHA256 of the raw body with the integration's client secret) is NOT
 * verified here: the `SourceAdapter` contract receives only the request and
 * has no per-adapter secret plumbing, and widening it for one source would
 * break the uniform per-source auth model. See README.md "Security notes".
 */

import { z } from "zod";
import type { IncidentEvent } from "../../core/types";
import type { SourceAdapter } from "./types";

/**
 * Schemas use `z.looseObject` (unlike the other adapters' strict `z.object`)
 * so the full Sentry payload -- contexts, exception stacktraces, request
 * data -- survives into `IncidentEvent.raw` for audit, instead of being
 * stripped to the fields this adapter reads.
 */
const sentryEventSchema = z.looseObject({
	event_id: z.string().optional(),
	issue_id: z.string().min(1),
	title: z.string().optional(),
	message: z.string().optional(),
	culprit: z.string().optional(),
	level: z.string().optional(),
	platform: z.string().optional(),
	/** Numeric project id on SaaS payloads; some self-hosted versions send the slug. */
	project: z.union([z.string(), z.number()]).optional(),
	release: z.string().nullish(),
	environment: z.string().optional(),
	datetime: z.string().min(1),
	web_url: z.string().optional(),
	issue_url: z.string().optional(),
	tags: z.array(z.tuple([z.string(), z.string()])).default([]),
	metadata: z
		.looseObject({
			type: z.string().optional(),
			value: z.string().optional(),
		})
		.optional(),
});

const eventAlertPayloadSchema = z.looseObject({
	action: z.string(),
	data: z.looseObject({
		event: sentryEventSchema,
		triggered_rule: z.string().optional(),
	}),
});

const sentryIssueSchema = z.looseObject({
	id: z.string().min(1),
	shortId: z.string().optional(),
	title: z.string().optional(),
	culprit: z.string().optional(),
	level: z.string().optional(),
	logger: z.string().optional(),
	platform: z.string().optional(),
	issueCategory: z.string().optional(),
	project: z.looseObject({
		id: z.union([z.string(), z.number()]).optional(),
		name: z.string().optional(),
		slug: z.string().optional(),
	}),
	firstSeen: z.string().min(1),
	web_url: z.string().optional(),
	permalink: z.string().nullish(),
	url: z.string().optional(),
});

const issuePayloadSchema = z.looseObject({
	action: z.string(),
	data: z.looseObject({
		issue: sentryIssueSchema,
	}),
});

/**
 * Sentry levels normalized into the spec's severity vocabulary
 * (critical / warning / info); unknown or missing levels become "unknown".
 */
function normalizeSeverity(level: string | undefined): string {
	switch (level) {
		case "fatal":
		case "error":
			return "critical";
		case "warning":
			return "warning";
		case "info":
		case "debug":
			return "info";
		default:
			return "unknown";
	}
}

/**
 * `Sentry-Hook-Timestamp` is a Unix timestamp in seconds (numeric string).
 * Tolerates an ISO 8601 value as well, in case a self-hosted version formats
 * it differently. Returns undefined when absent or unparseable.
 */
function hookTimestampToIso(req: Request): string | undefined {
	const raw = req.headers.get("sentry-hook-timestamp");
	if (!raw) {
		return undefined;
	}
	if (/^\d+$/.test(raw)) {
		return new Date(Number.parseInt(raw, 10) * 1000).toISOString();
	}
	const parsed = Date.parse(raw);
	return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function tagsToLabels(tags: Array<[string, string]>): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const [key, value] of tags) {
		labels[key] = value;
	}
	return labels;
}

function eventAlertToIncidentEvent(
	payload: z.infer<typeof eventAlertPayloadSchema>,
): IncidentEvent {
	const { event } = payload.data;
	const rule = payload.data.triggered_rule;

	// Sentry event tags are the closest analog to alert labels (they often
	// carry service/environment markers repo resolution matches on), so they
	// are promoted wholesale; curated fields below win on conflicts (e.g. the
	// "level" tag Sentry adds to every event).
	const labels: Record<string, string> = tagsToLabels(event.tags);
	if (event.project !== undefined) {
		labels.project = String(event.project);
	}
	if (event.platform) {
		labels.platform = event.platform;
	}
	if (event.culprit) {
		labels.culprit = event.culprit;
	}
	if (event.level) {
		labels.level = event.level;
	}
	const environment = event.environment ?? labels.environment;
	if (environment) {
		labels.environment = environment;
	}
	if (event.release) {
		labels.release = event.release;
	}
	if (rule) {
		labels.rule = rule;
	}

	const annotations: Record<string, string> = {};
	if (event.event_id) {
		annotations.event_id = event.event_id;
	}
	if (event.issue_url) {
		annotations.issue_url = event.issue_url;
	}

	return {
		fingerprint: event.issue_id,
		source: "sentry",
		status: "firing",
		severity: normalizeSeverity(event.level),
		title: event.title ?? rule ?? "Sentry alert",
		description: event.message || event.metadata?.value || undefined,
		labels,
		annotations,
		startsAt: event.datetime,
		generatorUrl: event.web_url,
		raw: payload,
	};
}

function issueToIncidentEvent(
	payload: z.infer<typeof issuePayloadSchema>,
	req: Request,
): IncidentEvent | undefined {
	const { issue } = payload.data;

	let status: IncidentEvent["status"];
	switch (payload.action) {
		case "created":
		// A regressed/reopened issue fires again.
		case "unresolved":
			status = "firing";
			break;
		// "archived" means the issue is no longer considered active -- the
		// closest analog to resolved in paperhanger's two-state lifecycle.
		case "resolved":
		case "archived":
			status = "resolved";
			break;
		// e.g. "assigned": no alert-state change, nothing to dispatch.
		default:
			return undefined;
	}

	const labels: Record<string, string> = {};
	if (issue.project.slug) {
		labels.project = issue.project.slug;
	}
	if (issue.platform) {
		labels.platform = issue.platform;
	}
	if (issue.culprit) {
		labels.culprit = issue.culprit;
	}
	if (issue.level) {
		labels.level = issue.level;
	}
	if (issue.logger) {
		labels.logger = issue.logger;
	}
	if (issue.issueCategory) {
		labels.issue_category = issue.issueCategory;
	}

	const annotations: Record<string, string> = {};
	if (issue.shortId) {
		annotations.short_id = issue.shortId;
	}
	if (issue.url) {
		annotations.issue_url = issue.url;
	}

	return {
		fingerprint: issue.id,
		source: "sentry",
		status,
		severity: normalizeSeverity(issue.level),
		title: issue.title ?? "Sentry issue",
		labels,
		annotations,
		startsAt: issue.firstSeen,
		// The payload has no resolved-at timestamp; the hook timestamp is the
		// closest "when this state change happened" signal Sentry sends.
		endsAt: status === "resolved" ? hookTimestampToIso(req) : undefined,
		generatorUrl: issue.web_url ?? issue.permalink ?? undefined,
		raw: payload,
	};
}

/** Best-effort resource detection when the `Sentry-Hook-Resource` header is missing. */
function sniffResource(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null || !("data" in body)) {
		return undefined;
	}
	const data = (body as { data: unknown }).data;
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	if ("event" in data) {
		return "event_alert";
	}
	if ("issue" in data) {
		return "issue";
	}
	return undefined;
}

export const sentryAdapter: SourceAdapter = {
	name: "sentry",

	async parse(req: Request): Promise<IncidentEvent[]> {
		let body: unknown;
		try {
			body = await req.json();
		} catch (err) {
			throw new Error(`Invalid JSON body: ${(err as Error).message}`);
		}

		const resource =
			req.headers.get("sentry-hook-resource") ?? sniffResource(body);
		switch (resource) {
			case "event_alert": {
				const result = eventAlertPayloadSchema.safeParse(body);
				if (!result.success) {
					throw new Error(
						`Invalid Sentry event_alert webhook payload: ${result.error.message}`,
					);
				}
				// Only "triggered" is a state change; accept anything else as a no-op.
				if (result.data.action !== "triggered") {
					return [];
				}
				return [eventAlertToIncidentEvent(result.data)];
			}
			case "issue": {
				const result = issuePayloadSchema.safeParse(body);
				if (!result.success) {
					throw new Error(
						`Invalid Sentry issue webhook payload: ${result.error.message}`,
					);
				}
				const event = issueToIncidentEvent(result.data, req);
				return event ? [event] : [];
			}
			case undefined:
				throw new Error(
					"Unrecognized Sentry webhook: missing Sentry-Hook-Resource header and body matches neither the event_alert nor the issue shape",
				);
			default:
				// Authenticated, well-formed webhook for a resource paperhanger
				// does not act on (metric_alert, installation, error, comment,
				// ...) -- accept it so Sentry does not flag the integration as
				// failing.
				return [];
		}
	},
};
