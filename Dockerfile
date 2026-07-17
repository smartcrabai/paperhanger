# syntax=docker/dockerfile:1
#
# Single-image build for paperhanger. Ships BOTH runtimes in one container
# (see docs/architecture.md "Flue agent host (Node sidecar)"):
#
#   - Bun runs the main paperhanger process (webhook ingest, incident
#     lifecycle, telemetry collection, repo resolution, notifications).
#   - Node.js (>=22.19) runs the built Flue agent-host as a child process,
#     spawned by src/agent/sidecar.ts. Flue's generated production server
#     (`flue build --target node` -> dist/server.mjs) unconditionally imports
#     `node:sqlite`, which Bun does not implement, so it cannot run under Bun
#     -- see docs/research/flue.md section 10.
#
# Base image choice: `oven/bun:1.3` (Debian 13 "trixie"). Debian trixie's own
# `nodejs` apt package is only 20.19.x, older than the >=22.19 that
# `node:sqlite` requires, so Node is installed from the NodeSource `setup_22.x`
# repository instead (verified empirically against this exact base image --
# NodeSource's repo is codename-independent ("nodistro"), so it works fine on
# a Debian release newer than what NodeSource officially lists). `git` is
# installed via apt too: the fix agent clones the target repository over
# HTTPS with an embedded GitHub App installation token (repo/github.ts
# `cloneUrlWithToken`), which requires a real `git` binary in PATH.

# ---- Stage 1: main app dependencies (Bun) ----------------------------------
FROM oven/bun:1.3 AS app-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile

# ---- Stage 2: agent-host build (Node/Flue app, built under Bun) ------------
# `flue build --target node` runs fine under Bun (only the *generated server*
# requires Node at runtime, per docs/research/flue.md section 10), so the
# build itself stays in a Bun-based stage; only the final runtime copy needs
# Node.
FROM oven/bun:1.3 AS agent-host-build
WORKDIR /agent-host
COPY agent-host/package.json agent-host/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile
COPY agent-host/flue.config.ts ./
COPY agent-host/src ./src
RUN bun run build
# Re-install production-only dependencies for the runtime image: the build
# step needs `@flue/cli` (a devDependency pulling in a full bundler toolchain)
# but the built dist/server.mjs only needs the plain runtime deps to execute
# (verified empirically: this shrinks node_modules from ~450MB to ~220MB).
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	rm -rf node_modules && bun install --production --frozen-lockfile

# ---- Stage 3: runtime -------------------------------------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app

# Node.js 22.x (>=22.19, for `node:sqlite`) + git (for cloning target repos)
# + curl (container HEALTHCHECK). NodeSource's setup script only configures
# the apt repository; the actual package install is the second command.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg git \
	&& curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& node --version \
	&& rm -rf /var/lib/apt/lists/*

# Main app (Bun).
COPY package.json bun.lock ./
COPY --from=app-deps /app/node_modules ./node_modules
COPY src ./src

# Agent-host (Node/Flue), built in stage 2.
COPY agent-host/package.json ./agent-host/package.json
COPY --from=agent-host-build /agent-host/node_modules ./agent-host/node_modules
COPY --from=agent-host-build /agent-host/dist ./agent-host/dist

ENV NODE_ENV=production
# Path to the built agent-host server entrypoint, read by src/agent/sidecar.ts
# (`Bun.spawn(["node", AGENT_HOST_SERVER_PATH])`). Configurable so a custom
# image layout or an externally-deployed agent-host build can override it.
ENV AGENT_HOST_SERVER_PATH=/app/agent-host/dist/server.mjs
ENV PAPERHANGER_CONFIG=/app/paperhanger.yaml

EXPOSE 8080
VOLUME ["/data"]

# Assumes the default `server.port: 8080` (see paperhanger.example.yaml); if a
# deployment overrides it, override this HEALTHCHECK (or the orchestrator's
# own probe) to match.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD curl -fsS "http://127.0.0.1:8080/healthz" || exit 1

CMD ["bun", "run", "start"]
