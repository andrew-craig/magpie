#!/usr/bin/env bash
set -euo pipefail

# magpie-reviewer entrypoint (M3-A; gateway wiring added M4-C; fail-closed
# startup confinement assertions added M4-E).
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

# ---------------------------------------------------------------------------
# M4-E: fail-closed startup confinement assertions. PLAN.md milestone 4's
# explicit acceptance check requires this script to verify its OWN
# confinement before `exec pi` below, and abort non-zero (surfaced by
# reviewer.ts/pipeline.ts as a review-failure comment, never a silent hang)
# if either invariant is violated. Both checks are cheap and bounded so a
# healthy run pays only a few seconds of extra startup latency.
#
# RECONCILING the two checks against how the M4-E task was originally
# written (see chalk task_1ffd's description) vs. what M4-C actually built:
#
#   1. "no long-lived provider key in the container env" -- the task text
#      says to fail if OPENROUTER_API_KEY (or any real-key variable) is
#      PRESENT. That predates M4-C: as of M4-C this container legitimately
#      ALWAYS holds OPENROUTER_API_KEY, because it's how Pi's OpenRouter
#      provider resolves its credential (see the doc comment above) -- the
#      var can no longer be "absent" as the bar for safety, the `:?` above
#      already requires it to be set. What actually changed under M4 is
#      *what kind of value* is allowed to be in it: a short-lived,
#      budget-capped GATEWAY VIRTUAL key (packages/gateway/src/keystore.ts's
#      `KeyStore.mint`), never a real, long-lived OpenRouter key. Virtual
#      keys are minted with a fixed, unambiguous prefix (`KEY_PREFIX =
#      "sk-magpie-"` in that file); real OpenRouter keys look like
#      `sk-or-v1-...` and are never supposed to reach this container at all
#      once the gateway is wired up. So the as-built, meaningful version of
#      this check is: OPENROUTER_API_KEY must look like a magpie virtual
#      key, not merely be non-empty. Keep this prefix in sync with
#      packages/gateway/src/keystore.ts's KEY_PREFIX if that ever changes.
#   2. "no host but the gateway is reachable" is unchanged from the task
#      text and is implemented as a set of cheap reachability probes below.
# ---------------------------------------------------------------------------

# --- 1. Virtual-key-only assertion -----------------------------------------
#
# Deliberately does NOT print (or substring-match-log) the key value itself
# -- only ever the fact that its shape was wrong -- so a real key accidentally
# injected here never ends up echoed into container logs by the very check
# meant to catch it.
case "${OPENROUTER_API_KEY}" in
  sk-magpie-*)
    ;;
  *)
    echo "magpie-reviewer: refusing to run: OPENROUTER_API_KEY is not a magpie gateway virtual key (expected the sk-magpie- prefix minted by packages/gateway). A real/long-lived provider key must never be injected into this container -- aborting before Pi starts." >&2
    exit 1
    ;;
esac

# --- 2. Network confinement assertion ---------------------------------------
#
# This container's only permitted egress is the gateway's proxy plane (see
# scripts/setup-network.sh / M4-D: magpie-net is an `--internal` docker
# bridge, so there is no DNS and no route to anything but the gateway's fixed
# IP). Probe a couple of canaries that MUST be unreachable and the gateway
# that MUST be reachable; abort if either comes out wrong, since that means
# this container's actual confinement doesn't match what it's trusting.
#
# Implementation notes:
#   - Uses bash's built-in `/dev/tcp/<host>/<port>` pseudo-device for a raw
#     TCP connect test -- no curl/wget/nc needed, so no new image
#     dependency (see docker/reviewer/Dockerfile; deliberately unchanged by
#     M4-E). `timeout` (coreutils, already in the base image) bounds each
#     probe so a filtered/blackholed connection attempt can't hang the job.
#   - `/dev/tcp` name resolution failures (expected for the DNS-based canary
#     below, since magpie-net has no resolver at all) exit non-zero from the
#     inner bash, same as a refused/timed-out connection -- both count as
#     "unreachable", which is exactly the property being asserted.
#   - Every probe is read-only against the network and writes nothing to
#     disk, so it's safe under the `--read-only` root filesystem regardless
#     of HOME/tmp state at this point in the script.
readonly MAGPIE_PROBE_TIMEOUT_SECONDS=3

# Raw TCP connect test: exit 0 iff <host>:<port> accepts a connection within
# the timeout. Host/port are passed as positional args to the inner `bash -c`
# (not string-interpolated into its script) so there's no quoting/injection
# hazard even though these values are only ever internal, non-attacker-
# controlled constants/config in practice.
magpie_tcp_reachable() {
  # shellcheck disable=SC2016 # intentional: $1/$2 are the INNER bash -c's
  # own positional params (bound from the "_" "$1" "$2" args below), not the
  # outer shell's -- single quotes are required to keep them literal here.
  timeout "${MAGPIE_PROBE_TIMEOUT_SECONDS}" bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null
}

# Raw HTTP/1.0 GET over the same `/dev/tcp` mechanism, used only for the
# gateway's /healthz check below (see proxy-server.ts: unauthenticated,
# always `200 "ok"` on success). Deliberately not a general HTTP client --
# just enough to read a status line back.
magpie_http_get_200() {
  local host="$1" port="$2" path="$3" response first_line
  # shellcheck disable=SC2016 # same as magpie_tcp_reachable above: $1/$2/$3
  # here belong to the inner bash -c, bound from the "_" "$host" "$port"
  # "$path" args passed to it, not this outer function's own variables.
  response=$(timeout "${MAGPIE_PROBE_TIMEOUT_SECONDS}" bash -c '
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$3" "$1" >&3
    cat <&3
  ' _ "$host" "$port" "$path" 2>/dev/null) || return 1
  first_line="${response%%$'\r'*}"
  case "${first_line}" in
    "HTTP/1.1 200"* | "HTTP/1.0 200"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Canaries that MUST be unreachable from this container. A raw public IP
# (not just a hostname) is included deliberately -- it tests actual routing
# on the bridge, not merely the (already-absent) DNS resolver; a name-based
# canary is included too since it's still a meaningful signal (failing at
# resolution counts as unreachable, per the note above).
readonly MAGPIE_NETWORK_CANARIES=(
  "1.1.1.1:443"     # raw public IP -- must be unroutable on magpie-net
  "github.com:443"  # name-based -- must fail to resolve at all
)

for canary in "${MAGPIE_NETWORK_CANARIES[@]}"; do
  canary_host="${canary%%:*}"
  canary_port="${canary##*:}"
  if magpie_tcp_reachable "${canary_host}" "${canary_port}"; then
    echo "magpie-reviewer: refusing to run: network canary ${canary} is REACHABLE from this container, but must not be -- confinement to the gateway-only network is broken. Aborting before Pi starts." >&2
    exit 1
  fi
done

# The gateway itself MUST be reachable -- derive host/port from
# OPENAI_BASE_URL (config.gateway.containerBaseUrl, e.g.
# "http://172.31.99.1:4000/v1") rather than hardcoding a second copy of the
# address here, so this check can never silently drift from what Pi is
# actually configured to talk to (see the models.json translation below).
magpie_gateway_authority="${OPENAI_BASE_URL#*://}"
magpie_gateway_authority="${magpie_gateway_authority%%/*}"
magpie_gateway_host="${magpie_gateway_authority%%:*}"
magpie_gateway_port="${magpie_gateway_authority##*:}"
if [ "${magpie_gateway_host}" = "${magpie_gateway_port}" ]; then
  # No explicit ":port" in OPENAI_BASE_URL -- fall back to the scheme default.
  case "${OPENAI_BASE_URL}" in
    https://*) magpie_gateway_port=443 ;;
    *) magpie_gateway_port=80 ;;
  esac
fi

if ! magpie_http_get_200 "${magpie_gateway_host}" "${magpie_gateway_port}" "/healthz"; then
  echo "magpie-reviewer: refusing to run: gateway proxy plane at ${magpie_gateway_host}:${magpie_gateway_port}/healthz (derived from OPENAI_BASE_URL) is NOT reachable -- this container's only permitted egress is unavailable, so no review can be attempted. Aborting before Pi starts." >&2
  exit 1
fi

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
