import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { GitHubApiError, GitHubAppClient } from "./github";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

/** Generates one RSA keypair, exposed as PKCS#1 PEM, PKCS#8 PEM, and an SPKI public key for verification. */
function generateTestKeyMaterial() {
	const { privateKey: pkcs1Pem, publicKey: spkiPem } = generateKeyPairSync(
		"rsa",
		{
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs1", format: "pem" },
		},
	);
	const pkcs8Pem = createPrivateKey(pkcs1Pem)
		.export({ type: "pkcs8", format: "pem" })
		.toString();
	return { pkcs1Pem, pkcs8Pem, spkiPem };
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
	const base64 = pem
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("-----"))
		.join("");
	return Uint8Array.fromBase64(base64);
}

async function importVerifyKey(spkiPem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"spki",
		pemToDer(spkiPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
}

interface DecodedJwt {
	header: { alg: string; typ: string };
	payload: { iat: number; exp: number; iss: string };
	verified: boolean;
}

async function decodeAndVerifyJwt(
	jwt: string,
	verifyKey: CryptoKey,
): Promise<DecodedJwt> {
	const parts = jwt.split(".");
	expect(parts.length).toBe(3);
	const [headerPart, payloadPart, signaturePart] = parts as [
		string,
		string,
		string,
	];
	const header = JSON.parse(
		new TextDecoder().decode(
			Uint8Array.fromBase64(headerPart, { alphabet: "base64url" }),
		),
	);
	const payload = JSON.parse(
		new TextDecoder().decode(
			Uint8Array.fromBase64(payloadPart, { alphabet: "base64url" }),
		),
	);
	const signature = Uint8Array.fromBase64(signaturePart, {
		alphabet: "base64url",
	});
	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		verifyKey,
		signature,
		new TextEncoder().encode(`${headerPart}.${payloadPart}`),
	);
	return { header, payload, verified };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface RecordedCall {
	method: string;
	url: string;
	authorization: string | undefined;
	body: unknown;
}

/** A fake `fetch` that records every call and answers via `responder`. */
function createFakeFetch(
	responder: (call: RecordedCall) => Response | Promise<Response>,
) {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const call: RecordedCall = {
			method,
			url,
			authorization: headers.get("Authorization") ?? undefined,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		return responder(call);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function farFutureExpiry(minutesFromNow: number): string {
	return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

/** Routes the two app-level endpoints every "installation" auth path needs before reaching the real target. */
function installationBootstrapResponse(
	url: string,
	options: { installationId?: number; tokenExpiryMinutes?: number } = {},
): Response | undefined {
	if (url.endsWith("/installation")) {
		return jsonResponse(200, { id: options.installationId ?? 42 });
	}
	if (url.endsWith("/access_tokens")) {
		return jsonResponse(200, {
			token: "installation-token",
			expires_at: farFutureExpiry(options.tokenExpiryMinutes ?? 55),
		});
	}
	return undefined;
}

describe("GitHubAppClient - app JWT", () => {
	test.each([
		["pkcs1", () => generateTestKeyMaterial().pkcs1Pem] as const,
		["pkcs8", () => generateTestKeyMaterial().pkcs8Pem] as const,
	])(
		"signs a valid RS256 JWT from a %s PEM private key",
		async (_label, _pemFactory) => {
			const { pkcs1Pem, pkcs8Pem, spkiPem } = generateTestKeyMaterial();
			const privateKey = _label === "pkcs1" ? pkcs1Pem : pkcs8Pem;
			const verifyKey = await importVerifyKey(spkiPem);

			const { fetchImpl, calls } = createFakeFetch(
				(call) =>
					installationBootstrapResponse(call.url) ??
					jsonResponse(404, { message: "unexpected" }),
			);

			const client = new GitHubAppClient(
				{ appId: "app-123", privateKey },
				silentLogger(),
				fetchImpl,
			);

			const before = Math.floor(Date.now() / 1000);
			await client.getRepoInstallation("acme", "widgets");
			const after = Math.floor(Date.now() / 1000);

			expect(calls.length).toBe(1);
			const auth = calls[0]?.authorization;
			expect(auth).toBeDefined();
			expect(auth?.startsWith("Bearer ")).toBe(true);
			const jwt = (auth as string).slice("Bearer ".length);

			const { header, payload, verified } = await decodeAndVerifyJwt(
				jwt,
				verifyKey,
			);
			expect(verified).toBe(true);
			expect(header.alg).toBe("RS256");
			expect(header.typ).toBe("JWT");
			expect(payload.iss).toBe("app-123");
			expect(payload.exp - payload.iat).toBe(600);
			expect(payload.iat).toBeLessThanOrEqual(before - 59);
			expect(payload.exp).toBeGreaterThanOrEqual(after + 539);
		},
	);

	test("rejects a PEM that is neither PKCS#1 nor PKCS#8", async () => {
		const { fetchImpl } = createFakeFetch(() => jsonResponse(200, { id: 1 }));
		const client = new GitHubAppClient(
			{
				appId: "app-123",
				privateKey:
					"-----BEGIN CERTIFICATE-----\nbogus\n-----END CERTIFICATE-----",
			},
			silentLogger(),
			fetchImpl,
		);
		await expect(client.getRepoInstallation("acme", "widgets")).rejects.toThrow(
			/Unsupported GitHub App private key format/,
		);
	});
});

describe("GitHubAppClient - app JWT caching", () => {
	test("reuses a single JWT across two app-auth calls made within its lifetime", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch(() =>
			jsonResponse(200, { id: 1 }),
		);
		const client = new GitHubAppClient(
			{ appId: "app-123", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await client.getRepoInstallation("acme", "widgets");
		await client.getRepoInstallation("acme", "other");

		expect(calls.length).toBe(2);
		const [first, second] = calls;
		expect(first?.authorization).toBeDefined();
		expect(second?.authorization).toBeDefined();
		// Same JWT reused: identical Authorization header both times.
		expect(second?.authorization).toBe(first?.authorization);
	});

	test("mints a new JWT once the refresh buffer is crossed", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch(() =>
			jsonResponse(200, { id: 1 }),
		);
		const client = new GitHubAppClient(
			{ appId: "app-123", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const nowSpy = spyOn(Date, "now");
		const baseTimeMs = 1_700_000_000_000;
		nowSpy.mockImplementation(() => baseTimeMs);
		try {
			await client.getRepoInstallation("acme", "widgets");

			// Advance past the JWT's ~9-minute lifetime minus the 60s refresh
			// buffer (i.e. past the point where less than 60s of validity
			// remains), forcing a fresh JWT to be minted on the next call.
			nowSpy.mockImplementation(() => baseTimeMs + 9 * 60_000);
			await client.getRepoInstallation("acme", "other");
		} finally {
			nowSpy.mockRestore();
		}

		expect(calls.length).toBe(2);
		const [first, second] = calls;
		expect(second?.authorization).toBeDefined();
		expect(second?.authorization).not.toBe(first?.authorization);
	});
});

describe("GitHubAppClient - installation token caching", () => {
	test("reuses a cached token while it has ample lifetime left", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		let accessTokenCalls = 0;
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.endsWith("/access_tokens")) {
				accessTokenCalls++;
				return jsonResponse(200, {
					token: "tok-1",
					expires_at: farFutureExpiry(55),
				});
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const first = await client.createInstallationToken(42);
		const second = await client.createInstallationToken(42);

		expect(first.token).toBe("tok-1");
		expect(second.token).toBe("tok-1");
		expect(accessTokenCalls).toBe(1);
	});

	test("refreshes the token once less than 5 minutes of lifetime remain", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		let accessTokenCalls = 0;
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.endsWith("/access_tokens")) {
				accessTokenCalls++;
				// Only 2 minutes left: below the 5-minute refresh buffer.
				return jsonResponse(200, {
					token: `tok-${accessTokenCalls}`,
					expires_at: farFutureExpiry(2),
				});
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const first = await client.createInstallationToken(42);
		const second = await client.createInstallationToken(42);

		expect(first.token).toBe("tok-1");
		expect(second.token).toBe("tok-2");
		expect(accessTokenCalls).toBe(2);
	});

	test("forceRefresh bypasses the cache even with ample lifetime left", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		let accessTokenCalls = 0;
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.endsWith("/access_tokens")) {
				accessTokenCalls++;
				return jsonResponse(200, {
					token: `tok-${accessTokenCalls}`,
					expires_at: farFutureExpiry(55),
				});
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const first = await client.createInstallationToken(42);
		const second = await client.createInstallationToken(42, true);

		expect(first.token).toBe("tok-1");
		expect(second.token).toBe("tok-2");
		expect(accessTokenCalls).toBe(2);
	});
});

describe("GitHubAppClient - malformed installation-token response", () => {
	function clientWithAccessTokenResponse(body: unknown) {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.endsWith("/access_tokens")) {
				return jsonResponse(200, body);
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		return new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);
	}

	test("throws GitHubApiError(502) when the response body is empty", async () => {
		const client = clientWithAccessTokenResponse({});
		await expect(client.createInstallationToken(42)).rejects.toMatchObject({
			status: 502,
		});
	});

	test("throws GitHubApiError(502) when token is not a string", async () => {
		const client = clientWithAccessTokenResponse({
			token: 123,
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		});
		await expect(client.createInstallationToken(42)).rejects.toMatchObject({
			status: 502,
		});
	});

	test("throws GitHubApiError(502) when only expires_at is missing (token alone is not enough)", async () => {
		const client = clientWithAccessTokenResponse({ token: "valid-token" });
		await expect(client.createInstallationToken(42)).rejects.toThrow(
			GitHubApiError,
		);
		await expect(client.createInstallationToken(42)).rejects.toMatchObject({
			status: 502,
		});
	});

	test("throws GitHubApiError(502) when only token is missing (expires_at alone is not enough)", async () => {
		const client = clientWithAccessTokenResponse({
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		});
		await expect(client.createInstallationToken(42)).rejects.toThrow(
			GitHubApiError,
		);
		await expect(client.createInstallationToken(42)).rejects.toMatchObject({
			status: 502,
		});
	});
});

describe("GitHubAppClient - 401 retry", () => {
	test("refreshes the installation token once and retries after a 401", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		let labelsCallCount = 0;
		let accessTokenCallCount = 0;
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.endsWith("/installation")) {
				return jsonResponse(200, { id: 42 });
			}
			if (call.url.endsWith("/access_tokens")) {
				accessTokenCallCount++;
				return jsonResponse(200, {
					token: `tok-${accessTokenCallCount}`,
					expires_at: farFutureExpiry(55),
				});
			}
			if (call.url.endsWith("/labels")) {
				labelsCallCount++;
				if (labelsCallCount === 1) {
					return jsonResponse(401, { message: "Bad credentials" });
				}
				return jsonResponse(200, [{ name: "automated-fix" }]);
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await client.addLabels("acme", "widgets", 7, ["automated-fix"]);

		expect(labelsCallCount).toBe(2);
		// One token mint for the first attempt, one forced refresh for the retry.
		expect(accessTokenCallCount).toBe(2);
	});

	test("throws GitHubApiError if the retried request also fails", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		let labelsCallCount = 0;
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.endsWith("/installation")) {
				return jsonResponse(200, { id: 42 });
			}
			if (call.url.endsWith("/access_tokens")) {
				return jsonResponse(200, {
					token: "tok",
					expires_at: farFutureExpiry(55),
				});
			}
			if (call.url.endsWith("/labels")) {
				labelsCallCount++;
				return jsonResponse(401, { message: "Bad credentials" });
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await expect(client.addLabels("acme", "widgets", 7, ["x"])).rejects.toThrow(
			GitHubApiError,
		);
		// Exactly one retry: two attempts against the labels endpoint, no more.
		expect(labelsCallCount).toBe(2);
	});

	test("does not retry an unauthenticated (org-less) search on 401", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		let searchCallCount = 0;
		const { fetchImpl } = createFakeFetch((call) => {
			if (call.url.includes("/search/repositories")) {
				searchCallCount++;
				return jsonResponse(401, { message: "rate limited" });
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await expect(client.searchRepositories("widgets")).rejects.toThrow(
			GitHubApiError,
		);
		expect(searchCallCount).toBe(1);
	});
});

describe("GitHubAppClient - pull requests and labels", () => {
	test("createPullRequest sends the expected payload and maps the response", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			if (call.url.endsWith("/repos/acme/widgets/pulls")) {
				return jsonResponse(201, {
					html_url: "https://github.com/acme/widgets/pull/9",
					number: 9,
				});
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const result = await client.createPullRequest("acme", "widgets", {
			title: "Fix the bug",
			head: "paperhanger/incident-1",
			base: "main",
			body: "Diagnosis summary",
			draft: true,
		});

		expect(result).toEqual({
			url: "https://github.com/acme/widgets/pull/9",
			number: 9,
		});

		const prCall = calls.find((c) => c.url.endsWith("/pulls"));
		expect(prCall?.method).toBe("POST");
		expect(prCall?.body).toEqual({
			title: "Fix the bug",
			head: "paperhanger/incident-1",
			base: "main",
			body: "Diagnosis summary",
			draft: true,
		});
	});

	test("createPullRequest defaults draft to false when omitted", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			return jsonResponse(201, {
				html_url: "https://github.com/a/b/pull/1",
				number: 1,
			});
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await client.createPullRequest("a", "b", {
			title: "t",
			head: "h",
			base: "main",
		});

		const prCall = calls.find((c) => c.url.endsWith("/pulls"));
		const body = prCall?.body as { draft?: boolean } | undefined;
		expect(body?.draft).toBe(false);
	});

	test("addLabels posts the labels array to the issue labels endpoint", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			return jsonResponse(200, [{ name: "automated-fix" }]);
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await client.addLabels("acme", "widgets", 5, [
			"automated-fix",
			"paperhanger",
		]);

		const labelsCall = calls.find((c) => c.url.endsWith("/issues/5/labels"));
		expect(labelsCall?.method).toBe("POST");
		expect(labelsCall?.body).toEqual({
			labels: ["automated-fix", "paperhanger"],
		});
	});

	test("maps a non-2xx response to a GitHubApiError with status and message", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			return jsonResponse(422, { message: "Validation Failed" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const promise = client.createPullRequest("acme", "widgets", {
			title: "t",
			head: "h",
			base: "main",
		});
		await expect(promise).rejects.toThrow(GitHubApiError);
		try {
			await promise;
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(GitHubApiError);
			expect((err as InstanceType<typeof GitHubApiError>).status).toBe(422);
			expect((err as Error).message).toBe("Validation Failed");
		}
	});
});

describe("GitHubAppClient - repo metadata", () => {
	test("getRepo maps the API response and getDefaultBranch reuses it", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			return jsonResponse(200, {
				name: "widgets",
				full_name: "acme/widgets",
				default_branch: "main",
				private: true,
				html_url: "https://github.com/acme/widgets",
				owner: { login: "acme" },
			});
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const repo = await client.getRepo("acme", "widgets");
		expect(repo).toEqual({
			owner: "acme",
			name: "widgets",
			fullName: "acme/widgets",
			defaultBranch: "main",
			private: true,
			htmlUrl: "https://github.com/acme/widgets",
		});

		expect(await client.getDefaultBranch("acme", "widgets")).toBe("main");
	});
});

describe("GitHubAppClient - searchRepositories auth", () => {
	test("resolves an org installation token when the query has an org: qualifier", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch((call) => {
			if (call.url.endsWith("/orgs/acme/installation")) {
				return jsonResponse(200, { id: 99 });
			}
			if (call.url.endsWith("/access_tokens")) {
				return jsonResponse(200, {
					token: "org-token",
					expires_at: farFutureExpiry(55),
				});
			}
			if (call.url.includes("/search/repositories")) {
				return jsonResponse(200, {
					total_count: 1,
					items: [
						{
							name: "widgets",
							full_name: "acme/widgets",
							default_branch: "main",
							private: false,
							html_url: "https://github.com/acme/widgets",
							owner: { login: "acme" },
						},
					],
				});
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const result = await client.searchRepositories("widgets org:acme");

		expect(result.totalCount).toBe(1);
		expect(result.items).toEqual([
			{
				owner: "acme",
				name: "widgets",
				fullName: "acme/widgets",
				defaultBranch: "main",
				private: false,
				htmlUrl: "https://github.com/acme/widgets",
			},
		]);

		const searchCall = calls.find((c) =>
			c.url.includes("/search/repositories"),
		);
		expect(searchCall?.authorization).toBe("Bearer org-token");
	});

	test("falls back to unauthenticated search when the query has no org: qualifier", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch(() =>
			jsonResponse(200, { total_count: 0, items: [] }),
		);
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await client.searchRepositories("widgets");

		expect(calls.length).toBe(1);
		expect(calls[0]?.authorization).toBeUndefined();
	});
});

describe("GitHubAppClient - compareCommits", () => {
	test("maps compare API files and totals additions/deletions", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			if (call.url.includes("/compare/")) {
				return jsonResponse(200, {
					files: [
						{
							filename: "src/index.ts",
							status: "modified",
							additions: 10,
							deletions: 2,
						},
						{
							filename: "src/new.ts",
							status: "added",
							additions: 5,
							deletions: 0,
						},
					],
				});
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const result = await client.compareCommits(
			"acme",
			"widgets",
			"main",
			"paperhanger/incident-1",
		);

		expect(result).toEqual({
			files: [
				{
					filename: "src/index.ts",
					status: "modified",
					additions: 10,
					deletions: 2,
				},
				{ filename: "src/new.ts", status: "added", additions: 5, deletions: 0 },
			],
			totalAdditions: 15,
			totalDeletions: 2,
		});

		const compareCall = calls.find((c) => c.url.includes("/compare/"));
		expect(compareCall?.method).toBe("GET");
		expect(compareCall?.url).toContain(
			"/repos/acme/widgets/compare/main...paperhanger%2Fincident-1",
		);
	});

	test("returns empty totals when the compare response has no files", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			return jsonResponse(200, {});
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		const result = await client.compareCommits(
			"acme",
			"widgets",
			"main",
			"head",
		);
		expect(result).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
	});
});

describe("GitHubAppClient - deleteRef", () => {
	test("sends a DELETE to the git refs endpoint with an unprefixed ref", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl, calls } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			if (call.url.endsWith("/git/refs/heads/paperhanger/incident-1")) {
				return new Response(null, { status: 204 });
			}
			return jsonResponse(404, { message: "unexpected" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await client.deleteRef("acme", "widgets", "heads/paperhanger/incident-1");

		const deleteCall = calls.find((c) => c.url.includes("/git/refs/"));
		expect(deleteCall?.method).toBe("DELETE");
		expect(deleteCall?.url).toContain(
			"/repos/acme/widgets/git/refs/heads/paperhanger/incident-1",
		);
	});

	test("throws GitHubApiError when the ref does not exist", async () => {
		const { pkcs8Pem } = generateTestKeyMaterial();
		const { fetchImpl } = createFakeFetch((call) => {
			const bootstrapped = installationBootstrapResponse(call.url);
			if (bootstrapped) {
				return bootstrapped;
			}
			return jsonResponse(422, { message: "Reference does not exist" });
		});
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: pkcs8Pem },
			silentLogger(),
			fetchImpl,
		);

		await expect(
			client.deleteRef("acme", "widgets", "heads/missing-branch"),
		).rejects.toThrow(GitHubApiError);
	});
});

describe("GitHubAppClient - request timeout", () => {
	/** A `fetch` whose returned promise only ever settles by rejecting on abort. */
	function hangingFetch(): typeof fetch {
		return (async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}) as typeof fetch;
	}

	test("throws a typed GitHubApiError instead of hanging forever", async () => {
		const client = new GitHubAppClient(
			{
				appId: "1",
				privateKey: generateTestKeyMaterial().pkcs8Pem,
				timeoutMs: 10,
			},
			silentLogger(),
			hangingFetch(),
		);

		let caught: unknown;
		try {
			await client.getRepoInstallation("acme", "widgets");
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(GitHubApiError);
		expect((caught as InstanceType<typeof GitHubApiError>).status).toBe(504);
		expect((caught as Error).message).toContain("timed out after 10ms");
	});

	test("resolves normally when the response arrives before the timeout", async () => {
		const { fetchImpl } = createFakeFetch(() => jsonResponse(200, { id: 1 }));
		const client = new GitHubAppClient(
			{
				appId: "1",
				privateKey: generateTestKeyMaterial().pkcs8Pem,
				timeoutMs: 5_000,
			},
			silentLogger(),
			fetchImpl,
		);

		await expect(
			client.getRepoInstallation("acme", "widgets"),
		).resolves.toEqual({ id: 1 });
	});
});

describe("GitHubAppClient - cloneUrlWithToken", () => {
	test("uses github.com for the default api.github.com base URL", () => {
		const client = new GitHubAppClient(
			{ appId: "1", privateKey: generateTestKeyMaterial().pkcs8Pem },
			silentLogger(),
		);
		expect(client.cloneUrlWithToken("acme", "widgets", "tok")).toBe(
			"https://x-access-token:tok@github.com/acme/widgets.git",
		);
	});

	test("derives the host from a GitHub Enterprise Server base URL", () => {
		const client = new GitHubAppClient(
			{
				appId: "1",
				privateKey: generateTestKeyMaterial().pkcs8Pem,
				baseUrl: "https://ghe.example.com/api/v3",
			},
			silentLogger(),
		);
		expect(client.cloneUrlWithToken("acme", "widgets", "tok")).toBe(
			"https://x-access-token:tok@ghe.example.com/acme/widgets.git",
		);
	});
});
