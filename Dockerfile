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
# It also ships general-purpose tooling for the *target* repositories the fix
# agent clones and tests (see README.md "Current limitations" -- without
# this, only Node/Go/Rust projects were fixable): a C/C++ toolchain,
# Docker/DB/GitHub CLIs, and -- via mise and Nix, both installed but not
# pre-populated -- on-demand access to Python, Go, Rust, Java (+Maven/
# Gradle), Ruby, PHP, .NET, Deno, or anything else a target repo's test suite
# needs. These are deliberately *not* baked into the image at build time
# (Ruby/PHP alone, compiled from source, added ~15 minutes per build): a thin
# wrapper (see the mise step below) installs a tool via `mise exec` the
# first time the model actually runs it, so the image stays fast to build,
# and only the languages a fix run actually touches ever get installed --
# onto the running container's writable layer, which is why an install made
# this way doesn't survive that container being recreated (see "Operational
# notes" below). Which *version* gets installed is, for most of these
# languages, the target repo's own call: mise reads its idiomatic version
# file (.python-version, go.mod's sibling .go-version, etc.) out of the
# cloned checkout when present, falling back to .mise.toml's pin only when
# the target repo doesn't say -- see .mise.toml for exactly which languages
# support this and why Maven/Gradle/PHP can't.
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
# + curl (container HEALTHCHECK) + a C/C++ toolchain and the headers/libs
# mise needs on hand for whatever it ends up compiling from source on demand
# (Ruby and PHP always compile from source; see the mise step further down).
# NodeSource's setup script only configures the apt repository; the actual
# package install is the second command.
#
# `/usr/local/bun-node-fallback-bin` (a Bun-provided `node` shim, earlier in
# PATH than nothing else at this point) sits *after* `/usr/bin` in the base
# image's PATH, so the real NodeSource `node` installed below always resolves
# first (verified empirically) -- this is also why AGENT_HOST_NODE_PATH below
# is pinned to its absolute path rather than left to resolve by name.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl gnupg git build-essential clang cmake ninja-build \
		autoconf bison re2c patch pkg-config unzip \
		libssl-dev libyaml-dev libreadline-dev zlib1g-dev libgmp-dev \
		libncurses-dev libffi-dev libgdbm-dev libdb-dev uuid-dev \
		libxml2-dev libsqlite3-dev libonig-dev libicu-dev libzip-dev \
		libcurl4-openssl-dev libpng-dev libfreetype-dev libjpeg-dev \
		libwebp-dev libsodium-dev libgd-dev \
		redis-tools ripgrep tmux vim nano pipx \
	&& curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& node --version \
	&& rm -rf /var/lib/apt/lists/*

# PostgreSQL client (psql etc.): pinned to major version 18, since Debian
# trixie's own `postgresql-client` apt package is only 17.x. `pgdg`'s
# `apt.postgresql.org.sh` helper (shipped in the `postgresql-common` package)
# configures the official PGDG apt repo non-interactively; it recognizes
# "trixie" as a supported codename directly (verified against
# apt.postgresql.org/pub/repos/apt/dists/).
#
# `libpq-dev` (headers/lib, not just the `psql` CLI) is needed too: PHP's
# configure script auto-detects PostgreSQL support via `pg_config` on PATH
# when mise compiles it on demand, and without the dev package it finds the
# binary but not the library and fails the build outright rather than just
# skipping PDO_pgsql (verified empirically).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends postgresql-common \
	&& /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
	&& apt-get install -y --no-install-recommends postgresql-client-18 libpq-dev \
	&& rm -rf /var/lib/apt/lists/*

# Docker CLI only (docker-ce-cli + the compose plugin) -- no dockerd. The fix
# agent talks to the *host's* Docker daemon via a bind-mounted
# /var/run/docker.sock (an operator/deploy-time concern, not something this
# Dockerfile can set up); running a nested dockerd here would need
# `privileged: true`, which would defeat the container-as-isolation-boundary
# model described in README.md "Security notes". Docker's official apt repo
# does list "trixie" directly (verified against
# download.docker.com/linux/debian/dists/).
RUN install -m 0755 -d /etc/apt/keyrings \
	&& curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
	&& chmod a+r /etc/apt/keyrings/docker.asc \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		> /etc/apt/sources.list.d/docker.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
	&& rm -rf /var/lib/apt/lists/*

# GitHub CLI (`gh`) -- used by the fix agent for anything beyond the
# GitHub-App-authenticated PR creation paperhanger itself already does via
# repo/github.ts (see agent-host/README.md). The official repo uses a fixed
# "stable" suite name rather than a Debian codename, so it needs no
# trixie-specific check.
RUN install -m 0755 -d /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# yq (mikefarah/yq, the Go binary -- NOT Debian's `yq` apt package, which is
# the unrelated Python/kislyuk yq with an incompatible CLI). Pinned via a
# Renovate-tracked ARG (see renovate.json5 customManagers) since there's no
# apt repo to pull a moving version from.
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.44.3
RUN curl -fsSL -o /usr/local/bin/yq \
		"https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_$(dpkg --print-architecture)" \
	&& chmod +x /usr/local/bin/yq \
	&& yq --version

# mise (github.com/jdx/mise): on-demand source for the target-repo language
# toolchains pinned in .mise.toml (Python, Go, Rust, Java, +Maven/Gradle,
# Ruby, PHP, .NET, Deno) -- none of them are installed at build time here
# (building Ruby/PHP from source alone added ~15 minutes per build); see
# "Operational notes" in README.md for the tradeoff this implies.
#
# mise's own shims only work for a tool it has *already* installed at least
# once -- invoking one for a tool that's merely pinned in config but never
# installed errors "not a valid shim" rather than auto-installing, even with
# MISE_NOT_FOUND_AUTO_INSTALL set (verified empirically), so they can't
# front on-demand installs from a cold start the way this image needs.
# `mise exec <tool> -- <cmd> ...` (alias `mise x`) does install on demand,
# though, so the wrapper below fronts that instead of a real mise shim.
ENV MISE_DATA_DIR=/root/.local/share/mise
ENV PATH="/root/.local/bin:${PATH}"
# No confirmation prompts for the installs `mise exec` triggers below.
ENV MISE_YES=1
# Ruby defaults to compiling from source (~13 minutes, verified empirically)
# until mise 2026.8.0 makes precompiled the default; take the fast path
# now rather than waiting on that release, since it's exactly the on-demand
# install cost this design is trying to minimize.
ENV MISE_RUBY_COMPILE=false
RUN curl -fsSL https://mise.run | sh
# The *global* config path (~/.config/mise/config.toml), not a project-local
# `.mise.toml` -- verified empirically that only the global path is resolved
# from an arbitrary cwd (e.g. the fix agent's tmpdir-based per-run work
# directory, see agent-host/src/fix-agent.ts `createWorkDir()`), whereas a
# project-local file only resolves by walking up from that cwd. Pins the
# *fallback* version each language installs when the cloned target repo
# doesn't pin its own (see .mise.toml for exactly how that precedence works).
COPY .mise.toml /root/.config/mise/config.toml
# One wrapper, symlinked under every binary name a .mise.toml-pinned tool
# provides (extend both this list and the `case` below together if
# .mise.toml gains a tool): each symlink's argv[0] is its own basename, used
# below to recover which mise tool it belongs to, since e.g. `mvn`/`gradle`
# don't share their tool's mise name the way `python`/`go`/`deno` do.
COPY <<'EOF' /usr/local/bin/mise-tool-wrapper
#!/bin/sh
set -e
bin=$(basename "$0")
case "$bin" in
	python | python3 | pip | pip3 | pydoc3) tool=python ;;
	go | gofmt) tool=go ;;
	# rustfmt/clippy-driver are deliberately NOT wired to `rust` here: the
	# `profile = "minimal"` pinned in .mise.toml (needed to dodge a rustup
	# bug, see that file's comment) never installs them, so routing those
	# two through this wrapper would just mise-exec-install rustc/cargo/
	# rust-std yet again and still fail to find rustfmt/clippy-driver
	# afterwards -- better to fail fast as "command not found" (never
	# symlinked below) than mislead a build script into thinking they're
	# one on-demand install away from working.
	cargo | rustc | rustup) tool=rust ;;
	java | javac | jar | jshell | keytool | jlink | jdeps) tool=java ;;
	mvn | mvnDebug) tool=maven ;;
	gradle) tool=gradle ;;
	ruby | gem | irb | rake | erb | rdoc | ri | bundle | bundler) tool=ruby ;;
	php | phpize | php-config | phpdbg) tool=php ;;
	dotnet) tool=dotnet ;;
	deno) tool=deno ;;
	*)
		echo "mise-tool-wrapper: no known mise tool provides '$bin'" >&2
		exit 127
		;;
esac
# --quiet: without it, `mise exec` warns about every *other* pinned tool in
# .mise.toml that isn't installed yet on every single invocation (verified
# empirically) -- noise a model reading command output shouldn't have to
# filter through.
#
# Only take a lock -- and only around `mise install`, never around running
# the command itself -- when the tool isn't installed yet. `mise which`
# exits 0 with the resolved binary's path once installed, non-zero
# otherwise (verified empirically), so this is a cheap, accurate check.
# An earlier version locked around the *whole* `mise exec` call (install +
# run) for every invocation, tool-installed-or-not; that meant two ordinary
# concurrent calls into an *already-installed* tool (e.g. a target repo's
# own test suite forking multiple `ruby` workers, or a parallel `make -j`
# build invoking `java` repeatedly) raced on the same lockfile and one of
# them got refused as "invoked recursively" even though neither was
# installing anything -- verified by re-reading this exact failure mode
# out of code review. Skipping the lock entirely once mise already has the
# tool avoids that: concurrent *use* of an installed tool is mise's problem
# to handle (it does), not this wrapper's.
if ! mise which "$tool" >/dev/null 2>&1; then
	# Guard against self-referential recursion during the install itself,
	# *per tool* (not a single global flag -- see below for why that
	# distinction matters): PHP's build script probes for an existing `php`
	# on PATH to compare versions while `php` itself is still installing,
	# which through this wrapper means "mise exec php" calling back into
	# "mise exec php" -- the outer install already holds mise's per-tool
	# install lock, so the inner call blocks on it and dies with mise's own
	# 3s lock-wait timeout (verified empirically: intermittent, depending on
	# exactly when the probe fires relative to the outer install finishing).
	# Failing fast here instead makes it look like `php` simply isn't
	# installed yet, which a build script probing for an optional existing
	# installation handles fine.
	#
	# Keyed by tool (one lock dir per tool, not one shared flag): an earlier
	# version used a single flag and broke Maven, whose `mvn` launcher
	# script legitimately shells out to `java` while mise-installing maven
	# is still in flight -- a single flag mistook that cross-tool call for
	# the same self-referential recursion as PHP's and refused it too.
	#
	# A lock *directory*, not an inherited env var or a plain `[ -e ]`-
	# checked file: an earlier version tried `FOO=1 exec mise exec ...` and
	# relied on that env var reaching the probe's child invocation of this
	# same wrapper, but vfox backends (php's included) run their
	# install-hook shell commands through their own env construction rather
	# than a plain inherited-environment child process, so the var never
	# arrived and the guard silently never fired (verified empirically: PHP
	# still deadlocked identically after switching to a per-tool env var).
	# A later version used a lockfile with a separate `[ -e ]` existence
	# check followed by a separate `echo "$$" >"$lockfile"` write -- two
	# concurrent first-time callers for the same not-yet-installed tool
	# could both see "no lockfile" and both write, defeating the lock
	# (verified against code review). `mkdir` is atomic on any POSIX
	# filesystem: exactly one of two concurrent callers can create the same
	# directory, so lock acquisition and the liveness check below can't
	# both slip through.
	lockdir="/tmp/.mise-tool-wrapper-installing-${tool}"
	lock_held_by_live_process() {
		[ -d "$lockdir" ] || return 1
		lock_pid=$(cat "$lockdir/pid" 2>/dev/null)
		[ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null
	}
	if ! mkdir "$lockdir" 2>/dev/null; then
		# One retry after a short wait before concluding this is a real
		# deadlock: a failed remote-version lookup (rate limit, timeout --
		# both verified empirically against ruby/rust while GitHub API
		# quota was exhausted during this image's own testing) makes the
		# *outer* `mise exec` retry or fall back internally, which can
		# re-invoke this same wrapper while the outer call is still
		# technically "installing" but about to finish/error out on its own
		# within a couple seconds -- not stuck waiting on this inner call
		# the way PHP's genuine self-reference is. Retrying once
		# distinguishes the two: PHP's case is still holding the lock 2s
		# later (its outer install is blocked on this inner call
		# completing), so it still gets refused below; the transient case
		# has usually cleared by then.
		if lock_held_by_live_process; then
			sleep 2
		fi
		if ! mkdir "$lockdir" 2>/dev/null; then
			if lock_held_by_live_process; then
				echo "mise-tool-wrapper: '$bin' invoked recursively while $tool is installing; refusing to avoid a mise lock deadlock" >&2
				exit 127
			fi
			# Stale lock: the owning process is gone entirely (SIGKILL --
			# e.g. an OOM kill or `docker kill` -- skips the EXIT/INT/TERM
			# trap below entirely, verified empirically to leave a lock dir
			# behind exactly this way). Take it over rather than refusing
			# every future call for this tool for the rest of this
			# long-running container's life over an install that isn't
			# even running anymore.
			rm -rf "$lockdir"
			mkdir "$lockdir" 2>/dev/null || true
		fi
	fi
	echo "$$" >"$lockdir/pid"
	# Also clean up on a signal (e.g. the fix agent's own shell-call timeout
	# killing this process with SIGTERM) -- SIGKILL still leaks the lock dir
	# (trap can't intercept it), which the stale-lock check above covers.
	trap 'rm -rf "$lockdir"' EXIT INT TERM
	# Install only, deliberately not running "$bin" yet -- that happens
	# below, once the lock is released, so concurrent *use* of this
	# now-installed tool from other callers is never serialized through
	# this lock. `|| true`: if this fails (network, disk, ...) the `mise
	# exec` below will surface the same failure with its own error message;
	# no need to duplicate that here.
	mise install --quiet "$tool" >&2 || true
	rm -rf "$lockdir"
	trap - EXIT INT TERM
fi
# `if <cmd>` rather than `<cmd>; status=$?`: under `set -e`, a non-zero exit
# from the latter form would end the script right there, before reaching
# the explicit `exit` below -- moot for the final exit status either way,
# but kept for clarity.
if mise exec --quiet "$tool" -- "$bin" "$@"; then
	status=0
else
	status=$?
fi
exit "$status"
EOF
RUN chmod +x /usr/local/bin/mise-tool-wrapper \
	&& for bin in \
		python python3 pip pip3 pydoc3 \
		go gofmt \
		cargo rustc rustup \
		java javac jar jshell keytool jlink jdeps \
		mvn mvnDebug \
		gradle \
		ruby gem irb rake erb rdoc ri bundle bundler \
		php phpize php-config phpdbg \
		dotnet \
		deno; \
	do \
		ln -s /usr/local/bin/mise-tool-wrapper "/usr/local/bin/$bin"; \
	done

# Nix (single-user install, no daemon): a fallback package source for
# whatever the fix agent needs that isn't covered by apt or mise. Runs as
# root in this image, so `--no-daemon` (single-user mode) applies; the
# multi-user daemon install assumes a dedicated `nixbld` user set and a
# systemd unit, neither of which fits a container. The installer normally
# shells out to `sudo` to create /nix when run as a non-root user, but there's
# no `sudo` in this image and none is needed -- pre-creating /nix (verified
# empirically to be exactly what the installer's own root-owned-directory
# check wants) skips that shell-out entirely.
#
# The single-user installer's generated nix.conf still points
# `build-users-group` at `nixbld` (verified empirically -- it doesn't clear
# the setting the way multi-user installs' dedicated user set would need),
# so `nix` refuses to run at all unless that group exists *and* has at least
# one member, even though single-user mode never actually uses it to sandbox
# anything: an empty group fails "has no members", so a placeholder member
# (never otherwise used) is required too.
RUN groupadd nixbld \
	&& useradd -M -N -G nixbld nixbld1 \
	&& mkdir -m 0755 /nix && chown root /nix \
	&& curl -fsSL -o /tmp/nix-install.sh https://nixos.org/nix/install \
	&& sh /tmp/nix-install.sh --no-daemon \
	&& rm /tmp/nix-install.sh
# Appended, not prepended: a `nix profile install`/`nix-env -i` for a package
# that happens to provide a binary also named `python`/`ruby`/`php`/etc.
# (any of the ~30 names the mise-tool-wrapper symlinks own) would otherwise
# silently shadow that symlink for the rest of this container's life,
# bypassing mise's idiomatic-version-file resolution and .mise.toml pin with
# no error (verified by resolving the resulting PATH order empirically).
# Appending keeps Nix strictly a fallback for names nothing else here
# provides, matching the intent described in the comment below.
ENV PATH="${PATH}:/root/.nix-profile/bin"

# conan (C/C++ package manager): installed at build time via pipx (unlike the
# mise-managed languages above, it's a small pure-Python tool, not worth
# deferring), which keeps it and its Python deps isolated from whatever
# mise-managed `python` a fix run later installs on demand.
RUN pipx install conan \
	&& pipx ensurepath
ENV PATH="/root/.local/bin:${PATH}"

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
# (`Bun.spawn([AGENT_HOST_NODE_PATH, AGENT_HOST_SERVER_PATH])`). Configurable
# so a custom image layout or an externally-deployed agent-host build can
# override it.
ENV AGENT_HOST_SERVER_PATH=/app/agent-host/dist/server.mjs
# Absolute path to the system Node binary (see the PATH comment on the first
# apt-get above): pinned rather than left to resolve `node` by name so the
# sidecar can never accidentally pick up a mise-managed or Nix-profile `node`
# that ends up earlier on PATH (see .mise.toml for why Node/Bun themselves
# are intentionally not mise-managed).
ENV AGENT_HOST_NODE_PATH=/usr/bin/node
ENV PAPERHANGER_CONFIG=/app/paperhanger.yaml

EXPOSE 8080
VOLUME ["/data"]

# Assumes the default `server.port: 8080` (see paperhanger.example.yaml); if a
# deployment overrides it, override this HEALTHCHECK (or the orchestrator's
# own probe) to match.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD curl -fsS "http://127.0.0.1:8080/healthz" || exit 1

CMD ["bun", "run", "start"]
