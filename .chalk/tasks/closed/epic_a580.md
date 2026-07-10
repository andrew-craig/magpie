---
id: epic_a580
title: Milestone 3 — Containerize the reviewer runtime
type: epic
status: closed
priority: 1
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-10T06:47:15Z
updated_at: 2026-07-10T21:18:52Z
---
Run Pi inside an ephemeral, hardened Docker container instead of the M1/M2 host
subprocess. This is PLAN.md milestone 3 ("Containerize") and PLAN.md §4 (Review container).

## Goal / definition of done

The reviewer no longer runs `pi` directly on the host. Instead, for every job the
orchestrator does `docker run --rm` of a pinned `magpie-reviewer` image, hands the PR
worktree in **read-only with `.git` stripped**, collects findings from a **mounted output
dir**, and tears the container down on completion, timeout, or abort. The structured-findings
behaviour and the posted review must be byte-for-byte equivalent to M2 — this milestone changes
*where Pi runs*, not *what it produces*.

## Explicit scope boundary (read this first)

- **IN scope (M3):** reviewer image, hardened `docker run` invocation, read-only `.git`-free
  workspace handoff, findings via mounted `/out`, container lifecycle (kill on timeout/abort,
  `--rm`, orphan cleanup), docker-availability preflight, config for image tag + resource limits.
- **NOT in scope (deferred to M4):** the LiteLLM gateway, per-job virtual keys, `magpie-net`
  bridge + host iptables egress lockdown, and the fail-closed egress startup assertion.
  **Interim consequence:** in M3 the container still reaches OpenRouter directly on the default
  bridge network and is still injected with the real `OPENROUTER_API_KEY` (exactly as the host
  subprocess is today). This is a deliberate, documented interim state — M4 removes the last
  secret and locks egress. Do NOT try to build the gateway here.

## Key design decisions (settle before coding; carry into the tasks)

1. **Findings transport stays the M2 contract.** The `report_findings` extension already writes
   to the path in `MAGPIE_FINDINGS_PATH` (see epic_e6e6 decision). In-container we set
   `MAGPIE_FINDINGS_PATH=/out/findings.json`, mount a per-job host temp dir at `/out` (rw), and
   read `<hostOutDir>/findings.json` back out. No schema/validator changes — `parseFindings`
   (findings.ts) still guards the trust boundary.
2. **`.git` is stripped from the mounted worktree.** The reviewer never needs git: the diff comes
   from the GitHub API (diff.ts), and the read-only tool allowlist is `read,grep,find,ls`. Mount
   a `.git`-free copy/export of the worktree at `/work:ro` so no lazy blob fetch or `git` call can
   reach `origin`.
3. **Baked-in vs mounted assets.** The Pi binary, the `report_findings` extension, and
   `reviewer-prompt.md` are **baked into the image** at pinned versions (not mounted from host).
   Rebuilding the image is therefore required whenever the extension or prompt changes — the build
   script and docs must call this out.
4. **Container user / `/out` writability (the main gotcha).** `--read-only` rootfs + `--tmpfs /tmp`
   is fine, but the mounted `/out` must be writable by whatever UID the container process runs as.
   PLAN.md §4 shows `--user reviewer`; a baked `reviewer` user's UID will almost never own the host
   temp dir. **Recommended for M3:** run `docker run --user "$(id -u):$(id -g)"` (the orchestrator's
   own uid/gid) so `/out` writes just work, and keep `--read-only`+`tmpfs /tmp` for the rest. Document
   the choice; M4 can revisit alongside the gateway. (Whichever way you go, there must be a test/e2e
   proving findings.json is actually written and readable.)

## Task graph (3 waves)

- **Wave 1 (parallel):** task_5b3a (M3-A, image) ‖ task_037b (M3-B, orchestrator plumbing).
- **Wave 2:** task_4ed4 (M3-C, reviewer.ts docker runner) — depends on A + B.
- **Wave 3:** task_d8aa (M3-D, pipeline wiring + live e2e) — depends on C + A.

See PLAN.md §4 and milestone 3 for the source of truth. All code goes into a branch (suggested
`m3-containerize`); junior engineers implement, tech lead reviews each task before merge.
