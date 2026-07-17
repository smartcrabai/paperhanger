import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import { CompositeNotifier, NotifierResponseError } from "./types";
import type { IncidentSnapshot, Notifier, NotificationEvent } from "./types";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

function collectLines(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = [];
	return { lines, sink: (line: string) => lines.push(line) };
}

const incident: IncidentSnapshot = {
	id: "incident-1",
	fingerprint: "fp-1",
	severity: "critical",
	title: "High error rate",
	source: "grafana",
};

const event: NotificationEvent = { kind: "diagnosis_started", incident };

class RecordingNotifier implements Notifier {
	readonly calls: NotificationEvent[] = [];

	constructor(readonly name: string) {}

	async notify(evt: NotificationEvent): Promise<void> {
		this.calls.push(evt);
	}
}

class ThrowingNotifier implements Notifier {
	constructor(
		readonly name: string,
		private readonly error: unknown = new Error("boom"),
	) {}

	async notify(): Promise<void> {
		throw this.error;
	}
}

describe("NotifierResponseError", () => {
	test("carries notifier name, status, and body excerpt in its message", () => {
		const err = new NotifierResponseError("slack", 500, "server error");
		expect(err.name).toBe("NotifierResponseError");
		expect(err.notifierName).toBe("slack");
		expect(err.status).toBe(500);
		expect(err.bodyExcerpt).toBe("server error");
		expect(err.message).toContain("slack");
		expect(err.message).toContain("500");
	});
});

describe("CompositeNotifier", () => {
	test("fans an event out to every notifier", async () => {
		const a = new RecordingNotifier("a");
		const b = new RecordingNotifier("b");
		const composite = new CompositeNotifier([a, b], silentLogger());

		await composite.notify(event);

		expect(a.calls).toEqual([event]);
		expect(b.calls).toEqual([event]);
	});

	test("isolates a failing notifier: others still run and the error is not rethrown", async () => {
		const good = new RecordingNotifier("good");
		const bad = new ThrowingNotifier("bad");
		const composite = new CompositeNotifier([bad, good], silentLogger());

		await expect(composite.notify(event)).resolves.toBeUndefined();
		expect(good.calls).toEqual([event]);
	});

	test("logs the failing notifier's name, event kind, and incident id", async () => {
		const { lines, sink } = collectLines();
		const bad = new ThrowingNotifier("bad", new Error("connection refused"));
		const composite = new CompositeNotifier([bad], createLogger({ sink }));

		await composite.notify(event);

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.level).toBe("error");
		expect(entry.notifier).toBe("bad");
		expect(entry.kind).toBe("diagnosis_started");
		expect(entry.incidentId).toBe("incident-1");
		expect(entry.error).toBe("connection refused");
	});

	test("does not throw even when every notifier fails", async () => {
		const composite = new CompositeNotifier(
			[new ThrowingNotifier("a"), new ThrowingNotifier("b")],
			silentLogger(),
		);

		await expect(composite.notify(event)).resolves.toBeUndefined();
	});

	test("handles non-Error throws (e.g. a thrown string)", async () => {
		const { lines, sink } = collectLines();
		const bad = new ThrowingNotifier("bad", "raw string failure");
		const composite = new CompositeNotifier([bad], createLogger({ sink }));

		await composite.notify(event);

		const entry = JSON.parse(lines[0] as string);
		expect(entry.error).toBe("raw string failure");
	});
});
