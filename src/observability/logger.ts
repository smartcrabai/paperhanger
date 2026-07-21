/**
 * Minimal structured JSON-lines logger.
 *
 * Every log line is a single JSON object with at least `level`, `ts`, and
 * `msg`. Additional fields (from `child()` or per-call) are merged in. When
 * called while an OTel span is active (see `src/observability/tracing.ts`),
 * the line also carries `traceId`/`spanId` so logs and traces correlate.
 */

import { isSpanContextValid, trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function isLogLevel(value: string): value is LogLevel {
	return LOG_LEVELS.has(value as LogLevel);
}

export type LogFields = Record<string, unknown>;

export interface Logger {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
	/** Returns a new logger that merges `fields` into every subsequent log line. */
	child(fields: LogFields): Logger;
}

export interface LoggerOptions {
	/** Minimum level to emit. Defaults to `LOG_LEVEL` env var, then "info". */
	level?: LogLevel;
	/** Fields merged into every log line emitted by this logger. */
	fields?: LogFields;
	/** Where to write each formatted line. Defaults to `console.log`. Mainly for tests. */
	sink?: (line: string) => void;
}

/** Reads the default log level from the `LOG_LEVEL` environment variable, if valid. */
export function logLevelFromEnv(
	env: Record<string, string | undefined> = Bun.env,
): LogLevel | undefined {
	const raw = env.LOG_LEVEL?.toLowerCase();
	return raw !== undefined && isLogLevel(raw) ? raw : undefined;
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const level = options.level ?? logLevelFromEnv() ?? "info";
	const baseFields = options.fields ?? {};
	const sink = options.sink ?? ((line: string) => console.log(line));

	function write(msgLevel: LogLevel, msg: string, fields?: LogFields): void {
		if (LEVEL_ORDER[msgLevel] < LEVEL_ORDER[level]) {
			return;
		}
		const spanContext = trace.getActiveSpan()?.spanContext();
		const correlation =
			spanContext !== undefined && isSpanContextValid(spanContext)
				? { traceId: spanContext.traceId, spanId: spanContext.spanId }
				: {};
		const entry = {
			level: msgLevel,
			ts: new Date().toISOString(),
			msg,
			...correlation,
			...baseFields,
			...fields,
		};
		sink(JSON.stringify(entry));
	}

	return {
		debug: (msg, fields) => write("debug", msg, fields),
		info: (msg, fields) => write("info", msg, fields),
		warn: (msg, fields) => write("warn", msg, fields),
		error: (msg, fields) => write("error", msg, fields),
		child: (fields) =>
			createLogger({ level, fields: { ...baseFields, ...fields }, sink }),
	};
}
