/**
 * "Repositories" dashboard view: lists dashboard-managed `RepoDefinition`s
 * and drives the create/edit/delete flow via `RepoDefinitionForm`. See the
 * design doc's "Views" section.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoDefinition } from "../core/types";
import {
	ApiError,
	createRepoDefinition,
	deleteRepoDefinition,
	listRepoDefinitions,
	updateRepoDefinition,
} from "./api";
import {
	draftFromDefinition,
	draftToMappings,
	emptyDraft,
	RepoDefinitionForm,
	type RepoDefinitionDraft,
} from "./repo-definition-form";

function summarizeMappings(definition: RepoDefinition): string {
	const count = definition.mappings.length;
	if (count === 0) {
		return "none";
	}
	return `${count} group${count === 1 ? "" : "s"}`;
}

/** Chars of `setupScript` shown in the "Setup script" cell's title tooltip. */
const SETUP_SCRIPT_PREVIEW_LENGTH = 200;

/** Native title tooltip preview so the script is inspectable without opening Edit. */
function setupScriptPreview(definition: RepoDefinition): string | undefined {
	const script = definition.setupScript;
	if (!script) {
		return undefined;
	}
	return script.length > SETUP_SCRIPT_PREVIEW_LENGTH
		? `${script.slice(0, SETUP_SCRIPT_PREVIEW_LENGTH)}...`
		: script;
}

/** `editingId` is `"new"` for the create form, a definition id for editing it, or `null` when the form is closed. */
type EditingTarget = string | "new" | null;

export function RepositoriesView({
	token,
	onUnauthorized,
}: {
	token: string;
	onUnauthorized: () => void;
}) {
	const [definitions, setDefinitions] = useState<RepoDefinition[]>([]);
	const [loading, setLoading] = useState(true);
	const [listError, setListError] = useState<string | undefined>();
	const [editingId, setEditingId] = useState<EditingTarget>(null);
	const [draft, setDraft] = useState<RepoDefinitionDraft>(emptyDraft());
	const [formError, setFormError] = useState<string | undefined>();
	const [submitting, setSubmitting] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const result = await listRepoDefinitions(token);
			setDefinitions(result);
			setListError(undefined);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setListError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [token, onUnauthorized]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Identifies which form "session" (create/edit/cancel) is current, so a
	// submit that's still in flight when the user moves on to a different
	// session can't clobber that session's state when it eventually settles.
	// `submitControllerRef` lets us also actually abort the underlying
	// request instead of merely ignoring its result.
	const submitGenerationRef = useRef(0);
	const submitControllerRef = useRef<AbortController | null>(null);

	const abortPendingSubmit = useCallback(() => {
		submitControllerRef.current?.abort();
		submitControllerRef.current = null;
		submitGenerationRef.current += 1;
	}, []);

	function startCreate(): void {
		abortPendingSubmit();
		setDraft(emptyDraft());
		setFormError(undefined);
		setSubmitting(false);
		setEditingId("new");
	}

	function startEdit(definition: RepoDefinition): void {
		abortPendingSubmit();
		setDraft(draftFromDefinition(definition));
		setFormError(undefined);
		setSubmitting(false);
		setEditingId(definition.id);
	}

	const cancelForm = useCallback(() => {
		abortPendingSubmit();
		setEditingId(null);
		setFormError(undefined);
		setSubmitting(false);
	}, [abortPendingSubmit]);

	// Escape closes the form, mirroring the Cancel button -- kept as a
	// document-level listener (rather than an onClick on the backdrop <div>)
	// so the backdrop stays a plain, non-interactive element.
	useEffect(() => {
		if (!editingId) {
			return;
		}
		function handleKeyDown(event: KeyboardEvent): void {
			if (event.key === "Escape") {
				cancelForm();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [editingId, cancelForm]);

	async function handleSubmit(): Promise<void> {
		// Captured up front: if the user cancels (or opens a different form)
		// before this request settles, `abortPendingSubmit` bumps the
		// generation and aborts `controller`, so the checks below know this
		// submission is no longer the one the visible form belongs to.
		const generation = submitGenerationRef.current;
		const controller = new AbortController();
		submitControllerRef.current = controller;
		setSubmitting(true);
		setFormError(undefined);
		try {
			const mappings = draftToMappings(draft);
			const owner = draft.owner.trim();
			const repo = draft.repo.trim();
			const setupScript = draft.setupScript.trim();
			const testCommand = draft.testCommand.trim();
			if (editingId === "new") {
				await createRepoDefinition(
					token,
					{
						owner,
						repo,
						mappings,
						enabled: draft.enabled,
						setupScript: setupScript.length > 0 ? setupScript : undefined,
						testCommand: testCommand.length > 0 ? testCommand : undefined,
					},
					controller.signal,
				);
			} else if (editingId) {
				await updateRepoDefinition(
					token,
					editingId,
					{
						owner,
						repo,
						mappings,
						enabled: draft.enabled,
						setupScript: setupScript.length > 0 ? setupScript : null,
						testCommand: testCommand.length > 0 ? testCommand : null,
					},
					controller.signal,
				);
			}
			if (submitGenerationRef.current !== generation) {
				// A different form session owns the UI now, but the write
				// still landed -- refresh the list without touching its state.
				await refresh();
				return;
			}
			submitControllerRef.current = null;
			setEditingId(null);
			await refresh();
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			if (submitGenerationRef.current !== generation) {
				// Superseded (e.g. the request was aborted by Cancel) --
				// don't surface a stale error on whatever form is open now.
				return;
			}
			submitControllerRef.current = null;
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			if (submitGenerationRef.current === generation) {
				setSubmitting(false);
			}
		}
	}

	async function handleDelete(definition: RepoDefinition): Promise<void> {
		if (
			!confirm(
				`Delete repo definition "${definition.owner}/${definition.repo}"? This cannot be undone.`,
			)
		) {
			return;
		}
		try {
			await deleteRepoDefinition(token, definition.id);
			await refresh();
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setListError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<section>
			<div className="view-header">
				<h2>Repositories</h2>
				<button type="button" onClick={startCreate}>
					+ New repository
				</button>
			</div>
			{listError && <p className="form-error">{listError}</p>}
			{loading ? (
				<p className="muted">Loading...</p>
			) : definitions.length === 0 ? (
				<p className="muted">No repository definitions yet.</p>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Owner/Repo</th>
								<th>Mappings</th>
								<th>Setup script</th>
								<th>Test command</th>
								<th>Enabled</th>
								<th>Updated</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{definitions.map((definition) => (
								<tr key={definition.id}>
									<td>
										{definition.owner}/{definition.repo}
									</td>
									<td>{summarizeMappings(definition)}</td>
									<td title={setupScriptPreview(definition)}>
										{definition.setupScript ? "yes" : "no"}
									</td>
									<td>{definition.testCommand ?? "auto-detect"}</td>
									<td>{definition.enabled ? "yes" : "no"}</td>
									<td>{new Date(definition.updatedAt).toLocaleString()}</td>
									<td className="table-actions">
										<button
											type="button"
											className="link-button"
											onClick={() => startEdit(definition)}
										>
											Edit
										</button>
										<button
											type="button"
											className="link-button danger"
											onClick={() => void handleDelete(definition)}
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
						<RepoDefinitionForm
							title={editingId === "new" ? "New repository" : "Edit repository"}
							draft={draft}
							onChange={setDraft}
							onSubmit={() => void handleSubmit()}
							onCancel={cancelForm}
							submitting={submitting}
							error={formError}
						/>
					</div>
				</div>
			)}
		</section>
	);
}
