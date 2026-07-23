import { describe, expect, test } from "bun:test";
import {
	duplicateKeysInGroup,
	type EditableGroup,
	type EditablePair,
	hasDuplicateMappingKeys,
	hasIncompleteMappingPairs,
	incompletePairIdsInGroup,
} from "./mappings-editor";
import { draftToMappings, emptyDraft } from "./repo-definition-form";

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
