import { useCallback, useEffect, useRef, useState } from "react";
import type { CommonSystemPrompt } from "../core/types";
import { ApiError, getCommonSystemPrompt, saveCommonSystemPrompt } from "./api";

export function SystemPromptView({
	token,
	onUnauthorized,
}: {
	token: string;
	onUnauthorized: () => void;
}) {
	const [stored, setStored] = useState<CommonSystemPrompt | null>(null);
	const [draft, setDraft] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string>();
	// A refetch that fails once content is already on screen must not tear
	// down the form (see `hasLoadedOnceRef`) -- it surfaces here instead of
	// in `loadError`, alongside the form rather than in place of it.
	const [refreshError, setRefreshError] = useState<string>();
	const [error, setError] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	const submitControllerRef = useRef<AbortController | null>(null);
	// Whether a load has ever SUCCEEDED -- only before that happens should a
	// (re)load show the "Loading..." placeholder and should a failure replace
	// the form with the full-screen error+Retry UI. A failed first load must
	// leave this false, so clicking Retry shows the loading state again
	// instead of silently doing nothing; once a load has ever succeeded,
	// later refreshes (poll, prop-identity change, or Retry) report a
	// failure inline without disturbing the form.
	const hasLoadedOnceRef = useRef(false);
	// Monotonic id for the in-flight `refresh` call. Two overlapping GETs are
	// reachable here -- e.g. a manual Retry racing a refetch triggered by a
	// fresh auth attempt's changed `onUnauthorized` identity -- so whichever
	// call's generation is no longer the current one when it settles must be
	// ignored, or a slow superseded response could clobber a newer one.
	const refreshGenerationRef = useRef(0);

	const dirty = draft !== (stored?.prompt ?? "");
	// Mirrors `dirty` for `refresh` to read without depending on it (which
	// would recreate `refresh`, re-running the fetch, on every keystroke).
	// Kept in sync by the effect below, which runs after every render.
	const dirtyRef = useRef(dirty);
	useEffect(() => {
		dirtyRef.current = dirty;
	});

	const refresh = useCallback(async () => {
		const generation = ++refreshGenerationRef.current;
		const isInitialLoad = !hasLoadedOnceRef.current;
		if (isInitialLoad) {
			setLoading(true);
		}
		try {
			const prompt = await getCommonSystemPrompt(token);
			if (refreshGenerationRef.current !== generation) return;
			setStored(prompt);
			// A refetch must not clobber an edit the operator is mid-typing;
			// only adopt the server's text into the draft when there is
			// nothing unsaved to lose.
			if (!dirtyRef.current) {
				setDraft(prompt?.prompt ?? "");
			}
			setLoadError(undefined);
			setRefreshError(undefined);
			hasLoadedOnceRef.current = true;
		} catch (err) {
			if (refreshGenerationRef.current !== generation) return;
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (isInitialLoad) {
				setLoadError(message);
			} else {
				setRefreshError(message);
			}
		} finally {
			if (refreshGenerationRef.current === generation) {
				setLoading(false);
			}
		}
	}, [token, onUnauthorized]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(
		() => () => {
			submitControllerRef.current?.abort();
		},
		[],
	);

	async function submit(): Promise<void> {
		const controller = new AbortController();
		submitControllerRef.current?.abort();
		submitControllerRef.current = controller;
		setSubmitting(true);
		setError(undefined);
		const signal = controller.signal;
		try {
			const saved = await saveCommonSystemPrompt(token, draft, signal);
			if (signal.aborted) return;
			setStored(saved);
			setDraft(saved.prompt);
		} catch (err) {
			if (controller.signal.aborted) return;
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (submitControllerRef.current === controller) {
				submitControllerRef.current = null;
				setSubmitting(false);
			}
		}
	}

	function reset(): void {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		setSubmitting(false);
		setError(undefined);
		setDraft(stored?.prompt ?? "");
	}

	return (
		<section>
			<div className="view-header">
				<div>
					<h2>System prompt</h2>
					<p className="muted">
						Applies to every repository. Clearing the box disables it.
					</p>
				</div>
			</div>
			{loading ? (
				<p className="muted">Loading...</p>
			) : loadError ? (
				<div>
					<p className="form-error">{loadError}</p>
					<button
						type="button"
						className="secondary"
						onClick={() => void refresh()}
					>
						Retry
					</button>
				</div>
			) : (
				<form
					className="system-prompt-form"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					{refreshError && <p className="form-error">{refreshError}</p>}
					<label>
						Operator instructions
						<textarea
							className="mono"
							rows={16}
							placeholder="e.g. Always write tests before implementing a fix."
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							disabled={submitting}
						/>
					</label>
					{error && <p className="form-error">{error}</p>}
					<div className="form-actions">
						<button
							type="button"
							className="secondary"
							onClick={reset}
							disabled={!dirty || submitting}
						>
							Reset
						</button>
						<button type="submit" disabled={!dirty || submitting}>
							{submitting ? "Saving..." : "Save"}
						</button>
					</div>
					<p className="muted">
						{stored?.prompt.trim()
							? `Last updated: ${new Date(stored.updatedAt).toLocaleString()}`
							: "Not configured yet."}
					</p>
				</form>
			)}
		</section>
	);
}
