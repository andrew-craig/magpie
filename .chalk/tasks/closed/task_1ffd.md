---
id: task_1ffd
title: M4-E: fail-closed startup assertions in the container entry script
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:51:30Z
updated_at: 2026-07-11T23:05:57Z
---
Wave 3 (final M4 task; needs the gateway wiring and the network lockdown in place). PLAN.md milestone 4's explicit acceptance check.

Extend the magpie-reviewer entry script to verify its own confinement before running Pi, and exit non-zero (fail closed, surfaced as a review failure comment) if:
- any host other than the configured gateway is reachable (probe a couple of canaries, e.g. github.com and a raw public IP, and require them to FAIL; require the gateway health endpoint to succeed), or
- a long-lived provider key is present in the container env (e.g. OPENROUTER_API_KEY or any configured real-key variable) — only the per-job virtual key is allowed.

Keep the probes cheap and bounded (short timeouts) so they don't eat the job clock. Add an integration test or documented manual check demonstrating both failure modes actually abort the run.

Done when: deliberately breaking either invariant (extra network route, real key injected) aborts the review at startup with a clear log line.

## Review

**Status: implementation + live verification complete, left `in_progress` per instructions (tech lead to close).**

### As-built assertions (`docker/reviewer/entrypoint.sh`, inserted after the existing
`OPENROUTER_API_KEY`/`OPENAI_BASE_URL` `:?` checks, before `exec pi`)

1. **Virtual-key-only assertion.** `case "${OPENROUTER_API_KEY}" in sk-magpie-*) ;; *) ... exit 1 ;; esac`.
   Never echoes the key value or any substring of it — only the fact that its shape was wrong.
2. **Network confinement assertion.** Two small helpers (`magpie_tcp_reachable`, a raw
   `/dev/tcp` connect test; `magpie_http_get_200`, a raw HTTP/1.0 GET over the same
   mechanism), both wrapped in `timeout 3`. Canaries `1.1.1.1:443` (raw IP — tests actual
   routing) and `github.com:443` (name-based — fails at DNS resolution on `magpie-net`'s
   `--internal` bridge, which counts as unreachable) must both be UNREACHABLE, or the
   script aborts. The gateway's proxy-plane `GET /healthz` — host:port parsed from
   `OPENAI_BASE_URL` itself (no second hardcoded copy) — must be REACHABLE (200), or the
   script aborts. No new image dependency: bash builtins + coreutils' `timeout`, both
   already present.

### Task-text vs. M4-C reconciliation (documented in-line in entrypoint.sh too)

The task was written before M4-C existed and says to fail if a real provider key is
*present*. As of M4-C the container **always legitimately holds** `OPENROUTER_API_KEY`
— it's how Pi's OpenRouter provider resolves its credential, and the pre-existing `:?`
already requires it to be set — so "present" can no longer be the safety bar. What M4
actually changed is *what kind of value* is allowed in it: a short-lived, budget-capped
gateway virtual key (`sk-magpie-` prefix, `packages/gateway/src/keystore.ts`'s
`KEY_PREFIX`), never a real OpenRouter key (`sk-or-...`). The as-built check is
therefore "OPENROUTER_API_KEY must be a virtual key, not merely non-empty" — the
meaningful version of the same "no long-lived provider credential in the container"
guarantee the task intended.

### Verification evidence

**Build/tests** (clean, no regressions; TS packages untouched by this task so counts
match the pre-existing baseline exactly):
- `npm run build --workspaces --if-present` — clean across `@magpie/gateway`,
  `@magpie/orchestrator`, `@magpie/review-extension`.
- `npm run test --workspace=@magpie/orchestrator` — 188 passed (18 files).
- `npm run test --workspace=@magpie/review-extension` — 11 passed (1 file).
- `npm run test --workspace=@magpie/gateway` — 49 passed (6 files).
- Total: 248/248, unchanged from the pre-M4-E baseline (note: root `npm run test
  --workspaces` without `--if-present`/explicit workspace only picks up orchestrator +
  review-extension in this checkout for unrelated reasons predating this task; running
  gateway's test script directly works and is what's reported above).
- `shellcheck docker/reviewer/entrypoint.sh` — clean. Two `SC2016` (info) hits on the
  intentional single-quoted inner `bash -c '...'` scripts (their `$1`/`$2`/`$3` are the
  INNER bash's own positional params, bound via `_ "$host" "$port"` trailing args, not
  outer-shell variables) are suppressed with `# shellcheck disable=SC2016` + an inline
  comment explaining why, right above each occurrence.
- `bash -n docker/reviewer/entrypoint.sh` — syntax OK.

**Live demo — rebuilt `magpie-reviewer:0.1.0`, `scripts/setup-network.sh` (magpie-net
already provisioned and matching contract), gateway started bound to
`172.31.99.1:4000` (proxy) / `127.0.0.1:4100` (mgmt) with
`MAGPIE_GATEWAY_OPENROUTER_KEY=<repo-root .env's MAGPIE_LLM_API_KEY>` and a throwaway
`MAGPIE_GATEWAY_MASTER_KEY`:**

1. **Happy path** — `docker run --network magpie-net -e OPENROUTER_API_KEY=<freshly
   minted sk-magpie-... key> -e OPENAI_BASE_URL=http://172.31.99.1:4000/v1 ...
   magpie-reviewer:0.1.0 --provider openrouter --model openai/gpt-4o-mini` <<< a small
   JSON prompt payload on stdin. Both M4-E assertions passed silently, Pi ran, produced
   a real review through the gateway (`openai/gpt-4o-mini`, cost `$0.0003969` recorded
   by the gateway's keystore), wrote a valid `/out/findings.json` (1 finding, `verdict:
   "comment"`). **Exit code: 0.**

2. **Failure mode A — real key injected**: identical command with
   `OPENROUTER_API_KEY=sk-or-v1-deadbeefdeadbeefdeadbeefdeadbeef`. Output:
   ```
   magpie-reviewer: refusing to run: OPENROUTER_API_KEY is not a magpie gateway virtual key (expected the sk-magpie- prefix minted by packages/gateway). A real/long-lived provider key must never be injected into this container -- aborting before Pi starts.
   ```
   **Exit code: 1.** Pi never started; the gateway's own log shows no new request line
   (still just its 3 startup lines) — confirming no LLM traffic occurred.

3. **Failure mode B — extra network route**: same image + same freshly minted virtual
   key, but `--network bridge` instead of `magpie-net` (where `1.1.1.1` is genuinely
   routable, proven independently against the host beforehand). Output:
   ```
   magpie-reviewer: refusing to run: network canary 1.1.1.1:443 is REACHABLE from this container, but must not be -- confinement to the gateway-only network is broken. Aborting before Pi starts.
   ```
   **Exit code: 1.** Chose this over poking a hole in `magpie-net` itself, per the task
   brief — proves the probe detects a genuine escape rather than trusting the network
   name.

**Real key never leaked**: grepped the full captured happy-path NDJSON output and the
gateway's own log for the real key's `sk-or-` prefix — zero hits in either. The gateway
process, virtual key, and throwaway master key were all torn down/revoked after the
demo (key revoked via `DELETE /admin/keys/:id` → 204, gateway process killed).

### Files touched
- `docker/reviewer/entrypoint.sh` — the two assertions + updated header line + the
  reconciliation comment block.
- `docker/reviewer/README.md` — new "Fail-closed startup confinement assertions (M4-E)"
  subsection under "Gateway wiring (M4-C)", documenting the checks and the manual-check
  commands/expected output.
- `docker/reviewer/Dockerfile` — **unchanged**. No new image dependency was needed:
  bash's builtin `/dev/tcp` + coreutils' `timeout` (already present in `node:22-slim`)
  covered both the raw TCP canary probes and the HTTP `/healthz` check.

### Interpretation notes for the tech lead
- Reconciled "key present" (task text) → "key wrong shape" (as-built), per M4-C's
  design — see above; flagged explicitly per the task brief's instruction to explain
  this in-code and in this report.
- `exec pi`'s flag set is byte-for-byte unchanged; `reviewer.ts`'s docker invocation
  needed no changes (confirmed by re-reading `reviewer.ts`'s `dockerArgs` and diffing
  against the `exec pi` line — still flag-for-flag consistent).
- Did not touch `packages/gateway/**`, `pipeline.ts`, `config.ts`, or
  `scripts/setup-network.sh`, per the task's stated boundaries.
