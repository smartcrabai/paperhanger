/**
 * Single entry point for the dashboard's component tests: installs happy-dom's
 * globals, registers jest-dom's DOM matchers on bun:test's `expect`, and
 * re-exports the Testing Library API the tests use.
 *
 * Dashboard tests import Testing Library from *here*, never directly, and call
 * `setupDashboardTest()` once at file scope:
 *
 *     import { render, screen, setupDashboardTest, userEvent } from "./test-setup";
 *
 *     setupDashboardTest();
 *
 * Why the `require` calls below (static-import rule exception): Bun evaluates a
 * module's CommonJS dependencies before the ESM side-effect imports declared
 * above them, so a top-level `import ... from "@testing-library/react"` would
 * run before ./dom-globals had installed `window` -- and @testing-library/dom
 * binds `screen` to `document.body` at module-evaluation time, leaving every
 * `screen.*` query permanently throwing. A `require()` in the module body runs
 * strictly after the import above it, which is exactly the ordering needed.
 * Types still come from top-level `import type`s, so the API stays checked.
 *
 * Only src/dashboard/** loads this; the server-side suites keep running against
 * Bun's own globals (fetch, Response, ...) with no DOM in scope.
 */

import "./dom-globals";

import { afterEach, expect } from "bun:test";
import { restoreFetch } from "./test-fetch";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import type * as JestDom from "@testing-library/jest-dom/matchers";
import type * as ReactTestingLibrary from "@testing-library/react";
import type UserEventTypes from "@testing-library/user-event";

const jestDomMatchers: typeof JestDom = require("@testing-library/jest-dom/matchers");
const rtl: typeof ReactTestingLibrary = require("@testing-library/react");
const userEventModule: {
	default: typeof UserEventTypes;
} = require("@testing-library/user-event");

declare global {
	// React 19 refuses to run `act()` without this flag, and Testing Library
	// wraps every render and event in `act()`.
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// `expect.extend` above is invisible to the type checker; this teaches bun:test
// about jest-dom's matchers (toBeInTheDocument, toBeDisabled, toHaveValue, ...).
// `toBeEmpty` is omitted because bun:test ships its own, incompatible signature
// for that name; jest-dom's replacement for it is `toBeEmptyDOMElement`.
declare module "bun:test" {
	interface Matchers<T>
		extends Omit<TestingLibraryMatchers<unknown, T>, "toBeEmpty"> {}
	interface AsymmetricMatchers
		extends Omit<TestingLibraryMatchers<unknown, void>, "toBeEmpty"> {}
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

expect.extend(jestDomMatchers);

export const {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	waitForElementToBeRemoved,
	within,
} = rtl;

export const userEvent = userEventModule.default;

/**
 * Registers this file's per-test teardown: unmount React trees, drop
 * localStorage, and put the real `fetch` back.
 *
 * MUST be called at file scope by every dashboard test file. A root-level
 * `afterEach` belongs to whichever file was being evaluated when it ran, and
 * this module is evaluated only once per test process -- so registering the
 * hook here directly would protect the first importing file and silently leak
 * mounted DOM, stored tokens, and fetch stubs into every other one.
 */
export function setupDashboardTest(): void {
	afterEach(() => {
		cleanup();
		window.localStorage.clear();
		restoreFetch();
	});
}
