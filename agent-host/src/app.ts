/**
 * Custom application entrypoint (docs read guide/routing): mounts Flue's
 * public routes plus a `/healthz` route, since Flue adds no health endpoint
 * by default. The parent repo's `src/agent/sidecar.ts` polls `/healthz` to
 * detect readiness after spawning this server.
 */

import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", flue());

export default app;
