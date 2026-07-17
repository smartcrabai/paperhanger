/**
 * Adapter for the Grafana Alerting webhook notifier payload format.
 *
 * Reference: https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/
 *
 * Payload shape (top level): `{ status, alerts: [...], commonLabels, ... }`.
 * Each entry in `alerts` carries its own `status`, `labels`, `annotations`,
 * `startsAt`, `endsAt`, `generatorURL`, and `fingerprint`. One webhook call
 * maps to one `IncidentEvent` per alert.
 */

import { z } from "zod";
import type { IncidentEvent } from "../../core/types";
import type { SourceAdapter } from "./types";

/** Grafana uses this zero-value timestamp for `endsAt` while an alert is still firing. */
const ZERO_TIMESTAMP = "0001-01-01T00:00:00Z";

const grafanaAlertSchema = z.object({
	status: z.enum(["firing", "resolved"]),
	labels: z.record(z.string(), z.string()).default({}),
	annotations: z.record(z.string(), z.string()).default({}),
	startsAt: z.string().min(1),
	endsAt: z.string().optional(),
	generatorURL: z.string().optional(),
	fingerprint: z.string().min(1),
});

const grafanaWebhookPayloadSchema = z.object({
	receiver: z.string().optional(),
	status: z.enum(["firing", "resolved"]).optional(),
	alerts: z.array(grafanaAlertSchema),
	groupKey: z.string().optional(),
	externalURL: z.string().optional(),
});

function toIncidentEvent(
	alert: z.infer<typeof grafanaAlertSchema>,
): IncidentEvent {
	const endsAt =
		alert.endsAt && alert.endsAt !== ZERO_TIMESTAMP ? alert.endsAt : undefined;

	return {
		fingerprint: alert.fingerprint,
		source: "grafana",
		status: alert.status,
		severity: alert.labels.severity ?? "unknown",
		title:
			alert.annotations.summary ?? alert.labels.alertname ?? "Grafana alert",
		description: alert.annotations.description,
		labels: alert.labels,
		annotations: alert.annotations,
		startsAt: alert.startsAt,
		endsAt,
		generatorUrl: alert.generatorURL,
		raw: alert,
	};
}

export const grafanaAdapter: SourceAdapter = {
	name: "grafana",

	async parse(req: Request): Promise<IncidentEvent[]> {
		let body: unknown;
		try {
			body = await req.json();
		} catch (err) {
			throw new Error(`Invalid JSON body: ${(err as Error).message}`);
		}

		const result = grafanaWebhookPayloadSchema.safeParse(body);
		if (!result.success) {
			throw new Error(
				`Invalid Grafana webhook payload: ${result.error.message}`,
			);
		}

		return result.data.alerts.map(toIncidentEvent);
	},
};
