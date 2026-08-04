/**
 * Shared HTTP request helpers for `TelemetrySource` implementations that
 * speak to an external HTTP/JSON API (Datadog, New Relic, Grafana, Zabbix,
 * Mackerel), factored out of the per-request timeout + OTel CLIENT span
 * pattern `greptimedb.ts` established first, so each new backend doesn't
 * reimplement it from scratch.
 *
 * Unlike `greptimedb.ts`'s `withQuerySpan`, this generic version does not
 * attempt GreptimeDB's byte-for-byte "never echo the raw SQL text" span
 * redaction -- these backends are queried through structured JSON-RPC/REST
 * params rather than string-concatenated SQL, so that specific risk doesn't
 * apply the same way. What every implementation in this file's callers MUST
 * still uphold (see each backend's own module doc comment): never place an
 * API key/token/secret into a thrown `Error` message, a log field, or a span
 * attribute.
 */

import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * Wraps `fn` in an OTel CLIENT span: starts it with `attributes`, makes it
 * the active span for the duration of `fn` (so logger calls made inside,
 * e.g. a "no query hint" warn, correlate to this span), and on failure
 * records the exception and sets an ERROR status before rethrowing
 * unchanged. `span.end()` always runs.
 */
export async function withClientSpan<T>(
	tracer: Tracer,
	spanName: string,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>,
): Promise<T> {
	const span = tracer.startSpan(spanName, {
		kind: SpanKind.CLIENT,
		attributes,
	});
	try {
		return await context.with(trace.setSpan(context.active(), span), () =>
			fn(span),
		);
	} catch (err) {
		span.recordException(err as Error);
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message: err instanceof Error ? err.message : String(err),
		});
		throw err;
	} finally {
		span.end();
	}
}

/**
 * Wraps a `fetch` call with an `AbortController`-based timeout, so a hung
 * endpoint fails fast with a typed error instead of leaving the caller
 * (ultimately `IncidentPipeline`) waiting forever. `makeTimeoutError` builds
 * the backend-specific typed error (e.g. `DatadogError`) to throw on abort;
 * any other rejection propagates unchanged.
 */
export async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	makeTimeoutError: (timeoutMs: number) => Error,
): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (timedOut || controller.signal.aborted) {
			throw makeTimeoutError(timeoutMs);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** Parses a response body as JSON, mapping a parse failure to `onParseError` instead of a raw `SyntaxError`. */
export async function parseJsonResponse<T>(
	response: Response,
	onParseError: (message: string) => Error,
): Promise<T> {
	const text = await response.text();
	try {
		return JSON.parse(text) as T;
	} catch (err) {
		throw onParseError((err as Error).message);
	}
}
