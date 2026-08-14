import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import {
	duplicateKeysInGroup,
	type EditableGroup,
	type EditablePair,
	hasDuplicateMappingKeys,
	hasIncompleteMappingPairs,
	incompletePairIdsInGroup,
} from "./mappings-editor";
import {
	draftFromDefinition,
	draftToMappings,
	emptyDraft,
	RepoDefinitionForm,
	type RepoDefinitionDraft,
} from "./repo-definition-form";
import { repoDefinition } from "./test-fixtures";
import { render, screen, setupDashboardTest, userEvent } from "./test-setup";

setupDashboardTest();

let nextId = 0;

/** Builds a pair with a fresh id unless one is given -- ids only need to be distinct within a test. */
function pair(key: string, value: string, id?: string): EditablePair {
	return { id: id ?? `pair-${nextId++}`, key, value };
}

function group(pairs: EditablePair[], id?: string): EditableGroup {
	return { id: id ?? `group-${nextId++}`, pairs };
}

describe("draftToMappings", () => {
	test("keeps complete pairs, trimmed", () => {
		const draft = {
			...emptyDraft(),
			mappings: [group([pair(" env ", " prod ")])],
		};
		expect(draftToMappings(draft)).toEqual([{ env: "prod" }]);
	});

	test("ignores a fully blank pair", () => {
		const draft = {
			...emptyDraft(),
			mappings: [group([pair("env", "prod"), pair("", "")])],
		};
		expect(draftToMappings(draft)).toEqual([{ env: "prod" }]);
	});

	test("ignores a whitespace-only pair", () => {
		const draft = {
			...emptyDraft(),
			mappings: [group([pair("env", "prod"), pair("   ", "   ")])],
		};
		expect(draftToMappings(draft)).toEqual([{ env: "prod" }]);
	});

	test("drops a group whose pairs are all fully blank", () => {
		const draft = {
			...emptyDraft(),
			mappings: [group([pair("env", "prod")]), group([pair("", "")])],
		};
		expect(draftToMappings(draft)).toEqual([{ env: "prod" }]);
	});

	test("keeps multiple complete pairs within a group", () => {
		const draft = {
			...emptyDraft(),
			mappings: [group([pair("env", "prod"), pair("region", "us")])],
		};
		expect(draftToMappings(draft)).toEqual([{ env: "prod", region: "us" }]);
	});

	test("keeps multiple groups independently", () => {
		const draft = {
			...emptyDraft(),
			mappings: [group([pair("env", "prod")]), group([pair("env", "staging")])],
		};
		expect(draftToMappings(draft)).toEqual([
			{ env: "prod" },
			{ env: "staging" },
		]);
	});
});

describe("incompletePairIdsInGroup", () => {
	test("flags a pair with only the key filled", () => {
		const p = pair("env", "");
		expect(incompletePairIdsInGroup(group([p]))).toEqual(new Set([p.id]));
	});

	test("flags a pair with only the value filled", () => {
		const p = pair("", "prod");
		expect(incompletePairIdsInGroup(group([p]))).toEqual(new Set([p.id]));
	});

	test("flags a pair whose filled side is whitespace-only on the other side", () => {
		const p = pair("env", "   ");
		expect(incompletePairIdsInGroup(group([p]))).toEqual(new Set([p.id]));
	});

	test("does not flag a fully blank pair", () => {
		expect(incompletePairIdsInGroup(group([pair("", "")]))).toEqual(new Set());
	});

	test("does not flag a fully whitespace-only pair", () => {
		expect(incompletePairIdsInGroup(group([pair("  ", "  ")]))).toEqual(
			new Set(),
		);
	});

	test("does not flag a fully filled pair", () => {
		expect(incompletePairIdsInGroup(group([pair("env", "prod")]))).toEqual(
			new Set(),
		);
	});

	test("only flags the incomplete pairs among several", () => {
		const complete = pair("env", "prod");
		const incomplete = pair("region", "");
		const blank = pair("", "");
		expect(
			incompletePairIdsInGroup(group([complete, incomplete, blank])),
		).toEqual(new Set([incomplete.id]));
	});
});

describe("hasIncompleteMappingPairs", () => {
	test("false when no group has an incomplete pair", () => {
		expect(
			hasIncompleteMappingPairs([
				group([pair("env", "prod")]),
				group([pair("", "")]),
			]),
		).toBe(false);
	});

	test("true when any group has an incomplete pair", () => {
		expect(
			hasIncompleteMappingPairs([
				group([pair("env", "prod")]),
				group([pair("region", "")]),
			]),
		).toBe(true);
	});

	test("false for an empty list of groups", () => {
		expect(hasIncompleteMappingPairs([])).toBe(false);
	});
});

describe("duplicateKeysInGroup", () => {
	test("finds a key repeated after trimming", () => {
		expect(
			duplicateKeysInGroup(
				group([pair("env", "prod"), pair(" env ", "staging")]),
			),
		).toEqual(new Set(["env"]));
	});

	test("ignores blank keys when looking for duplicates", () => {
		expect(duplicateKeysInGroup(group([pair("", "a"), pair("", "b")]))).toEqual(
			new Set(),
		);
	});

	test("empty when all keys are unique", () => {
		expect(
			duplicateKeysInGroup(group([pair("env", "prod"), pair("region", "us")])),
		).toEqual(new Set());
	});
});

describe("hasDuplicateMappingKeys", () => {
	test("false when no group has duplicate keys", () => {
		expect(
			hasDuplicateMappingKeys([
				group([pair("env", "prod")]),
				group([pair("region", "us")]),
			]),
		).toBe(false);
	});

	test("true when any group has a duplicate key", () => {
		expect(
			hasDuplicateMappingKeys([
				group([pair("env", "prod")]),
				group([pair("region", "us"), pair("region", "eu")]),
			]),
		).toBe(true);
	});

	test("false for an empty list of groups", () => {
		expect(hasDuplicateMappingKeys([])).toBe(false);
	});
});

/**
 * `RepoDefinitionForm` is fully controlled: every field lives in `draft` and
 * every edit is reported through `onChange`, exactly like `RepositoriesView`
 * wires it (see repositories-view.tsx). This harness runs that same state
 * loop so typing in a test actually changes what's rendered, and captures
 * the draft `onSubmit` fires with via closure.
 */
function Harness({
	initialDraft = emptyDraft(),
	onSubmit = () => {},
	onCancel = () => {},
	submitting = false,
	error,
}: {
	initialDraft?: RepoDefinitionDraft;
	onSubmit?: (draft: RepoDefinitionDraft) => void;
	onCancel?: () => void;
	submitting?: boolean;
	error?: string;
}) {
	const [draft, setDraft] = useState(initialDraft);
	return (
		<RepoDefinitionForm
			title="Repository"
			draft={draft}
			onChange={setDraft}
			onSubmit={() => onSubmit(draft)}
			onCancel={onCancel}
			submitting={submitting}
			error={error}
		/>
	);
}

/** Fills the only two required fields, leaving mappings and optional fields untouched. */
async function fillRequired(user: UserEvent): Promise<void> {
	await user.type(screen.getByLabelText("Owner"), "acme");
	await user.type(screen.getByLabelText("Repo"), "api");
}

/**
 * happy-dom's `HTMLElement.prototype` has no working `scrollIntoView`
 * (jsdom-family environments never implement layout), so the effect under
 * test would throw without a stub. Patching the prototype (rather than the
 * specific node) also covers the case where the error `<p>` unmounts and
 * remounts a new DOM node across renders.
 */
function spyOnScrollIntoView(): { count: () => number; restore: () => void } {
	let calls = 0;
	const original = HTMLElement.prototype.scrollIntoView;
	HTMLElement.prototype.scrollIntoView = function (
		this: HTMLElement,
		...args: unknown[]
	) {
		calls++;
		return original?.apply(this, args as never);
	};
	return {
		count: () => calls,
		restore: () => {
			HTMLElement.prototype.scrollIntoView = original;
		},
	};
}

describe("RepoDefinitionForm", () => {
	test("create mode starts with blank fields, enabled on, and no mapping groups", () => {
		render(<Harness />);

		expect(screen.getByLabelText("Owner")).toHaveValue("");
		expect(screen.getByLabelText("Repo")).toHaveValue("");
		expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeChecked();
		expect(screen.getByLabelText("Setup script")).toHaveValue("");
		expect(screen.getByLabelText("Test command override")).toHaveValue("");
		expect(screen.getByLabelText("System prompt override")).toHaveValue("");
		// emptyDraft() has no mapping groups -- the editor's own empty-state hint.
		expect(
			screen.getByText(/this definition will never be selected/),
		).toBeInTheDocument();
	});

	test("keeps Save disabled until both owner and repo are non-blank", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();

		await user.type(screen.getByLabelText("Owner"), "acme");
		expect(save).toBeDisabled();

		await user.type(screen.getByLabelText("Repo"), "api");
		expect(save).toBeEnabled();
	});

	test("keeps Save disabled when owner and repo are whitespace-only", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.type(screen.getByLabelText("Owner"), "   ");
		await user.type(screen.getByLabelText("Repo"), "   ");

		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	test("keeps Save disabled while owner is blank, even once repo is filled", async () => {
		// canSubmit checks owner and repo independently -- covers the owner leg
		// of that check on its own so a bug that trims it to a no-op (e.g. a
		// stray `>= 0`) can't hide behind the "both filled" test above, which
		// always fills owner first.
		const user = userEvent.setup();
		render(<Harness />);

		await user.type(screen.getByLabelText("Repo"), "api");

		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	describe("edit mode prefill", () => {
		test("prefills owner, repo, and enabled from the edited definition", () => {
			const draft = draftFromDefinition(
				repoDefinition({ owner: "acme", repo: "widgets", enabled: false }),
			);
			render(<Harness initialDraft={draft} />);

			expect(screen.getByLabelText("Owner")).toHaveValue("acme");
			expect(screen.getByLabelText("Repo")).toHaveValue("widgets");
			expect(
				screen.getByRole("checkbox", { name: "Enabled" }),
			).not.toBeChecked();
		});

		test("prefills optional fields when the definition sets them", () => {
			const draft = draftFromDefinition(
				repoDefinition({
					setupScript: "npm ci",
					testCommand: "npm test",
					systemPrompt: "Be terse.",
				}),
			);
			render(<Harness initialDraft={draft} />);

			expect(screen.getByLabelText("Setup script")).toHaveValue("npm ci");
			expect(screen.getByLabelText("Test command override")).toHaveValue(
				"npm test",
			);
			expect(screen.getByLabelText("System prompt override")).toHaveValue(
				"Be terse.",
			);
		});

		test("leaves optional fields blank when the definition omits them", () => {
			// The optional fields are absent, not empty strings, on a definition
			// that never set them -- draftFromDefinition's `?? ""` must cover it.
			const draft = draftFromDefinition(repoDefinition());
			render(<Harness initialDraft={draft} />);

			expect(screen.getByLabelText("Setup script")).toHaveValue("");
			expect(screen.getByLabelText("Test command override")).toHaveValue("");
			expect(screen.getByLabelText("System prompt override")).toHaveValue("");
		});

		test("renders the definition's mappings as an editable group and pair", () => {
			// repoDefinition()'s default mapping is one group: { service: "api" }.
			// `repo` is overridden away from its own default of "api" so the
			// assertions below can pick the mapping's value out unambiguously.
			const draft = draftFromDefinition(repoDefinition({ repo: "widgets" }));
			render(<Harness initialDraft={draft} />);

			expect(screen.getByText("Match group 1")).toBeInTheDocument();
			expect(screen.getByDisplayValue("service")).toBeInTheDocument();
			expect(screen.getByDisplayValue("api")).toBeInTheDocument();
		});

		test("renders multiple mapping groups and pairs independently", () => {
			const draft = draftFromDefinition(
				repoDefinition({
					owner: "acme-corp",
					repo: "widgets",
					mappings: [{ env: "prod" }, { service: "api", region: "us" }],
				}),
			);
			render(<Harness initialDraft={draft} />);

			expect(screen.getByText("Match group 1")).toBeInTheDocument();
			expect(screen.getByText("Match group 2")).toBeInTheDocument();
			expect(screen.getAllByPlaceholderText("label key")).toHaveLength(3);
			for (const value of ["env", "prod", "service", "api", "region", "us"]) {
				expect(screen.getByDisplayValue(value)).toBeInTheDocument();
			}
		});
	});

	test("replaces every field when the parent hands it a different definition's draft, leaving nothing stale", () => {
		// RepositoriesView.startEdit swaps the whole `draft` state at once
		// (draftFromDefinition(definition)) rather than patching the old one --
		// the form must reflect that instantly, with none of the previous
		// row's values or mapping groups surviving. This is the invariant a
		// stale-draft-after-switching-rows bug would violate.
		const draftA = draftFromDefinition(
			repoDefinition({
				owner: "acme",
				repo: "widgets",
				mappings: [{ env: "prod" }],
			}),
		);
		const draftB = draftFromDefinition(
			repoDefinition({
				id: "repo-2",
				owner: "other-co",
				repo: "svc",
				mappings: [{ region: "eu" }],
			}),
		);
		const { rerender } = render(
			<RepoDefinitionForm
				title="Edit repository"
				draft={draftA}
				onChange={() => {}}
				onSubmit={() => {}}
				onCancel={() => {}}
				submitting={false}
			/>,
		);
		expect(screen.getByLabelText("Owner")).toHaveValue("acme");

		rerender(
			<RepoDefinitionForm
				title="Edit repository"
				draft={draftB}
				onChange={() => {}}
				onSubmit={() => {}}
				onCancel={() => {}}
				submitting={false}
			/>,
		);

		expect(screen.getByLabelText("Owner")).toHaveValue("other-co");
		expect(screen.getByLabelText("Repo")).toHaveValue("svc");
		expect(screen.queryByDisplayValue("env")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("prod")).not.toBeInTheDocument();
		expect(screen.getByDisplayValue("region")).toBeInTheDocument();
		expect(screen.getByDisplayValue("eu")).toBeInTheDocument();
	});

	describe("mapping payload construction", () => {
		test("converts pairs typed into the on-screen editor via draftToMappings", async () => {
			const user = userEvent.setup();
			let captured: RepoDefinitionDraft | undefined;
			render(
				<Harness
					onSubmit={(draft) => {
						captured = draft;
					}}
				/>,
			);

			await fillRequired(user);
			await user.click(
				screen.getByRole("button", { name: "+ Add match group" }),
			);
			await user.type(screen.getByPlaceholderText("label key"), "  service  ");
			await user.type(screen.getByPlaceholderText("label value"), "  api  ");
			await user.click(screen.getByRole("button", { name: "Save" }));

			if (!captured) {
				throw new Error("onSubmit was not called");
			}
			expect(draftToMappings(captured)).toEqual([{ service: "api" }]);
		});

		test("passes owner and repo through onSubmit exactly as typed, untrimmed", async () => {
			// canSubmit validates with `.trim()`, but the form must not rewrite
			// what the user typed on every keystroke -- trimming for the wire
			// payload is the caller's job (RepositoriesView.handleSubmit trims
			// right before building the create/update input).
			const user = userEvent.setup();
			let captured: RepoDefinitionDraft | undefined;
			render(
				<Harness
					onSubmit={(draft) => {
						captured = draft;
					}}
				/>,
			);

			await user.type(screen.getByLabelText("Owner"), "  acme  ");
			await user.type(screen.getByLabelText("Repo"), "  api  ");
			await user.click(screen.getByRole("button", { name: "Save" }));

			expect(captured?.owner).toBe("  acme  ");
			expect(captured?.repo).toBe("  api  ");
		});
	});

	describe("mapping validation blocks submit", () => {
		test("blocks Save and shows the incomplete-pairs message while a pair has only a key or only a value", async () => {
			const user = userEvent.setup();
			render(<Harness />);
			await fillRequired(user);
			await user.click(
				screen.getByRole("button", { name: "+ Add match group" }),
			);

			await user.type(screen.getByPlaceholderText("label key"), "service");
			// value left blank -- an incomplete pair.

			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
			expect(
				screen.getByText(
					"Resolve the incomplete label pairs above before saving.",
				),
			).toBeInTheDocument();
		});

		test("re-enables Save once the incomplete pair is completed", async () => {
			const user = userEvent.setup();
			render(<Harness />);
			await fillRequired(user);
			await user.click(
				screen.getByRole("button", { name: "+ Add match group" }),
			);
			await user.type(screen.getByPlaceholderText("label key"), "service");
			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

			await user.type(screen.getByPlaceholderText("label value"), "api");

			expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
			expect(
				screen.queryByText(
					"Resolve the incomplete label pairs above before saving.",
				),
			).not.toBeInTheDocument();
		});

		test("blocks Save and shows the duplicate-keys message when two pairs in a group share a key", async () => {
			const user = userEvent.setup();
			render(<Harness />);
			await fillRequired(user);
			await user.click(
				screen.getByRole("button", { name: "+ Add match group" }),
			);
			await user.type(screen.getByPlaceholderText("label key"), "service");
			await user.type(screen.getByPlaceholderText("label value"), "api");
			await user.click(screen.getByRole("button", { name: "+ Add label" }));

			const keyInputs = screen.getAllByPlaceholderText("label key");
			await user.type(keyInputs[1] as HTMLElement, "service");
			const valueInputs = screen.getAllByPlaceholderText("label value");
			await user.type(valueInputs[1] as HTMLElement, "web");

			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
			expect(
				screen.getByText(
					"Resolve the duplicate label keys above before saving.",
				),
			).toBeInTheDocument();
		});
	});

	test("toggles the enabled checkbox", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const checkbox = screen.getByRole("checkbox", { name: "Enabled" });
		expect(checkbox).toBeChecked(); // emptyDraft() defaults to enabled

		await user.click(checkbox);
		expect(checkbox).not.toBeChecked();

		await user.click(checkbox);
		expect(checkbox).toBeChecked();
	});

	test("Cancel calls onCancel and never onSubmit, even with blank required fields", async () => {
		const user = userEvent.setup();
		let cancelled = false;
		let submitted = false;
		render(
			<Harness
				onCancel={() => {
					cancelled = true;
				}}
				onSubmit={() => {
					submitted = true;
				}}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(cancelled).toBe(true);
		expect(submitted).toBe(false);
	});

	test("prevents the native form submission event so the SPA never navigates", async () => {
		// A plain <form onSubmit> with no server-side action reloads/navigates
		// the page on submit unless handleSubmit calls preventDefault(); assert
		// that directly rather than only inferring it from onSubmit firing, so
		// a dropped preventDefault() call doesn't pass unnoticed here.
		const user = userEvent.setup();
		render(<Harness />);
		await fillRequired(user);

		let submitEvent: Event | undefined;
		document.addEventListener(
			"submit",
			(event) => {
				submitEvent = event;
			},
			{ once: true },
		);

		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(submitEvent?.defaultPrevented).toBe(true);
	});

	test("shows Saving... and disables Save while submitting, even with valid fields", () => {
		render(
			<Harness
				submitting={true}
				initialDraft={{ ...emptyDraft(), owner: "acme", repo: "api" }}
			/>,
		);

		expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
	});

	describe("scrolls a newly-shown error into view", () => {
		// A rejected save (409/400) sets `error` out from under a user who may
		// already be scrolled down into the mapping groups -- the effect
		// exists so a failed submit is never silently missed off-screen.
		test("scrolls once when an error first appears, not before", () => {
			const scroll = spyOnScrollIntoView();
			try {
				const { rerender } = render(
					<RepoDefinitionForm
						title="t"
						draft={emptyDraft()}
						onChange={() => {}}
						onSubmit={() => {}}
						onCancel={() => {}}
						submitting={false}
					/>,
				);
				expect(screen.queryByText("Boom")).not.toBeInTheDocument();
				expect(scroll.count()).toBe(0);

				rerender(
					<RepoDefinitionForm
						title="t"
						draft={emptyDraft()}
						onChange={() => {}}
						onSubmit={() => {}}
						onCancel={() => {}}
						submitting={false}
						error="Boom"
					/>,
				);

				expect(screen.getByText("Boom")).toBeInTheDocument();
				expect(scroll.count()).toBe(1);
			} finally {
				scroll.restore();
			}
		});

		test("does not re-scroll on an unrelated re-render while the same error text persists", () => {
			const scroll = spyOnScrollIntoView();
			try {
				const { rerender } = render(
					<RepoDefinitionForm
						title="t"
						draft={emptyDraft()}
						onChange={() => {}}
						onSubmit={() => {}}
						onCancel={() => {}}
						submitting={false}
						error="Boom"
					/>,
				);
				expect(scroll.count()).toBe(1);

				// Only `submitting` changes -- the effect's dependency array is
				// `[error]`, so an unrelated prop update must not re-fire it.
				rerender(
					<RepoDefinitionForm
						title="t"
						draft={emptyDraft()}
						onChange={() => {}}
						onSubmit={() => {}}
						onCancel={() => {}}
						submitting={true}
						error="Boom"
					/>,
				);

				expect(scroll.count()).toBe(1);
			} finally {
				scroll.restore();
			}
		});

		test("scrolls again when the error message changes to a different one", () => {
			const scroll = spyOnScrollIntoView();
			try {
				const { rerender } = render(
					<RepoDefinitionForm
						title="t"
						draft={emptyDraft()}
						onChange={() => {}}
						onSubmit={() => {}}
						onCancel={() => {}}
						submitting={false}
						error="Boom"
					/>,
				);
				expect(scroll.count()).toBe(1);

				rerender(
					<RepoDefinitionForm
						title="t"
						draft={emptyDraft()}
						onChange={() => {}}
						onSubmit={() => {}}
						onCancel={() => {}}
						submitting={false}
						error="Kaboom"
					/>,
				);

				expect(screen.getByText("Kaboom")).toBeInTheDocument();
				expect(scroll.count()).toBe(2);
			} finally {
				scroll.restore();
			}
		});
	});

	describe("Enter-key submit respects the same validation as the Save button", () => {
		test("Enter in a text field submits once owner and repo are filled", async () => {
			const user = userEvent.setup();
			let captured: RepoDefinitionDraft | undefined;
			render(
				<Harness
					onSubmit={(draft) => {
						captured = draft;
					}}
				/>,
			);

			await user.type(screen.getByLabelText("Owner"), "acme");
			await user.type(screen.getByLabelText("Repo"), "api{Enter}");

			expect(captured?.owner).toBe("acme");
			expect(captured?.repo).toBe("api");
		});

		test("Enter does not submit while owner is blank", async () => {
			// Browsers suppress a form's implicit Enter-key submission when its
			// default submit button is disabled -- the same `disabled` state
			// that blocks a click blocks Enter too, so handleSubmit needs no
			// separate guard for this path.
			const user = userEvent.setup();
			let submitCount = 0;
			render(
				<Harness
					onSubmit={() => {
						submitCount++;
					}}
				/>,
			);

			await user.type(screen.getByLabelText("Repo"), "api{Enter}");

			expect(submitCount).toBe(0);
		});

		test("Enter does not submit while a mapping pair is incomplete", async () => {
			const user = userEvent.setup();
			let submitCount = 0;
			render(
				<Harness
					onSubmit={() => {
						submitCount++;
					}}
				/>,
			);
			await fillRequired(user);
			await user.click(
				screen.getByRole("button", { name: "+ Add match group" }),
			);
			await user.type(screen.getByPlaceholderText("label key"), "service");
			expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

			await user.type(screen.getByLabelText("Owner"), "{Enter}");

			expect(submitCount).toBe(0);
		});
	});
});
