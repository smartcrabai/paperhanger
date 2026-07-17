/**
 * Integration test for `PostgresIncidentStore` against a real PostgreSQL
 * instance started via testcontainers. See docs/spec.md section 3.3 and
 * docs/architecture.md's "Tests" convention.
 *
 * Requires Docker. If Docker is not reachable, the whole suite is skipped
 * (via `describe.skipIf`) with a clear console warning rather than failing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { PostgresIncidentStore } from "../../src/storage/postgres";
import type { IncidentStoreHarness } from "../../src/storage/store-suite";
import { runIncidentStoreSuite } from "../../src/storage/store-suite";

const POSTGRES_IMAGE = "postgres:17-alpine";
const POSTGRES_USER = "paperhanger";
const POSTGRES_PASSWORD = "paperhanger";
const POSTGRES_DB = "paperhanger";
const CONTAINER_STARTUP_TIMEOUT_MS = 120_000;

function isDockerAvailable(): boolean {
	try {
		const result = Bun.spawnSync({
			cmd: ["docker", "info"],
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.success;
	} catch {
		return false;
	}
}

const dockerAvailable = isDockerAvailable();

if (!dockerAvailable) {
	console.warn(
		"[tests/integration/postgres.test.ts] Docker is not available locally; skipping PostgresIncidentStore integration tests.",
	);
}

function connectionStringFor(container: StartedTestContainer): string {
	const host = container.getHost();
	const port = container.getMappedPort(5432);
	return `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}`;
}

describe.skipIf(!dockerAvailable)(
	"PostgresIncidentStore (testcontainers, requires Docker)",
	() => {
		let container: StartedTestContainer;
		let connectionString: string;
		let sharedStore: PostgresIncidentStore;
		/** Separate administrative connection used only to reset tables between suite tests. */
		let adminSql: SQL;
		/** Injected into `sharedStore`; mutated by the harness's `advance()` to pin cooldown/updatedAt-ordering tests deterministically. */
		let currentTime = new Date();

		beforeAll(async () => {
			container = await new GenericContainer(POSTGRES_IMAGE)
				.withEnvironment({
					POSTGRES_USER,
					POSTGRES_PASSWORD,
					POSTGRES_DB,
				})
				.withExposedPorts(5432)
				.withWaitStrategy(
					Wait.forLogMessage(
						/database system is ready to accept connections/,
						2,
					),
				)
				.withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
				.start();

			connectionString = connectionStringFor(container);
			sharedStore = new PostgresIncidentStore(connectionString, {
				now: () => currentTime,
			});
			await sharedStore.init();
			adminSql = new SQL(connectionString);
		}, CONTAINER_STARTUP_TIMEOUT_MS);

		afterAll(async () => {
			await adminSql?.close();
			await sharedStore?.close();
			await container?.stop();
		});

		async function makeStore(): Promise<IncidentStoreHarness> {
			// Reuse the same container/connection across the whole suite (starting
			// a fresh container per test would be far too slow); reset table
			// contents instead so each test sees an empty store.
			await adminSql`TRUNCATE TABLE incident_events, agent_runs, incidents RESTART IDENTITY CASCADE`;
			currentTime = new Date();
			return {
				store: sharedStore,
				advance: (ms) => {
					currentTime = new Date(currentTime.getTime() + ms);
				},
			};
		}

		runIncidentStoreSuite("PostgresIncidentStore", makeStore);

		test("ping returns false once the connection is closed", async () => {
			const store = new PostgresIncidentStore(connectionString);
			await store.init();
			await store.close();
			expect(await store.ping()).toBe(false);
		});

		test("close does not throw", async () => {
			const store = new PostgresIncidentStore(connectionString);
			await store.init();
			await expect(store.close()).resolves.toBeUndefined();
		});
	},
);
