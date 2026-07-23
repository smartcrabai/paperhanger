/**
 * Loads paperhanger.yaml, expands `${ENV_VAR}` references, and validates the
 * result against `ConfigSchema`. Any failure is logged in a readable form and
 * re-thrown so the composition root can exit the process non-zero.
 */

import { type Config, ConfigSchema } from "./schema";

export const DEFAULT_CONFIG_PATH = "./paperhanger.yaml";

/** Thrown when the config file is missing, unparseable, or fails validation. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Formats a JSON-path-like breadcrumb for error messages; empty at the config root. */
function formatPath(path: ReadonlyArray<string | number>): string {
	return path.length > 0 ? path.join(".") : "(root)";
}

/**
 * Recursively replaces `${ENV_VAR}` occurrences in string values with the
 * corresponding environment variable. Throws if a referenced variable is not
 * set, since writing `${FOO}` in the config only makes sense if `FOO` is
 * expected to be present.
 *
 * Fail-fast on malformed syntax (spec section 3.9): only a well-formed
 * `${IDENTIFIER}` sequence is recognized and expanded -- a lone `$` (e.g.
 * `"cost: $5"`) is left untouched, since it's never ambiguous with an env
 * var reference. But an unclosed `${FOO` or an empty `${}` would otherwise
 * silently pass through as a literal string containing `${`, which could let
 * a corrupted secret boot successfully instead of failing loudly. After
 * expansion, any string still containing the `${` sequence is therefore
 * rejected outright, naming the offending value's path and a snippet of its
 * (post-expansion) content.
 */
export function expandEnvVars(
	value: unknown,
	env: Record<string, string | undefined> = Bun.env,
	path: ReadonlyArray<string | number> = [],
): unknown {
	if (typeof value === "string") {
		const expanded = value.replace(ENV_VAR_PATTERN, (_match, name: string) => {
			const envValue = env[name];
			if (envValue === undefined) {
				throw new ConfigError(
					`Environment variable "${name}" referenced in config is not set ` +
						`(at ${formatPath(path)})`,
				);
			}
			return envValue;
		});
		if (expanded.includes("${")) {
			throw new ConfigError(
				`Malformed \${...} reference in config at ${formatPath(path)}: ` +
					`${JSON.stringify(expanded)}. Only a well-formed \${ENV_VAR_NAME} ` +
					'sequence is expanded; an unclosed or empty "${...}" is treated ' +
					"as a corrupted config value rather than passed through silently.",
			);
		}
		return expanded;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			expandEnvVars(item, env, [...path, index]),
		);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				expandEnvVars(item, env, [...path, key]),
			]),
		);
	}
	return value;
}

/**
 * Renders zod issues as a human-readable plain-text list. Exported so
 * `src/ingest/repo-definitions.ts` can reuse it for its own 400-body
 * formatting instead of duplicating it.
 */
export function formatZodError(error: import("zod").ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
			return `  - ${path}: ${issue.message}`;
		})
		.join("\n");
}

/**
 * Loads and validates the paperhanger config.
 *
 * @param path Config file path. Defaults to `PAPERHANGER_CONFIG` env var, then
 *   `./paperhanger.yaml`.
 */
export async function loadConfig(path?: string): Promise<Config> {
	const configPath = path ?? Bun.env.PAPERHANGER_CONFIG ?? DEFAULT_CONFIG_PATH;

	try {
		const file = Bun.file(configPath);
		if (!(await file.exists())) {
			throw new ConfigError(`Config file not found: ${configPath}`);
		}

		const text = await file.text();
		let raw: unknown;
		try {
			raw = Bun.YAML.parse(text);
		} catch (err) {
			throw new ConfigError(
				`Failed to parse YAML config at ${configPath}: ${(err as Error).message}`,
			);
		}

		const expanded = expandEnvVars(raw);
		const result = ConfigSchema.safeParse(expanded);
		if (!result.success) {
			throw new ConfigError(
				`Invalid config at ${configPath}:\n${formatZodError(result.error)}`,
			);
		}

		return result.data;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[paperhanger] Failed to load config: ${message}`);
		throw err;
	}
}
