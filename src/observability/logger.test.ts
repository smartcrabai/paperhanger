import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger";

function collectLines(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = [];
	return { lines, sink: (line: string) => lines.push(line) };
}

describe("createLogger", () => {
	test("writes a JSON line with level, ts, and msg", () => {
		const { lines, sink } = collectLines();
		const logger = createLogger({ sink });

		logger.info("hello");

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.level).toBe("info");
		expect(entry.msg).toBe("hello");
		expect(typeof entry.ts).toBe("string");
		expect(new Date(entry.ts).toString()).not.toBe("Invalid Date");
	});

	test("merges arbitrary fields into the log line", () => {
		const { lines, sink } = collectLines();
		const logger = createLogger({ sink });

		logger.info("event", { incidentId: "abc-123", count: 3 });

		const entry = JSON.parse(lines[0] as string);
		expect(entry.incidentId).toBe("abc-123");
		expect(entry.count).toBe(3);
	});

	test("child() merges base fields into every subsequent line", () => {
		const { lines, sink } = collectLines();
		const logger = createLogger({ sink });
		const child = logger.child({ component: "ingest" });

		child.warn("something happened", { detail: "x" });

		const entry = JSON.parse(lines[0] as string);
		expect(entry.component).toBe("ingest");
		expect(entry.detail).toBe("x");
		expect(entry.level).toBe("warn");
	});

	test("filters out messages below the configured level", () => {
		const { lines, sink } = collectLines();
		const logger = createLogger({ sink, level: "warn" });

		logger.debug("ignored");
		logger.info("ignored too");
		logger.warn("kept");

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.msg).toBe("kept");
	});

	test("child() inherits the parent's level filtering", () => {
		const { lines, sink } = collectLines();
		const logger = createLogger({ sink, level: "error" });
		const child = logger.child({ component: "x" });

		child.warn("dropped");
		child.error("kept");

		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0] as string);
		expect(entry.msg).toBe("kept");
	});
});
