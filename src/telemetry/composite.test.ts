import { describe, expect, test } from "bun:test";
import type {
	CompositeTelemetryConfig,
	SignalSourceConfig,
} from "../config/schema";
import { createLogger } from "../observability/logger";
import {
	CompositeTelemetrySource,
	type CompositeTelemetrySourceSlots,
} from "./composite";
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

/** A logger whose sink captures each emitted JSON line for assertions. */
function capturingLogger() {
	const lines: string[] = [];
	const logger = createLogger({ sink: (line) => lines.push(line) });
	return { logger, lines };
}

function parsedEntries(lines: string[]): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const WINDOW = {
	from: "2026-01-01T00:00:00.000Z",
	to: "2026-01-01T01:00:00.000Z",
};

function baseQuery(): TelemetryQuery {
	return { timeRange: WINDOW, labels: {} };
}

function makeLogRecord(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		timestamp: "2026-01-01T00:05:00.000Z",
		severityText: "ERROR",
		severityNumber: 17,
		body: "boom",
		attributes: {},
		resourceAttributes: {},
		...overrides,
	};
}

function makeTraceRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
	return {
		traceId: "trace-1",
		spanId: "span-1",
		name: "GET /widgets",
		kind: "SERVER",
		serviceName: "widgets",
		startTime: "2026-01-01T00:05:00.000Z",
		durationNano: 1_000_000,
		statusCode: "OK",
		attributes: {},
		...overrides,
	};
}

function makeMetricSeries(overrides: Partial<MetricSeries> = {}): MetricSeries {
	return {
		name: "http_requests_total",
		labels: {},
		points: [],
		...overrides,
	};
}

interface MockSourceOptions {
	name: string;
	logs?: LogRecord[];
	traces?: TraceRecord[];
	metrics?: MetricSeries[];
	throwOn?: "queryLogs" | "queryTraces" | "queryMetrics";
}

interface RecordedCall {
	method: "queryLogs" | "queryTraces" | "queryMetrics";
}

function mockSource(options: MockSourceOptions): {
	source: TelemetrySource;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const source: TelemetrySource = {
		name: options.name,
		async queryLogs() {
			calls.push({ method: "queryLogs" });
			if (options.throwOn === "queryLogs") {
				throw new Error(`${options.name} queryLogs failed`);
			}
			return options.logs ?? [];
		},
		async queryTraces() {
			calls.push({ method: "queryTraces" });
			if (options.throwOn === "queryTraces") {
				throw new Error(`${options.name} queryTraces failed`);
			}
			return options.traces ?? [];
		},
		async queryMetrics() {
			calls.push({ method: "queryMetrics" });
			if (options.throwOn === "queryMetrics") {
				throw new Error(`${options.name} queryMetrics failed`);
			}
			return options.metrics ?? [];
		},
	};
	return { source, calls };
}

function compositeConfig(
	overrides: Partial<CompositeTelemetryConfig> = {},
): CompositeTelemetryConfig {
	return { source: "composite", ...overrides } as CompositeTelemetryConfig;
}

const LOKI_SLOT: SignalSourceConfig = { source: "loki", url: "http://loki" };
const TEMPO_SLOT: SignalSourceConfig = { source: "tempo", url: "http://tempo" };
const PROMETHEUS_SLOT: SignalSourceConfig = {
	source: "prometheus",
	url: "http://prometheus",
};

describe("CompositeTelemetrySource - per-signal delegation", () => {
	test("queryLogs delegates only to the logs slot child", async () => {
		const logs = mockSource({ name: "loki", logs: [makeLogRecord()] });
		const traces = mockSource({ name: "tempo" });
		const metrics = mockSource({ name: "prometheus" });
		const slots: CompositeTelemetrySourceSlots = {
			logs: logs.source,
			traces: traces.source,
			metrics: metrics.source,
		};
		const composite = new CompositeTelemetrySource(
			compositeConfig({
				logs: LOKI_SLOT,
				traces: TEMPO_SLOT,
				metrics: PROMETHEUS_SLOT,
			}),
			slots,
			silentLogger(),
		);

		const result = await composite.queryLogs(baseQuery());

		expect(result).toEqual([makeLogRecord()]);
		expect(logs.calls).toEqual([{ method: "queryLogs" }]);
		expect(traces.calls).toEqual([]);
		expect(metrics.calls).toEqual([]);
	});

	test("queryTraces delegates only to the traces slot child", async () => {
		const logs = mockSource({ name: "loki" });
		const traces = mockSource({ name: "tempo", traces: [makeTraceRecord()] });
		const metrics = mockSource({ name: "prometheus" });
		const slots: CompositeTelemetrySourceSlots = {
			logs: logs.source,
			traces: traces.source,
			metrics: metrics.source,
		};
		const composite = new CompositeTelemetrySource(
			compositeConfig({
				logs: LOKI_SLOT,
				traces: TEMPO_SLOT,
				metrics: PROMETHEUS_SLOT,
			}),
			slots,
			silentLogger(),
		);

		const result = await composite.queryTraces(baseQuery());

		expect(result).toEqual([makeTraceRecord()]);
		expect(traces.calls).toEqual([{ method: "queryTraces" }]);
		expect(logs.calls).toEqual([]);
		expect(metrics.calls).toEqual([]);
	});

	test("queryMetrics delegates only to the metrics slot child", async () => {
		const logs = mockSource({ name: "loki" });
		const traces = mockSource({ name: "tempo" });
		const metrics = mockSource({
			name: "prometheus",
			metrics: [makeMetricSeries()],
		});
		const slots: CompositeTelemetrySourceSlots = {
			logs: logs.source,
			traces: traces.source,
			metrics: metrics.source,
		};
		const composite = new CompositeTelemetrySource(
			compositeConfig({
				logs: LOKI_SLOT,
				traces: TEMPO_SLOT,
				metrics: PROMETHEUS_SLOT,
			}),
			slots,
			silentLogger(),
		);

		const result = await composite.queryMetrics(baseQuery());

		expect(result).toEqual([makeMetricSeries()]);
		expect(metrics.calls).toEqual([{ method: "queryMetrics" }]);
		expect(logs.calls).toEqual([]);
		expect(traces.calls).toEqual([]);
	});

	test("a source placed in one slot never has its other query methods called, even though it implements them", async () => {
		// A single mock instance reused across all three slots (like configuring
		// the same multi-signal backend, e.g. datadog, in every slot) still only
		// ever receives the one call matching each slot's signal.
		const shared = mockSource({ name: "datadog" });
		const slots: CompositeTelemetrySourceSlots = {
			logs: shared.source,
			traces: shared.source,
			metrics: shared.source,
		};
		const composite = new CompositeTelemetrySource(
			compositeConfig({
				logs: { source: "datadog", apiKey: "k", appKey: "a" },
				traces: { source: "datadog", apiKey: "k", appKey: "a" },
				metrics: { source: "datadog", apiKey: "k", appKey: "a" },
			}),
			slots,
			silentLogger(),
		);

		await composite.queryLogs(baseQuery());

		expect(shared.calls).toEqual([{ method: "queryLogs" }]);
	});
});

describe("CompositeTelemetrySource - unset slots", () => {
	test("an unset logs slot returns [] without calling any child", async () => {
		const traces = mockSource({ name: "tempo" });
		const composite = new CompositeTelemetrySource(
			compositeConfig({ traces: TEMPO_SLOT }),
			{ traces: traces.source },
			silentLogger(),
		);

		const result = await composite.queryLogs(baseQuery());

		expect(result).toEqual([]);
	});

	test("querying an unset slot logs no warning", async () => {
		const { logger, lines } = capturingLogger();
		const composite = new CompositeTelemetrySource(
			compositeConfig({ logs: LOKI_SLOT }),
			{ logs: mockSource({ name: "loki" }).source },
			logger,
		);
		lines.length = 0; // discard the one construction-time info line

		await composite.queryTraces(baseQuery());
		await composite.queryMetrics(baseQuery());

		expect(lines).toEqual([]);
	});

	test("logs one info line at construction listing the unconfigured signals", () => {
		const { logger, lines } = capturingLogger();
		new CompositeTelemetrySource(
			compositeConfig({ logs: LOKI_SLOT }),
			{ logs: mockSource({ name: "loki" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		const infoEntries = entries.filter((e) => e.level === "info");
		expect(infoEntries.length).toBe(1);
		expect(infoEntries[0]?.signals).toEqual(["traces", "metrics"]);
	});

	test("logs no unconfigured-signals info line when every slot is set", () => {
		const { logger, lines } = capturingLogger();
		new CompositeTelemetrySource(
			compositeConfig({
				logs: LOKI_SLOT,
				traces: TEMPO_SLOT,
				metrics: PROMETHEUS_SLOT,
			}),
			{
				logs: mockSource({ name: "loki" }).source,
				traces: mockSource({ name: "tempo" }).source,
				metrics: mockSource({ name: "prometheus" }).source,
			},
			logger,
		);

		const entries = parsedEntries(lines);
		expect(entries.some((e) => e.level === "info")).toBe(false);
	});
});

describe("CompositeTelemetrySource - per-signal error isolation", () => {
	test("a child throwing in one slot isolates to that signal only", async () => {
		const { logger, lines } = capturingLogger();
		const logs = mockSource({ name: "loki", throwOn: "queryLogs" });
		const traces = mockSource({ name: "tempo", traces: [makeTraceRecord()] });
		const composite = new CompositeTelemetrySource(
			compositeConfig({ logs: LOKI_SLOT, traces: TEMPO_SLOT }),
			{ logs: logs.source, traces: traces.source },
			logger,
		);

		const logsResult = await composite.queryLogs(baseQuery());
		const tracesResult = await composite.queryTraces(baseQuery());

		expect(logsResult).toEqual([]);
		expect(tracesResult).toEqual([makeTraceRecord()]);
		const entries = parsedEntries(lines);
		const errorEntries = entries.filter((e) => e.level === "error");
		expect(errorEntries.length).toBe(1);
		expect(errorEntries[0]?.signal).toBe("logs");
		expect(errorEntries[0]?.childSource).toBe("loki");
	});

	test("a thrown error never propagates out of the composite source", async () => {
		const logs = mockSource({ name: "loki", throwOn: "queryLogs" });
		const composite = new CompositeTelemetrySource(
			compositeConfig({ logs: LOKI_SLOT }),
			{ logs: logs.source },
			silentLogger(),
		);

		await expect(composite.queryLogs(baseQuery())).resolves.toEqual([]);
	});
});

describe("CompositeTelemetrySource - slot misplacement warnings", () => {
	test("warns once at construction when a logs-only source is placed in traces:", () => {
		const { logger, lines } = capturingLogger();
		new CompositeTelemetrySource(
			compositeConfig({ traces: LOKI_SLOT }),
			{ traces: mockSource({ name: "loki" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		const warnEntries = entries.filter((e) => e.level === "warn");
		expect(warnEntries.length).toBe(1);
		expect(warnEntries[0]?.signal).toBe("traces");
		expect(warnEntries[0]?.source).toBe("loki");
	});

	test("does not warn when each slot's source matches its signal", () => {
		const { logger, lines } = capturingLogger();
		new CompositeTelemetrySource(
			compositeConfig({
				logs: LOKI_SLOT,
				traces: TEMPO_SLOT,
				metrics: PROMETHEUS_SLOT,
			}),
			{
				logs: mockSource({ name: "loki" }).source,
				traces: mockSource({ name: "tempo" }).source,
				metrics: mockSource({ name: "prometheus" }).source,
			},
			logger,
		);

		const entries = parsedEntries(lines);
		expect(entries.some((e) => e.level === "warn")).toBe(false);
	});

	test("warns for clickstack in the metrics slot (metrics always returns [] for that backend)", () => {
		const { logger, lines } = capturingLogger();
		const clickstackSlot: SignalSourceConfig = {
			source: "clickstack",
			url: "http://clickhouse:8123",
			database: "default",
		};
		new CompositeTelemetrySource(
			compositeConfig({ metrics: clickstackSlot }),
			{ metrics: mockSource({ name: "clickstack" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		const warnEntries = entries.filter((e) => e.level === "warn");
		expect(warnEntries.length).toBe(1);
		expect(warnEntries[0]?.signal).toBe("metrics");
	});

	test("warns for zabbix/mackerel-class sources in the traces slot (no tracing concept at all)", () => {
		const { logger, lines } = capturingLogger();
		const zabbixSlot: SignalSourceConfig = {
			source: "zabbix",
			url: "http://zabbix",
			apiToken: "token",
		};
		new CompositeTelemetrySource(
			compositeConfig({ traces: zabbixSlot }),
			{ traces: mockSource({ name: "zabbix" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		const warnEntries = entries.filter((e) => e.level === "warn");
		expect(warnEntries.length).toBe(1);
		expect(warnEntries[0]?.signal).toBe("traces");
	});

	test("does not warn for zabbix/mackerel-class sources in the metrics slot (per-query condition, not a structural no-op)", () => {
		const { logger, lines } = capturingLogger();
		const mackerelSlot: SignalSourceConfig = {
			source: "mackerel",
			apiKey: "key",
		};
		new CompositeTelemetrySource(
			compositeConfig({ metrics: mackerelSlot }),
			{ metrics: mockSource({ name: "mackerel" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		expect(entries.some((e) => e.level === "warn")).toBe(false);
	});

	test("grafana's capability is read from its configured datasource UIDs: warns when the matching UID is missing", () => {
		const { logger, lines } = capturingLogger();
		const grafanaSlotWithoutLokiUid: SignalSourceConfig = {
			source: "grafana",
			url: "http://grafana",
			serviceAccountToken: "token",
			tempoDatasourceUid: "tempo-uid",
		};
		new CompositeTelemetrySource(
			compositeConfig({ logs: grafanaSlotWithoutLokiUid }),
			{ logs: mockSource({ name: "grafana" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		const warnEntries = entries.filter((e) => e.level === "warn");
		expect(warnEntries.length).toBe(1);
		expect(warnEntries[0]?.signal).toBe("logs");
	});

	test("grafana's capability is read from its configured datasource UIDs: no warning when the matching UID is set", () => {
		const { logger, lines } = capturingLogger();
		const grafanaSlotWithLokiUid: SignalSourceConfig = {
			source: "grafana",
			url: "http://grafana",
			serviceAccountToken: "token",
			lokiDatasourceUid: "loki-uid",
		};
		new CompositeTelemetrySource(
			compositeConfig({ logs: grafanaSlotWithLokiUid }),
			{ logs: mockSource({ name: "grafana" }).source },
			logger,
		);

		const entries = parsedEntries(lines);
		expect(entries.some((e) => e.level === "warn")).toBe(false);
	});

	test("does not warn for an all-signal backend (e.g. greptimedb) in any slot", () => {
		const { logger, lines } = capturingLogger();
		const greptimedbSlot: SignalSourceConfig = {
			source: "greptimedb",
			url: "http://greptimedb:4000",
			database: "public",
		};
		new CompositeTelemetrySource(
			compositeConfig({
				logs: greptimedbSlot,
				traces: greptimedbSlot,
				metrics: greptimedbSlot,
			}),
			{
				logs: mockSource({ name: "greptimedb" }).source,
				traces: mockSource({ name: "greptimedb" }).source,
				metrics: mockSource({ name: "greptimedb" }).source,
			},
			logger,
		);

		const entries = parsedEntries(lines);
		expect(entries.some((e) => e.level === "warn")).toBe(false);
	});
});

describe("CompositeTelemetrySource - name", () => {
	test("reports 'composite' as its own name", () => {
		const composite = new CompositeTelemetrySource(
			compositeConfig({ logs: LOKI_SLOT }),
			{ logs: mockSource({ name: "loki" }).source },
			silentLogger(),
		);
		expect(composite.name).toBe("composite");
	});
});
