/**
 * Network stub for the dashboard's tests. The dashboard's only side effect is
 * HTTP, so the tests mock exactly that boundary -- `globalThis.fetch` -- and
 * exercise the real ./api client plus the real components above it. Stubbing
 * the ./api module instead would both skip that wiring and leak into other test
 * files (Bun's `mock.module` registry is process-wide).
 *
 * Usage:
 *
 *     const http = stubFetch((req) =>
 *         req.route === "GET /incidents"
 *             ? jsonResponse({ incidents: [] })
 *             : errorResponse(404, "not found"),
 *     );
 *     ...
 *     expect(http.calls.map((call) => call.route)).toEqual(["GET /incidents"]);
 *
 * The stub is uninstalled after every test by `setupDashboardTest()` (see
 * `restoreFetch` at the bottom of this file), so a test that never calls
 * `stubFetch` still sees the process's real `fetch`.
 */

/** One intercepted request, in the shape assertions actually want to read. */
export interface RecordedRequest {
	/** `"GET /incidents"` -- method plus path, the form route assertions use. */
	route: string;
	method: string;
	/** Request path exactly as ./api built it, query string included. */
	path: string;
	/** Value of the `X-Api-Token` header, or null when absent. */
	token: string | null;
	/** Value of the `Content-Type` header, or null when absent. */
	contentType: string | null;
	/** Request body parsed as JSON; undefined for bodyless requests. */
	body: unknown;
	/** Raw body text; undefined for bodyless requests. */
	rawBody: string | undefined;
	/** The `AbortSignal` ./api passed through, if any. */
	signal: AbortSignal | null;
}

export interface FetchStub {
	/** Every intercepted request, in call order. */
	calls: RecordedRequest[];
	/** Requests for one `"METHOD /path"` route. */
	callsTo(route: string): RecordedRequest[];
}

/** Handler return type: a `Response`, or a promise of one for pending requests. */
export type FetchStubHandler = (
	request: RecordedRequest,
) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

/**
 * Replaces `globalThis.fetch` with `handler` and records every request. A
 * handler that throws (or rejects) surfaces as a rejected `fetch`, which is how
 * the tests simulate a dropped connection rather than an HTTP error status.
 *
 * The stub honors `init.signal` the way the platform does -- an aborted request
 * rejects with an `AbortError` and can never deliver its handler's response,
 * even if the handler settles later. Tests that abort an in-flight request would
 * otherwise observe a success the browser could never produce.
 */
export function stubFetch(handler: FetchStubHandler): FetchStub {
	const calls: RecordedRequest[] = [];

	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const recorded = record(input, init);
		calls.push(recorded);
		const signal = recorded.signal;
		if (signal === null) {
			return await handler(recorded);
		}
		signal.throwIfAborted();
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([handler(recorded), aborted]);
		} finally {
			if (onAbort) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}) as typeof fetch;

	return {
		calls,
		callsTo: (route) => calls.filter((call) => call.route === route),
	};
}

function record(
	input: string | URL | Request,
	init: RequestInit | undefined,
): RecordedRequest {
	const path = typeof input === "string" ? input : input.toString();
	const method = (init?.method ?? "GET").toUpperCase();
	const headers = new Headers(init?.headers);
	const rawBody = typeof init?.body === "string" ? init.body : undefined;
	let body: unknown;
	if (rawBody !== undefined) {
		try {
			body = JSON.parse(rawBody);
		} catch {
			// Tests asserting on a non-JSON body read `rawBody` instead.
			body = undefined;
		}
	}
	return {
		route: `${method} ${path}`,
		method,
		path,
		token: headers.get("X-Api-Token"),
		contentType: headers.get("Content-Type"),
		body,
		rawBody,
		signal: init?.signal ?? null,
	};
}

/** 2xx JSON response, the shape every dashboard route returns on success. */
export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Non-2xx response shaped like the ones the dashboard's own route handlers
 * send: a plain-text body the UI shows verbatim (see `ApiError` in ./api).
 *
 * `Content-Type` is set explicitly because the real responses carry it --
 * `new Response("message")` ships `text/plain;charset=utf-8` per the fetch
 * spec -- and because `api.ts` keys its "is this text meant for a human?"
 * decision on that header. `statusText` deliberately differs from the body so
 * a test can tell which of the two `api.ts` surfaced.
 *
 * Pass `contentType` to model a failure the handlers never produce, e.g.
 * Bun's HTML crash page: `errorResponse(500, html, { contentType: "text/html" })`.
 * Pass `contentType: null` for a bodyless/header-less response.
 */
export function errorResponse(
	status: number,
	message = "",
	options: { contentType?: string | null; statusText?: string } = {},
): Response {
	const contentType =
		options.contentType === undefined
			? "text/plain;charset=utf-8"
			: options.contentType;
	return new Response(message, {
		status,
		statusText: options.statusText ?? "Server Error",
		headers: contentType === null ? {} : { "Content-Type": contentType },
	});
}

/** A response that never settles until `resolve` is called -- for pending-state tests. */
export function deferredResponse(): {
	promise: Promise<Response>;
	resolve: (response: Response) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (response: Response) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<Response>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * Puts the process's real `fetch` back. Called from `setupDashboardTest()`'s
 * `afterEach` rather than from an `afterEach` here: a root-level hook is scoped
 * to the file that was being evaluated when it was registered, and this module
 * is only ever evaluated once for the whole test process -- so registering it
 * here would leave every file except the first one with a leaked stub.
 */
export function restoreFetch(): void {
	globalThis.fetch = realFetch;
}
