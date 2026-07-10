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
# Runtime inputs (a container inherits NO ambient host env -- unlike the M1/M2
# host subprocess, which inherited process.env and had MAGPIE_* stripped from
# it -- so M3-C passes ONLY what's needed, explicitly):
#
#   `--provider <name> --model <id>` etc. as trailing ARGV. The baked flags
#     below are the fixed part of the invocation; everything the caller varies
#     per job (currently just provider + model, both non-secret and already
#     CLI flags in reviewer.ts's host spawn) arrives as `"$@"` appended after
#     them. M3-C invokes: `docker run ... IMAGE --provider openrouter --model
#     <config.llm.model>`.
#   OPENROUTER_API_KEY (env, `-e OPENROUTER_API_KEY=...`): provider credential;
#     pi-ai reads it directly from the environment. Required -- the one input
#     that legitimately comes via env because it's a secret, so we fail-fast if
#     it's missing (`:?` below) rather than letting Pi fail later with a
#     confusing provider-auth error. M3 still injects the real, long-lived
#     provider key; M4 replaces it with a short-lived, budget-capped gateway
#     virtual key -- the interim state this milestone deliberately leaves in
#     place. Never echoed to logs/stdout/stderr here.
#   OPENAI_BASE_URL (env, optional): OpenAI-compatible base URL override. Unset
#     in M3 (Pi/pi-ai talk to OpenRouter directly, same as today's host
#     subprocess); M4 will point this at the host-side LiteLLM gateway. Passed
#     through untouched if the caller set it -- never set or read here beyond
#     letting it flow through the environment.
#
# NOT a runtime input: MAGPIE_FINDINGS_PATH. The output path is part of the
# image contract (always /out/findings.json, the mounted output dir) and is
# baked into the Dockerfile via `ENV MAGPIE_FINDINGS_PATH=/out/findings.json`,
# so the baked-in report_findings extension already sees it -- this script
# neither reads nor requires it.

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set (-e OPENROUTER_API_KEY=...) -- see docker/reviewer/README.md}"

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
