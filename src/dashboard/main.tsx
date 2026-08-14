/**
 * Browser entry point (index.html's `<script type="module">`): mounts <App/>
 * into #root. Kept separate from ./app.tsx so that importing the component
 * tree -- from tests or from any other module -- never touches the DOM.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing #root element in dashboard/index.html");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
