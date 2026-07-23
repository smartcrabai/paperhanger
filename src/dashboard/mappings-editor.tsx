/**
 * Dynamic editor for a `RepoDefinition`'s `mappings`: a list of OR'd match
 * groups, each an AND'd list of label key/value pairs (see
 * `RepoDefinition.mappings` in src/core/types.ts).
 *
 * Groups/pairs carry a client-generated `id` distinct from their `key`/
 * `value` text: renaming a key on a plain `Record<string, string>` either
 * loses insertion order or silently collides with an existing key while the
 * user is mid-edit (e.g. typing a second "s" into "service"), and using the
 * array index as the id breaks React's reconciliation across
 * insert/remove. `RepositoriesView` converts to/from
 * `Record<string, string>[]` at the form boundary.
 */

export interface EditablePair {
	id: string;
	key: string;
	value: string;
}

export interface EditableGroup {
	id: string;
	pairs: EditablePair[];
}

function makeId(): string {
	return crypto.randomUUID();
}

/**
 * Trimmed, non-empty keys that appear more than once within a single group.
 * Pairs within a group are AND'd into one `Record<string, string>` (see
 * `draftToMappings` in repo-definition-form.tsx), so a duplicate key would
 * silently overwrite an earlier pair with no feedback -- callers use this to
 * warn instead.
 */
export function duplicateKeysInGroup(group: EditableGroup): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const pair of group.pairs) {
		const key = pair.key.trim();
		if (key.length === 0) {
			continue;
		}
		if (seen.has(key)) {
			duplicates.add(key);
		}
		seen.add(key);
	}
	return duplicates;
}

/** Whether any group in `groups` has a duplicate key -- see `duplicateKeysInGroup`. */
export function hasDuplicateMappingKeys(groups: EditableGroup[]): boolean {
	return groups.some((group) => duplicateKeysInGroup(group).size > 0);
}

/**
 * Ids of pairs within a single group where exactly one of key/value is
 * non-blank (after trimming) -- a row the user started filling in but didn't
 * finish. A fully blank pair (both sides empty, e.g. an untouched row from
 * `emptyPair`) is not incomplete -- it's simply ignored by `draftToMappings`
 * in repo-definition-form.tsx. A half-filled pair would be dropped the same
 * silent way with no feedback, so callers use this to warn instead.
 */
export function incompletePairIdsInGroup(group: EditableGroup): Set<string> {
	const incomplete = new Set<string>();
	for (const pair of group.pairs) {
		const keyFilled = pair.key.trim().length > 0;
		const valueFilled = pair.value.trim().length > 0;
		if (keyFilled !== valueFilled) {
			incomplete.add(pair.id);
		}
	}
	return incomplete;
}

/** Whether any group in `groups` has an incomplete pair -- see `incompletePairIdsInGroup`. */
export function hasIncompleteMappingPairs(groups: EditableGroup[]): boolean {
	return groups.some((group) => incompletePairIdsInGroup(group).size > 0);
}

export function emptyPair(): EditablePair {
	return { id: makeId(), key: "", value: "" };
}

export function emptyGroup(): EditableGroup {
	return { id: makeId(), pairs: [emptyPair()] };
}

function updateGroup(
	groups: EditableGroup[],
	groupId: string,
	next: EditableGroup,
): EditableGroup[] {
	return groups.map((group) => (group.id === groupId ? next : group));
}

export function MappingsEditor({
	value,
	onChange,
}: {
	value: EditableGroup[];
	onChange: (next: EditableGroup[]) => void;
}) {
	function addGroup(): void {
		onChange([...value, emptyGroup()]);
	}

	function removeGroup(groupId: string): void {
		onChange(value.filter((group) => group.id !== groupId));
	}

	function addPair(groupId: string): void {
		const group = value.find((g) => g.id === groupId);
		if (!group) {
			return;
		}
		onChange(
			updateGroup(value, groupId, {
				...group,
				pairs: [...group.pairs, emptyPair()],
			}),
		);
	}

	function removePair(groupId: string, pairId: string): void {
		const group = value.find((g) => g.id === groupId);
		if (!group) {
			return;
		}
		onChange(
			updateGroup(value, groupId, {
				...group,
				pairs: group.pairs.filter((pair) => pair.id !== pairId),
			}),
		);
	}

	function updatePair(
		groupId: string,
		pairId: string,
		patch: Partial<Pick<EditablePair, "key" | "value">>,
	): void {
		const group = value.find((g) => g.id === groupId);
		if (!group) {
			return;
		}
		onChange(
			updateGroup(value, groupId, {
				...group,
				pairs: group.pairs.map((pair) =>
					pair.id === pairId ? { ...pair, ...patch } : pair,
				),
			}),
		);
	}

	return (
		<div className="mappings-editor">
			{value.length === 0 && (
				<p className="mappings-empty-hint">
					No match groups -- this definition will never be selected by label
					matching (it can still be resolved another way, e.g. an attribute
					annotation).
				</p>
			)}
			{value.map((group, groupIndex) => {
				const duplicateKeys = duplicateKeysInGroup(group);
				const incompletePairIds = incompletePairIdsInGroup(group);
				return (
					<div className="mapping-group" key={group.id}>
						<div className="mapping-group-header">
							<span>Match group {groupIndex + 1}</span>
							<button
								type="button"
								className="link-button"
								onClick={() => removeGroup(group.id)}
							>
								Remove group
							</button>
						</div>
						{duplicateKeys.size > 0 && (
							<p className="form-error">
								Duplicate key{duplicateKeys.size === 1 ? "" : "s"} in this group
								({Array.from(duplicateKeys).join(", ")}) -- only the last pair
								for each would be saved.
							</p>
						)}
						{incompletePairIds.size > 0 && (
							<p className="form-error">
								Incomplete label pair{incompletePairIds.size === 1 ? "" : "s"}{" "}
								in this group -- fill in both the key and value (or remove the
								row) before saving.
							</p>
						)}
						{group.pairs.map((pair) => {
							const isDuplicate = duplicateKeys.has(pair.key.trim());
							const isIncomplete = incompletePairIds.has(pair.id);
							const keyBlank = pair.key.trim().length === 0;
							const valueBlank = pair.value.trim().length === 0;
							return (
								<div className="mapping-pair" key={pair.id}>
									<input
										type="text"
										placeholder="label key"
										className={
											isDuplicate || (isIncomplete && keyBlank)
												? "input-error"
												: undefined
										}
										value={pair.key}
										onChange={(event) =>
											updatePair(group.id, pair.id, {
												key: event.target.value,
											})
										}
									/>
									<span className="mapping-pair-eq">=</span>
									<input
										type="text"
										placeholder="label value"
										className={
											isIncomplete && valueBlank ? "input-error" : undefined
										}
										value={pair.value}
										onChange={(event) =>
											updatePair(group.id, pair.id, {
												value: event.target.value,
											})
										}
									/>
									<button
										type="button"
										className="link-button"
										onClick={() => removePair(group.id, pair.id)}
									>
										&times;
									</button>
								</div>
							);
						})}
						<button
							type="button"
							className="link-button"
							onClick={() => addPair(group.id)}
						>
							+ Add label
						</button>
					</div>
				);
			})}
			<button type="button" className="secondary" onClick={addGroup}>
				+ Add match group
			</button>
		</div>
	);
}
