# magpie-reviewer (M3-A): containerized runtime for the Pi coding agent.
#
# Runs Pi headless over a mounted, read-only, `.git`-free PR worktree
# (`/work`) and writes structured findings to a mounted `/out`. No secrets or
# per-job config are baked in -- everything that varies per job (model,
# provider key/base URL, findings output path) is read from the environment
# by docker/reviewer/entrypoint.sh at run time. See docker/reviewer/README.md
# for build/run instructions and the current pinned-version record.
#
# PINNED VERSIONS (bump deliberately -- no floating tags/ranges anywhere in
# this file; see README.md for the "how to re-pin" checklist):
#   - Base image:  node:22.23.1-slim, pinned by BOTH tag and digest below.
#   - Pi:          @earendil-works/pi-coding-agent@0.80.3 (matches the host's
#                  `pi --version` == 0.80.3 as of 2026-07-10; see
#                  docker/reviewer/extension-package.json).
#   - Extension's own runtime deps: @earendil-works/pi-tui@0.80.3,
#                  typebox@1.1.38 (must match packages/review-extension's
#                  resolved versions on the host -- see that package's
#                  package.json / the repo root package-lock.json).
FROM node:22.23.1-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# git: kept on PATH as defence-in-depth in case Pi or a future tool probes
# for it, even though the mounted worktree itself is `.git`-free (M3-B strips
# it host-side) and the read-only tool allowlist below never includes `bash`.
# Minimal install, apt lists cleaned up in the same layer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# --- Pi + review-extension, installed together at pinned exact versions ---
#
# The `pi` CLI and the report_findings extension's `import`s
# (@earendil-works/pi-coding-agent's ExtensionAPI, @earendil-works/pi-tui's
# Text, typebox's Type) are installed as ONE regular (non-global) npm
# dependency set at /opt/magpie/review-extension, so both resolve against the
# exact same on-disk copies -- no separate global install that could drift to
# a different version. `/opt/magpie/review-extension/node_modules/.bin/pi` is
# symlinked onto PATH below so `pi` is invocable normally.
WORKDIR /opt/magpie/review-extension
COPY docker/reviewer/extension-package.json ./package.json
RUN npm install --omit=dev \
    && ln -s /opt/magpie/review-extension/node_modules/.bin/pi /usr/local/bin/pi

# Bake in the extension SOURCE (Pi runs the .ts file directly -- no build
# step, see packages/review-extension's own doc comments) and the reviewer
# system prompt. Both are pinned to whatever this build's git checkout has;
# rebuild the image whenever either changes (see README.md).
COPY packages/review-extension/src ./src
COPY reviewer-prompt.md /opt/magpie/reviewer-prompt.md

# Non-root user, defence-in-depth only. The image must NOT depend on running
# as this user: M3-C (the orchestrator's docker runner) overrides with
# `--user <hostuid>:<hostgid>` so the mounted `/out` dir (owned by the host
# orchestrator process) stays writable -- see epic_a580 decision #4. uid/gid
# 10001 chosen to avoid the base image's existing `node` user (uid 1000) and
# common host uid ranges.
RUN groupadd --gid 10001 reviewer \
    && useradd --uid 10001 --gid reviewer --no-create-home --shell /usr/sbin/nologin reviewer

COPY docker/reviewer/entrypoint.sh /opt/magpie/entrypoint.sh
RUN chmod +x /opt/magpie/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/opt/magpie/entrypoint.sh"]
