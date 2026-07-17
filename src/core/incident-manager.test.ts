import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { SqliteIncidentStore } from "../storage/sqlite";
import { IncidentManager, type IncidentProcessor } from "./incident-manager";
import type { Incident, IncidentEvent } from "./types";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

function flushAsync(times = 3): Promise<void> {
	return times <= 0
		? Promise.resolve()
		: new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
				flushAsync(times - 1),
			);
}

function makeEvent(overrides: Partial<IncidentEvent> = {}): IncidentEvent {
	return {
		fingerprint: "fp-default",
		source: "grafana",
		status: "firing",
		severity: "critical",
		title: "Something broke",
		labels: { service: "my-api" },
		annotations: {},
		startsAt: new Date().toISOString(),
		raw: {},
		...overrides,
	};
}

/** Processor whose `process()` calls hang until manually resolved, for concurrency tests. */
class ControllableProcessor implements IncidentProcessor {
	readonly calls: Incident[] = [];
	private readonly resolvers = new Map<string, () => void>();

	process(incident: Incident): Promise<void> {
		this.calls.push(incident);
		return new Promise((resolve) => {
			this.resolvers.set(incident.id, () => resolve());
		});
	}

	resolve(incidentId: string): void {
		const resolver = this.resolvers.get(incidentId);
		if (!resolver) {
			throw new Error(`no pending resolver for incident ${incidentId}`);
		}
		resolver();
		this.resolvers.delete(incidentId);
	}
}

class ThrowingProcessor implements IncidentProcessor {
	async process(): Promise<void> {
		throw new Error("processor exploded");
	}
}

async function createManagerDeps(
	concurrency: number,
	cooldownHours: number,
	processor: IncidentProcessor,
) {
	const store = new SqliteIncidentStore(":memory:");
	await store.init();
	const manager = new IncidentManager({
		store,
		logger: silentLogger(),
		config: { agent: { concurrency, cooldownHours } },
		processor,
	});
	return { store, manager };
}

/**
 * Like `createManagerDeps`, but wires the same injectable clock into both the
 * store and the manager, and exposes `advance()` to move it forward
 * deterministically. Used by cooldown-boundary tests that need to
 * distinguish "59 minutes ago" from "61 minutes ago" without depending on
 * real elapsed time (see `IncidentManagerDeps.now`).
 */
async function createManagerDepsWithClock(
	concurrency: number,
	cooldownHours: number,
	processor: IncidentProcessor,
) {
	let current = new Date("2024-01-01T00:00:00.000Z");
	const clock = () => current;
	const store = new SqliteIncidentStore(":memory:", { now: clock });
	await store.init();
	const manager = new IncidentManager({
		store,
		logger: silentLogger(),
		config: { agent: { concurrency, cooldownHours } },
		processor,
		now: clock,
	});
	return {
		store,
		manager,
		advance: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
	};
}

describe("IncidentManager - dedup and cooldown", () => {
	test("dedups a firing event against an existing open incident", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const first = await manager.handleEvent(makeEvent({ fingerprint: "fp-a" }));
		expect(first.action).toBe("created");
		const incidentId = first.incident?.id as string;

		const second = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-a", title: "Still broken" }),
		);
		expect(second.action).toBe("deduped");
		expect(second.incident?.id).toBe(incidentId);

		const events = await store.listEvents(incidentId);
		expect(events.length).toBe(2);
	});

	test("records a cooldown event on the terminal incident instead of creating a new one", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const terminal = await store.createIncident({
			fingerprint: "fp-b",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Old incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "failed",
			failureReason: "timed out",
		});

		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-b" }),
		);
		expect(result.action).toBe("cooldown");
		expect(result.incident?.id).toBe(terminal.id);

		expect(await store.findOpenIncidentByFingerprint("fp-b")).toBeUndefined();
		const events = await store.listEvents(terminal.id);
		expect(events.length).toBe(1);
	});

	test("creates a new incident once the cooldown window has expired", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 0, processor);

		const terminal = await store.createIncident({
			fingerprint: "fp-c",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Old incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "failed",
			failureReason: "timed out",
		});

		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-c" }),
		);
		expect(result.action).toBe("created");
		expect(result.incident?.id).not.toBe(terminal.id);
	});

	test("a 'skipped' terminal incident does not gate a new incident, regardless of recency", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const terminal = await store.createIncident({
			fingerprint: "fp-d",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Old incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "skipped",
			resolvedAt: new Date().toISOString(),
		});

		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-d" }),
		);
		expect(result.action).toBe("created");
	});
});

describe("IncidentManager - resolved events", () => {
	test("drops a resolved event when there is no matching open incident", async () => {
		const processor = new ControllableProcessor();
		const { manager } = await createManagerDeps(2, 24, processor);

		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-none", status: "resolved" }),
		);
		expect(result.action).toBe("dropped");
	});

	test("marks a still-queued incident as skipped and removes it from the queue", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(1, 24, processor);

		const createdA = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-a" }),
		);
		const createdB = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-b" }),
		);
		await flushAsync();

		// Concurrency is 1, so only A should have started; B sits in the queue.
		expect(processor.calls.map((i) => i.fingerprint)).toEqual(["fp-a"]);
		expect(manager.pendingCount).toBe(2);

		const resolvedB = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-b", status: "resolved" }),
		);
		expect(resolvedB.action).toBe("resolved-skip");
		expect(resolvedB.incident?.status).toBe("skipped");

		// Freeing the only concurrency slot must not cause B to run: it was removed from the queue.
		const incidentAId = createdA.incident?.id as string;
		processor.resolve(incidentAId);
		await flushAsync();

		expect(processor.calls.map((i) => i.fingerprint)).toEqual(["fp-a"]);
		const incidentB = await store.getIncident(createdB.incident?.id as string);
		expect(incidentB?.status).toBe("skipped");
	});

	test("keeps an actively-processing incident running and just records resolvedAt", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(1, 24, processor);

		const created = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-active" }),
		);
		await flushAsync();
		expect(processor.calls.length).toBe(1);

		const resolved = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-active", status: "resolved" }),
		);
		expect(resolved.action).toBe("resolved");
		expect(resolved.incident?.resolvedAt).toBeTruthy();

		processor.resolve(created.incident?.id as string);
		await flushAsync();

		// The processor ran exactly once for this incident: resolution did not restart it.
		expect(processor.calls.length).toBe(1);
		const incident = await store.getIncident(created.incident?.id as string);
		expect(incident?.resolvedAt).toBeTruthy();
	});
});

describe("IncidentManager - concurrency", () => {
	test("limits parallel processing to config.agent.concurrency and drains the queue as slots free up", async () => {
		const processor = new ControllableProcessor();
		const { manager } = await createManagerDeps(2, 24, processor);

		const a = await manager.handleEvent(makeEvent({ fingerprint: "fp-1" }));
		const b = await manager.handleEvent(makeEvent({ fingerprint: "fp-2" }));
		const c = await manager.handleEvent(makeEvent({ fingerprint: "fp-3" }));
		await flushAsync();

		expect(processor.calls.length).toBe(2);
		expect(manager.pendingCount).toBe(3);

		processor.resolve(a.incident?.id as string);
		await flushAsync();

		expect(processor.calls.length).toBe(3);
		expect(processor.calls.map((i) => i.fingerprint)).toEqual([
			"fp-1",
			"fp-2",
			"fp-3",
		]);

		processor.resolve(b.incident?.id as string);
		processor.resolve(c.incident?.id as string);
		await flushAsync();

		expect(manager.pendingCount).toBe(0);
	});

	test("continues draining after a processor throws, marking that incident failed", async () => {
		const { store, manager } = await createManagerDeps(
			1,
			24,
			new ThrowingProcessor(),
		);

		const created = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-throw" }),
		);
		await flushAsync();

		const incident = await store.getIncident(created.incident?.id as string);
		expect(incident?.status).toBe("failed");
		expect(incident?.failureReason).toBe("processor exploded");
		expect(manager.pendingCount).toBe(0);
	});
});

describe("IncidentManager - concurrency-safe dedup", () => {
	test("serializes concurrent firing events for a brand-new fingerprint so only one incident is created", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const [a, b] = await Promise.all([
			manager.handleEvent(makeEvent({ fingerprint: "fp-race" })),
			manager.handleEvent(makeEvent({ fingerprint: "fp-race" })),
		]);

		const actions = [a.action, b.action].sort();
		expect(actions).toEqual(["created", "deduped"]);
		expect(a.incident?.id).toBe(b.incident?.id);

		const all = await store.listIncidents(100);
		expect(
			all.filter((incident) => incident.fingerprint === "fp-race").length,
		).toBe(1);
	});

	test("re-enqueues an open incident that is not tracked in-memory (orphaned) when a new firing event dedupes onto it", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		// Simulates a leftover open incident from a previous process lifetime
		// that this manager instance never enqueued itself (e.g. before
		// `recoverOpenIncidents` runs, or some other gap): the manager's
		// in-memory tracking has no idea it exists.
		const orphan = await store.createIncident({
			fingerprint: "fp-orphan",
			source: "grafana",
			status: "diagnosing",
			severity: "critical",
			title: "Orphaned incident",
			labels: {},
			annotations: {},
		});

		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-orphan" }),
		);
		await flushAsync();

		expect(result.action).toBe("deduped");
		expect(result.incident?.id).toBe(orphan.id);
		expect(processor.calls.map((incident) => incident.id)).toEqual([orphan.id]);
	});

	test("does not re-enqueue an open incident that is already active", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const first = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-already-active" }),
		);
		await flushAsync();
		expect(processor.calls.length).toBe(1);

		const second = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-already-active", title: "still broken" }),
		);
		await flushAsync();

		expect(second.action).toBe("deduped");
		// Still exactly one `process()` call: the already-in-flight incident
		// was not queued a second time.
		expect(processor.calls.length).toBe(1);

		processor.resolve(first.incident?.id as string);
		await store.getIncident(first.incident?.id as string);
	});
});

describe("IncidentManager - cooldown window boundary (injectable clock)", () => {
	test("stays in cooldown 59 minutes after the terminal incident's updatedAt with cooldownHours: 1", async () => {
		const processor = new ControllableProcessor();
		const { store, manager, advance } = await createManagerDepsWithClock(
			2,
			1,
			processor,
		);

		const terminal = await store.createIncident({
			fingerprint: "fp-cooldown-boundary-59",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Old incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "failed",
			failureReason: "timed out",
		});

		advance(59 * 60 * 1000);
		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-cooldown-boundary-59" }),
		);

		expect(result.action).toBe("cooldown");
		expect(result.incident?.id).toBe(terminal.id);
	});

	test("creates a new incident 61 minutes after the terminal incident's updatedAt with cooldownHours: 1", async () => {
		const processor = new ControllableProcessor();
		const { store, manager, advance } = await createManagerDepsWithClock(
			2,
			1,
			processor,
		);

		const terminal = await store.createIncident({
			fingerprint: "fp-cooldown-boundary-61",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Old incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "failed",
			failureReason: "timed out",
		});

		advance(61 * 60 * 1000);
		const result = await manager.handleEvent(
			makeEvent({ fingerprint: "fp-cooldown-boundary-61" }),
		);

		expect(result.action).toBe("created");
		expect(result.incident?.id).not.toBe(terminal.id);
	});
});

describe("IncidentManager - restart recovery", () => {
	test("recoverOpenIncidents re-enqueues every non-terminal incident and ignores terminal ones", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const diagnosing = await store.createIncident({
			fingerprint: "fp-recover-a",
			source: "grafana",
			status: "diagnosing",
			severity: "critical",
			title: "Stuck incident A",
			labels: {},
			annotations: {},
		});
		const fixing = await store.createIncident({
			fingerprint: "fp-recover-b",
			source: "grafana",
			status: "fixing",
			severity: "critical",
			title: "Stuck incident B",
			labels: {},
			annotations: {},
		});
		const terminal = await store.createIncident({
			fingerprint: "fp-recover-c",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Terminal incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "failed",
			failureReason: "done",
		});

		expect(manager.pendingCount).toBe(0);
		await manager.recoverOpenIncidents();
		await flushAsync();

		const recoveredIds = processor.calls.map((incident) => incident.id).sort();
		expect(recoveredIds).toEqual([diagnosing.id, fixing.id].sort());
	});

	test("recoverOpenIncidents is a no-op when there are no open incidents", async () => {
		const processor = new ControllableProcessor();
		const { store, manager } = await createManagerDeps(2, 24, processor);

		const terminal = await store.createIncident({
			fingerprint: "fp-recover-none",
			source: "grafana",
			status: "received",
			severity: "critical",
			title: "Terminal incident",
			labels: {},
			annotations: {},
		});
		await store.updateIncident(terminal.id, {
			status: "report_only",
			diagnosis: "n/a",
		});

		await manager.recoverOpenIncidents();
		await flushAsync();

		expect(processor.calls.length).toBe(0);
		expect(manager.pendingCount).toBe(0);
	});
});
