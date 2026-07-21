/**
 * GitHub App integration: JWT-based app authentication, installation token
 * exchange/caching, and the small set of REST calls the resolver and (future)
 * fix agent need. See docs/spec.md section 3.7.
 *
 * Auth model recap (see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app):
 * - The **app JWT** (signed with the App's private key) only works against a
 *   handful of "app-level" endpoints: `GET /app`, `GET /repos/{owner}/{repo}/installation`,
 *   `GET /orgs/{org}/installation`, `POST /app/installations/{id}/access_tokens`.
 * - Every other REST call (reading repo metadata, searching repositories,
 *   creating pull requests, adding labels, ...) requires an **installation
 *   access token**, minted via the endpoint above. `GET /search/repositories`
 *   in particular does NOT accept the app JWT; without an installation token
 *   it silently degrades to an unauthenticated, public-only search. This
 *   client therefore always resolves an installation token for the org
 *   embedded in a search query (via the `org:` qualifier) before searching,
 *   and only falls back to unauthenticated search when no org is present.
 */

import {
	context,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { Logger } from "../observability/logger";

const DEFAULT_BASE_URL = "https://api.github.com";

/** Clock skew allowance: the JWT `iat` is backdated by this many seconds. */
const APP_JWT_ISSUED_AT_SKEW_SECONDS = 60;
/** GitHub caps app JWT validity at 10 minutes; stay comfortably under that. */
const APP_JWT_LIFETIME_SECONDS = 540;
/** Regenerate the cached app JWT once less than this much lifetime remains. */
const APP_JWT_REFRESH_BUFFER_SECONDS = 60;
/** Refresh a cached installation token once less than this much lifetime remains. */
const INSTALLATION_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** Default per-request timeout for all REST calls; overridable via `GitHubAppClientOptions.timeoutMs`. */
const DEFAULT_GITHUB_API_TIMEOUT_MS = 30_000;

/** Thrown for any non-2xx GitHub API response. */
export class GitHubApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, message: string, body?: unknown) {
		super(message);
		this.name = "GitHubApiError";
		this.status = status;
		this.body = body;
	}
}

export interface GitHubAppClientOptions {
	appId: string;
	/** PEM-encoded private key. Accepts PKCS#1 ("BEGIN RSA PRIVATE KEY") or PKCS#8 ("BEGIN PRIVATE KEY"). */
	privateKey: string;
	/** REST API base URL. Defaults to github.com; set to `https://HOST/api/v3` for GitHub Enterprise Server. */
	baseUrl?: string;
	/** Per-request timeout in milliseconds for all REST calls. Defaults to `DEFAULT_GITHUB_API_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

export interface Installation {
	id: number;
}

export interface InstallationToken {
	token: string;
	/** ISO 8601 expiry timestamp, as returned by GitHub. */
	expiresAt: string;
}

export interface GitHubRepo {
	owner: string;
	name: string;
	fullName: string;
	defaultBranch: string;
	private: boolean;
	htmlUrl: string;
}

export interface RepoSearchResult {
	totalCount: number;
	items: GitHubRepo[];
}

export interface CreatePullRequestInput {
	title: string;
	head: string;
	base: string;
	body?: string;
	draft?: boolean;
}

export interface CreatePullRequestResult {
	url: string;
	number: number;
}

interface CachedInstallationToken extends InstallationToken {
	expiresAtMs: number;
}

type AuthMode =
	| { readonly type: "app" }
	| { readonly type: "installation"; readonly installationId: number }
	| { readonly type: "none" };

interface GitHubRepoApiResponse {
	name: string;
	full_name: string;
	default_branch: string;
	private: boolean;
	html_url: string;
	owner: { login: string };
}

interface GitHubSearchRepositoriesApiResponse {
	total_count: number;
	items: GitHubRepoApiResponse[];
}

interface CreateInstallationTokenApiResponse {
	token: string;
	expires_at: string;
}

interface CreatePullRequestApiResponse {
	html_url: string;
	number: number;
}

interface GitHubCompareFileApiResponse {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
}

interface GitHubCompareApiResponse {
	files?: GitHubCompareFileApiResponse[];
}

export interface CompareCommitsFile {
	filename: string;
	/** GitHub's file status for this comparison, e.g. "added" / "modified" / "removed" / "renamed". */
	status: string;
	additions: number;
	deletions: number;
}

export interface CompareCommitsResult {
	files: CompareCommitsFile[];
	totalAdditions: number;
	totalDeletions: number;
}

const ORG_QUALIFIER_PATTERN = /\borg:(\S+)/i;

function extractOrgQualifier(query: string): string | undefined {
	return ORG_QUALIFIER_PATTERN.exec(query)?.[1];
}

/** Derives the git clone host from the REST API base URL (github.com <-> api.github.com). */
function deriveGitHost(baseUrl: string): string {
	const hostname = new URL(baseUrl).hostname;
	return hostname === "api.github.com" ? "github.com" : hostname;
}

function mapRepo(data: GitHubRepoApiResponse): GitHubRepo {
	return {
		owner: data.owner.login,
		name: data.name,
		fullName: data.full_name,
		defaultBranch: data.default_branch,
		private: data.private,
		htmlUrl: data.html_url,
	};
}

async function readErrorBody(res: Response): Promise<unknown> {
	const text = await res.text().catch(() => "");
	if (text.length === 0) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function extractErrorMessage(body: unknown, res: Response): string {
	if (
		body !== null &&
		typeof body === "object" &&
		"message" in body &&
		typeof (body as { message: unknown }).message === "string"
	) {
		return (body as { message: string }).message;
	}
	if (typeof body === "string" && body.length > 0) {
		return body;
	}
	return (
		res.statusText || `GitHub API request failed with status ${res.status}`
	);
}

function base64UrlEncode(bytes: Uint8Array): string {
	return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function base64UrlEncodeJson(value: unknown): string {
	return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

type PemFormat = "pkcs1" | "pkcs8";

interface ParsedPem {
	der: Uint8Array<ArrayBuffer>;
	format: PemFormat;
}

/**
 * Parses a PEM-encoded RSA private key, accepting either PKCS#1
 * ("-----BEGIN RSA PRIVATE KEY-----", GitHub's default download format) or
 * PKCS#8 ("-----BEGIN PRIVATE KEY-----"). Also unescapes literal `\n`
 * sequences, since private keys sourced from a single-line environment
 * variable commonly arrive that way.
 */
function parsePemPrivateKey(pem: string): ParsedPem {
	const normalized =
		pem.includes("\\n") && !pem.includes("\n")
			? pem.replace(/\\n/g, "\n").trim()
			: pem.trim();

	let format: PemFormat;
	if (normalized.includes("BEGIN RSA PRIVATE KEY")) {
		format = "pkcs1";
	} else if (normalized.includes("BEGIN PRIVATE KEY")) {
		format = "pkcs8";
	} else {
		throw new Error(
			'Unsupported GitHub App private key format: expected a PEM block starting with "-----BEGIN RSA PRIVATE KEY-----" (PKCS#1) or "-----BEGIN PRIVATE KEY-----" (PKCS#8)',
		);
	}

	const base64 = normalized
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("-----"))
		.join("");
	const der = Uint8Array.fromBase64(base64);
	return { der, format };
}

/** DER SEQUENCE for the RSA `AlgorithmIdentifier` (rsaEncryption OID, NULL params). */
const RSA_ALGORITHM_IDENTIFIER_DER = Uint8Array.of(
	0x30,
	0x0d,
	0x06,
	0x09,
	0x2a,
	0x86,
	0x48,
	0x86,
	0xf7,
	0x0d,
	0x01,
	0x01,
	0x01,
	0x05,
	0x00,
);

function encodeDerLength(length: number): number[] {
	if (length < 0x80) {
		return [length];
	}
	const bytes: number[] = [];
	let remaining = length;
	while (remaining > 0) {
		bytes.unshift(remaining & 0xff);
		remaining = Math.floor(remaining / 256);
	}
	return [0x80 | bytes.length, ...bytes];
}

/**
 * Concatenates byte arrays into a freshly allocated `Uint8Array<ArrayBuffer>`.
 * Using `new Uint8Array(length)` (rather than `Uint8Array.from`/spreads)
 * guarantees an `ArrayBuffer`-backed result, which is what WebCrypto's
 * `BufferSource` parameters require (a plain `Uint8Array` can otherwise be
 * backed by a `SharedArrayBuffer`, which `importKey` rejects at the type level).
 */
function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function derTlv(tag: number, contents: Uint8Array): Uint8Array<ArrayBuffer> {
	return concatBytes(
		Uint8Array.of(tag, ...encodeDerLength(contents.length)),
		contents,
	);
}

/**
 * Wraps a PKCS#1 `RSAPrivateKey` DER blob in a PKCS#8 `PrivateKeyInfo`
 * structure, since WebCrypto's `importKey("pkcs8", ...)` does not accept
 * PKCS#1 directly:
 *
 * ```
 * PrivateKeyInfo ::= SEQUENCE {
 *   version                   INTEGER (0),
 *   privateKeyAlgorithm       AlgorithmIdentifier,  -- rsaEncryption, NULL params
 *   privateKey                OCTET STRING          -- the PKCS#1 DER, verbatim
 * }
 * ```
 */
function wrapPkcs1AsPkcs8(pkcs1Der: Uint8Array): Uint8Array<ArrayBuffer> {
	const version = Uint8Array.of(0x02, 0x01, 0x00);
	const privateKeyOctetString = derTlv(0x04, pkcs1Der);
	const body = concatBytes(
		version,
		RSA_ALGORITHM_IDENTIFIER_DER,
		privateKeyOctetString,
	);
	return derTlv(0x30, body);
}

async function importSigningKey(pem: string): Promise<CryptoKey> {
	const { der, format } = parsePemPrivateKey(pem);
	const pkcs8Der: Uint8Array<ArrayBuffer> =
		format === "pkcs1" ? wrapPkcs1AsPkcs8(der) : der;
	return crypto.subtle.importKey(
		"pkcs8",
		pkcs8Der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function signAppJwt(
	appId: string,
	key: CryptoKey,
	nowSeconds: number,
): Promise<{ token: string; expiresAtSeconds: number }> {
	const iat = nowSeconds - APP_JWT_ISSUED_AT_SKEW_SECONDS;
	const exp = nowSeconds + APP_JWT_LIFETIME_SECONDS;
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat, exp, iss: appId };
	const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	const token = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
	return { token, expiresAtSeconds: exp };
}

function repoKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
}

/**
 * GitHub App REST client: mints its own JWT and installation tokens, caching
 * both in memory. See the module doc comment above for the auth model.
 */
export class GitHubAppClient {
	private readonly appId: string;
	private readonly privateKey: string;
	private readonly baseUrl: string;
	private readonly gitHost: string;
	private readonly logger: Logger;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly tracer: Tracer;

	private signingKeyPromise: Promise<CryptoKey> | undefined;
	private appJwtCache: { token: string; expiresAtSeconds: number } | undefined;
	private readonly installationTokenCache = new Map<
		number,
		CachedInstallationToken
	>();
	private readonly repoInstallationCache = new Map<string, number>();
	private readonly orgInstallationCache = new Map<string, number>();

	constructor(
		options: GitHubAppClientOptions,
		logger: Logger,
		fetchImpl: typeof fetch = fetch,
		tracer?: Tracer,
	) {
		this.appId = options.appId;
		this.privateKey = options.privateKey;
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.gitHost = deriveGitHost(this.baseUrl);
		this.logger = logger.child({ component: "github-app-client" });
		this.fetchImpl = fetchImpl;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_API_TIMEOUT_MS;
		this.tracer = tracer ?? trace.getTracer("github-app-client");
	}

	/** `GET /repos/{owner}/{repo}/installation`. Requires the app JWT. */
	async getRepoInstallation(
		owner: string,
		repo: string,
	): Promise<Installation> {
		const installation = await this.request<Installation>(
			"GET",
			`/repos/${owner}/${repo}/installation`,
			{ type: "app" },
		);
		this.repoInstallationCache.set(repoKey(owner, repo), installation.id);
		return installation;
	}

	/**
	 * `POST /app/installations/{id}/access_tokens`. Cached in memory per
	 * installation; refreshed automatically once less than 5 minutes remain.
	 * Pass `forceRefresh: true` to bypass the cache (used for 401 recovery).
	 */
	async createInstallationToken(
		installationId: number,
		forceRefresh = false,
	): Promise<InstallationToken> {
		const cached = this.installationTokenCache.get(installationId);
		if (
			!forceRefresh &&
			cached &&
			cached.expiresAtMs - Date.now() > INSTALLATION_TOKEN_REFRESH_BUFFER_MS
		) {
			return { token: cached.token, expiresAt: cached.expiresAt };
		}

		const data = await this.request<CreateInstallationTokenApiResponse>(
			"POST",
			`/app/installations/${installationId}/access_tokens`,
			{ type: "app" },
		);
		if (typeof data.token !== "string" || typeof data.expires_at !== "string") {
			throw new GitHubApiError(
				502,
				"Malformed installation token response from GitHub API",
				data,
			);
		}
		const result: CachedInstallationToken = {
			token: data.token,
			expiresAt: data.expires_at,
			expiresAtMs: Date.parse(data.expires_at),
		};
		this.installationTokenCache.set(installationId, result);
		return { token: result.token, expiresAt: result.expiresAt };
	}

	/** `GET /repos/{owner}/{repo}`, authenticated as the repo's installation. */
	async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
		const installationId = await this.resolveRepoInstallationId(owner, repo);
		const data = await this.request<GitHubRepoApiResponse>(
			"GET",
			`/repos/${owner}/${repo}`,
			{ type: "installation", installationId },
		);
		return mapRepo(data);
	}

	async getDefaultBranch(owner: string, repo: string): Promise<string> {
		return (await this.getRepo(owner, repo)).defaultBranch;
	}

	/**
	 * `GET /search/repositories`. The search endpoint does not accept the app
	 * JWT, so this resolves an installation token for the org named in the
	 * query's `org:` qualifier (as used by the org-search resolver step). If
	 * the query has no `org:` qualifier, falls back to an unauthenticated
	 * request (public repositories only) and logs a warning, since there is
	 * no installation to resolve a token for.
	 */
	async searchRepositories(query: string): Promise<RepoSearchResult> {
		const org = extractOrgQualifier(query);
		let auth: AuthMode;
		if (org !== undefined) {
			const installationId = await this.resolveOrgInstallationId(org);
			auth = { type: "installation", installationId };
		} else {
			this.logger.warn("github.search.no_org_qualifier", { query });
			auth = { type: "none" };
		}

		const data = await this.request<GitHubSearchRepositoriesApiResponse>(
			"GET",
			`/search/repositories?q=${encodeURIComponent(query)}`,
			auth,
		);
		return { totalCount: data.total_count, items: data.items.map(mapRepo) };
	}

	async createPullRequest(
		owner: string,
		repo: string,
		input: CreatePullRequestInput,
	): Promise<CreatePullRequestResult> {
		const installationId = await this.resolveRepoInstallationId(owner, repo);
		const data = await this.request<CreatePullRequestApiResponse>(
			"POST",
			`/repos/${owner}/${repo}/pulls`,
			{ type: "installation", installationId },
			{
				title: input.title,
				head: input.head,
				base: input.base,
				body: input.body,
				draft: input.draft ?? false,
			},
		);
		return { url: data.html_url, number: data.number };
	}

	async addLabels(
		owner: string,
		repo: string,
		issueNumber: number,
		labels: string[],
	): Promise<void> {
		const installationId = await this.resolveRepoInstallationId(owner, repo);
		await this.request<unknown>(
			"POST",
			`/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
			{ type: "installation", installationId },
			{ labels },
		);
	}

	/**
	 * `GET /repos/{owner}/{repo}/compare/{base}...{head}`. Used by the fix
	 * agent's guardrail check (M5) to inspect the actual changed files/line
	 * counts of a pushed branch before a PR is created, independent of
	 * whatever the agent itself reported.
	 */
	async compareCommits(
		owner: string,
		repo: string,
		base: string,
		head: string,
	): Promise<CompareCommitsResult> {
		const installationId = await this.resolveRepoInstallationId(owner, repo);
		const data = await this.request<GitHubCompareApiResponse>(
			"GET",
			`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
			{ type: "installation", installationId },
		);
		const files: CompareCommitsFile[] = (data.files ?? []).map((file) => ({
			filename: file.filename,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
		}));
		return {
			files,
			totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
			totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
		};
	}

	/**
	 * `DELETE /repos/{owner}/{repo}/git/refs/{ref}`. `ref` follows GitHub's own
	 * convention and must NOT include the leading `refs/` segment, e.g.
	 * `heads/paperhanger/incident-123`. Used to clean up a branch the fix
	 * agent pushed after a guardrail violation, so a rejected fix never
	 * lingers as a pushable branch.
	 */
	async deleteRef(owner: string, repo: string, ref: string): Promise<void> {
		const installationId = await this.resolveRepoInstallationId(owner, repo);
		await this.request<unknown>(
			"DELETE",
			`/repos/${owner}/${repo}/git/refs/${ref}`,
			{ type: "installation", installationId },
		);
	}

	/** Builds an authenticated HTTPS clone URL. `host` is derived from `baseUrl` (github.com for the default API host). */
	cloneUrlWithToken(owner: string, repo: string, token: string): string {
		return `https://x-access-token:${token}@${this.gitHost}/${owner}/${repo}.git`;
	}

	private async resolveRepoInstallationId(
		owner: string,
		repo: string,
	): Promise<number> {
		const cached = this.repoInstallationCache.get(repoKey(owner, repo));
		if (cached !== undefined) {
			return cached;
		}
		const installation = await this.getRepoInstallation(owner, repo);
		return installation.id;
	}

	private async resolveOrgInstallationId(org: string): Promise<number> {
		const cached = this.orgInstallationCache.get(org);
		if (cached !== undefined) {
			return cached;
		}
		const installation = await this.request<Installation>(
			"GET",
			`/orgs/${org}/installation`,
			{ type: "app" },
		);
		this.orgInstallationCache.set(org, installation.id);
		return installation.id;
	}

	private getSigningKey(): Promise<CryptoKey> {
		if (!this.signingKeyPromise) {
			this.signingKeyPromise = importSigningKey(this.privateKey);
		}
		return this.signingKeyPromise;
	}

	private async getAppJwt(forceRefresh: boolean): Promise<string> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		if (
			!forceRefresh &&
			this.appJwtCache &&
			this.appJwtCache.expiresAtSeconds - nowSeconds >
				APP_JWT_REFRESH_BUFFER_SECONDS
		) {
			return this.appJwtCache.token;
		}
		const key = await this.getSigningKey();
		const { token, expiresAtSeconds } = await signAppJwt(
			this.appId,
			key,
			nowSeconds,
		);
		this.appJwtCache = { token, expiresAtSeconds };
		return token;
	}

	private async tokenFor(
		auth: AuthMode,
		forceRefresh: boolean,
	): Promise<string | undefined> {
		if (auth.type === "app") {
			return this.getAppJwt(forceRefresh);
		}
		if (auth.type === "installation") {
			return (
				await this.createInstallationToken(auth.installationId, forceRefresh)
			).token;
		}
		return undefined;
	}

	/**
	 * Issues one authenticated REST call and returns both the parsed body and
	 * the HTTP status, so callers (namely `request()`, for its `github.request`
	 * span's `http.response.status_code` attribute) can observe the status of a
	 * *successful* response too, not just a thrown `GitHubApiError`'s.
	 */
	private async fetchJson<T>(
		method: string,
		path: string,
		token: string | undefined,
		body?: Record<string, unknown>,
	): Promise<{ data: T; status: number }> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "paperhanger",
		};
		if (token !== undefined) {
			headers.Authorization = `Bearer ${token}`;
		}
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);

		let res: Response;
		try {
			res = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
		} catch (err) {
			if (timedOut || controller.signal.aborted) {
				throw new GitHubApiError(
					504,
					`GitHub API request timed out after ${this.timeoutMs}ms`,
				);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}

		if (!res.ok) {
			const errorBody = await readErrorBody(res);
			throw new GitHubApiError(
				res.status,
				extractErrorMessage(errorBody, res),
				errorBody,
			);
		}
		if (res.status === 204) {
			return { data: undefined as T, status: res.status };
		}
		return { data: (await res.json()) as T, status: res.status };
	}

	/**
	 * Issues a request with the given auth mode, resolving/caching whatever
	 * credential that mode needs. On a 401, refreshes the credential once
	 * (bypassing its cache) and retries exactly once before giving up.
	 *
	 * Wrapped in a single `github.request` CLIENT span per logical operation
	 * (the 401 retry, when it fires, nests inside the same span rather than
	 * getting one of its own). `paperhanger.github.path` is truncated at the
	 * first `?`: some callers (`searchRepositories`) build the query string
	 * from upstream-controlled free text (alert labels), which must never be
	 * recorded, while the path segment itself (including owner/repo
	 * identifiers) is fine.
	 */
	private async request<T>(
		method: string,
		path: string,
		auth: AuthMode,
		body?: Record<string, unknown>,
	): Promise<T> {
		const span = this.tracer.startSpan("github.request", {
			kind: SpanKind.CLIENT,
		});
		span.setAttribute("http.request.method", method);
		span.setAttribute("paperhanger.github.path", path.split("?")[0] ?? path);

		// Activate the span so logger calls inside this body (e.g. the 401
		// retry warning) correlate to it rather than to whatever span was
		// active on the caller's side.
		return context.with(trace.setSpan(context.active(), span), async () => {
			try {
				const token = await this.tokenFor(auth, false);
				try {
					const { data, status } = await this.fetchJson<T>(
						method,
						path,
						token,
						body,
					);
					span.setAttribute("http.response.status_code", status);
					return data;
				} catch (err) {
					if (
						err instanceof GitHubApiError &&
						err.status === 401 &&
						auth.type !== "none"
					) {
						this.logger.warn("github.request.retry_after_401", {
							method,
							path,
							authType: auth.type,
						});
						span.setAttribute("paperhanger.github.auth_retried", true);
						const refreshedToken = await this.tokenFor(auth, true);
						const { data, status } = await this.fetchJson<T>(
							method,
							path,
							refreshedToken,
							body,
						);
						span.setAttribute("http.response.status_code", status);
						return data;
					}
					throw err;
				}
			} catch (err) {
				if (err instanceof GitHubApiError) {
					// GitHubApiError.message can embed the RAW response body verbatim
					// (see readErrorBody/extractErrorMessage above) -- e.g. an HTML
					// error page from a proxy/WAF in front of GitHub, unbounded and
					// unredacted. Never pass it to recordException or into the span
					// status message; http.response.status_code (set here) already
					// carries the actionable signal for a span.
					span.setAttribute("http.response.status_code", err.status);
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: `GitHub request failed (status=${err.status})`,
					});
				} else {
					// Non-GitHubApiError exceptions originate locally (e.g. an
					// AbortError surfaced before the timeout mapping below, or a
					// programming error) and carry no upstream-controlled content,
					// so recording the full exception is safe here.
					const message = err instanceof Error ? err.message : String(err);
					span.recordException(err instanceof Error ? err : new Error(message));
					span.setStatus({ code: SpanStatusCode.ERROR, message });
				}
				throw err;
			} finally {
				span.end();
			}
		});
	}
}
