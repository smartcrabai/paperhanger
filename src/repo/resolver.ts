/**
 * Repo Resolver: determines which repository the fix agent should operate
 * against, following the fallback chain from docs/spec.md section 3.5:
 *
 *   1. attribute  - an annotation/label/resource-attribute already names the repo
 *   2. mapping    - a configured label matcher -> repo table
 *   3. org-search - dynamic GitHub org search by service name (low confidence
 *                   unless the match is exact; the caller is expected to fall
 *                   back to `report_only` on low confidence, per spec)
 */

import type { Config } from "../config/schema";
import type { Logger } from "../observability/logger";
import type { RepoSearchResult } from "./github";

/** Only the `repos` slice of the app config; keeps this module decoupled from the rest of `Config`. */
export type RepoResolverConfig = Config["repos"];

export type RepoResolutionMethod = "attribute" | "mapping" | "org-search";
export type RepoResolutionConfidence = "high" | "low";

export interface ResolvedRepo {
	owner: string;
	repo: string;
	method: RepoResolutionMethod;
	confidence: RepoResolutionConfidence;
}

/**
 * Inputs available at resolution time. `resourceAttributes` stays a plain
 * `Record<string, string>` (rather than importing a telemetry-specific type)
 * so this module has no dependency on `src/telemetry/`.
 */
export interface ResolveRepoInput {
	labels: Record<string, string>;
	annotations: Record<string, string>;
	resourceAttributes?: Record<string, string>;
}

/**
 * Minimal shape of `GitHubAppClient` this module depends on. Kept as a
 * narrow structural interface (rather than importing the class) so tests can
 * supply a fake without constructing a real client (which needs an RSA key).
 */
export interface RepoSearchClient {
	searchRepositories(query: string): Promise<RepoSearchResult>;
}

/**
 * `owner/repo` reference: one path segment, a literal slash, another path
 * segment. Deliberately conservative (no leading/trailing slash, no nested
 * paths) since a false positive here would point the fix agent at the wrong
 * repository.
 */
const OWNER_REPO_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

function parseOwnerRepo(
	value: string,
): { owner: string; repo: string } | undefined {
	const trimmed = value.trim();
	if (!OWNER_REPO_PATTERN.test(trimmed)) {
		return undefined;
	}
	const slashIndex = trimmed.indexOf("/");
	return {
		owner: trimmed.slice(0, slashIndex),
		repo: trimmed.slice(slashIndex + 1),
	};
}

function pickAttributeValue(
	key: string,
	input: ResolveRepoInput,
): string | undefined {
	return (
		input.annotations[key] ??
		input.labels[key] ??
		input.resourceAttributes?.[key]
	);
}

/** Priority order for guessing a service name out of alert labels, per spec section 3.5. */
function deriveServiceName(labels: Record<string, string>): string | undefined {
	return (
		labels.service ??
		labels.service_name ??
		labels["service.name"] ??
		labels.job ??
		labels.app
	);
}

export class RepoResolver {
	private readonly logger: Logger;

	constructor(
		private readonly config: RepoResolverConfig,
		private readonly githubClient: RepoSearchClient,
		logger: Logger,
	) {
		this.logger = logger.child({ component: "repo-resolver" });
	}

	async resolve(input: ResolveRepoInput): Promise<ResolvedRepo | null> {
		const byAttribute = this.resolveByAttribute(input);
		if (byAttribute) {
			return byAttribute;
		}

		const byMapping = this.resolveByMapping(input.labels);
		if (byMapping) {
			return byMapping;
		}

		return this.resolveByOrgSearch(input.labels);
	}

	/** Step 1: annotation, then label, then resource attribute, checked per key in `attributeKeys` order. */
	private resolveByAttribute(input: ResolveRepoInput): ResolvedRepo | null {
		for (const key of this.config.attributeKeys) {
			const value = pickAttributeValue(key, input);
			if (value === undefined) {
				continue;
			}
			const parsed = parseOwnerRepo(value);
			if (parsed) {
				return {
					owner: parsed.owner,
					repo: parsed.repo,
					method: "attribute",
					confidence: "high",
				};
			}
			this.logger.warn("repo_resolver.attribute.invalid", { key, value });
		}
		return null;
	}

	/** Step 2: first mapping whose `match` is fully satisfied (all keys equal) by `labels`. */
	private resolveByMapping(
		labels: Record<string, string>,
	): ResolvedRepo | null {
		for (const mapping of this.config.mappings) {
			const matches = Object.entries(mapping.match).every(
				([key, value]) => labels[key] === value,
			);
			if (!matches) {
				continue;
			}
			const parsed = parseOwnerRepo(mapping.repo);
			if (!parsed) {
				this.logger.warn("repo_resolver.mapping.invalid", {
					repo: mapping.repo,
				});
				continue;
			}
			return {
				owner: parsed.owner,
				repo: parsed.repo,
				method: "mapping",
				confidence: "high",
			};
		}
		return null;
	}

	/**
	 * Step 3: dynamic org search. Only runs if `orgSearch.enabled`. An exact
	 * (case-insensitive) repo-name match is high confidence; a single
	 * non-exact hit is low confidence; zero or multiple hits resolve to
	 * `null`. The caller decides what "low confidence" means operationally
	 * (spec: fall back to `report_only`) - this method just reports honestly.
	 */
	private async resolveByOrgSearch(
		labels: Record<string, string>,
	): Promise<ResolvedRepo | null> {
		if (!this.config.orgSearch.enabled) {
			return null;
		}
		const org = this.config.orgSearch.org;
		if (!org) {
			this.logger.warn("repo_resolver.org_search.missing_org");
			return null;
		}
		const serviceName = deriveServiceName(labels);
		if (!serviceName) {
			this.logger.warn("repo_resolver.org_search.missing_service_name");
			return null;
		}

		const result = await this.githubClient.searchRepositories(
			`${serviceName} org:${org}`,
		);

		const exactMatch = result.items.find(
			(item) => item.name.toLowerCase() === serviceName.toLowerCase(),
		);
		if (exactMatch) {
			return {
				owner: exactMatch.owner,
				repo: exactMatch.name,
				method: "org-search",
				confidence: "high",
			};
		}

		if (result.items.length === 1) {
			const [only] = result.items;
			if (only) {
				this.logger.info("repo_resolver.org_search.low_confidence", {
					serviceName,
					org,
					repo: only.fullName,
				});
				return {
					owner: only.owner,
					repo: only.name,
					method: "org-search",
					confidence: "low",
				};
			}
		}

		this.logger.info("repo_resolver.org_search.no_match", {
			serviceName,
			org,
			totalCount: result.items.length,
		});
		return null;
	}
}
