/**
 * Custom application entrypoint. Flue 2 routes are mounted explicitly so the
 * sidecar exposes only the fix-incident agent and its health check.
 */

import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { FixIncidentAgent } from "./fix-agent.ts";

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/agents/fix-incident", createAgentRouter(FixIncidentAgent));

export default app;
