/**
 * Guardrail helper (docs/spec.md section 3.6): matches a changed file's path
 * against the configured `agent.forbiddenPaths` glob patterns. Uses
 * `Bun.Glob`, which matches `**` across directory boundaries (e.g.
 * `.github/workflows/**` matches `.github/workflows/sub/ci.yml`) but not the
 * bare directory itself.
 */

export function isForbiddenPath(filename: string, patterns: string[]): boolean {
	return patterns.some((pattern) => new Bun.Glob(pattern).match(filename));
}

/** Returns every file that matches at least one forbidden-path pattern. */
export function findForbiddenPaths(
	filenames: string[],
	patterns: string[],
): string[] {
	if (patterns.length === 0) {
		return [];
	}
	return filenames.filter((filename) => isForbiddenPath(filename, patterns));
}
