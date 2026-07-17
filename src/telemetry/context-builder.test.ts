import { describe, expect, test } from "bun:test";
import type { Incident, IncidentEvent } from "../core/types";
import { createLogger } from "../observability/logger";
import { buildIncidentContext, renderContextMarkdown } from "./context-builder";
import type {
	LogRecord,
	MetricSeries,
	TelemetryQuery,
	TelemetrySource,
	TraceRecord,
} from "./types";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
	return {
		id: "incident-1",
		fingerprint: "fp-1",
		source: "grafana",
		status: "collecting",
		severity: "critical",
		title: "High error rate on checkout",
		labels: { service: "checkout" },
		annotations: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function makeAlert(overrides: Partial<IncidentEvent> = {}): IncidentEvent {
	return {
		fingerprint: "fp-1",
		source: "grafana",
		status: "firing",
		severity: "critical",
		title: "High error rate on checkout",
		labels: { service: "checkout" },
		annotations: {},
		startsAt: "2026-01-01T12:00:00.000Z",
		raw: {},
		...overrides,
	};
}

function makeLog(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		timestamp: "2026-01-01T11:55:00.000Z",
		severityText: "ERROR",
		severityNumber: 17,
		body: "something failed",
		attributes: {},
		resourceAttributes: {},
		...overrides,
	};
}

function makeTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
	return {
		traceId: "trace-1",
		spanId: "span-1",
		name: "GET /checkout",
		kind: "SPAN_KIND_SERVER",
		serviceName: "checkout",
		startTime: "2026-01-01T11:55:00.000Z",
		durationNano: 10_000_000,
		statusCode: "STATUS_CODE_OK",
		attributes: {},
		...overrides,
	};
}

/** A stubbed TelemetrySource recording every query it receives. */
class StubSource implements TelemetrySource {
	readonly name = "stub";
	readonly logQueries: TelemetryQuery[] = [];
	readonly traceQueries: TelemetryQuery[] = [];
	readonly metricQueries: (TelemetryQuery & { promql?: string })[] = [];

	logsResult: LogRecord[] = [];
	tracesResult: TraceRecord[] = [];
	metricsResult: MetricSeries[] = [];

	async queryLogs(query: TelemetryQuery): Promise<LogRecord[]> {
		this.logQueries.push(query);
		return this.logsResult;
	}

	async queryTraces(query: TelemetryQuery): Promise<TraceRecord[]> {
		this.traceQueries.push(query);
		return this.tracesResult;
	}

	async queryMetrics(
		query: TelemetryQuery & { promql?: string },
	): Promise<MetricSeries[]> {
		this.metricQueries.push(query);
		return this.metricsResult;
	}
}

const defaultConfig = {
	collect: { windowBeforeMinutes: 30, windowAfterMinutes: 5 },
};

describe("buildIncidentContext - window and service resolution", () => {
	test("computes the window from alert.startsAt using config.collect", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const alert = makeAlert({ startsAt: "2026-01-01T12:00:00.000Z" });

		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(context.window.from).toBe("2026-01-01T11:30:00.000Z");
		expect(context.window.to).toBe("2026-01-01T12:05:00.000Z");
	});

	test("caps the window end at 'now' when it would otherwise be in the future", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const now = new Date();
		const alert = makeAlert({ startsAt: now.toISOString() });

		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(new Date(context.window.to).getTime()).toBeLessThanOrEqual(
			Date.now() + 1000,
		);
		expect(new Date(context.window.to).getTime()).toBeLessThan(
			now.getTime() + 5 * 60_000,
		);
	});

	test("survives a malformed alert.startsAt by anchoring the window at now and noting the fallback", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const alert = makeAlert({ startsAt: "N/A" });

		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		// Must not throw (a bare `new Date("N/A").toISOString()` would raise
		// "RangeError: Invalid time value"), and the window must be anchored
		// close to "now" rather than reflecting an Invalid Date.
		expect(new Date(context.window.from).toString()).not.toBe("Invalid Date");
		expect(new Date(context.window.to).toString()).not.toBe("Invalid Date");
		expect(
			Math.abs(new Date(context.window.to).getTime() - Date.now()),
		).toBeLessThan(5_000);
		expect(
			context.notes.some(
				(n) => n.includes("startsAt") && n.includes("not a valid timestamp"),
			),
		).toBe(true);
	});

	test("resolves the service label from the first matching alias and queries by it", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const alert = makeAlert({ labels: { service_name: "billing" } });

		await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(source.logQueries[0]?.labels.service).toBe("billing");
		expect(source.logQueries[0]?.labels.severity).toBe("error");
		expect(source.traceQueries[0]?.labels.service).toBe("billing");
	});

	test("falls back to a window-only, tightly-limited query and records a note when no service label exists", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const alert = makeAlert({ labels: {} });

		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(source.logQueries[0]?.labels.service).toBeUndefined();
		expect(source.logQueries[0]?.limit).toBeLessThan(50);
		expect(
			context.notes.some((n) => n.includes("No service label resolved")),
		).toBe(true);
		expect(
			context.notes.some((n) => n.includes("Skipped representative")),
		).toBe(true);
		// No service means no representative-span query should have been issued.
		expect(source.traceQueries.length).toBe(0);
	});
});

describe("buildIncidentContext - trace collection", () => {
	test("collects distinct trace_ids from error logs (capped) and fetches their spans plus representative spans", async () => {
		const source = new StubSource();
		source.logsResult = [
			makeLog({ traceId: "t1" }),
			makeLog({ traceId: "t1" }),
			makeLog({ traceId: "t2" }),
			makeLog({ traceId: undefined }),
			makeLog({ traceId: "t3" }),
			makeLog({ traceId: "t4" }),
			makeLog({ traceId: "t5" }),
			makeLog({ traceId: "t6" }), // beyond the cap of 5 distinct ids
		];
		source.tracesResult = [makeTrace({ traceId: "t1" })];

		const incident = makeIncident();
		const alert = makeAlert();
		await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		// One call for the by-trace-id batch, one for the representative-spans query.
		expect(source.traceQueries.length).toBe(2);
		const byIdQuery = source.traceQueries[0];
		const ids = byIdQuery?.labels.trace_id?.split(",") ?? [];
		expect(ids.length).toBe(5);
		expect(ids).toEqual(["t1", "t2", "t3", "t4", "t5"]);
	});

	test("dedupes spans that appear in both the by-id and representative-span results", async () => {
		const source = new StubSource();
		source.logsResult = [makeLog({ traceId: "t1" })];
		const shared = makeTrace({ traceId: "t1", spanId: "shared-span" });
		source.tracesResult = [shared];

		const incident = makeIncident();
		const alert = makeAlert();
		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		// Both the by-id call and the representative call return the exact same
		// stub result in this test; the merged output must not duplicate it.
		expect(
			context.telemetry.traces.filter(
				(t) => t.traceId === "t1" && t.spanId === "shared-span",
			).length,
		).toBe(1);
	});
});

describe("buildIncidentContext - metrics", () => {
	test("skips metrics and records a note when no query hint annotation is present", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const alert = makeAlert({ annotations: {} });

		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(source.metricQueries.length).toBe(0);
		expect(context.telemetry.metrics).toEqual([]);
		expect(context.notes.some((n) => n.includes("Metrics skipped"))).toBe(true);
	});

	test("queries metrics using the 'promql' annotation as the query hint", async () => {
		const source = new StubSource();
		source.metricsResult = [
			{
				name: "http_requests_total",
				labels: {},
				points: [{ timestamp: "t", value: 1 }],
			},
		];
		const incident = makeIncident();
		const alert = makeAlert({
			annotations: {
				promql: 'rate(http_requests_total{service="checkout"}[1m])',
			},
		});

		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(source.metricQueries[0]?.promql).toBe(
			'rate(http_requests_total{service="checkout"}[1m])',
		);
		expect(context.telemetry.metrics.length).toBe(1);
	});

	test("falls back to the 'metric' annotation when 'promql' is absent", async () => {
		const source = new StubSource();
		const incident = makeIncident();
		const alert = makeAlert({ annotations: { metric: "up" } });

		await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
		);

		expect(source.metricQueries[0]?.promql).toBe("up");
	});
});

describe("buildIncidentContext - budget/truncation priority", () => {
	function bigBody(prefix: string): string {
		return `${prefix} ${"x".repeat(500)}`;
	}

	// Each test below is individually calibrated (sizes/budgets measured
	// empirically against the real renderer) so that swapping the drop order
	// between tiers -- e.g. dropping traces before metrics, or plain logs
	// before traces -- would make at least one of these fail. A test that
	// merely checks "metrics ended up empty at some tight budget" (the
	// previous version of this suite) passes regardless of *which* tier was
	// dropped first, since a tight enough budget empties every tier anyway.

	test("drops metrics before touching traces", async () => {
		const source = new StubSource();
		const log = makeLog({
			traceId: "t1",
			body: "a single non-exception error",
		});
		const trace = makeTrace({ traceId: "t1", spanId: "s1" });
		// Many distinct series (not many points -- points collapse into one
		// summary line each) so the metrics section meaningfully inflates size.
		const metrics = Array.from({ length: 20 }, (_, i) => ({
			name: `metric_series_${i}`,
			labels: { instance: `host-${i}` },
			points: [{ timestamp: "2026-01-01T11:00:00.000Z", value: i }],
		}));
		source.logsResult = [log];
		source.tracesResult = [trace];
		source.metricsResult = metrics;

		const incident = makeIncident();
		const alert = makeAlert({ annotations: { promql: "cpu_usage" } });

		// Fits without metrics (~640 chars) but not with all 20 series (~2200).
		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
			1_000,
		);

		expect(context.telemetry.metrics).toEqual([]);
		expect(context.telemetry.traces.length).toBe(1);
		expect(context.telemetry.logs.length).toBe(1);
		expect(
			context.notes.some((n) => n.includes("Dropped") && n.includes("metric")),
		).toBe(true);
		expect(context.notes.some((n) => n.includes("trace"))).toBe(false);
		expect(renderContextMarkdown(context).length).toBeLessThanOrEqual(1_000);
	});

	test("drops traces (once metrics are exhausted) before touching plain logs", async () => {
		const source = new StubSource();
		const logs = [
			makeLog({
				traceId: "t1",
				body: "database timeout while fetching cart contents",
			}),
			makeLog({
				traceId: "t1",
				body: "upstream payment gateway returned a 503 response",
			}),
		];
		const traces = [
			makeTrace({ traceId: "t1", spanId: "s1" }),
			makeTrace({ traceId: "t1", spanId: "s2" }),
		];
		source.logsResult = logs;
		source.tracesResult = traces;
		source.metricsResult = []; // no metrics in play for this tier

		const incident = makeIncident();
		const alert = makeAlert({ annotations: {} });

		// Fits with both logs but neither trace (~684 chars); does not fit with
		// even one trace still present (~800+ chars).
		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
			700,
		);

		expect(context.telemetry.traces).toEqual([]);
		expect(context.telemetry.logs.length).toBe(2);
		expect(
			context.notes.some((n) => n.includes("Dropped") && n.includes("trace")),
		).toBe(true);
		expect(context.notes.some((n) => n.includes("log"))).toBe(false);
		expect(renderContextMarkdown(context).length).toBeLessThanOrEqual(700);
	});

	test("keeps exception-bearing logs longest: they survive after metrics, traces, and plain logs are gone", async () => {
		const source = new StubSource();
		source.logsResult = [
			makeLog({
				traceId: "t1",
				body: `exception thrown\n    at handler (/app/x.js:1:1)\n${bigBody("exc")}`,
			}),
			makeLog({ traceId: "t1", body: bigBody("plain-error-1") }),
			makeLog({ traceId: "t1", body: bigBody("plain-error-2") }),
		];
		source.tracesResult = [
			makeTrace({ traceId: "t1", spanId: "s1" }),
			makeTrace({ traceId: "t1", spanId: "s2" }),
		];
		source.metricsResult = [
			{
				name: "cpu_usage",
				labels: {},
				points: Array.from({ length: 20 }, (_, i) => ({
					timestamp: `2026-01-01T11:${String(i).padStart(2, "0")}:00.000Z`,
					value: i,
				})),
			},
		];

		const incident = makeIncident();
		const alert = makeAlert({ annotations: { promql: "cpu_usage" } });

		// Tight enough to force every other tier to empty out completely; the
		// single remaining exception log's own body is large enough that even
		// this last-resort content does not actually fit in 900 chars (see the
		// "still exceeds the budget" test below) -- that's fine, the point here
		// is drop *order*, not that this particular budget is satisfiable.
		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
			900,
		);

		expect(context.telemetry.metrics).toEqual([]);
		expect(context.telemetry.traces).toEqual([]);
		expect(context.telemetry.logs.length).toBe(1);
		const hasExceptionLog = context.telemetry.logs.some((l) =>
			l.body.includes("exception thrown"),
		);
		expect(hasExceptionLog).toBe(true);
	});

	test("does not touch telemetry when the rendered context already fits the budget", async () => {
		const source = new StubSource();
		source.logsResult = [makeLog()];
		source.tracesResult = [makeTrace()];

		const incident = makeIncident();
		const alert = makeAlert();
		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
			60_000,
		);

		expect(context.telemetry.logs.length).toBe(1);
		expect(context.notes.some((n) => n.includes("Dropped"))).toBe(false);
	});

	test("adds a warning note when even maximal truncation cannot fit the budget", async () => {
		const source = new StubSource();
		source.logsResult = [
			makeLog({ body: `exception\n    at f (/a.js:1:1)\n${"x".repeat(2000)}` }),
		];

		const incident = makeIncident();
		const alert = makeAlert();
		const context = await buildIncidentContext(
			{ source, logger: silentLogger(), config: defaultConfig },
			incident,
			alert,
			50,
		);

		expect(
			context.notes.some((n) => n.includes("still exceeds the 50-char budget")),
		).toBe(true);
	});
});

describe("renderContextMarkdown", () => {
	test("renders a deterministic, sectioned summary", () => {
		const incident = makeIncident();
		const alert = makeAlert({
			labels: { service: "checkout", region: "us-east" },
			annotations: { runbook_url: "https://example.com/runbook" },
		});
		const context = {
			incident,
			alert,
			window: {
				from: "2026-01-01T11:30:00.000Z",
				to: "2026-01-01T12:05:00.000Z",
			},
			telemetry: {
				logs: [
					makeLog({
						timestamp: "2026-01-01T11:59:00.000Z",
						body: "database connection timeout after 30s",
					}),
					makeLog({
						timestamp: "2026-01-01T11:58:00.000Z",
						body: "earlier error",
					}),
				],
				traces: [
					makeTrace({
						traceId: "trace-b",
						spanId: "s1",
						startTime: "2026-01-01T11:59:00.000Z",
					}),
					makeTrace({
						traceId: "trace-a",
						spanId: "s2",
						startTime: "2026-01-01T11:58:00.000Z",
					}),
				],
				metrics: [
					{
						name: "http_requests_total",
						labels: { status: "500" },
						points: [
							{ timestamp: "2026-01-01T11:58:00.000Z", value: 1 },
							{ timestamp: "2026-01-01T11:59:00.000Z", value: 3 },
						],
					},
				],
			},
			notes: ["Metrics skipped: no query hint."],
		};

		const markdown = renderContextMarkdown(context);

		expect(markdown).toContain(
			"# Incident: High error rate on checkout (incident-1)",
		);
		expect(markdown).toContain("- Labels: region=us-east, service=checkout");
		expect(markdown).toContain(
			"- Annotations: runbook_url=https://example.com/runbook",
		);
		expect(markdown).toContain("## Notes");
		expect(markdown).toContain("- Metrics skipped: no query hint.");
		expect(markdown).toContain("## Error logs (2)");
		// Logs must be rendered newest-first regardless of input order.
		const timeoutIdx = markdown.indexOf(
			"database connection timeout after 30s",
		);
		const earlierIdx = markdown.indexOf("earlier error");
		expect(timeoutIdx).toBeGreaterThan(-1);
		expect(timeoutIdx).toBeLessThan(earlierIdx);
		// Trace groups are ordered alphabetically by trace_id, deterministically.
		expect(markdown.indexOf("### trace trace-a")).toBeLessThan(
			markdown.indexOf("### trace trace-b"),
		);
		expect(markdown).toContain("## Metrics (1 series)");
		expect(markdown).toContain(
			"http_requests_total{status=500}: n=2 min=1.000 max=3.000 avg=2.000 last=3.000",
		);
	});

	test("renders explicit placeholders for empty sections", () => {
		const incident = makeIncident();
		const alert = makeAlert({ annotations: {} });
		const context = {
			incident,
			alert,
			window: {
				from: "2026-01-01T11:30:00.000Z",
				to: "2026-01-01T12:05:00.000Z",
			},
			telemetry: { logs: [], traces: [], metrics: [] },
			notes: [],
		};

		const markdown = renderContextMarkdown(context);
		expect(markdown).toContain("_No error logs collected._");
		expect(markdown).toContain("_No trace spans collected._");
		expect(markdown).toContain("_No metrics collected._");
		expect(markdown).not.toContain("## Notes");
		expect(markdown).not.toContain("- Annotations:");
	});

	test("truncates a long log body to a 300-char excerpt", () => {
		const incident = makeIncident();
		const alert = makeAlert();
		const longBody = "y".repeat(1_000);
		const context = {
			incident,
			alert,
			window: {
				from: "2026-01-01T11:30:00.000Z",
				to: "2026-01-01T12:05:00.000Z",
			},
			telemetry: {
				logs: [makeLog({ body: longBody })],
				traces: [],
				metrics: [],
			},
			notes: [],
		};

		const markdown = renderContextMarkdown(context);

		expect(markdown).not.toContain(longBody);
		expect(markdown).toContain(`${"y".repeat(300)}…`);
		expect(markdown).not.toContain(`${"y".repeat(301)}`);
	});

	test("is deterministic across repeated calls with the same input", () => {
		const incident = makeIncident();
		const alert = makeAlert();
		const context = {
			incident,
			alert,
			window: {
				from: "2026-01-01T11:30:00.000Z",
				to: "2026-01-01T12:05:00.000Z",
			},
			telemetry: {
				logs: [makeLog(), makeLog({ timestamp: "2026-01-01T11:50:00.000Z" })],
				traces: [makeTrace(), makeTrace({ traceId: "trace-2", spanId: "s2" })],
				metrics: [],
			},
			notes: [],
		};

		expect(renderContextMarkdown(context)).toBe(renderContextMarkdown(context));
	});
});
