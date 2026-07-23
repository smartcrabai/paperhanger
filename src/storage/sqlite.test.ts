import { describe, expect, test } from "bun:test";
import { SqliteIncidentStore } from "./sqlite";
import type {
	IncidentStoreHarness,
	RepoDefinitionStoreHarness,
} from "./store-suite";
import {
	runIncidentStoreSuite,
	runRepoDefinitionStoreSuite,
} from "./store-suite";

async function createStore(): Promise<SqliteIncidentStore> {
	const store = new SqliteIncidentStore(":memory:");
	await store.init();
	return store;
}

async function createStoreHarness(): Promise<IncidentStoreHarness> {
	let current = new Date("2024-01-01T00:00:00.000Z");
	const store = new SqliteIncidentStore(":memory:", { now: () => current });
	await store.init();
	return {
		store,
		advance: (ms) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

async function createRepoDefinitionStoreHarness(): Promise<RepoDefinitionStoreHarness> {
	let current = new Date("2024-01-01T00:00:00.000Z");
	const store = new SqliteIncidentStore(":memory:", { now: () => current });
	await store.init();
	return {
		store,
		advance: (ms) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

runIncidentStoreSuite("SqliteIncidentStore", createStoreHarness);
runRepoDefinitionStoreSuite(
	"SqliteIncidentStore (RepoDefinitionStore)",
	createRepoDefinitionStoreHarness,
);

describe("SqliteIncidentStore - lifecycle", () => {
	test("close does not throw", async () => {
		const store = await createStore();
		await store.close();
	});

	test("ping returns false after close", async () => {
		const store = await createStore();
		await store.close();
		expect(await store.ping()).toBe(false);
	});
});
