/**
 * Adapter for the Prometheus Alertmanager webhook receiver format.
 *
 * Reference: https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
 *
 * Payload shape (top level): `{ version, status, groupLabels, commonLabels,
 * commonAnnotations, externalURL, alerts: [...] }`. Each entry in `alerts`
 * carries its own `status`, `labels`, `annotations`, `startsAt`, `endsAt`,
 * `generatorURL`, and `fingerprint`. One webhook call maps to one
 * `IncidentEvent` per alert, mirroring the grafana adapter's mapping rules.
 */

import { z } from "zod";
import type { IncidentEvent } from "../../core/types";
import type { SourceAdapter } from "./types";

/** Alertmanager uses this zero-value timestamp for `endsAt` while an alert is still firing. */
const ZERO_TIMESTAMP = "0001-01-01T00:00:00Z";

const alertmanagerAlertSchema = z.object({
	status: z.enum(["firing", "resolved"]),
	labels: z.record(z.string(), z.string()).default({}),
	annotations: z.record(z.string(), z.string()).default({}),
	startsAt: z.string().min(1),
	endsAt: z.string().optional(),
	generatorURL: z.string().optional(),
	fingerprint: z.string().min(1),
});

const alertmanagerWebhookPayloadSchema = z.object({
	version: z.string().optional(),
	status: z.enum(["firing", "resolved"]).optional(),
	groupLabels: z.record(z.string(), z.string()).default({}),
	commonLabels: z.record(z.string(), z.string()).default({}),
	commonAnnotations: z.record(z.string(), z.string()).default({}),
	externalURL: z.string().optional(),
	alerts: z.array(alertmanagerAlertSchema),
});

function toIncidentEvent(
	alert: z.infer<typeof alertmanagerAlertSchema>,
): IncidentEvent {
	const endsAt =
		alert.endsAt && alert.endsAt !== ZERO_TIMESTAMP ? alert.endsAt : undefined;

	return {
		fingerprint: alert.fingerprint,
		source: "alertmanager",
		status: alert.status,
		severity: alert.labels.severity ?? "unknown",
		title:
			alert.annotations.summary ??
			alert.labels.alertname ??
			"Alertmanager alert",
		description: alert.annotations.description,
		labels: alert.labels,
		annotations: alert.annotations,
		startsAt: alert.startsAt,
		endsAt,
		generatorUrl: alert.generatorURL,
		raw: alert,
	};
}

export const alertmanagerAdapter: SourceAdapter = {
	name: "alertmanager",

	async parse(req: Request): Promise<IncidentEvent[]> {
		let body: unknown;
		try {
			body = await req.json();
		} catch (err) {
			throw new Error(`Invalid JSON body: ${(err as Error).message}`);
		}

		const result = alertmanagerWebhookPayloadSchema.safeParse(body);
		if (!result.success) {
			throw new Error(
				`Invalid Alertmanager webhook payload: ${result.error.message}`,
			);
		}

		return result.data.alerts.map(toIncidentEvent);
	},
};
