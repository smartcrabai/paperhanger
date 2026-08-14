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
	const [listError, setListError] = useState<string>();
	const [editingId, setEditingId] = useState<EditingTarget>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [formError, setFormError] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	const submitControllerRef = useRef<AbortController | null>(null);
	// Set by the unmount cleanup below so `submit`'s abort-triggered
	// background refresh (see below) can tell "the operator gave up on this
	// form session" (Cancel/openCreate/openEdit) apart from "this component
	// tree is gone" -- the rejection alone looks identical either way, but
	// the latter must never touch state.
	const unmountedRef = useRef(false);

	const refresh = useCallback(
		async (options?: { background?: boolean }) => {
			const background = options?.background ?? false;
			if (!background) {
				setLoading(true);
			}
			try {
				setSetupScripts(await listCommonSetupScripts(token));
				setListError(undefined);
			} catch (err) {
				if (err instanceof ApiError && err.status === 401) {
					onUnauthorized();
					return;
				}
				setListError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!background) {
					setLoading(false);
				}
			}
		},
		[token, onUnauthorized],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(
		() => () => {
			unmountedRef.current = true;
			submitControllerRef.current?.abort();
		},
		[],
	);

	function cancelForm(): void {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		setSubmitting(false);
		setFormError(undefined);
		setEditingId(null);
	}

	function openCreate(): void {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		setSubmitting(false);
		setDraft(EMPTY_DRAFT);
		setFormError(undefined);
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
		setFormError(undefined);
		setEditingId(setupScript.id);
	}

	async function submit(): Promise<void> {
		const controller = new AbortController();
		submitControllerRef.current?.abort();
		submitControllerRef.current = controller;
		setSubmitting(true);
		setFormError(undefined);
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
			if (signal.aborted) {
				// The write may have landed server-side even though this form
				// session gave up on it (Cancel/openCreate/openEdit aborted the
				// controller) -- refresh in the background instead of leaving
				// the list stale until a manual reload. The editor for this
				// session is already closed by whichever caller aborted it.
				// If the whole component is gone (unmount, not Cancel), there
				// is no tree left to refresh into -- skip it.
				if (!unmountedRef.current) {
					void refresh({ background: true });
				}
				return;
			}
			setEditingId(null);
			await refresh();
		} catch (err) {
			if (controller.signal.aborted) {
				if (!unmountedRef.current) {
					void refresh({ background: true });
				}
				return;
			}
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setFormError(err instanceof Error ? err.message : String(err));
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
			setListError(err instanceof Error ? err.message : String(err));
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
			{listError && <p className="form-error">{listError}</p>}
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
							{formError && <p className="form-error">{formError}</p>}
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
