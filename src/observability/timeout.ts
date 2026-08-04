/**
 * Shared helper for bounding OTel flush/shutdown work so process shutdown
 * stays bounded even against an unreachable OTLP endpoint. Used by both
 * self-instrumentation signals (tracing.ts, log-export.ts).
 */

/**
 * Races `work` against `timeoutMs`. On timeout, calls `onTimeout` and
 * resolves -- the returned promise never rejects because of the timeout
 * itself (rejections of `work` still propagate to the caller).
 */
export async function withTimeout(
	work: Promise<void>,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			onTimeout();
			resolve();
		}, timeoutMs);
	});
	try {
		await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
