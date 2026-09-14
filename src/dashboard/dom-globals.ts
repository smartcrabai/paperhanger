/**
 * Side-effect-only module that installs happy-dom's globals (window, document,
 * HTMLElement, localStorage, ...) into the Bun test process.
 *
 * Split out of ./test-setup.ts, and kept free of any other import, so that the
 * registration is a *synchronous* module evaluation: ESM finishes evaluating a
 * dependency before the next one in declaration order, so `import
 * "./dom-globals"` above `import ... from "@testing-library/react"` guarantees
 * `window` exists by the time Testing Library captures it at module scope
 * (@testing-library/dom's `screen` binds to `document` on load, and throws if
 * it was missing).
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Happy DOM installs its own fetch/Request/Response globals. Keep Bun's HTTP
// primitives in place because this module shares a process with server tests;
// Bun.serve rejects a Response created by another implementation.
const nativeHttpGlobals = {
	fetch: globalThis.fetch,
	Request: globalThis.Request,
	Response: globalThis.Response,
	Headers: globalThis.Headers,
};

if (!("document" in globalThis)) {
	GlobalRegistrator.register({ url: "https://dashboard.test/" });
	globalThis.fetch = nativeHttpGlobals.fetch;
	globalThis.Request = nativeHttpGlobals.Request;
	globalThis.Response = nativeHttpGlobals.Response;
	globalThis.Headers = nativeHttpGlobals.Headers;
}
