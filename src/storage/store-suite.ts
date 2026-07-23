/**
 * Behavioral contract shared by every `IncidentStore` implementation.
 *
 * Both `sqlite.test.ts` (unit, in-memory) and `tests/integration/postgres.test.ts`
 * (testcontainers) register this suite against their own backing store via
 * `runIncidentStoreSuite`. Deliberately named without a `.test.ts` suffix so
 * bun's test discovery does not try to run it as a standalone file: it only
 * runs once imported and invoked from an actual test file.
 *
 * Lifecycle (`close()`) is intentionally NOT covered here, since a
 * `makeStore` factory may reuse a single connection across every test in the
 * suite (as the postgres integration test does, to avoid spinning up a
 * fresh container per test) — closing it mid-suite would break subsequent
 * tests. Each test file adds its own dedicated close-lifecycle test using a
 * throwaway store instance.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { CreateRepoDefinitionInput, IncidentEvent } from "../core/types";
import {
	DuplicateOpenIncidentError,
	DuplicateRepoDefinitionError,
	RepoDefinitionNotFoundError,
} from "./types";
import type {
	CreateIncidentInput,
	IncidentStore,
	RepoDefinitionStore,
} from "./types";

/**
 * What a `makeStore` factory hands back to the suite: an initialized store,
 * plus a way to advance that store's injected clock (see the `now` option on
 * both `SqliteIncidentStore` and `PostgresIncidentStore`). Advancing the
 * clock deterministically -- rather than sleeping on the real wall clock --
 * is what lets `updateIncident applies a partial patch and strictly advances
 * updatedAt` below make a meaningful assertion instead of a tautological one.
 */
export interface IncidentStoreHarness {
	store: IncidentStore;
	/** Advances the store's injected clock by `ms` milliseconds. */
	advance(ms: number): void;
}

function makeIncidentInput(
	overrides: Partial<CreateIncidentInput> = {},
): CreateIncidentInput {
	return {
		fingerprint: "fp-1",
		source: "grafana",
		status: "received",
		severity: "critical",
		title: "High error rate",
		labels: { service: "my-api" },
		annotations: { runbook_url: "https://example.com/runbook" },
		...overrides,
	};
}

function makeIncidentEvent(
	overrides: Partial<IncidentEvent> = {},
): IncidentEvent {
	return {
		fingerprint: "fp-1",
		source: "grafana",
		status: "firing",
		severity: "critical",
		title: "High error rate",
		labels: { service: "my-api" },
		annotations: {},
		startsAt: new Date().toISOString(),
		raw: { hello: "world" },
		...overrides,
	};
}

/**
 * Registers the shared `IncidentStore` behavioral suite under a `describe`
 * block named `label`. `makeStore` is called before each test and must
 * return a harness wrapping a store that is initialized and empty (or reset
 * to empty).
 */
export function runIncidentStoreSuite(
	label: string,
	makeStore: () => Promise<IncidentStoreHarness>,
): void {
	describe(label, () => {
		let harness: IncidentStoreHarness;
		let store: IncidentStore;

		beforeEach(async () => {
			harness = await makeStore();
			store = harness.store;
		});

		test("ping succeeds after init", async () => {
			expect(await store.ping()).toBe(true);
		});

		test("createIncident then getIncident round-trips all fields", async () => {
			const created = await store.createIncident(makeIncidentInput());

			expect(created.id).toBeTruthy();
			expect(created.createdAt).toBe(created.updatedAt);

			const fetched = await store.getIncident(created.id);
			expect(fetched).toEqual(created);
		});

		test("getIncident returns undefined for unknown id", async () => {
			expect(await store.getIncident("does-not-exist")).toBeUndefined();
		});

		test("listIncidents returns newest-first", async () => {
			const first = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-list-1" }),
			);
			harness.advance(2);
			const second = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-list-2" }),
			);

			const listed = await store.listIncidents();
			const ids = listed.map((incident) => incident.id);
			expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
		});

		test("listIncidents respects the limit argument", async () => {
			await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-lim-1" }),
			);
			await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-lim-2" }),
			);
			await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-lim-3" }),
			);

			const listed = await store.listIncidents(2);
			expect(listed.length).toBe(2);
		});

		test("findOpenIncidentByFingerprint finds non-terminal incidents", async () => {
			const created = await store.createIncident(makeIncidentInput());

			const open = await store.findOpenIncidentByFingerprint("fp-1");
			expect(open?.id).toBe(created.id);
		});

		test("findOpenIncidentByFingerprint ignores terminal incidents", async () => {
			const created = await store.createIncident(makeIncidentInput());
			await store.updateIncident(created.id, {
				status: "failed",
				failureReason: "boom",
			});

			expect(await store.findOpenIncidentByFingerprint("fp-1")).toBeUndefined();
		});

		test("createIncident throws DuplicateOpenIncidentError for a second open incident with the same fingerprint", async () => {
			await store.createIncident(makeIncidentInput({ fingerprint: "fp-dup" }));

			await expect(
				store.createIncident(makeIncidentInput({ fingerprint: "fp-dup" })),
			).rejects.toThrow(DuplicateOpenIncidentError);
		});

		test("createIncident allows a new open incident once the previous one for that fingerprint is terminal", async () => {
			const first = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-dup-terminal" }),
			);
			await store.updateIncident(first.id, {
				status: "failed",
				failureReason: "boom",
			});

			const second = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-dup-terminal" }),
			);
			expect(second.id).not.toBe(first.id);
		});

		test("findLatestTerminalByFingerprint returns the most recently updated terminal incident", async () => {
			const first = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-2" }),
			);
			await store.updateIncident(first.id, {
				status: "failed",
				failureReason: "first failure",
			});

			const second = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-2" }),
			);
			await store.updateIncident(second.id, {
				status: "pr_created",
				prUrl: "https://example.com/pr/1",
			});

			const latest = await store.findLatestTerminalByFingerprint("fp-2");
			expect(latest?.id).toBe(second.id);
			expect(latest?.status).toBe("pr_created");
		});

		test("findLatestTerminalByFingerprint returns undefined when no terminal incident exists", async () => {
			await store.createIncident(makeIncidentInput({ fingerprint: "fp-3" }));
			expect(
				await store.findLatestTerminalByFingerprint("fp-3"),
			).toBeUndefined();
		});

		test("listOpenIncidents returns only non-terminal incidents, oldest first", async () => {
			const terminal = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-open-terminal" }),
			);
			await store.updateIncident(terminal.id, {
				status: "failed",
				failureReason: "boom",
			});

			const openFirst = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-open-1", status: "diagnosing" }),
			);
			harness.advance(2);
			const openSecond = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-open-2", status: "fixing" }),
			);

			const open = await store.listOpenIncidents();
			const ids = open.map((incident) => incident.id);

			expect(ids).not.toContain(terminal.id);
			expect(ids.indexOf(openFirst.id)).toBeLessThan(
				ids.indexOf(openSecond.id),
			);
		});

		test("updateIncident applies a partial patch and strictly advances updatedAt", async () => {
			const created = await store.createIncident(makeIncidentInput());
			const beforeUpdate = created.updatedAt;

			harness.advance(2);
			const updated = await store.updateIncident(created.id, {
				status: "report_only",
				diagnosis: "Root cause: config drift",
			});

			expect(updated.status).toBe("report_only");
			expect(updated.diagnosis).toBe("Root cause: config drift");
			expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
				new Date(beforeUpdate).getTime(),
			);
			// Fields not in the patch are preserved.
			expect(updated.title).toBe(created.title);
		});

		test("updateIncident throws for unknown incident id", async () => {
			await expect(
				store.updateIncident("missing", { status: "failed" }),
			).rejects.toThrow();
		});

		test("concurrent updateIncident patches touching disjoint fields both survive (no lost update)", async () => {
			const created = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-concurrent-update" }),
			);

			await Promise.all([
				store.updateIncident(created.id, { status: "fixing" }),
				store.updateIncident(created.id, {
					resolvedAt: "2024-01-01T00:00:00.000Z",
				}),
			]);

			const final = await store.getIncident(created.id);
			expect(final?.status).toBe("fixing");
			expect(final?.resolvedAt).toBe("2024-01-01T00:00:00.000Z");
		});

		test("appendEvent and listEvents round-trip event + raw payload", async () => {
			const created = await store.createIncident(makeIncidentInput());
			const event = makeIncidentEvent();

			await store.appendEvent(created.id, event, { original: true });
			const events = await store.listEvents(created.id);

			expect(events.length).toBe(1);
			expect(events[0]?.incidentId).toBe(created.id);
			expect(events[0]?.event).toEqual(event);
			expect(events[0]?.rawPayload).toEqual({ original: true });
		});

		test("appendEvent and listEvents round-trip unicode, nested structures, and special characters", async () => {
			const created = await store.createIncident(
				makeIncidentInput({
					fingerprint: "fp-unicode",
					labels: { service: "日本語サービス", note: "emoji 🎉 test" },
					annotations: { path: 'C:\\Users\\test\\n"quoted"' },
				}),
			);

			const rawPayload = {
				message: "こんにちは、世界! 🌍",
				nested: {
					list: [1, 2, { deep: 'value with "quotes" and \\ slashes' }],
				},
				multiline: "line1\nline2\ttabbed",
			};
			const event = makeIncidentEvent({
				fingerprint: "fp-unicode",
				title: "エラー発生 🔥",
				description: '改行を含む\nテキストと "引用符" と \\バックスラッシュ',
				labels: { service: "日本語サービス", tags: '["a","b"]' },
				annotations: { note: '{"a":1,"b":[1,2,3]}' },
				raw: rawPayload,
			});

			await store.appendEvent(created.id, event, rawPayload);
			const events = await store.listEvents(created.id);

			expect(events[0]?.event).toEqual(event);
			expect(events[0]?.rawPayload).toEqual(rawPayload);

			const fetchedIncident = await store.getIncident(created.id);
			expect(fetchedIncident?.labels).toEqual({
				service: "日本語サービス",
				note: "emoji 🎉 test",
			});
			expect(fetchedIncident?.annotations).toEqual({
				path: 'C:\\Users\\test\\n"quoted"',
			});
		});

		test("listEvents returns events in chronological order", async () => {
			const created = await store.createIncident(makeIncidentInput());
			const baseEvent = {
				fingerprint: "fp-1",
				source: "grafana",
				severity: "critical",
				title: "High error rate",
				labels: {},
				annotations: {},
				startsAt: new Date().toISOString(),
				raw: {},
			};

			await store.appendEvent(
				created.id,
				{ ...baseEvent, status: "firing" },
				{},
			);
			await store.appendEvent(
				created.id,
				{ ...baseEvent, status: "resolved" },
				{},
			);

			const events = await store.listEvents(created.id);
			expect(events.length).toBe(2);
			expect(events[0]?.event.status).toBe("firing");
			expect(events[1]?.event.status).toBe("resolved");
		});

		test("listEvents preserves insertion order for events received in a tight loop", async () => {
			const created = await store.createIncident(
				makeIncidentInput({ fingerprint: "fp-tight-loop" }),
			);
			const baseEvent = {
				fingerprint: "fp-tight-loop",
				source: "grafana",
				status: "firing" as const,
				severity: "critical",
				labels: {},
				annotations: {},
				startsAt: new Date().toISOString(),
				raw: {},
			};

			const insertedTitles = ["first", "second", "third", "fourth", "fifth"];
			for (const title of insertedTitles) {
				// No inter-insert delay: on a fast machine several of these can
				// land within the same millisecond, which is exactly the
				// nondeterministic-ordering scenario this test guards against.
				await store.appendEvent(created.id, { ...baseEvent, title }, {});
			}

			const events = await store.listEvents(created.id);
			expect(events.map((record) => record.event.title)).toEqual(
				insertedTitles,
			);
		});

		test("appendEvent rejects when the incident does not exist (foreign key enforcement)", async () => {
			await expect(
				store.appendEvent("does-not-exist", makeIncidentEvent(), {}),
			).rejects.toThrow();
		});

		test("createAgentRun rejects when the incident does not exist (foreign key enforcement)", async () => {
			await expect(
				store.createAgentRun({
					incidentId: "does-not-exist",
					startedAt: new Date().toISOString(),
					model: "anthropic/claude-sonnet-4-6",
				}),
			).rejects.toThrow();
		});

		test("createAgentRun then updateAgentRun round-trips fields", async () => {
			const incident = await store.createIncident(makeIncidentInput());
			const run = await store.createAgentRun({
				incidentId: incident.id,
				startedAt: new Date().toISOString(),
				model: "anthropic/claude-sonnet-4-6",
			});

			expect(run.finishedAt).toBeUndefined();

			const updated = await store.updateAgentRun(run.id, {
				finishedAt: new Date().toISOString(),
				outcome: "pr_created",
				costUsd: 0.42,
			});

			expect(updated.outcome).toBe("pr_created");
			expect(updated.costUsd).toBe(0.42);
			expect(updated.finishedAt).toBeTruthy();
		});

		test("updateAgentRun throws for unknown run id", async () => {
			await expect(
				store.updateAgentRun("missing", { outcome: "failed" }),
			).rejects.toThrow();
		});
	});
}

/**
 * What a `makeStore` factory hands back to `runRepoDefinitionStoreSuite`: an
 * initialized store, plus a way to advance that store's injected clock. See
 * `IncidentStoreHarness` above for why the clock is advanced explicitly
 * rather than by sleeping on the real wall clock.
 */
export interface RepoDefinitionStoreHarness {
	store: RepoDefinitionStore;
	/** Advances the store's injected clock by `ms` milliseconds. */
	advance(ms: number): void;
}

function makeRepoDefinitionInput(
	overrides: Partial<CreateRepoDefinitionInput> = {},
): CreateRepoDefinitionInput {
	return {
		owner: "acme",
		repo: "widgets",
		...overrides,
	};
}

/**
 * Registers the shared `RepoDefinitionStore` behavioral suite under a
 * `describe` block named `label`. `makeStore` is called before each test and
 * must return a harness wrapping a store that is initialized and empty (or
 * reset to empty).
 */
export function runRepoDefinitionStoreSuite(
	label: string,
	makeStore: () => Promise<RepoDefinitionStoreHarness>,
): void {
	describe(label, () => {
		let harness: RepoDefinitionStoreHarness;
		let store: RepoDefinitionStore;

		beforeEach(async () => {
			harness = await makeStore();
			store = harness.store;
		});

		test("createRepoDefinition applies defaults: enabled=true, mappings=[]", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "defaults" }),
			);

			expect(created.enabled).toBe(true);
			expect(created.mappings).toEqual([]);
			expect(created.id).toBeTruthy();
			expect(created.createdAt).toBe(created.updatedAt);
		});

		test("createRepoDefinition then getRepoDefinition round-trips all fields", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({
					owner: "acme",
					repo: "roundtrip",
					mappings: [{ service: "api" }],
					setupScript: "npm ci",
					testCommand: "npm test",
					enabled: false,
				}),
			);

			const fetched = await store.getRepoDefinition(created.id);
			expect(fetched).toEqual(created);
		});

		test("getRepoDefinition returns undefined for unknown id", async () => {
			expect(await store.getRepoDefinition("does-not-exist")).toBeUndefined();
		});

		test("listRepoDefinitions returns all rows, including disabled, ordered by owner then repo", async () => {
			await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "zeta", repo: "z-repo" }),
			);
			await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "b-repo" }),
			);
			await store.createRepoDefinition(
				makeRepoDefinitionInput({
					owner: "acme",
					repo: "a-repo",
					enabled: false,
				}),
			);

			const listed = await store.listRepoDefinitions();
			expect(
				listed.map((definition) => `${definition.owner}/${definition.repo}`),
			).toEqual(["acme/a-repo", "acme/b-repo", "zeta/z-repo"]);
		});

		test("findRepoDefinitionByRepo matches case-insensitively", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "Acme", repo: "Widgets" }),
			);

			const found = await store.findRepoDefinitionByRepo("acme", "widgets");
			expect(found?.id).toBe(created.id);
		});

		test("findRepoDefinitionByRepo returns undefined when no definition matches", async () => {
			expect(
				await store.findRepoDefinitionByRepo("nope", "nothing"),
			).toBeUndefined();
		});

		test("findRepoDefinitionByRepo also returns a disabled definition (the store does not filter on enabled)", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({
					owner: "acme",
					repo: "disabled-lookup",
					enabled: false,
				}),
			);

			const found = await store.findRepoDefinitionByRepo(
				"acme",
				"disabled-lookup",
			);
			expect(found?.id).toBe(created.id);
			expect(found?.enabled).toBe(false);
		});

		test("createRepoDefinition throws DuplicateRepoDefinitionError for a duplicate (owner, repo) pair", async () => {
			await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "dup" }),
			);

			await expect(
				store.createRepoDefinition(
					makeRepoDefinitionInput({ owner: "acme", repo: "dup" }),
				),
			).rejects.toThrow(DuplicateRepoDefinitionError);
		});

		test("two concurrent createRepoDefinition calls for the same (owner, repo) leave exactly one fulfilled and one rejected with DuplicateRepoDefinitionError", async () => {
			const results = await Promise.allSettled([
				store.createRepoDefinition(
					makeRepoDefinitionInput({ owner: "acme", repo: "race" }),
				),
				store.createRepoDefinition(
					makeRepoDefinitionInput({ owner: "acme", repo: "race" }),
				),
			]);

			const fulfilled = results.filter(
				(result) => result.status === "fulfilled",
			);
			const rejected = results.filter((result) => result.status === "rejected");
			expect(fulfilled.length).toBe(1);
			expect(rejected.length).toBe(1);
			expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
				DuplicateRepoDefinitionError,
			);
		});

		test("createRepoDefinition throws DuplicateRepoDefinitionError for a case-variant duplicate", async () => {
			await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "Acme", repo: "Dup" }),
			);

			await expect(
				store.createRepoDefinition(
					makeRepoDefinitionInput({ owner: "acme", repo: "dup" }),
				),
			).rejects.toThrow(DuplicateRepoDefinitionError);
		});

		test("updateRepoDefinition applies a partial patch and strictly advances updatedAt", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "update-me" }),
			);
			const beforeUpdate = created.updatedAt;

			harness.advance(2);
			const updated = await store.updateRepoDefinition(created.id, {
				enabled: false,
				mappings: [{ service: "api" }],
			});

			expect(updated.enabled).toBe(false);
			expect(updated.mappings).toEqual([{ service: "api" }]);
			expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
				new Date(beforeUpdate).getTime(),
			);
			// Fields not in the patch are preserved.
			expect(updated.owner).toBe(created.owner);
			expect(updated.repo).toBe(created.repo);
		});

		test("updateRepoDefinition clears setupScript and testCommand when patched with null", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({
					owner: "acme",
					repo: "clear-me",
					setupScript: "npm ci",
					testCommand: "npm test",
				}),
			);

			const updated = await store.updateRepoDefinition(created.id, {
				setupScript: null,
				testCommand: null,
			});

			expect(updated.setupScript).toBeUndefined();
			expect(updated.testCommand).toBeUndefined();
		});

		test("updateRepoDefinition throws RepoDefinitionNotFoundError for unknown id", async () => {
			await expect(
				store.updateRepoDefinition("missing", { enabled: false }),
			).rejects.toThrow(RepoDefinitionNotFoundError);
		});

		test("updateRepoDefinition throws DuplicateRepoDefinitionError when the patched (owner, repo) collides with another definition", async () => {
			await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "taken" }),
			);
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "free" }),
			);

			await expect(
				store.updateRepoDefinition(created.id, { repo: "taken" }),
			).rejects.toThrow(DuplicateRepoDefinitionError);
		});

		test("deleteRepoDefinition returns true and removes the row", async () => {
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({ owner: "acme", repo: "delete-me" }),
			);

			expect(await store.deleteRepoDefinition(created.id)).toBe(true);
			expect(await store.getRepoDefinition(created.id)).toBeUndefined();
		});

		test("deleteRepoDefinition returns false for an unknown id", async () => {
			expect(await store.deleteRepoDefinition("does-not-exist")).toBe(false);
		});

		test("mappings round-trip nested unicode and multiple matcher entries", async () => {
			const mappings: Array<Record<string, string>> = [
				{ service: "日本語サービス", env: "prod" },
				{ service: "widgets", note: 'emoji 🎉 and "quotes"' },
			];
			const created = await store.createRepoDefinition(
				makeRepoDefinitionInput({
					owner: "acme",
					repo: "unicode-mappings",
					mappings,
				}),
			);

			const fetched = await store.getRepoDefinition(created.id);
			expect(fetched?.mappings).toEqual(mappings);
		});
	});
}
