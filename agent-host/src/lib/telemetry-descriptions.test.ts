import { describe, expect, test } from "bun:test";
import { describeTelemetrySource } from "./telemetry-descriptions";

describe("describeTelemetrySource", () => {
	test("mentions GreptimeDB's SQL expression escape hatch for logs/traces", () => {
		const description = describeTelemetrySource("greptimedb");
		expect(description).toContain("GreptimeDB");
		expect(description).toContain("SQL statement");
	});

	test("states Loki is logs-only", () => {
		const description = describeTelemetrySource("loki");
		expect(description).toContain("Loki");
		expect(description).toContain("Logs only");
	});

	test("states Tempo is traces-only", () => {
		const description = describeTelemetrySource("tempo");
		expect(description).toContain("Traces only");
	});

	test("states Zabbix has no tracing concept and requires an exact item key for metrics", () => {
		const description = describeTelemetrySource("zabbix");
		expect(description).toContain("no tracing concept");
		expect(description).toContain("exact Zabbix item key");
	});

	test("states Mackerel has no tracing concept and requires an exact metric name for metrics", () => {
		const description = describeTelemetrySource("mackerel");
		expect(description).toContain("no tracing concept");
		expect(description).toContain("exact Mackerel metric name");
	});

	test.each([
		["prometheus", "Prometheus"],
		["clickstack", "ClickStack"],
		["signoz", "SigNoz"],
		["openobserve", "OpenObserve"],
		["datadog", "Datadog"],
		["newrelic", "New Relic"],
		["grafana", "Grafana"],
	])("returns a description naming the backend for %s", (source, name) => {
		const description = describeTelemetrySource(source);
		expect(description).toContain(name);
	});

	test("falls back to a safe generic description for an unrecognized source name (e.g. a future `composite` source)", () => {
		const description = describeTelemetrySource("composite");
		expect(description).toContain('Backend: "composite"');
		// Still carries the generic capabilities note, so the tool remains
		// usable (structured filter + the metrics expression requirement)
		// even for a source this file doesn't specifically know about.
		expect(description).toContain("Structured `filter`");
	});

	test("never throws for an empty source name", () => {
		expect(() => describeTelemetrySource("")).not.toThrow();
	});
});
