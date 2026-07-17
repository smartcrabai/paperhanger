/**
 * Minimal generic-webhook receiver for the compose E2E stack (docs/spec.md
 * section 3.10). Records every POSTed notification body in memory and
 * exposes `GET /received` so `scripts/e2e-smoke.sh` (and a human) can assert
 * the notify path actually fired, without needing a real Slack/Discord
 * webhook endpoint.
 *
 * Run under `oven/bun:1.3` directly by compose.yml (bind-mounted, no
 * dedicated Dockerfile needed): `bun run /sink/webhook-sink.ts`.
 */

interface ReceivedNotification {
	receivedAt: string;
	body: unknown;
}

const received: ReceivedNotification[] = [];
const port = Number(Bun.env.PORT ?? 8080);

Bun.serve({
	port,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "POST") {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				body = await req.text();
			}
			const entry: ReceivedNotification = {
				receivedAt: new Date().toISOString(),
				body,
			};
			received.push(entry);
			console.log(JSON.stringify({ msg: "webhook-sink.received", ...entry }));
			return Response.json({ ok: true });
		}

		if (req.method === "GET" && url.pathname === "/received") {
			return Response.json({ received });
		}

		if (req.method === "GET" && url.pathname === "/healthz") {
			return new Response("ok");
		}

		return new Response("not found", { status: 404 });
	},
});

console.log(`webhook-sink listening on :${port}`);
