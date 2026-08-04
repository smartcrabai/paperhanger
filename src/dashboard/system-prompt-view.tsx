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
	const [error, setError] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	const submitControllerRef = useRef<AbortController | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const prompt = await getCommonSystemPrompt(token);
			setStored(prompt);
			setDraft(prompt?.prompt ?? "");
			setLoadError(undefined);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setLoadError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
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

	const dirty = draft !== (stored?.prompt ?? "");

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
