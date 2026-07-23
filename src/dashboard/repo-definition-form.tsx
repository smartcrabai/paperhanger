/**
 * Create/edit form for a single `RepoDefinition`. Owns the conversion
 * between the wire shape (`mappings: Array<Record<string, string>>`) and the
 * editable `EditableGroup[]` shape the mappings editor needs -- see
 * mappings-editor.tsx for why plain records aren't edited directly.
 */

import type { FormEvent } from "react";
import { useEffect, useRef } from "react";
import type { RepoDefinition } from "../core/types";
import {
	type EditableGroup,
	hasDuplicateMappingKeys,
	hasIncompleteMappingPairs,
	MappingsEditor,
} from "./mappings-editor";

export interface RepoDefinitionDraft {
	owner: string;
	repo: string;
	enabled: boolean;
	mappings: EditableGroup[];
	setupScript: string;
	testCommand: string;
}

function toEditableGroups(
	mappings: Array<Record<string, string>>,
): EditableGroup[] {
	return mappings.map((mapping) => ({
		id: crypto.randomUUID(),
		pairs: Object.entries(mapping).map(([key, value]) => ({
			id: crypto.randomUUID(),
			key,
			value,
		})),
	}));
}

export function draftFromDefinition(
	definition: RepoDefinition,
): RepoDefinitionDraft {
	return {
		owner: definition.owner,
		repo: definition.repo,
		enabled: definition.enabled,
		mappings: toEditableGroups(definition.mappings),
		setupScript: definition.setupScript ?? "",
		testCommand: definition.testCommand ?? "",
	};
}

export function emptyDraft(): RepoDefinitionDraft {
	return {
		owner: "",
		repo: "",
		enabled: true,
		mappings: [],
		setupScript: "",
		testCommand: "",
	};
}

/**
 * Drops fully blank pairs (both key and value empty -- an untouched editor
 * row) and groups with no surviving pairs -- the server rejects an empty
 * match object outright. Half-filled pairs (only key or only value set) are
 * dropped the same way here, but the form blocks Save while any exist (see
 * `hasIncompleteMappingPairs`), so that path should never actually be
 * reached with user-entered data.
 */
export function draftToMappings(
	draft: RepoDefinitionDraft,
): Array<Record<string, string>> {
	return draft.mappings
		.map((group) => {
			const record: Record<string, string> = {};
			for (const pair of group.pairs) {
				const key = pair.key.trim();
				const value = pair.value.trim();
				if (key.length > 0 && value.length > 0) {
					record[key] = value;
				}
			}
			return record;
		})
		.filter((record) => Object.keys(record).length > 0);
}

export function RepoDefinitionForm({
	title,
	draft,
	onChange,
	onSubmit,
	onCancel,
	submitting,
	error,
}: {
	title: string;
	draft: RepoDefinitionDraft;
	onChange: (next: RepoDefinitionDraft) => void;
	onSubmit: () => void;
	onCancel: () => void;
	submitting: boolean;
	error?: string;
}) {
	function handleSubmit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		onSubmit();
	}

	// A failed submit (409/400 from the server) sets `error` from underneath
	// the user, who may already be scrolled past it into the mapping groups --
	// pull the banner into view so a rejected save is never silently missed.
	const errorRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (error) {
			errorRef.current?.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
			});
		}
	}, [error]);

	const hasDuplicateKeys = hasDuplicateMappingKeys(draft.mappings);
	const hasIncompletePairs = hasIncompleteMappingPairs(draft.mappings);
	const canSubmit =
		draft.owner.trim().length > 0 &&
		draft.repo.trim().length > 0 &&
		!hasDuplicateKeys &&
		!hasIncompletePairs &&
		!submitting;

	return (
		<form className="repo-form" onSubmit={handleSubmit}>
			<h2>{title}</h2>
			<div className="modal-body">
				{error && (
					<p className="form-error" ref={errorRef}>
						{error}
					</p>
				)}
				<div className="form-row">
					<label>
						Owner
						<input
							type="text"
							value={draft.owner}
							onChange={(event) =>
								onChange({ ...draft, owner: event.target.value })
							}
							required
						/>
					</label>
					<label>
						Repo
						<input
							type="text"
							value={draft.repo}
							onChange={(event) =>
								onChange({ ...draft, repo: event.target.value })
							}
							required
						/>
					</label>
				</div>
				<label className="checkbox-row">
					<input
						type="checkbox"
						checked={draft.enabled}
						onChange={(event) =>
							onChange({ ...draft, enabled: event.target.checked })
						}
					/>
					Enabled
				</label>
				<fieldset>
					<legend>Label mappings</legend>
					<MappingsEditor
						value={draft.mappings}
						onChange={(mappings) => onChange({ ...draft, mappings })}
					/>
				</fieldset>
				<label>
					Setup script
					<textarea
						className="mono"
						rows={6}
						placeholder={"#!/bin/sh\nnpm ci"}
						value={draft.setupScript}
						onChange={(event) =>
							onChange({ ...draft, setupScript: event.target.value })
						}
					/>
				</label>
				<label>
					Test command override
					<input
						type="text"
						placeholder="leave blank to auto-detect"
						value={draft.testCommand}
						onChange={(event) =>
							onChange({ ...draft, testCommand: event.target.value })
						}
					/>
				</label>
				{hasDuplicateKeys && (
					<p className="form-error">
						Resolve the duplicate label keys above before saving.
					</p>
				)}
				{hasIncompletePairs && (
					<p className="form-error">
						Resolve the incomplete label pairs above before saving.
					</p>
				)}
			</div>
			<div className="form-actions">
				<button type="submit" disabled={!canSubmit}>
					{submitting ? "Saving..." : "Save"}
				</button>
				<button type="button" className="secondary" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}
