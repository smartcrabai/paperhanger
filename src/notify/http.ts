/**
 * Shared HTTP POST helper for the webhook-based notifiers. Centralizes the
 * "non-2xx -> log excerpt + throw typed error" behavior so slack.ts,
 * discord.ts, and webhook.ts don't each reimplement it. Also centralizes a
 * request timeout: without one, a hung endpoint's `fetch` call never
 * settles, `CompositeNotifier` waits forever, and since `IncidentPipeline`
 * awaits `notify()` while holding a concurrency slot, a couple of hung
 * notifications would permanently exhaust the pipeline's concurrency with
 * zero log output.
 */

import {
	context,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { Logger } from "../observability/logger";
import { NotifierResponseError, NotifierTimeoutError } from "./types";

const RESPONSE_EXCERPT_LIMIT = 500;

/** Default per-request timeout, overridable via each notifier's constructor. */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

async function readBodyExcerpt(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.length > RESPONSE_EXCERPT_LIMIT
			? `${text.slice(0, RESPONSE_EXCERPT_LIMIT)}…`
			: text;
	} catch {
		return "(failed to read response body)";
	}
}

/**
 * POSTs a JSON body to `url` using the injected `fetchImpl`. On a non-2xx
 * response, logs the status and a response body excerpt, then throws a
 * `NotifierResponseError`. If the request does not complete within
 * `timeoutMs` (default `DEFAULT_NOTIFY_TIMEOUT_MS`), aborts it and throws a
 * `NotifierTimeoutError` instead. Callers (individual `Notifier`
 * implementations) are expected to let both propagate; `CompositeNotifier` is
 * the layer that catches and logs them.
 *
 * Wraps the call in a `notify.post` CLIENT span. Deliberately records no
 * `url` attribute: notifier webhook URLs (Slack/Discord in particular) embed
 * secrets in the path/query.
 */
export async function postJson(params: {
	fetchImpl: typeof fetch;
	url: string;
	body: unknown;
	notifierName: string;
	logger: Logger;
	timeoutMs?: number;
	/** Tracer for the `notify.post` span. Defaults to a no-op tracer (tracing disabled) when omitted. */
	tracer?: Tracer;
	/** Notifier type ("slack" / "discord" / "webhook"), recorded as `paperhanger.notify.component`. */
	component?: string;
}): Promise<void> {
	const {
		fetchImpl,
		url,
		body,
		notifierName,
		logger,
		timeoutMs = DEFAULT_NOTIFY_TIMEOUT_MS,
		tracer = trace.getTracer("notify"),
		component,
	} = params;

	const span = tracer.startSpan("notify.post", { kind: SpanKind.CLIENT });
	if (component !== undefined) {
		span.setAttribute("paperhanger.notify.component", component);
	}

	try {
		// Activate the leaf span for the duration of the request so that
		// logger.error("notify.timeout" / "notify.http_error", ...) calls
		// inside this closure correlate (traceId/spanId) to THIS span.
		await context.with(trace.setSpan(context.active(), span), async () => {
			const controller = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);

			let res: Response;
			try {
				res = await fetchImpl(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} catch (err) {
				if (timedOut || controller.signal.aborted) {
					logger.error("notify.timeout", { notifier: notifierName, timeoutMs });
					throw new NotifierTimeoutError(notifierName, timeoutMs);
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}

			span.setAttribute("http.response.status_code", res.status);

			if (!res.ok) {
				const bodyExcerpt = await readBodyExcerpt(res);
				logger.error("notify.http_error", {
					notifier: notifierName,
					status: res.status,
					bodyExcerpt,
				});
				throw new NotifierResponseError(notifierName, res.status, bodyExcerpt);
			}
		});
	} catch (err) {
		if (err instanceof NotifierResponseError) {
			// NotifierResponseError.message embeds up to 500 chars of the
			// target's RAW response body (see readBodyExcerpt above).
			// recordException would export that raw body to the trace
			// backend, so record a redacted status message instead;
			// http.response.status_code (set above) already carries the code.
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: `notifier request failed (status=${err.status})`,
			});
		} else {
			// NotifierTimeoutError's message is locally constructed
			// (notifierName + configured timeoutMs, both trusted values) and
			// carries no upstream-controlled content, so recording the full
			// exception is safe here.
			const message = err instanceof Error ? err.message : String(err);
			span.recordException(err instanceof Error ? err : new Error(message));
			span.setStatus({ code: SpanStatusCode.ERROR, message });
		}
		throw err;
	} finally {
		span.end();
	}
}
