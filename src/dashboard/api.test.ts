import { describe, expect, test } from "bun:test";
import {
	ApiError,
	createCommonSetupScript,
	createRepoDefinition,
	deleteCommonSetupScript,
	deleteRepoDefinition,
	getCommonSystemPrompt,
	getIncidentEvents,
	listCommonSetupScripts,
	listIncidents,
	listRepoDefinitions,
	saveCommonSystemPrompt,
	updateCommonSetupScript,
	updateRepoDefinition,
} from "./api";
import { errorResponse, jsonResponse, stubFetch } from "./test-fetch";
import {
	commonSetupScript,
	commonSystemPrompt,
	incident,
	incidentEventRecord,
	repoDefinition,
} from "./test-fixtures";
import { setupDashboardTest } from "./test-setup";

setupDashboardTest();

const TOKEN = "tok-abc123";
/** Slash, space, and `#` all carry meaning in a URL path -- api.ts must
 *  percent-encode an id containing them before this file's own encoding
 *  assertions below can pass. This pins ONLY api.ts's client-side encoding:
 *  server.ts's id extractors (repoDefinitionIdFromPath,
 *  commonSetupScriptIdFromPath, incidentEventsIdFromPath) slice the raw
 *  pathname and never call decodeURIComponent, so a real request for an id
 *  with reserved characters would look up the literal percent-encoded string
 *  and 404 -- it would NOT round-trip server-side. That asymmetry never
 *  surfaces in practice because every real id is a crypto.randomUUID(), for
 *  which encodeURIComponent is a no-op. */
const RAW_ID = "a/b c#1";
const ENCODED_ID = encodeURIComponent(RAW_ID);

describe("ApiError", () => {
	test("carries the response's status and message, and identifies as ApiError rather than a generic Error", () => {
		const err = new ApiError(503, "Service Unavailable");

		expect(err.status).toBe(503);
		expect(err.message).toBe("Service Unavailable");
		expect(err.name).toBe("ApiError");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("list endpoints (GET, envelope unwrapping)", () => {
	const cases: Array<{
		label: string;
		route: string;
		envelopeKey: string;
		items: unknown[];
		call: (token: string) => Promise<unknown>;
	}> = [
		{
			label: "listRepoDefinitions",
			route: "GET /repo-definitions",
			envelopeKey: "repoDefinitions",
			items: [repoDefinition(), repoDefinition({ id: "repo-2" })],
			call: listRepoDefinitions,
		},
		{
			label: "listCommonSetupScripts",
			route: "GET /setup-scripts",
			envelopeKey: "setupScripts",
			items: [commonSetupScript()],
			call: listCommonSetupScripts,
		},
		{
			label: "listIncidents",
			route: "GET /incidents",
			envelopeKey: "incidents",
			items: [incident()],
			call: listIncidents,
		},
	];

	for (const tc of cases) {
		test(`${tc.label} issues ${tc.route}, sends the token, and returns the unwrapped ${tc.envelopeKey} array (not the envelope)`, async () => {
			const http = stubFetch((req) =>
				req.route === tc.route
					? jsonResponse({ [tc.envelopeKey]: tc.items })
					: errorResponse(500, `unexpected route: ${req.route}`),
			);

			const result = await tc.call(TOKEN);

			expect(result).toEqual(tc.items);
			const call = http.calls[0];
			expect(call?.route).toBe(tc.route);
			expect(call?.token).toBe(TOKEN);
			// A bodyless GET must not claim a JSON payload it isn't sending.
			expect(call?.contentType).toBeNull();
		});
	}

	test("listCommonSetupScripts returns an empty array, not null or undefined, when the server has none configured yet", async () => {
		const http = stubFetch((req) =>
			req.route === "GET /setup-scripts"
				? jsonResponse({ setupScripts: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await listCommonSetupScripts(TOKEN);

		expect(result).toEqual([]);
		expect(http.calls[0]?.token).toBe(TOKEN);
	});
});

describe("create endpoints (POST, JSON body, Content-Type set, raw response returned)", () => {
	test("createRepoDefinition POSTs the input as the JSON body and returns the created definition verbatim (no envelope)", async () => {
		const input = { owner: "acme", repo: "api" };
		const created = repoDefinition(input);
		const http = stubFetch((req) =>
			req.route === "POST /repo-definitions"
				? jsonResponse(created)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await createRepoDefinition(TOKEN, input);

		expect(result).toEqual(created);
		const call = http.calls[0];
		expect(call?.token).toBe(TOKEN);
		expect(call?.contentType).toBe("application/json");
		expect(call?.body).toEqual(input);
	});

	test("createCommonSetupScript POSTs the input as the JSON body and returns the created script verbatim (no envelope)", async () => {
		const input = { triggerFile: "package.json", script: "bun install" };
		const created = commonSetupScript(input);
		const http = stubFetch((req) =>
			req.route === "POST /setup-scripts"
				? jsonResponse(created)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await createCommonSetupScript(TOKEN, input);

		expect(result).toEqual(created);
		const call = http.calls[0];
		expect(call?.token).toBe(TOKEN);
		expect(call?.contentType).toBe("application/json");
		expect(call?.body).toEqual(input);
	});
});

describe("update endpoints (PUT, percent-encoded id in path, JSON body)", () => {
	test("updateRepoDefinition PUTs to the percent-encoded id and returns the updated definition verbatim", async () => {
		const patch = { enabled: false };
		const updated = repoDefinition({ id: RAW_ID, enabled: false });
		const http = stubFetch((req) =>
			req.route === `PUT /repo-definitions/${ENCODED_ID}`
				? jsonResponse(updated)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await updateRepoDefinition(TOKEN, RAW_ID, patch);

		expect(result).toEqual(updated);
		const call = http.calls[0];
		expect(call?.path).toBe(`/repo-definitions/${ENCODED_ID}`);
		expect(call?.contentType).toBe("application/json");
		expect(call?.body).toEqual(patch);
	});

	test("updateCommonSetupScript PUTs to the percent-encoded id and returns the updated script verbatim", async () => {
		const patch = { script: "bun install --frozen-lockfile" };
		const updated = commonSetupScript({ id: RAW_ID, script: patch.script });
		const http = stubFetch((req) =>
			req.route === `PUT /setup-scripts/${ENCODED_ID}`
				? jsonResponse(updated)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await updateCommonSetupScript(TOKEN, RAW_ID, patch);

		expect(result).toEqual(updated);
		const call = http.calls[0];
		expect(call?.path).toBe(`/setup-scripts/${ENCODED_ID}`);
		expect(call?.contentType).toBe("application/json");
		expect(call?.body).toEqual(patch);
	});

	// updateCommonSetupScript's id and token are both strings passed to the
	// same request() call -- a copy-paste refactor could swap which variable
	// fills which parameter without any type error catching it.
	test("updateCommonSetupScript sends the token as X-Api-Token, not the resource id", async () => {
		const http = stubFetch((req) =>
			req.route === `PUT /setup-scripts/${ENCODED_ID}`
				? jsonResponse(commonSetupScript({ id: RAW_ID }))
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await updateCommonSetupScript(TOKEN, RAW_ID, { script: "bun test" });

		expect(http.calls[0]?.token).toBe(TOKEN);
	});
});

describe("delete endpoints (DELETE, percent-encoded id, no body, resolves undefined without parsing JSON)", () => {
	test("deleteRepoDefinition DELETEs the percent-encoded id, sends no body, and resolves undefined on a 204", async () => {
		const http = stubFetch((req) =>
			req.route === `DELETE /repo-definitions/${ENCODED_ID}`
				? new Response(null, { status: 204 })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(deleteRepoDefinition(TOKEN, RAW_ID)).resolves.toBeUndefined();

		const call = http.calls[0];
		expect(call?.path).toBe(`/repo-definitions/${ENCODED_ID}`);
		expect(call?.method).toBe("DELETE");
		expect(call?.token).toBe(TOKEN);
		// DELETE carries no body, so `request` must not claim a JSON Content-Type it isn't sending.
		expect(call?.contentType).toBeNull();
		expect(call?.rawBody).toBeUndefined();
	});

	test("deleteCommonSetupScript DELETEs the percent-encoded id and resolves undefined on a 204", async () => {
		const http = stubFetch((req) =>
			req.route === `DELETE /setup-scripts/${ENCODED_ID}`
				? new Response(null, { status: 204 })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(
			deleteCommonSetupScript(TOKEN, RAW_ID),
		).resolves.toBeUndefined();

		const call = http.calls[0];
		expect(call?.path).toBe(`/setup-scripts/${ENCODED_ID}`);
		expect(call?.contentType).toBeNull();
	});
});

describe("getCommonSystemPrompt (GET /system-prompt, unwraps systemPrompt)", () => {
	test("returns the unwrapped prompt verbatim when one is configured", async () => {
		const prompt = commonSystemPrompt();
		const http = stubFetch((req) =>
			req.route === "GET /system-prompt"
				? jsonResponse({ systemPrompt: prompt })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await getCommonSystemPrompt(TOKEN);

		expect(result).toEqual(prompt);
		expect(http.calls[0]?.contentType).toBeNull();
	});

	test("returns null verbatim -- the documented 'no common prompt configured' case, not an empty object", async () => {
		stubFetch((req) =>
			req.route === "GET /system-prompt"
				? jsonResponse({ systemPrompt: null })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await getCommonSystemPrompt(TOKEN);

		expect(result).toBeNull();
	});
});

describe("saveCommonSystemPrompt (PUT /system-prompt)", () => {
	test("PUTs {prompt} as the JSON body (not the raw string) and returns the saved prompt verbatim", async () => {
		const saved = commonSystemPrompt({ prompt: "Keep diffs small." });
		const http = stubFetch((req) =>
			req.route === "PUT /system-prompt"
				? jsonResponse(saved)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await saveCommonSystemPrompt(TOKEN, "Keep diffs small.");

		expect(result).toEqual(saved);
		const call = http.calls[0];
		expect(call?.contentType).toBe("application/json");
		expect(call?.body).toEqual({ prompt: "Keep diffs small." });
	});
});

describe("getIncidentEvents (GET /incidents/:id/events, percent-encoded id, unwraps events)", () => {
	test("GETs the percent-encoded incident id and returns the unwrapped events array", async () => {
		const events = [
			incidentEventRecord(),
			incidentEventRecord({ id: "event-2" }),
		];
		const http = stubFetch((req) =>
			req.route === `GET /incidents/${ENCODED_ID}/events`
				? jsonResponse({ events })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const result = await getIncidentEvents(TOKEN, RAW_ID);

		expect(result).toEqual(events);
		const call = http.calls[0];
		expect(call?.path).toBe(`/incidents/${ENCODED_ID}/events`);
		expect(call?.contentType).toBeNull();
	});
});

describe("token and signal handling", () => {
	test("forwards a token containing URL-reserved characters verbatim -- the header is never itself encoded", async () => {
		const weirdToken = "a-b_c.d~e:f/g?h=i&j#k";
		const http = stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await listIncidents(weirdToken);

		expect(http.calls[0]?.token).toBe(weirdToken);
	});

	test("each call sends its own token -- no module-level token cache to fall out of sync when the user changes it", async () => {
		const http = stubFetch((req) =>
			req.route === "GET /incidents"
				? jsonResponse({ incidents: [] })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await listIncidents("tok-first");
		await listIncidents("tok-second");

		expect(http.calls.map((call) => call.token)).toEqual([
			"tok-first",
			"tok-second",
		]);
	});

	test("omitting the optional signal sends no AbortSignal at all, rather than some default object", async () => {
		const http = stubFetch((req) =>
			req.route === "POST /repo-definitions"
				? jsonResponse(repoDefinition())
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await createRepoDefinition(TOKEN, { owner: "acme", repo: "api" });

		expect(http.calls[0]?.signal).toBeNull();
	});
});

describe("AbortSignal pass-through", () => {
	// Every function below takes an optional trailing `signal` -- `request`
	// must forward the exact object, not a copy, or `controller.abort()` in a
	// caller would silently stop doing anything.
	const cases: Array<{
		label: string;
		route: string;
		call: (token: string, signal: AbortSignal) => Promise<unknown>;
	}> = [
		{
			label: "createRepoDefinition",
			route: "POST /repo-definitions",
			call: (token, signal) =>
				createRepoDefinition(token, { owner: "acme", repo: "api" }, signal),
		},
		{
			label: "updateRepoDefinition",
			route: `PUT /repo-definitions/${ENCODED_ID}`,
			call: (token, signal) =>
				updateRepoDefinition(token, RAW_ID, { enabled: false }, signal),
		},
		{
			label: "createCommonSetupScript",
			route: "POST /setup-scripts",
			call: (token, signal) =>
				createCommonSetupScript(
					token,
					{ triggerFile: "package.json", script: "bun install" },
					signal,
				),
		},
		{
			label: "updateCommonSetupScript",
			route: `PUT /setup-scripts/${ENCODED_ID}`,
			call: (token, signal) =>
				updateCommonSetupScript(token, RAW_ID, { script: "bun test" }, signal),
		},
		{
			label: "saveCommonSystemPrompt",
			route: "PUT /system-prompt",
			call: (token, signal) =>
				saveCommonSystemPrompt(token, "Be careful.", signal),
		},
	];

	for (const tc of cases) {
		test(`${tc.label} forwards its AbortSignal to fetch unchanged`, async () => {
			const controller = new AbortController();
			const http = stubFetch((req) =>
				req.route === tc.route
					? jsonResponse({})
					: errorResponse(500, `unexpected route: ${req.route}`),
			);

			await tc.call(TOKEN, controller.signal);

			expect(http.calls[0]?.signal).toBe(controller.signal);
		});
	}
});

describe("error mapping (non-2xx -> ApiError)", () => {
	test("a non-2xx response rejects with an ApiError carrying the status and the response body text as message", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? errorResponse(401, "invalid token")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 401,
			message: "invalid token",
			name: "ApiError",
		});
	});

	test("an error response with an empty body falls back to statusText for the message", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response("", { status: 500, statusText: "Boom" })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 500,
			message: "Boom",
		});
	});

	// A non-empty body and a differing statusText must not resolve the same
	// way -- the body text is the server's actual error message and takes
	// priority; statusText is only the last-resort fallback for an empty body.
	test("a non-2xx response with a non-empty body prefers the body text over statusText for the message", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response("owner is required", {
						status: 400,
						statusText: "Bad Request",
					})
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 400,
			message: "owner is required",
		});
	});

	test('a body-read failure (res.text() rejects) still surfaces as an ApiError, falling back to statusText via the .catch(() => "") branch', async () => {
		stubFetch((req) => {
			if (req.route !== "GET /repo-definitions") {
				return errorResponse(500, `unexpected route: ${req.route}`);
			}
			const res = new Response("", { status: 502, statusText: "Bad Gateway" });
			res.text = () => Promise.reject(new Error("stream aborted"));
			return res;
		});

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 502,
			message: "Bad Gateway",
		});
	});

	test("the rejection is a real ApiError instance (instanceof Error too), not a plain object shaped like one", async () => {
		stubFetch((req) =>
			req.route === "GET /incidents"
				? errorResponse(401, "unauthorized")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		try {
			await listIncidents(TOKEN);
			throw new Error("expected listIncidents to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect(err).toBeInstanceOf(Error);
		}
	});

	// The three cases below cover the same shared `request()` error path
	// exercised through a POST, a PUT, and a DELETE -- guarding against a
	// regression where a mutation swallows a failed response and resolves
	// as if it had succeeded (especially easy to miss on the `void`-returning
	// delete functions).
	test("createRepoDefinition rejects with ApiError, not a resolved value, when the server rejects the input", async () => {
		stubFetch((req) =>
			req.route === "POST /repo-definitions"
				? errorResponse(
						400,
						"  - owner: must match GitHub's owner/repo naming rules",
					)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(
			createRepoDefinition(TOKEN, { owner: "bad owner!", repo: "api" }),
		).rejects.toMatchObject({
			status: 400,
			message: "  - owner: must match GitHub's owner/repo naming rules",
		});
	});

	test("updateCommonSetupScript rejects with ApiError, not a resolved script, when the id does not exist", async () => {
		stubFetch((req) =>
			req.route === `PUT /setup-scripts/${ENCODED_ID}`
				? errorResponse(404, "common setup script not found")
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(
			updateCommonSetupScript(TOKEN, RAW_ID, { triggerFile: "package.json" }),
		).rejects.toMatchObject({
			status: 404,
			message: "common setup script not found",
		});
	});

	// A bodyless 404 (handleDeleteRepoDefinition's `not found` branch sends
	// none) is the one delete failure in this file where api.ts's
	// `res.text() || res.statusText` fallback is load-bearing.
	test("deleteRepoDefinition rejects with ApiError, falling back to statusText, when the id does not exist", async () => {
		stubFetch((req) =>
			req.route === `DELETE /repo-definitions/${ENCODED_ID}`
				? new Response(null, { status: 404, statusText: "Not Found" })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(deleteRepoDefinition(TOKEN, RAW_ID)).rejects.toMatchObject({
			status: 404,
			message: "Not Found",
		});
	});
});

describe("error message sanitization (content-type aware, length-capped)", () => {
	// The dashboard's own handlers (src/ingest/*.ts) always answer failures
	// with a plain-text body. An HTML body only shows up when something
	// below the app layer failed instead -- e.g. Bun's default runtime error
	// page when a store call throws unhandled. That page is not a message
	// for a human operator, so it must never reach the UI verbatim.
	test("a non-2xx response with an HTML body (e.g. a runtime error page) falls back to statusText instead of rendering the markup", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response(
						"<html><body><h1>500 Internal Server Error</h1><pre>TypeError: store.list is not a function</pre></body></html>",
						{
							status: 500,
							statusText: "Internal Server Error",
							headers: { "Content-Type": "text/html; charset=utf-8" },
						},
					)
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 500,
			message: "Internal Server Error",
		});
	});

	test("a non-2xx response with a JSON body falls back to statusText instead of rendering the raw JSON", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response(JSON.stringify({ error: "owner is required" }), {
						status: 400,
						statusText: "Bad Request",
						headers: { "Content-Type": "application/json" },
					})
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 400,
			message: "Bad Request",
		});
	});

	test("a long plain-text body is truncated to the length cap with a trailing ellipsis", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response("x".repeat(600), {
						status: 500,
						statusText: "Server Error",
					})
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const err = await listRepoDefinitions(TOKEN).catch((caught) => caught);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).message).toBe(`${"x".repeat(500)}…`);
	});

	// The cap check is `>`, not `>=`: a body landing exactly at the cap must
	// pass through unmodified, with no ellipsis appended. The 600-char case
	// above can't catch a `>` -> `>=` regression (600 > 500 either way); this
	// one would start failing immediately, truncated to 499 chars plus "…".
	test("a plain-text body exactly at the length cap is returned verbatim, with no ellipsis", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? errorResponse(500, "x".repeat(500))
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		const err = await listRepoDefinitions(TOKEN).catch((caught) => caught);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).message).toBe("x".repeat(500));
	});

	// Distinct from the missing-Content-Type case already covered above --
	// an explicit `text/plain` (with a charset parameter, as real servers
	// send) must also be trusted verbatim, not just an absent header.
	test("a plain-text body with an explicit text/plain content type stays verbatim", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response("owner is required", {
						status: 400,
						statusText: "Bad Request",
						headers: { "Content-Type": "text/plain; charset=utf-8" },
					})
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 400,
			message: "owner is required",
		});
	});

	test("an error response with both an empty body and an empty statusText falls back to `HTTP <status>`", async () => {
		stubFetch((req) =>
			req.route === "GET /repo-definitions"
				? new Response("", { status: 500, statusText: "" })
				: errorResponse(500, `unexpected route: ${req.route}`),
		);

		await expect(listRepoDefinitions(TOKEN)).rejects.toMatchObject({
			status: 500,
			message: "HTTP 500",
		});
	});
});
