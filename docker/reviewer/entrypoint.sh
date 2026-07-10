#!/usr/bin/env bash
set -euo pipefail

# magpie-reviewer entrypoint (M3-A).
#
# Runs Pi headless over the mounted /work worktree using the extension +
# system prompt baked into the image at /opt/magpie (see
# docker/reviewer/Dockerfile). This flag set MUST mirror
# packages/orchestrator/src/reviewer.ts's `pi` invocation EXACTLY
# (flag-for-flag, same order) -- if reviewer.ts's args array changes, update
# this script to match and vice versa. As of M3-A, reviewer.ts spawns:
#
#   pi -p --mode json --no-session --tools read,grep,find,ls,report_findings
#      --extension <review-extension> --no-extensions --provider openrouter
#      --model <config.llm.model> --append-system-prompt <reviewer-prompt.md>
#
# with the PR title/body/changed-files/diff prompt payload piped on stdin
# (see reviewer.ts's buildPromptPayload) -- this container must be run
# attached (`docker run -i`) so that reaches Pi.
#
# Everything that varies per job is read from the environment below (never
# baked into the image, never hardcoded, never echoed to logs/stdout/stderr):
#
#   MAGPIE_MODEL          Model id/pattern passed to --model. Required (M3-C
#                         sets this from config.llm.model).
#   MAGPIE_PROVIDER        Provider name passed to --provider. Optional,
#                         defaults to "openrouter" (reviewer.ts's current
#                         hardcoded value).
#   MAGPIE_FINDINGS_PATH   Path the baked-in report_findings extension writes
#                         its output to (see packages/review-extension).
#                         Required (M3-C sets this to /out/findings.json, the
#                         mounted output dir).
#   OPENROUTER_API_KEY     Provider credential; pi-ai reads this directly from
#                         the environment (same as the M1/M2 host subprocess
#                         -- see reviewer.ts's module doc comment). Required.
#                         M3 still injects the real, long-lived provider key;
#                         M4 replaces it with a short-lived, budget-capped
#                         gateway virtual key -- that's the interim state this
#                         milestone deliberately leaves in place.
#   OPENAI_BASE_URL        Optional OpenAI-compatible base URL override. Unset
#                         in M3 (Pi/pi-ai talk to OpenRouter directly, same as
#                         today's host subprocess); M4 will point this at the
#                         host-side LiteLLM gateway. Passed through untouched
#                         if the caller set it -- never set or read here
#                         beyond letting it flow through the environment.
#
# `set -u` above means any of the required variables being unset fails fast
# with a clear message (via the `:?` checks) rather than Pi failing later
# with a confusing provider-auth error.

: "${MAGPIE_MODEL:?MAGPIE_MODEL must be set -- see docker/reviewer/README.md}"
: "${MAGPIE_FINDINGS_PATH:?MAGPIE_FINDINGS_PATH must be set -- see docker/reviewer/README.md}"
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set -- see docker/reviewer/README.md}"

MAGPIE_PROVIDER="${MAGPIE_PROVIDER:-openrouter}"

# exec: replace this script as PID 1 so Pi receives SIGTERM/SIGKILL directly
# from `docker stop`/`docker kill` (the container-lifecycle timeout/abort
# path -- see epic_a580) instead of a shell swallowing the signal.
exec pi \
  -p \
  --mode json \
  --no-session \
  --tools read,grep,find,ls,report_findings \
  --extension /opt/magpie/review-extension/src/index.ts \
  --no-extensions \
  --provider "$MAGPIE_PROVIDER" \
  --model "$MAGPIE_MODEL" \
  --append-system-prompt /opt/magpie/reviewer-prompt.md
