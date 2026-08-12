import { describe, expect, test } from "bun:test";
import {
	TELEMETRY_CALLBACK_ENV_KEYS,
	telemetryCallbackConfigFromEnv,
} from "./telemetry-callback-config";

const FULL_ENV = {
	PAPERHANGER_TELEMETRY_CALLBACK_URL: "http://parent/telemetry/query",
	PAPERHANGER_TELEMETRY_CALLBACK_TOKEN: "cb-secret-token",
	PAPERHANGER_TELEMETRY_CALLBACK_SOURCE: "zabbix",
};

describe("telemetryCallbackConfigFromEnv", () => {
	test("returns the config when all three env vars are set", () => {
		expect(telemetryCallbackConfigFromEnv(FULL_ENV)).toEqual({
			url: "http://parent/telemetry/query",
			token: "cb-secret-token",
			source: "zabbix",
		});
	});

	test("returns undefined when no env var is set", () => {
		expect(telemetryCallbackConfigFromEnv({})).toBeUndefined();
	});

	// Partial configuration must not yield a half-usable callback: without a
	// token the tool would call the parent unauthenticated, and without a URL
	// there is nothing to call. Either way `../tools.ts` must register no tool.
	test.each(TELEMETRY_CALLBACK_ENV_KEYS)(
		"returns undefined when only %s is missing",
		(missingKey) => {
			const env: Record<string, string | undefined> = { ...FULL_ENV };
			delete env[missingKey];

			expect(telemetryCallbackConfigFromEnv(env)).toBeUndefined();
		},
	);

	test.each(TELEMETRY_CALLBACK_ENV_KEYS)(
		"treats an empty %s as unset rather than as a usable value",
		(emptyKey) => {
			expect(
				telemetryCallbackConfigFromEnv({ ...FULL_ENV, [emptyKey]: "" }),
			).toBeUndefined();
		},
	);

	test("reads process.env when no env object is passed", () => {
		const saved = TELEMETRY_CALLBACK_ENV_KEYS.map(
			(key) => [key, process.env[key]] as const,
		);
		try {
			for (const [key, value] of Object.entries(FULL_ENV)) {
				process.env[key] = value;
			}

			expect(telemetryCallbackConfigFromEnv()?.source).toBe("zabbix");
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});
});
