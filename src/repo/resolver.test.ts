import { describe, expect, test } from "bun:test";
import type { RepoDefinition } from "../core/types";
import { createLogger } from "../observability/logger";
import type { RepoSearchResult } from "./github";
import {
	type RepoDefinitionSource,
	type RepoResolverConfig,
	type RepoSearchClient,
	RepoResolver,
	type ResolveRepoInput,
} from "./resolver";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

function collectingLogger(): {
	logger: ReturnType<typeof createLogger>;
	lines: string[];
} {
	const lines: string[] = [];
	return { logger: createLogger({ sink: (line) => lines.push(line) }), lines };
}

function baseConfig(
	overrides: Partial<RepoResolverConfig> = {},
): RepoResolverConfig {
	return {
		attributeKeys: [],
		mappings: [],
		orgSearch: { enabled: false },
		...overrides,
	};
}

function baseInput(
	overrides: Partial<ResolveRepoInput> = {},
): ResolveRepoInput {
	return {
		labels: {},
		annotations: {},
		...overrides,
	};
}

/** Throws if called - used to assert a later resolution step was never reached. */
class UnreachableSearchClient implements RepoSearchClient {
	searchRepositories(): Promise<RepoSearchResult> {
		throw new Error("searchRepositories should not have been called");
	}
}

class StubSearchClient implements RepoSearchClient {
	public readonly calls: string[] = [];
	constructor(private readonly result: RepoSearchResult) {}

	async searchRepositories(query: string): Promise<RepoSearchResult> {
		this.calls.push(query);
		return this.result;
	}
}

function repoItem(
	owner: string,
	name: string,
	overrides: Partial<RepoSearchResult["items"][number]> = {},
) {
	return {
		owner,
		name,
		fullName: `${owner}/${name}`,
		defaultBranch: "main",
		private: false,
		htmlUrl: `https://github.com/${owner}/${name}`,
		...overrides,
	};
}

function repoDefinition(
	overrides: Partial<RepoDefinition> = {},
): RepoDefinition {
	return {
		id: crypto.randomUUID(),
		owner: "acme",
		repo: "widgets",
		mappings: [],
		enabled: true,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		...overrides,
	};
}

/** A `RepoDefinitionSource` that always returns `[]` - the default when a test doesn't care about the definition step. */
function noDefinitions(): RepoDefinitionSource {
	return { listRepoDefinitions: async () => [] };
}

class StubDefinitionSource implements RepoDefinitionSource {
	constructor(private readonly definitions: RepoDefinition[]) {}

	async listRepoDefinitions(): Promise<RepoDefinition[]> {
		return this.definitions;
	}
}

/** A `RepoDefinitionSource` whose `listRepoDefinitions` always rejects - used to assert store-error fallthrough. */
class FailingDefinitionSource implements RepoDefinitionSource {
	async listRepoDefinitions(): Promise<RepoDefinition[]> {
		throw new Error("listRepoDefinitions should have failed for this test");
	}
}

describe("RepoResolver - priority order", () => {
	test("attribute resolution short-circuits mapping and org search", async () => {
		const config = baseConfig({
			attributeKeys: ["repository"],
			mappings: [{ match: { service: "my-api" }, repo: "should-not/be-used" }],
			orgSearch: { enabled: true, org: "acme" },
		});
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({
				annotations: { repository: "acme/widgets" },
				labels: { service: "my-api" },
			}),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		});
	});

	test("mapping resolution short-circuits org search", async () => {
		const config = baseConfig({
			mappings: [{ match: { service: "my-api" }, repo: "acme/my-api" }],
			orgSearch: { enabled: true, org: "acme" },
		});
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "my-api",
			method: "mapping",
			confidence: "high",
		});
	});

	test("falls through to org search when neither attribute nor mapping match", async () => {
		const config = baseConfig({
			attributeKeys: ["repository"],
			mappings: [{ match: { service: "other" }, repo: "acme/other" }],
			orgSearch: { enabled: true, org: "acme" },
		});
		const searchClient = new StubSearchClient({
			totalCount: 1,
			items: [repoItem("acme", "my-api")],
		});
		const resolver = new RepoResolver(
			config,
			searchClient,
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(searchClient.calls).toEqual(["my-api org:acme"]);
		expect(result).toEqual({
			owner: "acme",
			repo: "my-api",
			method: "org-search",
			confidence: "high",
		});
	});

	test("attribute resolution short-circuits a matching enabled definition", async () => {
		const config = baseConfig({ attributeKeys: ["repository"] });
		const definitions = new StubDefinitionSource([
			repoDefinition({
				owner: "acme",
				repo: "from-definition",
				mappings: [{ service: "my-api" }],
			}),
		]);
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			definitions,
		);

		const result = await resolver.resolve(
			baseInput({
				annotations: { repository: "acme/widgets" },
				labels: { service: "my-api" },
			}),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		});
	});
});

describe("RepoResolver - attribute step", () => {
	test("annotation takes precedence over label for the same key", async () => {
		const config = baseConfig({ attributeKeys: ["repository"] });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({
				annotations: { repository: "from-annotation/repo" },
				labels: { repository: "from-label/repo" },
			}),
		);

		expect(result).toEqual({
			owner: "from-annotation",
			repo: "repo",
			method: "attribute",
			confidence: "high",
		});
	});

	test("falls back to label when the annotation for that key is absent", async () => {
		const config = baseConfig({ attributeKeys: ["repository"] });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { repository: "from-label/repo" } }),
		);

		expect(result).toEqual({
			owner: "from-label",
			repo: "repo",
			method: "attribute",
			confidence: "high",
		});
	});

	test("falls back to resourceAttributes when neither annotation nor label has the key", async () => {
		const config = baseConfig({ attributeKeys: ["service.repository"] });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({
				resourceAttributes: { "service.repository": "from-resource/repo" },
			}),
		);

		expect(result).toEqual({
			owner: "from-resource",
			repo: "repo",
			method: "attribute",
			confidence: "high",
		});
	});

	test("respects attributeKeys order, trying later keys after an earlier key is absent", async () => {
		const config = baseConfig({
			attributeKeys: ["service.repository", "repository"],
		});
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ annotations: { repository: "acme/widgets" } }),
		);

		expect(result?.repo).toBe("widgets");
	});

	test("rejects a value that does not look like owner/repo, logs a warning, and moves to the next key", async () => {
		const config = baseConfig({ attributeKeys: ["repository", "fallback"] });
		const { logger, lines } = collectingLogger();
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			logger,
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({
				annotations: {
					repository: "not-a-valid-value",
					fallback: "acme/widgets",
				},
			}),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "widgets",
			method: "attribute",
			confidence: "high",
		});
		expect(
			lines.some((line) => line.includes("repo_resolver.attribute.invalid")),
		).toBe(true);
	});

	test("returns null and falls through when no attribute key has a value", async () => {
		const config = baseConfig({ attributeKeys: ["repository"] });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(baseInput());

		expect(result).toBeNull();
	});
});

describe("RepoResolver - definition step", () => {
	test("a matching definition short-circuits static YAML mapping", async () => {
		const config = baseConfig({
			mappings: [{ match: { service: "my-api" }, repo: "should-not/be-used" }],
		});
		const definitions = new StubDefinitionSource([
			repoDefinition({
				owner: "acme",
				repo: "my-api",
				mappings: [{ service: "my-api" }],
			}),
		]);
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			definitions,
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "my-api",
			method: "definition",
			confidence: "high",
		});
	});

	test("skips disabled definitions", async () => {
		const config = baseConfig({
			mappings: [{ match: { service: "my-api" }, repo: "acme/from-yaml" }],
		});
		const definitions = new StubDefinitionSource([
			repoDefinition({
				owner: "acme",
				repo: "disabled-repo",
				enabled: false,
				mappings: [{ service: "my-api" }],
			}),
		]);
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			definitions,
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "from-yaml",
			method: "mapping",
			confidence: "high",
		});
	});

	test("matches when any mapping entry in the OR'd list is fully satisfied", async () => {
		const config = baseConfig();
		const definitions = new StubDefinitionSource([
			repoDefinition({
				owner: "acme",
				repo: "my-api",
				mappings: [{ service: "other" }, { service: "my-api", env: "prod" }],
			}),
		]);
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			definitions,
		);

		const noMatch = await resolver.resolve(
			baseInput({ labels: { service: "my-api", env: "staging" } }),
		);
		expect(noMatch).toBeNull();

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api", env: "prod" } }),
		);
		expect(result).toEqual({
			owner: "acme",
			repo: "my-api",
			method: "definition",
			confidence: "high",
		});
	});

	test("uses the first matching definition in store order when multiple enabled definitions match the same labels", async () => {
		const config = baseConfig();
		// `StubDefinitionSource` hands back its array as-is, standing in for
		// `listRepoDefinitions()`'s owner/repo ASC ordering (see
		// `runRepoDefinitionStoreSuite`'s "ordered by owner then repo" test).
		const definitions = new StubDefinitionSource([
			repoDefinition({
				owner: "acme",
				repo: "first",
				mappings: [{ service: "my-api" }],
			}),
			repoDefinition({
				owner: "acme",
				repo: "second",
				mappings: [{ service: "my-api" }],
			}),
		]);
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			definitions,
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "first",
			method: "definition",
			confidence: "high",
		});
	});

	test("a definition with an empty mappings array never matches", async () => {
		const config = baseConfig();
		const definitions = new StubDefinitionSource([
			repoDefinition({ owner: "acme", repo: "no-mappings", mappings: [] }),
		]);
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			definitions,
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toBeNull();
	});

	test("logs and falls through to the next stage when the store read fails", async () => {
		const config = baseConfig({
			mappings: [{ match: { service: "my-api" }, repo: "acme/from-yaml" }],
		});
		const { logger, lines } = collectingLogger();
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			logger,
			new FailingDefinitionSource(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "from-yaml",
			method: "mapping",
			confidence: "high",
		});
		const entries = lines.map((line) => JSON.parse(line));
		const storeErrorEntry = entries.find(
			(entry) => entry.msg === "repo_resolver.definition.store_error",
		);
		expect(storeErrorEntry).toBeDefined();
		// The raw `Error` must not be logged directly: its `message` property
		// is non-enumerable, so spreading it into the JSON log entry would
		// silently emit `{}` instead of anything actionable.
		expect(storeErrorEntry.error).toBe(
			"listRepoDefinitions should have failed for this test",
		);
	});
});

describe("RepoResolver - mapping step", () => {
	test("requires every key in match to equal the corresponding label", async () => {
		const config = baseConfig({
			mappings: [
				{ match: { service: "my-api", env: "prod" }, repo: "acme/my-api" },
			],
		});
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const partial = await resolver.resolve(
			baseInput({ labels: { service: "my-api", env: "staging" } }),
		);
		expect(partial).toBeNull();

		const full = await resolver.resolve(
			baseInput({ labels: { service: "my-api", env: "prod" } }),
		);
		expect(full).toEqual({
			owner: "acme",
			repo: "my-api",
			method: "mapping",
			confidence: "high",
		});
	});

	test("uses the first matching mapping in array order", async () => {
		const config = baseConfig({
			mappings: [
				{ match: { service: "my-api" }, repo: "acme/first" },
				{ match: { service: "my-api" }, repo: "acme/second" },
			],
		});
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result?.repo).toBe("first");
	});

	test("skips a mapping with an invalid repo value, logs a warning, and tries the next mapping", async () => {
		const config = baseConfig({
			mappings: [
				{ match: { service: "my-api" }, repo: "not-valid" },
				{ match: { service: "my-api" }, repo: "acme/my-api" },
			],
		});
		const { logger, lines } = collectingLogger();
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			logger,
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "my-api",
			method: "mapping",
			confidence: "high",
		});
		expect(
			lines.some((line) => line.includes("repo_resolver.mapping.invalid")),
		).toBe(true);
	});
});

describe("RepoResolver - org search step", () => {
	test("is skipped entirely when disabled, without ever calling the search client", async () => {
		const config = baseConfig({ orgSearch: { enabled: false } });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toBeNull();
	});

	test("returns null when enabled but no org is configured", async () => {
		const config = baseConfig({ orgSearch: { enabled: true } });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toBeNull();
	});

	test("returns null when no service name can be derived from labels", async () => {
		const config = baseConfig({ orgSearch: { enabled: true, org: "acme" } });
		const resolver = new RepoResolver(
			config,
			new UnreachableSearchClient(),
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { unrelated: "x" } }),
		);

		expect(result).toBeNull();
	});

	test("derives the service name with the documented label priority", async () => {
		const config = baseConfig({ orgSearch: { enabled: true, org: "acme" } });
		const searchClient = new StubSearchClient({ totalCount: 0, items: [] });
		const resolver = new RepoResolver(
			config,
			searchClient,
			silentLogger(),
			noDefinitions(),
		);

		await resolver.resolve(
			baseInput({
				labels: { service: "svc-a", job: "job-b", app: "app-c" },
			}),
		);

		expect(searchClient.calls).toEqual(["svc-a org:acme"]);
	});

	test("an exact case-insensitive repo-name match is high confidence", async () => {
		const config = baseConfig({ orgSearch: { enabled: true, org: "acme" } });
		const searchClient = new StubSearchClient({
			totalCount: 2,
			items: [repoItem("acme", "My-API"), repoItem("acme", "unrelated-repo")],
		});
		const resolver = new RepoResolver(
			config,
			searchClient,
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "My-API",
			method: "org-search",
			confidence: "high",
		});
	});

	test("a single non-exact hit is low confidence", async () => {
		const config = baseConfig({ orgSearch: { enabled: true, org: "acme" } });
		const searchClient = new StubSearchClient({
			totalCount: 1,
			items: [repoItem("acme", "my-api-service")],
		});
		const resolver = new RepoResolver(
			config,
			searchClient,
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toEqual({
			owner: "acme",
			repo: "my-api-service",
			method: "org-search",
			confidence: "low",
		});
	});

	test("multiple non-exact hits resolve to null", async () => {
		const config = baseConfig({ orgSearch: { enabled: true, org: "acme" } });
		const searchClient = new StubSearchClient({
			totalCount: 2,
			items: [
				repoItem("acme", "my-api-service"),
				repoItem("acme", "my-api-worker"),
			],
		});
		const resolver = new RepoResolver(
			config,
			searchClient,
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toBeNull();
	});

	test("zero hits resolve to null", async () => {
		const config = baseConfig({ orgSearch: { enabled: true, org: "acme" } });
		const searchClient = new StubSearchClient({ totalCount: 0, items: [] });
		const resolver = new RepoResolver(
			config,
			searchClient,
			silentLogger(),
			noDefinitions(),
		);

		const result = await resolver.resolve(
			baseInput({ labels: { service: "my-api" } }),
		);

		expect(result).toBeNull();
	});
});
