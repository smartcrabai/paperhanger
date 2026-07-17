import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IncidentManager } from "../core/incident-manager";
import type { Incident, IncidentEvent } from "../core/types";
import { createLogger } from "../observability/logger";
import type { IncidentStore } from "../storage/types";
import type { SourceAdapter } from "./adapters/types";
import { createServer, parseListLimit } from "./server";

const SECRET = "s3cr3t";
const API_TOKEN = "incidents-api-token";

const testAdapter: SourceAdapter = {
	name: "test-source",
	async parse(req: Request): Promise<IncidentEvent[]> {
		const body = await req.json();
		if (!Array.isArray(body)) {
			throw new Error("expected a JSON array of events");
		}
		return body as IncidentEvent[];
	},
};

function fakeManager(
	onEvent?: (event: IncidentEvent) => void,
): IncidentManager {
	return {
		handleEvent: async (event: IncidentEvent) => {
			onEvent?.(event);
			return { action: "created" };
		},
	} as unknown as IncidentManager;
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
	return {
		id: "incident-1",
		fingerprint: "fp-1",
		source: "grafana",
		status: "report_only",
		severity: "critical",
		title: "High error rate",
		labels: {},
		annotations: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

type IncidentsStoreSlice = Pick<
	IncidentStore,
	"ping" | "getIncident" | "listIncidents"
>;

function fakeStore(
	ready: boolean,
	incidents: Incident[] = [],
): IncidentsStoreSlice {
	return {
		ping: async () => ready,
		getIncident: async (id: string) =>
			incidents.find((incident) => incident.id === id),
		listIncidents: async (limit = 100) => incidents.slice(0, limit),
	};
}

/** A store whose `ping()` rejects instead of resolving `false` (finding 6b). */
function rejectingPingStore(): IncidentsStoreSlice {
	return {
		ping: async () => {
			throw new Error("connection refused");
		},
		getIncident: async () => undefined,
		listIncidents: async () => [],
	};
}

/** A store that records every `limit` value it's called with (finding 6c). */
function recordingLimitStore(receivedLimits: number[]): IncidentsStoreSlice {
	return {
		ping: async () => true,
		getIncident: async () => undefined,
		listIncidents: async (limit = 100) => {
			receivedLimits.push(limit);
			return [];
		},
	};
}

function bearerHeaders(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

describe("ingest server", () => {
	let server: ReturnType<typeof createServer>;
	let baseUrl: string;
	let receivedEvents: IncidentEvent[];

	function startServer(options?: {
		ready?: boolean;
		onEvent?: (event: IncidentEvent) => void;
		incidents?: Incident[];
		/** Omit `server.apiToken` entirely, to exercise the secure-by-default 401. */
		noApiToken?: boolean;
		store?: IncidentsStoreSlice;
	}) {
		receivedEvents = [];
		server = createServer({
			config: {
				server: {
					port: 0,
					apiToken: options?.noApiToken ? undefined : API_TOKEN,
				},
				sources: { "test-source": { secret: SECRET } },
			},
			logger: createLogger({ sink: () => {} }),
			manager: fakeManager(options?.onEvent ?? ((e) => receivedEvents.push(e))),
			adapters: { "test-source": testAdapter },
			store:
				options?.store ??
				fakeStore(options?.ready ?? true, options?.incidents ?? []),
		});
		baseUrl = `http://localhost:${server.port}`;
	}

	beforeEach(() => {
		startServer();
	});

	afterEach(() => {
		server.stop(true);
	});

	test("GET /healthz returns 200", async () => {
		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
	});

	test("GET /readyz returns 200 when the store is ready", async () => {
		const res = await fetch(`${baseUrl}/readyz`);
		expect(res.status).toBe(200);
	});

	test("GET /readyz returns 503 when the store is not ready", async () => {
		server.stop(true);
		startServer({ ready: false });

		const res = await fetch(`${baseUrl}/readyz`);
		expect(res.status).toBe(503);
	});

	test("GET /readyz returns 503 when store.ping() rejects rather than resolving false", async () => {
		server.stop(true);
		startServer({ store: rejectingPingStore() });

		const res = await fetch(`${baseUrl}/readyz`);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("not ready");
	});

	test("unknown routes return 404", async () => {
		const res = await fetch(`${baseUrl}/nope`);
		expect(res.status).toBe(404);
	});

	test("POST /webhooks/:source returns 404 for an unconfigured source", async () => {
		const res = await fetch(`${baseUrl}/webhooks/not-configured`, {
			method: "POST",
			headers: { "x-webhook-token": SECRET },
			body: "[]",
		});
		expect(res.status).toBe(404);
	});

	test("POST /webhooks/:source returns 401 when no token is provided", async () => {
		const res = await fetch(`${baseUrl}/webhooks/test-source`, {
			method: "POST",
			body: "[]",
		});
		expect(res.status).toBe(401);
	});

	test("POST /webhooks/:source returns 401 when the token does not match", async () => {
		const res = await fetch(`${baseUrl}/webhooks/test-source`, {
			method: "POST",
			headers: { "x-webhook-token": "wrong" },
			body: "[]",
		});
		expect(res.status).toBe(401);
	});

	test("POST /webhooks/:source returns 401 for a wrong token of the same length as the secret", async () => {
		// SECRET is "s3cr3t" (6 chars); this differs only in the last
		// character, so a length-only short-circuit in safeCompare would
		// wrongly let it through -- this exercises the byte-by-byte XOR loop.
		expect(SECRET.length).toBe(6);
		const sameLengthWrongToken = "s3cr3x";
		expect(sameLengthWrongToken.length).toBe(SECRET.length);

		const res = await fetch(`${baseUrl}/webhooks/test-source`, {
			method: "POST",
			headers: { "x-webhook-token": sameLengthWrongToken },
			body: "[]",
		});
		expect(res.status).toBe(401);
	});

	test("POST /webhooks/:source returns 401 when the token via query param is wrong", async () => {
		const res = await fetch(`${baseUrl}/webhooks/test-source?token=wrong`, {
			method: "POST",
			body: "[]",
		});
		expect(res.status).toBe(401);
	});

	test("POST /webhooks/:source accepts the token via header", async () => {
		const res = await fetch(`${baseUrl}/webhooks/test-source`, {
			method: "POST",
			headers: { "x-webhook-token": SECRET },
			body: "[]",
		});
		expect(res.status).toBe(202);
	});

	test("POST /webhooks/:source accepts the token via query param", async () => {
		const res = await fetch(`${baseUrl}/webhooks/test-source?token=${SECRET}`, {
			method: "POST",
			body: "[]",
		});
		expect(res.status).toBe(202);
	});

	test("POST /webhooks/:source returns 400 on unparseable payload", async () => {
		const res = await fetch(`${baseUrl}/webhooks/test-source`, {
			method: "POST",
			headers: { "x-webhook-token": SECRET },
			body: JSON.stringify({ not: "an array" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /webhooks/:source returns 202 with the accepted count and forwards events to the manager", async () => {
		const event: IncidentEvent = {
			fingerprint: "fp-1",
			source: "test-source",
			status: "firing",
			severity: "critical",
			title: "Test event",
			labels: {},
			annotations: {},
			startsAt: new Date().toISOString(),
			raw: {},
		};

		const res = await fetch(`${baseUrl}/webhooks/test-source`, {
			method: "POST",
			headers: { "x-webhook-token": SECRET },
			body: JSON.stringify([event, event]),
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: 2 });
		expect(receivedEvents.length).toBe(2);
	});

	describe("GET /incidents and /incidents/:id authentication", () => {
		test("GET /incidents returns 401 with an explanatory body when server.apiToken is not configured", async () => {
			server.stop(true);
			startServer({ noApiToken: true });

			const res = await fetch(`${baseUrl}/incidents`, {
				headers: bearerHeaders(API_TOKEN),
			});
			expect(res.status).toBe(401);
			expect(await res.text()).toContain("server.apiToken is not configured");
		});

		test("GET /incidents/:id returns 401 with an explanatory body when server.apiToken is not configured", async () => {
			server.stop(true);
			startServer({ noApiToken: true });

			const res = await fetch(`${baseUrl}/incidents/incident-1`);
			expect(res.status).toBe(401);
			expect(await res.text()).toContain("server.apiToken is not configured");
		});

		test("GET /incidents returns 401 when no token is provided", async () => {
			const res = await fetch(`${baseUrl}/incidents`);
			expect(res.status).toBe(401);
		});

		test("GET /incidents returns 401 when the wrong bearer token is provided", async () => {
			const res = await fetch(`${baseUrl}/incidents`, {
				headers: bearerHeaders("wrong-token"),
			});
			expect(res.status).toBe(401);
		});

		test("GET /incidents returns 401 for a wrong token of the same length as the configured one", async () => {
			const sameLengthWrongToken = `${API_TOKEN.slice(0, -1)}!`;
			expect(sameLengthWrongToken.length).toBe(API_TOKEN.length);

			const res = await fetch(`${baseUrl}/incidents`, {
				headers: bearerHeaders(sameLengthWrongToken),
			});
			expect(res.status).toBe(401);
		});

		test("GET /incidents accepts a valid token via the Authorization: Bearer header", async () => {
			const res = await fetch(`${baseUrl}/incidents`, {
				headers: bearerHeaders(API_TOKEN),
			});
			expect(res.status).toBe(200);
		});

		test("GET /incidents accepts a valid token via the X-Api-Token header", async () => {
			const res = await fetch(`${baseUrl}/incidents`, {
				headers: { "x-api-token": API_TOKEN },
			});
			expect(res.status).toBe(200);
		});

		test("GET /incidents/:id returns 401 when no token is provided", async () => {
			const res = await fetch(`${baseUrl}/incidents/incident-1`);
			expect(res.status).toBe(401);
		});

		test("GET /incidents/:id accepts a valid token", async () => {
			server.stop(true);
			const incident = makeIncident({ id: "incident-42" });
			startServer({ incidents: [incident] });

			const res = await fetch(`${baseUrl}/incidents/incident-42`, {
				headers: bearerHeaders(API_TOKEN),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual(incident);
		});
	});

	test("GET /incidents/:id returns the incident when it exists", async () => {
		const incident = makeIncident({ id: "incident-42" });
		server.stop(true);
		startServer({ incidents: [incident] });

		const res = await fetch(`${baseUrl}/incidents/incident-42`, {
			headers: bearerHeaders(API_TOKEN),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(incident);
	});

	test("GET /incidents/:id returns 404 for an unknown id", async () => {
		const res = await fetch(`${baseUrl}/incidents/does-not-exist`, {
			headers: bearerHeaders(API_TOKEN),
		});
		expect(res.status).toBe(404);
	});

	test("GET /incidents lists incidents newest-first as reported by the store", async () => {
		const a = makeIncident({ id: "incident-a", fingerprint: "fp-a" });
		const b = makeIncident({ id: "incident-b", fingerprint: "fp-b" });
		server.stop(true);
		startServer({ incidents: [b, a] });

		const res = await fetch(`${baseUrl}/incidents`, {
			headers: bearerHeaders(API_TOKEN),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ incidents: [b, a] });
	});

	test("GET /incidents respects a ?limit= query param", async () => {
		const incidents = [
			makeIncident({ id: "incident-1", fingerprint: "fp-1" }),
			makeIncident({ id: "incident-2", fingerprint: "fp-2" }),
			makeIncident({ id: "incident-3", fingerprint: "fp-3" }),
		];
		server.stop(true);
		startServer({ incidents });

		const res = await fetch(`${baseUrl}/incidents?limit=1`, {
			headers: bearerHeaders(API_TOKEN),
		});
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { incidents: Incident[] }).incidents.length,
		).toBe(1);
	});

	describe("GET /incidents limit clamping (end-to-end)", () => {
		test("clamps a limit above the max down to 500", async () => {
			const receivedLimits: number[] = [];
			server.stop(true);
			startServer({ store: recordingLimitStore(receivedLimits) });

			const res = await fetch(`${baseUrl}/incidents?limit=1000`, {
				headers: bearerHeaders(API_TOKEN),
			});
			expect(res.status).toBe(200);
			expect(receivedLimits).toEqual([500]);
		});

		test("falls back to the default limit for limit=0, a negative limit, and a non-numeric limit", async () => {
			const receivedLimits: number[] = [];
			server.stop(true);
			startServer({ store: recordingLimitStore(receivedLimits) });

			for (const rawLimit of ["0", "-5", "abc"]) {
				const res = await fetch(`${baseUrl}/incidents?limit=${rawLimit}`, {
					headers: bearerHeaders(API_TOKEN),
				});
				expect(res.status).toBe(200);
			}
			expect(receivedLimits).toEqual([100, 100, 100]);
		});
	});
});

describe("parseListLimit", () => {
	function urlWithLimit(raw: string | undefined): URL {
		const url = new URL("http://localhost/incidents");
		if (raw !== undefined) {
			url.searchParams.set("limit", raw);
		}
		return url;
	}

	test("defaults to 100 when no ?limit= is present", () => {
		expect(parseListLimit(urlWithLimit(undefined))).toBe(100);
	});

	test("clamps a limit above 500 down to 500", () => {
		expect(parseListLimit(urlWithLimit("1000"))).toBe(500);
	});

	test("passes through an in-range limit unchanged", () => {
		expect(parseListLimit(urlWithLimit("42"))).toBe(42);
	});

	test("falls back to the default for limit=0", () => {
		expect(parseListLimit(urlWithLimit("0"))).toBe(100);
	});

	test("falls back to the default for a negative limit", () => {
		expect(parseListLimit(urlWithLimit("-5"))).toBe(100);
	});

	test("falls back to the default for a non-numeric limit", () => {
		expect(parseListLimit(urlWithLimit("abc"))).toBe(100);
	});
});
