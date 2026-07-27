import { useCallback, useEffect, useRef, useState } from "react";
import type { CommonSetupScript } from "../core/types";
import {
	ApiError,
	createCommonSetupScript,
	deleteCommonSetupScript,
	listCommonSetupScripts,
	updateCommonSetupScript,
} from "./api";

interface Draft {
	triggerFile: string;
	script: string;
}

type EditingTarget = string | "new" | null;
const EMPTY_DRAFT: Draft = { triggerFile: "", script: "" };

export function SetupScriptsView({
	token,
	onUnauthorized,
}: {
	token: string;
	onUnauthorized: () => void;
}) {
	const [setupScripts, setSetupScripts] = useState<CommonSetupScript[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [editingId, setEditingId] = useState<EditingTarget>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [submitting, setSubmitting] = useState(false);
	const submitControllerRef = useRef<AbortController | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setSetupScripts(await listCommonSetupScripts(token));
			setError(undefined);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
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

	function cancelForm(): void {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		setSubmitting(false);
		setError(undefined);
		setEditingId(null);
	}

	function openCreate(): void {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		setSubmitting(false);
		setDraft(EMPTY_DRAFT);
		setError(undefined);
		setEditingId("new");
	}

	function openEdit(setupScript: CommonSetupScript): void {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		setSubmitting(false);
		setDraft({
			triggerFile: setupScript.triggerFile,
			script: setupScript.script,
		});
		setError(undefined);
		setEditingId(setupScript.id);
	}

	async function submit(): Promise<void> {
		const controller = new AbortController();
		submitControllerRef.current?.abort();
		submitControllerRef.current = controller;
		setSubmitting(true);
		setError(undefined);
		const signal = controller.signal;
		try {
			const input = {
				triggerFile: draft.triggerFile.trim(),
				script: draft.script.trim(),
			};
			if (editingId === "new") {
				await createCommonSetupScript(token, input, signal);
			} else if (editingId) {
				await updateCommonSetupScript(token, editingId, input, signal);
			}
			if (signal.aborted) return;
			setEditingId(null);
			await refresh();
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

	async function remove(setupScript: CommonSetupScript): Promise<void> {
		if (!confirm(`Delete setup script for "${setupScript.triggerFile}"?`))
			return;
		try {
			await deleteCommonSetupScript(token, setupScript.id);
			await refresh();
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const canSubmit =
		draft.triggerFile.trim().length > 0 && draft.script.trim().length > 0;

	return (
		<section>
			<div className="view-header">
				<div>
					<h2>Common setup scripts</h2>
					<p className="muted">
						Scripts run in this order for every repository when the specified
						file exists.
					</p>
				</div>
				<button type="button" onClick={openCreate}>
					+ New setup script
				</button>
			</div>
			{error && !editingId && <p className="form-error">{error}</p>}
			{loading ? (
				<p className="muted">Loading...</p>
			) : setupScripts.length === 0 ? (
				<p className="muted">No common setup scripts yet.</p>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>When this file exists</th>
								<th>Script</th>
								<th>Updated</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{setupScripts.map((setupScript) => (
								<tr key={setupScript.id}>
									<td className="mono">{setupScript.triggerFile}</td>
									<td
										className="mono setup-script-preview"
										title={setupScript.script}
									>
										{setupScript.script.split("\n")[0]}
									</td>
									<td>{new Date(setupScript.updatedAt).toLocaleString()}</td>
									<td className="table-actions">
										<button
											type="button"
											className="link-button"
											onClick={() => openEdit(setupScript)}
										>
											Edit
										</button>
										<button
											type="button"
											className="link-button danger"
											onClick={() => void remove(setupScript)}
										>
											Delete
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{editingId && (
				<div className="modal-backdrop">
					<div className="modal">
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void submit();
							}}
						>
							<h2>
								{editingId === "new" ? "New setup script" : "Edit setup script"}
							</h2>
							<label>
								Run when this repository-relative file exists
								<input
									className="mono"
									placeholder="bun.lock"
									value={draft.triggerFile}
									onChange={(event) =>
										setDraft({ ...draft, triggerFile: event.target.value })
									}
								/>
							</label>
							<label>
								Setup script
								<textarea
									className="mono"
									rows={8}
									placeholder="bun install --frozen-lockfile"
									value={draft.script}
									onChange={(event) =>
										setDraft({ ...draft, script: event.target.value })
									}
								/>
							</label>
							{error && <p className="form-error">{error}</p>}
							<div className="form-actions">
								<button
									type="button"
									className="secondary"
									onClick={cancelForm}
								>
									Cancel
								</button>
								<button type="submit" disabled={!canSubmit || submitting}>
									{submitting ? "Saving..." : "Save"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</section>
	);
}
