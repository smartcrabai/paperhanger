import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, expandEnvVars, loadConfig } from "./load";

const ENV_KEYS = [
	"GRAFANA_WEBHOOK_SECRET",
	"GREPTIMEDB_URL",
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"OTEL_EXPORTER_HEADER_VALUE",
] as const;

const MINIMAL_YAML = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
telemetry:
  source: greptimedb
  url: \${GREPTIMEDB_URL}
  database: public
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;

const tempFiles: string[] = [];

async function writeFixture(content: string): Promise<string> {
	const path = join(
		tmpdir(),
		`paperhanger-config-test-${crypto.randomUUID()}.yaml`,
	);
	await Bun.write(path, content);
	tempFiles.push(path);
	return path;
}

afterEach(async () => {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
	while (tempFiles.length > 0) {
		const path = tempFiles.pop();
		if (path) {
			await Bun.file(path)
				.delete()
				.catch(() => {});
		}
	}
});

describe("expandEnvVars", () => {
	test("replaces ${VAR} with the environment value", () => {
		const result = expandEnvVars(
			{ url: "https://${HOST}/path" },
			{ HOST: "example.com" },
		);
		expect(result).toEqual({ url: "https://example.com/path" });
	});

	test("throws when the referenced variable is not set", () => {
		expect(() => expandEnvVars({ url: "${MISSING_VAR}" }, {})).toThrow(
			ConfigError,
		);
	});

	test("recurses into arrays and nested objects", () => {
		const result = expandEnvVars(
			{ list: [{ nested: "${A}" }, "${B}"] },
			{ A: "1", B: "2" },
		);
		expect(result).toEqual({ list: [{ nested: "1" }, "2"] });
	});

	test("leaves non-string values untouched", () => {
		const result = expandEnvVars({ count: 3, enabled: true, tag: null }, {});
		expect(result).toEqual({ count: 3, enabled: true, tag: null });
	});

	test("expands multiple ${VAR} references within a single string", () => {
		const result = expandEnvVars(
			{ dsn: "postgres://${USER}:${PASS}@${HOST}/db" },
			{ USER: "alice", PASS: "s3cret", HOST: "db.internal" },
		);
		expect(result).toEqual({ dsn: "postgres://alice:s3cret@db.internal/db" });
	});

	test("leaves a lone '$' (not followed by '{') untouched", () => {
		const result = expandEnvVars({ note: "cost: $5 flat" }, {});
		expect(result).toEqual({ note: "cost: $5 flat" });
	});

	test("throws on an unclosed ${VAR reference", () => {
		expect(() => expandEnvVars({ url: "https://${HOST/path" }, {})).toThrow(
			ConfigError,
		);
	});

	test("throws on an empty ${} reference", () => {
		expect(() => expandEnvVars({ url: "https://${}/path" }, {})).toThrow(
			ConfigError,
		);
	});

	test("names the offending value's path in the malformed-reference error", () => {
		try {
			expandEnvVars({ github: { privateKey: "${UNCLOSED" } }, {});
			throw new Error("expected expandEnvVars to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).message).toContain("github.privateKey");
		}
	});
});

describe("loadConfig", () => {
	test("applies documented defaults when optional fields are omitted", async () => {
		process.env.GRAFANA_WEBHOOK_SECRET = "grafana-secret";
		process.env.GREPTIMEDB_URL = "http://greptimedb:4000";
		process.env.GITHUB_APP_ID = "12345";
		process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";

		const path = await writeFixture(MINIMAL_YAML);
		const config = await loadConfig(path);

		expect(config.server.port).toBe(8080);
		expect(config.agent.concurrency).toBe(2);
		expect(config.agent.cooldownHours).toBe(24);
		expect(config.agent.timeoutMinutes).toBe(30);
		expect(config.agent.draftPr).toBe(false);
		expect(config.agent.forbiddenPaths).toEqual([".github/workflows/**"]);
		expect(config.agent.hostPort).toBe(8700);
		expect(config.agent.maxDiffLines).toBe(500);
		expect(config.agent.maxFixAttempts).toBe(3);
		expect(config.agent.hostUrl).toBeUndefined();
		expect(config.agent.model).toBe("anthropic/claude-sonnet-4-6");
		expect(config.collect.windowBeforeMinutes).toBe(30);
		expect(config.collect.windowAfterMinutes).toBe(5);
		expect(config.repos.attributeKeys).toEqual([]);
		expect(config.repos.mappings).toEqual([]);
		expect(config.repos.orgSearch.enabled).toBe(false);
		expect(config.notifiers).toEqual([]);
	});

	test("loads successfully with no telemetry section at all", async () => {
		process.env.GRAFANA_WEBHOOK_SECRET = "grafana-secret";
		process.env.GITHUB_APP_ID = "12345";
		process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";

		const yamlWithoutTelemetry = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
		const path = await writeFixture(yamlWithoutTelemetry);
		const config = await loadConfig(path);

		expect(config.telemetry).toBeUndefined();
	});

	test("expands ${ENV_VAR} references in secrets before validation", async () => {
		process.env.GRAFANA_WEBHOOK_SECRET = "grafana-secret";
		process.env.GREPTIMEDB_URL = "http://greptimedb:4000";
		process.env.GITHUB_APP_ID = "app-id-value";
		process.env.GITHUB_APP_PRIVATE_KEY = "private-key-value";

		const path = await writeFixture(MINIMAL_YAML);
		const config = await loadConfig(path);

		expect(config.sources.grafana?.secret).toBe("grafana-secret");
		expect(config.telemetry?.source).toBe("greptimedb");
		if (config.telemetry?.source === "greptimedb") {
			expect(config.telemetry.url).toBe("http://greptimedb:4000");
		}
		expect(config.github.appId).toBe("app-id-value");
		expect(config.github.privateKey).toBe("private-key-value");
	});

	test("throws when a referenced environment variable is unset", async () => {
		// Intentionally leave GRAFANA_WEBHOOK_SECRET etc. unset.
		const path = await writeFixture(MINIMAL_YAML);
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("throws a readable error when the config fails schema validation", async () => {
		const invalidYaml = `
storage:
  driver: sqlite
sources: {}
telemetry:
  source: greptimedb
  url: http://greptimedb:4000
  database: public
github:
  appId: some-id
  privateKey: some-key
`;
		const path = await writeFixture(invalidYaml);
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("throws when the config file does not exist", async () => {
		await expect(loadConfig("/nonexistent/paperhanger.yaml")).rejects.toThrow(
			ConfigError,
		);
	});
});

describe("loadConfig - observability", () => {
	function setRequiredEnv(): void {
		process.env.GRAFANA_WEBHOOK_SECRET = "grafana-secret";
		process.env.GITHUB_APP_ID = "12345";
		process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";
	}

	test("omitted section leaves config.observability undefined", async () => {
		setRequiredEnv();
		const yaml = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
		const path = await writeFixture(yaml);
		const config = await loadConfig(path);

		expect(config.observability).toBeUndefined();
	});

	test("applies documented defaults when only endpoint is set", async () => {
		setRequiredEnv();
		const yaml = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
observability:
  endpoint: http://localhost:4318/v1/traces
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
		const path = await writeFixture(yaml);
		const config = await loadConfig(path);

		expect(config.observability?.endpoint).toBe(
			"http://localhost:4318/v1/traces",
		);
		expect(config.observability?.serviceName).toBe("paperhanger");
		expect(config.observability?.headers).toEqual({});
	});

	test("expands ${ENV_VAR} references inside observability.headers values", async () => {
		setRequiredEnv();
		process.env.OTEL_EXPORTER_HEADER_VALUE = "secret-token";
		const yaml = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
observability:
  endpoint: http://localhost:4318/v1/traces
  serviceName: paperhanger-test
  headers:
    x-api-key: \${OTEL_EXPORTER_HEADER_VALUE}
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
		const path = await writeFixture(yaml);
		const config = await loadConfig(path);

		expect(config.observability?.serviceName).toBe("paperhanger-test");
		expect(config.observability?.headers).toEqual({
			"x-api-key": "secret-token",
		});
	});

	test("rejects an empty observability.endpoint", async () => {
		setRequiredEnv();
		const yaml = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
observability:
  endpoint: ""
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
		const path = await writeFixture(yaml);
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});
});

describe("loadConfig - numeric guardrail validation", () => {
	function yamlWithOverrides(overrides: {
		serverPort?: number;
		concurrency?: number;
		timeoutMinutes?: number;
		maxDiffLines?: number;
		cooldownHours?: number;
	}): string {
		return `
server:
  port: ${overrides.serverPort ?? 8080}
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
agent:
  concurrency: ${overrides.concurrency ?? 2}
  timeoutMinutes: ${overrides.timeoutMinutes ?? 30}
  maxDiffLines: ${overrides.maxDiffLines ?? 500}
  cooldownHours: ${overrides.cooldownHours ?? 24}
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
	}

	function setRequiredEnv(): void {
		process.env.GRAFANA_WEBHOOK_SECRET = "grafana-secret";
		process.env.GITHUB_APP_ID = "12345";
		process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";
	}

	test("accepts the documented defaults (control case)", async () => {
		setRequiredEnv();
		const path = await writeFixture(yamlWithOverrides({}));
		await expect(loadConfig(path)).resolves.toBeDefined();
	});

	test("rejects agent.concurrency: 0", async () => {
		setRequiredEnv();
		const path = await writeFixture(yamlWithOverrides({ concurrency: 0 }));
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects agent.maxDiffLines: -1", async () => {
		setRequiredEnv();
		const path = await writeFixture(yamlWithOverrides({ maxDiffLines: -1 }));
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects agent.cooldownHours: -5", async () => {
		setRequiredEnv();
		const path = await writeFixture(yamlWithOverrides({ cooldownHours: -5 }));
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects server.port: 0", async () => {
		setRequiredEnv();
		const path = await writeFixture(yamlWithOverrides({ serverPort: 0 }));
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects agent.timeoutMinutes: 0", async () => {
		setRequiredEnv();
		const path = await writeFixture(yamlWithOverrides({ timeoutMinutes: 0 }));
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});

	test("rejects agent.maxFixAttempts: 0", async () => {
		setRequiredEnv();
		const yaml = `
storage:
  driver: sqlite
  path: /data/paperhanger.db
sources:
  grafana:
    secret: \${GRAFANA_WEBHOOK_SECRET}
agent:
  maxFixAttempts: 0
github:
  appId: \${GITHUB_APP_ID}
  privateKey: \${GITHUB_APP_PRIVATE_KEY}
`;
		const path = await writeFixture(yaml);
		await expect(loadConfig(path)).rejects.toThrow(ConfigError);
	});
});
