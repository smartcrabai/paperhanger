import { describe, expect, test } from "bun:test";
import type { IncidentStatus } from "../core/types";
import { INCIDENT_STATUSES, TERMINAL_INCIDENT_STATUSES } from "../core/types";
import { StatusBadge } from "./status-badge";
import { render, screen, setupDashboardTest } from "./test-setup";

setupDashboardTest();

/** The only tones `StatusBadge` is allowed to render (mirrors its private `Tone` union). */
const KNOWN_TONES: Record<string, true> = {
	amber: true,
	blue: true,
	green: true,
	purple: true,
	gray: true,
	red: true,
};

/**
 * Table-driven expectations, keyed by a `Record<IncidentStatus, ...>` literal:
 * adding a status to `IncidentStatus` without adding it here is a compile
 * error, so this table can't silently fall out of sync with the domain type
 * -- when someone actually runs `tsc`. `bun test` doesn't type-check, though,
 * so that guarantee is worthless against a status added and shipped through
 * `bun test` alone. `ALL_STATUSES` below is read from `INCIDENT_STATUSES`,
 * `core/types.ts`'s runtime source of truth, not from this hand-maintained
 * object, so the generic per-status assertions further down exercise every
 * *actual* status even if this table (or `StatusBadge`'s own label/tone maps)
 * forgot one.
 */
const CASES: Record<IncidentStatus, { label: string; tone: string }> = {
	received: { label: "Received", tone: "amber" },
	collecting: { label: "Collecting", tone: "amber" },
	resolving_repo: { label: "Resolving repo", tone: "amber" },
	diagnosing: { label: "Diagnosing", tone: "blue" },
	fixing: { label: "Fixing", tone: "blue" },
	pr_created: { label: "PR created", tone: "green" },
	report_only: { label: "Report only", tone: "purple" },
	failed: { label: "Failed", tone: "red" },
	skipped: { label: "Skipped", tone: "gray" },
};

const ALL_STATUSES = INCIDENT_STATUSES;

describe("StatusBadge", () => {
	for (const status of ALL_STATUSES) {
		const { label, tone } = CASES[status];

		test(`renders "${label}" with badge-${tone} for status "${status}"`, () => {
			render(<StatusBadge status={status} />);

			// The class name IS the contract here (StatusBadge is a pure label+tone
			// map), so asserting it directly is the behavior, not a proxy for it.
			expect(screen.getByText(label)).toHaveClass(`badge badge-${tone}`, {
				exact: true,
			});
		});
	}

	for (const status of ALL_STATUSES) {
		const { label } = CASES[status];

		test(`renders the "${label}" label with no stray whitespace for status "${status}"`, () => {
			render(<StatusBadge status={status} />);

			// getByText's default matcher trims and collapses whitespace, so a typo
			// like a trailing space left in STATUS_LABEL (e.g. "Received ") would
			// still satisfy `getByText(label)` above and render an invisible extra
			// space in the badge. Read the raw DOM text back out to catch that.
			expect(screen.getByText(label).textContent).toBe(label);
		});
	}

	// Runtime source-of-truth check, independent of CASES: reads the actual
	// rendered span for every status `INCIDENT_STATUSES` currently lists,
	// without assuming StatusBadge has a label/tone entry for it. Before this
	// bug was fixed, adding a status to the old bare `IncidentStatus` union
	// without a matching StatusBadge entry compiled fine and rendered an empty
	// label with class `badge badge-undefined` -- a bug no runtime test could
	// catch, because the union had no runtime list to drive a loop from. Now
	// that `IncidentStatus` is derived from `INCIDENT_STATUSES`, this loop
	// covers every status that exists, not just the ones this file's authors
	// remembered to add to CASES.
	for (const status of INCIDENT_STATUSES) {
		test(`gives status "${status}" a real label and a known tone (never badge-undefined)`, () => {
			const { container } = render(<StatusBadge status={status} />);
			const badge = container.firstElementChild;

			expect(badge).not.toBeNull();
			expect(badge?.textContent?.trim().length ?? 0).toBeGreaterThan(0);

			const toneMatch = badge?.className.match(/^badge badge-(.+)$/);
			expect(toneMatch).not.toBeNull();
			expect(KNOWN_TONES[toneMatch?.[1] ?? ""]).toBe(true);
		});
	}

	test("gives every status a distinct label", () => {
		const labels = ALL_STATUSES.map((status) => CASES[status].label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("never gives a terminal status the same tone as an in-flight one", () => {
		// The doc comment's invariant: terminal outcomes get their own colors so
		// an operator can tell "finished" from "still running" at a glance. If a
		// terminal and non-terminal status ever shared a tone, that glance would
		// lie.
		const terminalTones = new Set(
			TERMINAL_INCIDENT_STATUSES.map((status) => CASES[status].tone),
		);
		const nonTerminalTones = new Set(
			ALL_STATUSES.filter(
				(status) => !TERMINAL_INCIDENT_STATUSES.includes(status),
			).map((status) => CASES[status].tone),
		);

		for (const tone of terminalTones) {
			expect(nonTerminalTones.has(tone)).toBe(false);
		}
	});
	test("renders a single span with no wrapper element", () => {
		const { container } = render(<StatusBadge status="received" />);

		expect(container.children).toHaveLength(1);
		expect(container.firstElementChild?.tagName).toBe("SPAN");
	});
});
