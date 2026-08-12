import { describe, expect, test } from "bun:test";
import type { CompositeTelemetryConfig } from "../config/schema";
import { createLogger } from "../observability/logger";
import { ClickStackSource } from "./clickstack";
import { CompositeTelemetrySource } from "./composite";
import { DatadogSource } from "./datadog";
import { createTelemetrySource } from "./factory";
import { GrafanaSource } from "./grafana";
import { GreptimeDbSource } from "./greptimedb";
import { LokiSource } from "./loki";
import { MackerelSource } from "./mackerel";
import { NewRelicSource } from "./newrelic";
import { OpenObserveSource } from "./openobserve";
import { PrometheusSource } from "./prometheus";
import { SigNozSource } from "./signoz";
import { TempoSource } from "./tempo";
import { ZabbixSource } from "./zabbix";

function silentLogger() {
	return createLogger({ sink: () => {} });
}

describe("createTelemetrySource - composite", () => {
	test("constructs a CompositeTelemetrySource for source: composite", () => {
		const config: CompositeTelemetryConfig = {
			source: "composite",
			logs: { source: "loki", url: "http://loki" },
		};

		const source = createTelemetrySource(config, silentLogger());

		expect(source).toBeInstanceOf(CompositeTelemetrySource);
	});

	test("constructs the right concrete child class per configured slot", () => {
		const config: CompositeTelemetryConfig = {
			source: "composite",
			logs: { source: "loki", url: "http://loki" },
			traces: { source: "tempo", url: "http://tempo" },
			metrics: { source: "prometheus", url: "http://prometheus" },
		};

		const source = createTelemetrySource(
			config,
			silentLogger(),
		) as CompositeTelemetrySource;

		expect(source.slots.logs).toBeInstanceOf(LokiSource);
		expect(source.slots.traces).toBeInstanceOf(TempoSource);
		expect(source.slots.metrics).toBeInstanceOf(PrometheusSource);
	});

	test("leaves an unconfigured slot as undefined rather than constructing a default child", () => {
		const config: CompositeTelemetryConfig = {
			source: "composite",
			logs: { source: "loki", url: "http://loki" },
		};

		const source = createTelemetrySource(
			config,
			silentLogger(),
		) as CompositeTelemetrySource;

		expect(source.slots.logs).toBeInstanceOf(LokiSource);
		expect(source.slots.traces).toBeUndefined();
		expect(source.slots.metrics).toBeUndefined();
	});

	test("constructs a multi-signal backend (e.g. greptimedb) once per slot it's placed in", () => {
		const config: CompositeTelemetryConfig = {
			source: "composite",
			logs: {
				source: "greptimedb",
				url: "http://greptimedb:4000",
				database: "public",
			},
			metrics: {
				source: "greptimedb",
				url: "http://greptimedb:4000",
				database: "public",
			},
		};

		const source = createTelemetrySource(
			config,
			silentLogger(),
		) as CompositeTelemetrySource;

		expect(source.slots.logs).toBeInstanceOf(GreptimeDbSource);
		expect(source.slots.metrics).toBeInstanceOf(GreptimeDbSource);
		// Recursion constructs one child instance per slot, not a shared one.
		expect(source.slots.logs).not.toBe(source.slots.metrics);
	});

	test.each([
		[
			"clickstack",
			ClickStackSource,
			{ url: "http://clickhouse:8123", database: "default" },
		],
		["signoz", SigNozSource, { url: "http://signoz", apiKey: "key" }],
		[
			"openobserve",
			OpenObserveSource,
			{ url: "http://openobserve", organization: "org" },
		],
		["datadog", DatadogSource, { apiKey: "key", appKey: "app" }],
		["newrelic", NewRelicSource, { apiKey: "key", accountId: 1 }],
		[
			"grafana",
			GrafanaSource,
			{ url: "http://grafana", serviceAccountToken: "token" },
		],
		["zabbix", ZabbixSource, { url: "http://zabbix", apiToken: "token" }],
		["mackerel", MackerelSource, { apiKey: "key" }],
	] as const)(
		"constructs a %s child for a slot configured with that source",
		(sourceName, ExpectedClass, extraFields) => {
			const config = {
				source: "composite",
				logs: { source: sourceName, ...extraFields },
			} as CompositeTelemetryConfig;

			const source = createTelemetrySource(
				config,
				silentLogger(),
			) as CompositeTelemetrySource;

			expect(source.slots.logs).toBeInstanceOf(ExpectedClass);
		},
	);
});
