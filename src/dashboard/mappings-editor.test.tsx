import { describe, expect, test } from "bun:test";
import { useState } from "react";
import {
	type EditableGroup,
	type EditablePair,
	MappingsEditor,
} from "./mappings-editor";
import { render, screen, setupDashboardTest, userEvent } from "./test-setup";

setupDashboardTest();

// Pure predicates (duplicateKeysInGroup, hasIncompleteMappingPairs, ...) and
// draftToMappings are covered in repo-definition-form.test.ts. This file only
// covers the rendered <MappingsEditor>: rows, interactions, and the value it
// passes to onChange.

let nextId = 0;

/** Builds a pair with a fresh id unless one is given -- ids only need to be distinct within a test. */
function pair(key: string, value: string, id?: string): EditablePair {
	return { id: id ?? `pair-${nextId++}`, key, value };
}

function group(pairs: EditablePair[], id?: string): EditableGroup {
	return { id: id ?? `group-${nextId++}`, pairs };
}

describe("rendering", () => {
	test("renders one row per pair, across every group, holding the current key/value text", () => {
		const groups = [
			group([pair("env", "prod"), pair("region", "us-east")]),
			group([pair("team", "sre")]),
		];
		render(<MappingsEditor value={groups} onChange={() => {}} />);

		const keyInputs = screen.getAllByPlaceholderText("label key");
		const valueInputs = screen.getAllByPlaceholderText("label value");
		expect(keyInputs).toHaveLength(3);
		expect(valueInputs).toHaveLength(3);
		expect(keyInputs[0]).toHaveValue("env");
		expect(valueInputs[0]).toHaveValue("prod");
		expect(keyInputs[1]).toHaveValue("region");
		expect(valueInputs[1]).toHaveValue("us-east");
		expect(keyInputs[2]).toHaveValue("team");
		expect(valueInputs[2]).toHaveValue("sre");
		expect(screen.getByText("Match group 1")).toBeInTheDocument();
		expect(screen.getByText("Match group 2")).toBeInTheDocument();
	});

	test("shows the empty-state hint only when there are no match groups", () => {
		const { rerender } = render(
			<MappingsEditor value={[]} onChange={() => {}} />,
		);
		expect(
			screen.getByText(
				"No match groups -- this definition will never be selected by label matching (it can still be resolved another way, e.g. an attribute annotation).",
			),
		).toBeInTheDocument();

		rerender(
			<MappingsEditor
				value={[group([pair("env", "prod")])]}
				onChange={() => {}}
			/>,
		);
		expect(screen.queryByText(/No match groups/)).not.toBeInTheDocument();
	});
});

describe("editing a pair", () => {
	test("typing into a key input emits the updated key without mutating the previous props", async () => {
		const user = userEvent.setup();
		const untouchedGroup = group([pair("team", "sre")], "g2");
		const editedGroup = group([pair("", "prod")], "g1");
		const value = [editedGroup, untouchedGroup];
		const calls: EditableGroup[][] = [];

		render(
			<MappingsEditor value={value} onChange={(next) => calls.push(next)} />,
		);
		await user.type(screen.getAllByPlaceholderText("label key")[0]!, "x");

		expect(calls).toHaveLength(1);
		const next = calls[0]!;
		// The sibling group never touched by this edit keeps its exact reference.
		expect(next[1]).toBe(untouchedGroup);
		// The edited group is a new object -- the original is never written to.
		expect(next[0]).not.toBe(editedGroup);
		expect(next[0]!.pairs[0]!.key).toBe("x");
		expect(next[0]!.pairs[0]!.value).toBe("prod");
		expect(editedGroup.pairs[0]!.key).toBe("");
		expect(value[0]).toBe(editedGroup);
		expect(value[1]).toBe(untouchedGroup);
	});

	test("typing into a value input emits the updated value, leaving the key untouched", async () => {
		const user = userEvent.setup();
		const editedGroup = group([pair("env", "")], "g1");

		const calls: EditableGroup[][] = [];
		render(
			<MappingsEditor
				value={[editedGroup]}
				onChange={(next) => calls.push(next)}
			/>,
		);
		// A single keystroke: this component is fully controlled and does not
		// track its own state, so a second keystroke without a re-render would
		// have React reset the DOM value back to the (unchanged) "" prop first --
		// see the stateful re-render test below for realistic multi-character entry.
		await user.type(screen.getByPlaceholderText("label value"), "p");

		const next = calls.at(-1)!;
		expect(next[0]!.pairs[0]!.key).toBe("env");
		expect(next[0]!.pairs[0]!.value).toBe("p");
		expect(editedGroup.pairs[0]!.value).toBe("");
	});

	test("typing a key to completion (re-rendered with the new value) clears the incomplete-pair warning", async () => {
		const user = userEvent.setup();
		const initial = [group([pair("", "prod")], "g1")];

		function Harness() {
			const [value, setValue] = useState<EditableGroup[]>(initial);
			return <MappingsEditor value={value} onChange={setValue} />;
		}
		render(<Harness />);

		expect(screen.getByText(/Incomplete label pair/)).toBeInTheDocument();

		await user.type(screen.getByPlaceholderText("label key"), "env");

		expect(screen.getByPlaceholderText("label key")).toHaveValue("env");
		expect(screen.queryByText(/Incomplete label pair/)).not.toBeInTheDocument();
	});
});

describe("add / remove controls", () => {
	test("+ Add match group appends a new, empty group and leaves the existing one untouched", async () => {
		const user = userEvent.setup();
		const existing = group([pair("env", "prod")], "g1");
		const calls: EditableGroup[][] = [];
		render(
			<MappingsEditor
				value={[existing]}
				onChange={(next) => calls.push(next)}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "+ Add match group" }));

		const next = calls[0]!;
		expect(next).toHaveLength(2);
		expect(next[0]).toBe(existing);
		expect(next[1]!.id).not.toBe(existing.id);
		expect(next[1]!.pairs).toHaveLength(1);
		expect(next[1]!.pairs[0]!.key).toBe("");
		expect(next[1]!.pairs[0]!.value).toBe("");
	});

	test("Remove group removes exactly the targeted group, preserving the order and references of the rest", async () => {
		const user = userEvent.setup();
		const g1 = group([pair("a", "1")], "g1");
		const g2 = group([pair("b", "2")], "g2");
		const g3 = group([pair("c", "3")], "g3");
		const calls: EditableGroup[][] = [];
		render(
			<MappingsEditor
				value={[g1, g2, g3]}
				onChange={(next) => calls.push(next)}
			/>,
		);

		await user.click(
			screen.getAllByRole("button", { name: "Remove group" })[1]!,
		);

		expect(calls[0]).toEqual([g1, g3]);
		expect(calls[0]![0]).toBe(g1);
		expect(calls[0]![1]).toBe(g3);
	});

	test("+ Add label appends a blank pair to only the targeted group", async () => {
		const user = userEvent.setup();
		const g1 = group([pair("env", "prod")], "g1");
		const g2 = group([pair("team", "sre")], "g2");
		const calls: EditableGroup[][] = [];
		render(
			<MappingsEditor value={[g1, g2]} onChange={(next) => calls.push(next)} />,
		);

		await user.click(
			screen.getAllByRole("button", { name: "+ Add label" })[0]!,
		);

		const next = calls[0]!;
		expect(next[1]).toBe(g2);
		expect(next[0]!.pairs).toHaveLength(2);
		expect(next[0]!.pairs[0]).toBe(g1.pairs[0]);
		expect(next[0]!.pairs[1]!.key).toBe("");
		expect(next[0]!.pairs[1]!.value).toBe("");
	});

	test("removing a pair drops exactly that row, keeping the group's other pairs by reference", async () => {
		const user = userEvent.setup();
		const drop = pair("env", "prod");
		const keep = pair("region", "us");
		const g1 = group([drop, keep], "g1");
		const calls: EditableGroup[][] = [];
		render(
			<MappingsEditor value={[g1]} onChange={(next) => calls.push(next)} />,
		);

		await user.click(screen.getAllByRole("button", { name: "\u00d7" })[0]!);

		expect(calls[0]![0]!.pairs).toHaveLength(1);
		expect(calls[0]![0]!.pairs[0]).toBe(keep);
	});

	test("removing the last pair of a group empties its pairs, without deleting the group or refilling a blank row", async () => {
		const user = userEvent.setup();
		const initial = [group([pair("env", "prod")], "g1")];

		function Harness() {
			const [value, setValue] = useState<EditableGroup[]>(initial);
			return <MappingsEditor value={value} onChange={setValue} />;
		}
		render(<Harness />);

		await user.click(screen.getByRole("button", { name: "\u00d7" }));

		// The group survives with zero rows: not auto-removed, and no blank pair
		// is silently re-added in its place.
		expect(screen.queryByPlaceholderText("label key")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Remove group" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "+ Add label" }),
		).toBeInTheDocument();
	});
});

describe("generated ids", () => {
	test("clicking + Add match group twice generates two distinct group ids", async () => {
		const user = userEvent.setup();
		const calls: EditableGroup[][] = [];
		render(<MappingsEditor value={[]} onChange={(next) => calls.push(next)} />);
		const addButton = screen.getByRole("button", { name: "+ Add match group" });

		await user.click(addButton);
		await user.click(addButton);

		expect(calls).toHaveLength(2);
		expect(calls[0]![0]!.id).not.toBe(calls[1]![0]!.id);
	});

	test("clicking + Add label twice generates two distinct pair ids", async () => {
		const user = userEvent.setup();
		const g1 = group([pair("env", "prod")], "g1");
		const calls: EditableGroup[][] = [];
		render(
			<MappingsEditor value={[g1]} onChange={(next) => calls.push(next)} />,
		);
		const addButton = screen.getByRole("button", { name: "+ Add label" });

		await user.click(addButton);
		await user.click(addButton);

		const firstNewId = calls[0]![0]!.pairs[1]!.id;
		const secondNewId = calls[1]![0]!.pairs[1]!.id;
		expect(firstNewId).not.toBe(secondNewId);
	});

	test("group/pair ids stay stable across re-renders so React reuses the row's DOM node", () => {
		const g1 = group([pair("env", "prod")], "g1");
		const { rerender } = render(
			<MappingsEditor value={[g1]} onChange={() => {}} />,
		);
		const input = screen.getByPlaceholderText("label key");
		input.focus();
		expect(document.activeElement).toBe(input);

		// A fresh array/group object carrying the same ids, exactly what a real
		// onChange produces. If the ids were regenerated per render instead of
		// being data, React would key off a new id, unmount this row, and drop
		// both the DOM node and focus.
		rerender(
			<MappingsEditor
				value={[{ ...g1, pairs: [...g1.pairs] }]}
				onChange={() => {}}
			/>,
		);

		expect(document.activeElement).toBe(input);
		expect(screen.getByPlaceholderText("label key")).toBe(input);
	});

	test("pair ids stay stable when an earlier pair in the same group is dropped, so React reuses the surviving row's DOM node", () => {
		const p1 = pair("a", "1", "p1");
		const p2 = pair("b", "2", "p2");
		const g1 = group([p1, p2], "g1");
		const { rerender } = render(
			<MappingsEditor value={[g1]} onChange={() => {}} />,
		);

		const survivingInput = screen.getAllByPlaceholderText("label key")[1]!;
		survivingInput.focus();
		expect(document.activeElement).toBe(survivingInput);

		// The prop shape `removePair` actually produces when the FIRST pair is
		// removed: p2 carries the same id straight through, unchanged. Without
		// `key={pair.id}` on each row, React would reconcile by position
		// instead -- reusing the old index-0 ("a") DOM node relabelled as "b",
		// and unmounting the index-1 node that holds this focus/identity.
		rerender(
			<MappingsEditor value={[{ ...g1, pairs: [p2] }]} onChange={() => {}} />,
		);

		expect(screen.getByPlaceholderText("label key")).toBe(survivingInput);
		expect(document.activeElement).toBe(survivingInput);
	});
});

describe("duplicate keys within a group (OR semantics across groups)", () => {
	test("marks a single duplicate key with a singular message and flags both offending inputs", () => {
		render(
			<MappingsEditor
				value={[group([pair("env", "prod"), pair("env", "staging")])]}
				onChange={() => {}}
			/>,
		);

		expect(
			screen.getByText(
				"Duplicate key in this group (env) -- only the last pair for each would be saved.",
			),
		).toBeInTheDocument();
		const keyInputs = screen.getAllByPlaceholderText("label key");
		expect(keyInputs[0]).toHaveClass("input-error");
		expect(keyInputs[1]).toHaveClass("input-error");
	});

	test("treats a whitespace-padded key as the same key for duplicate detection, marking the padded input too", () => {
		render(
			<MappingsEditor
				value={[group([pair("env", "prod"), pair("  env  ", "staging")])]}
				onChange={() => {}}
			/>,
		);

		expect(
			screen.getByText(
				"Duplicate key in this group (env) -- only the last pair for each would be saved.",
			),
		).toBeInTheDocument();
		const keyInputs = screen.getAllByPlaceholderText("label key");
		// The message and error styling are both driven by trimmed comparison
		// (`draftToMappings` also trims before using a key), so the padded
		// second input must be marked too, not just the exact-text match.
		expect(keyInputs[0]).toHaveClass("input-error");
		expect(keyInputs[1]).toHaveClass("input-error");
	});

	test("pluralizes the duplicate-key message and lists every offending key when a group has more than one", () => {
		render(
			<MappingsEditor
				value={[
					group([
						pair("env", "a"),
						pair("env", "b"),
						pair("region", "c"),
						pair("region", "d"),
					]),
				]}
				onChange={() => {}}
			/>,
		);

		expect(
			screen.getByText(
				"Duplicate keys in this group (env, region) -- only the last pair for each would be saved.",
			),
		).toBeInTheDocument();
	});

	test("does not mark a key duplicated across two different groups -- groups are OR'd independently", () => {
		render(
			<MappingsEditor
				value={[group([pair("env", "prod")]), group([pair("env", "staging")])]}
				onChange={() => {}}
			/>,
		);

		expect(screen.queryByText(/Duplicate key/)).not.toBeInTheDocument();
		for (const input of screen.getAllByPlaceholderText("label key")) {
			expect(input).not.toHaveClass("input-error");
		}
	});
});

describe("incomplete pairs within a group (AND semantics within a group)", () => {
	test("flags a key-without-value pair as incomplete, marking only the blank value input", () => {
		render(
			<MappingsEditor value={[group([pair("env", "")])]} onChange={() => {}} />,
		);

		expect(
			screen.getByText(
				"Incomplete label pair in this group -- fill in both the key and value (or remove the row) before saving.",
			),
		).toBeInTheDocument();
		expect(screen.getByPlaceholderText("label key")).not.toHaveClass(
			"input-error",
		);
		expect(screen.getByPlaceholderText("label value")).toHaveClass(
			"input-error",
		);
	});

	test("flags a value-without-key pair as incomplete, marking only the blank key input", () => {
		render(
			<MappingsEditor
				value={[group([pair("", "prod")])]}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByPlaceholderText("label key")).toHaveClass("input-error");
		expect(screen.getByPlaceholderText("label value")).not.toHaveClass(
			"input-error",
		);
	});

	test("does not flag or mark a fully blank pair", () => {
		render(
			<MappingsEditor value={[group([pair("", "")])]} onChange={() => {}} />,
		);

		expect(screen.queryByText(/Incomplete label pair/)).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText("label key")).not.toHaveClass(
			"input-error",
		);
		expect(screen.getByPlaceholderText("label value")).not.toHaveClass(
			"input-error",
		);
	});

	test("treats a whitespace-only key as blank, flagging it the same as an empty key", () => {
		render(
			<MappingsEditor
				value={[group([pair("   ", "prod")])]}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByText(/Incomplete label pair/)).toBeInTheDocument();
		expect(screen.getByPlaceholderText("label key")).toHaveClass("input-error");
	});

	test("treats a whitespace-only pair on both sides as fully blank, not incomplete", () => {
		render(
			<MappingsEditor
				value={[group([pair("   ", "   ")])]}
				onChange={() => {}}
			/>,
		);

		expect(screen.queryByText(/Incomplete label pair/)).not.toBeInTheDocument();
	});

	test("pluralizes the incomplete-pair message when a group has more than one incomplete row", () => {
		render(
			<MappingsEditor
				value={[group([pair("env", ""), pair("", "prod")])]}
				onChange={() => {}}
			/>,
		);

		expect(
			screen.getByText(
				"Incomplete label pairs in this group -- fill in both the key and value (or remove the row) before saving.",
			),
		).toBeInTheDocument();
	});
});
