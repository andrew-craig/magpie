#!/usr/bin/env bash
set -euo pipefail

# magpie-reviewer entrypoint (M3-A; gateway wiring added M4-C).
#
# Runs Pi headless over the mounted /work worktree using the extension +
# system prompt baked into the image at /opt/magpie (see
# docker/reviewer/Dockerfile). The `pi` FLAG SET (the `exec pi ...` invocation
# below) MUST mirror packages/orchestrator/src/reviewer.ts's `pi` invocation
# EXACTLY (flag-for-flag, same order) -- if reviewer.ts's args array changes,
# update this script to match and vice versa. As of M3-A, reviewer.ts spawns:
#
#   pi -p --mode json --no-session --tools read,grep,find,ls,report_findings
#      --extension <review-extension> --no-extensions --provider openrouter
#      --model <config.llm.model> --append-system-prompt <reviewer-prompt.md>
#
# with the PR title/body/changed-files/diff prompt payload piped on stdin
# (see reviewer.ts's buildPromptPayload) -- this container must be run
# attached (`docker run -i`) so that reaches Pi.
#
# Runtime inputs (a container inherits NO ambient host env -- unlike the M1/M2
# host subprocess, which inherited process.env and had MAGPIE_* stripped from
# it -- so M3-C/M4-C pass ONLY what's needed, explicitly):
#
#   `--provider <name> --model <id>` etc. as trailing ARGV. The baked flags
#     below are the fixed part of the invocation; everything the caller varies
#     per job (currently just provider + model, both non-secret and already
#     CLI flags in reviewer.ts's host spawn) arrives as `"$@"` appended after
#     them. reviewer.ts invokes: `docker run ... IMAGE --provider openrouter
#     --model <config.llm.model>`.
#   OPENROUTER_API_KEY (env, `-e OPENROUTER_API_KEY`, name-only): provider
#     credential; pi-ai reads it directly from the environment. Required --
#     the one input that legitimately comes via env because it's a secret, so
#     we fail-fast if it's missing (`:?` below) rather than letting Pi fail
#     later with a confusing provider-auth error. As of M4-C this is ALWAYS a
#     short-lived, budget-capped GATEWAY VIRTUAL key minted per job
#     (packages/gateway, via packages/orchestrator/src/gateway.ts) -- the
#     orchestrator no longer holds a real, long-lived OpenRouter key to inject
#     at all (see config.ts: `secrets.llmApiKey` was removed). Never echoed to
#     logs/stdout/stderr here.
#   OPENAI_BASE_URL (env, `-e OPENAI_BASE_URL=<url>`, inline since it's not a
#     secret): the gateway's container-facing PROXY/data plane
#     (config.gateway.containerBaseUrl, default
#     http://172.31.99.1:4000/v1 -- magpie-net's fixed gateway IP, M4-D).
#     Required as of M4-C -- there is no direct-to-OpenRouter fallback any
#     more. IMPORTANT: Pi 0.80.3 does NOT read this env var itself (verified
#     empirically against a stub HTTP server during M4-C: a plain
#     OPENAI_BASE_URL was silently ignored and Pi's request still went to the
#     real api.openrouter.ai). The mechanism that actually redirects Pi's
#     OpenRouter traffic is a `~/.pi/agent/models.json` provider `baseUrl`
#     override (see Pi's docs/models.md, "Overriding Built-in Providers") --
#     so THIS SCRIPT translates OPENAI_BASE_URL into that file below, before
#     exec'ing `pi`. `pi`'s own invocation is otherwise unaffected: the
#     `--provider openrouter` flag stays exactly as before, and the resolved
#     credential (OPENROUTER_API_KEY above) still flows through Pi's normal
#     OpenRouter provider -- only its baseUrl changes.
#
# NOT a runtime input: MAGPIE_FINDINGS_PATH. The output path is part of the
# image contract (always /out/findings.json, the mounted output dir) and is
# baked into the Dockerfile via `ENV MAGPIE_FINDINGS_PATH=/out/findings.json`,
# so the baked-in report_findings extension already sees it -- this script
# neither reads nor requires it.

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set (-e OPENROUTER_API_KEY=...) -- see docker/reviewer/README.md}"
: "${OPENAI_BASE_URL:?OPENAI_BASE_URL must be set (-e OPENAI_BASE_URL=<gateway proxy URL>) -- see docker/reviewer/README.md}"

# HOME: the container's root filesystem is `--read-only` (see reviewer.ts's
# dockerArgs) with only `/tmp` writable (`--tmpfs /tmp`). reviewer.ts runs
# this container as an arbitrary HOST `--user <uid>:<gid>`, and the base image
# (node:22-slim) happens to bake in its own `node` account at uid 1000 -- so
# whenever the host uid this runs as collides with 1000 (a common first-
# non-root-user uid on many Linux distros; confirmed empirically during M4-C
# verification), the container runtime resolves THAT passwd entry and sets
# HOME=/home/node for us even though no `-e HOME` was ever passed -- and
# `/home/node` is on the read-only root filesystem, so writing there fails.
# A plain `: "${HOME:=/tmp}"` (default-if-unset) does NOT fix this, because
# HOME is already set (just to the wrong, unwritable path) -- so this
# unconditionally OVERRIDES it to the one location guaranteed writable
# regardless of uid (`/tmp`, torn down with the container on exit -- never
# persisted, which is fine since models.json below holds no secret).
export HOME=/tmp

# Translate OPENAI_BASE_URL into the provider-baseUrl override Pi actually
# reads (see the doc comment above). Preserves every built-in `openrouter`
# model and the normal OPENROUTER_API_KEY-env credential resolution -- only
# the endpoint moves, from api.openrouter.ai to the gateway's proxy plane.
# `mkdir -p` is safe to re-run; this file is not a secret (a fixed,
# deployment-wide URL, not a per-job credential) so no special permissions are
# needed beyond the tmpfs's own.
mkdir -p "$HOME/.pi/agent"
cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "openrouter": {
      "baseUrl": "${OPENAI_BASE_URL}"
    }
  }
}
EOF

# exec: replace this script as PID 1 so Pi receives SIGTERM/SIGKILL directly
# from `docker stop`/`docker kill` (the container-lifecycle timeout/abort
# path -- see epic_a580) instead of a shell swallowing the signal. `"$@"`
# forwards the caller's trailing args (--provider/--model) after the fixed
# baked flags.
exec pi \
  -p \
  --mode json \
  --no-session \
  --tools read,grep,find,ls,report_findings \
  --extension /opt/magpie/review-extension/src/index.ts \
  --no-extensions \
  --append-system-prompt /opt/magpie/reviewer-prompt.md \
  "$@"
