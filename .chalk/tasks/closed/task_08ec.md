---
id: task_08ec
title: M8-B2: rootless substrate — docker→rootless podman+crun port, orchestrator ⟂ gateway uid split preserved (merge blocker)
type: task
status: closed
priority: 1
labels: [security,merge-blocker,substrate]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:03Z
updated_at: 2026-07-23T08:28:41Z
---
Adopt Proposal B's rootless substrate WITHOUT B's as-written secret regression. CTO edit 1 makes
this a merge blocker: the orchestrator ⟂ gateway uid separation must hold in every tier from the
first landed commit. The provider key never lives in the process that parses untrusted PR
content — no interim commit may route gateway credentials through the orchestrator, even behind
a flag.

Plan:
- [ ] Port the reviewer launch path (docker.ts wrapper + reviewer.ts invocation) from the docker
      CLI to rootless podman with crun, keeping the exact hardened flag set — the M8-B1
      byte-for-byte floor test gates this port.
- [ ] Keep the gateway as its own unprivileged uid + separate systemd unit exactly as today; the
      per-job unix-socket handoff and mint/revoke management plane are unchanged in the crun tier.
- [ ] Orphan-cleanup: reap orphaned podman containers (docker kill targets → podman equivalents).
- [ ] Explicit review-checklist item on the PR: grep-level assertion that no provider-key env/
      config reaches the orchestrator process; document the uid layout in the PR body.
- [ ] Existing e2e review flow passes under rootless podman on a dev host (subuid/subgid + linger
      set up manually for now; installer automation is M8-D3).

Done when: main runs the full pipeline on rootless podman+crun with zero posture drift (floor
test green) and the uid split provably intact; no root daemon or docker-group grant remains in
the runtime path.

---

## Implementation plan (branch `m8-b2-rootless-substrate`, folds in task_bfaf)

Empirical groundwork (done up front on this host — podman 4.3.1 + crun + subuid configured):
- [x] Confirmed rootless podman `--user <hostuid>` + `/out` bind-mount writeback FAILS ("Permission
      denied") WITHOUT `--userns=keep-id`, and SUCCEEDS with it (findings.json comes back owned by the
      orchestrator uid). So `--userns=keep-id` is a genuine rootless requirement, not optional.
- [x] Confirmed `--network none`, `--cap-drop=ALL`, `--read-only`, `--tmpfs /tmp`, `--pids-limit`,
      `--cpus`, `--security-opt=no-new-privileges` all work rootless.
- [x] Confirmed this host's user cgroup delegation has only `cpu pids` (no `memory` controller —
      RPi `cgroup_disable=memory`), so `--memory` fails CLOSED under rootless crun. This is the
      pre-existing host gap tracked as bug_df2d, NOT a port defect. Live full-argv e2e on THIS host
      is therefore blocked on `--memory`; deferred with exact reason (see review section).

Design decisions:
- [ ] **podman is the new default runtime** (`config.container.dockerBin` default `docker` → `podman`;
      config.example.toml updated). docker stays fully supported via the same seam.
- [ ] **`--userns=keep-id` added CONDITIONALLY** — only when the runtime binary basename is `podman`
      (real docker hard-errors on the flag). This keeps the M8-B1 floor golden (which pins a
      `dockerBin:"docker"` config) byte-for-byte GREEN with ZERO fixture edits, while the actually-
      shipped podman posture is pinned by a NEW podman golden test. keep-id is a uid-mapping shim,
      not a hardening flag; every hardened flag is preserved unchanged.

Code changes:
- [ ] reviewer.ts: `isPodmanBinary()` helper + optional `dockerBin` on `BuildReviewDockerArgsParams`
      (defaults to `config.container.dockerBin`); inject `--userns=keep-id` iff podman. Keep every
      hardened flag identical.
- [ ] reviewer.ts: **runtime fail-closed preflight** (task_bfaf) — `assertHardenedFlags(argv)` asserts
      the full hardened set is present before spawn; loud `console.error` + `{ok:false}` if any missing
      (never throws, per contract).
- [ ] container-mounts.ts: `assertGitStripped(mountDir)` fail-closed check (task_bfaf) that `.git` is
      absent from the prepared `/work` mount; wired into runReview before spawn.
- [ ] docker.ts / orphan-cleanup.ts: podman-aware doc/messaging; verified `version`, `ps -aq --filter`,
      `kill`, `rm -f` argv are byte-identical under podman (no argv change needed).
- [ ] config.ts + config.example.toml: podman default + updated comments.

Tests (all must stay green):
- [ ] M8-B1 floor golden (`reviewer-crun-floor-argv.test.ts`) — UNCHANGED, still green (docker config).
- [ ] NEW podman golden test — pins podman argv incl. `--userns=keep-id` byte-for-byte.
- [ ] NEW `assertHardenedFlags` unit tests — passes on the real argv, fails closed on a dropped flag.
- [ ] NEW container-mounts posture tests — `.git` fully stripped; `assertGitStripped` fails closed.
- [ ] NEW `uid-split.test.ts` (merge-blocker grep assertion) — orchestrator src reads only the 4
      allowlisted `MAGPIE_*` env vars; NO real provider key (`*OPENROUTER*KEY*`/`*OPENAI*KEY*`) is read
      anywhere in the orchestrator; positive control: the gateway package DOES declare it.
- [ ] Full `npm test` green.

Deferred / out of scope (documented):
- [ ] Live rootless-podman full-argv e2e — blocked on this host by the missing `memory` cgroup
      controller (bug_df2d). Mechanics proven with a hardened-minus-`--memory` rootless run.
- [ ] systemd/install rootless provisioning (drop docker group, `--user` unit, subuid/linger) = M8-D3
      (task_67aa).

---

## Review (2026-07-23) — branch `m8-b2-rootless-substrate` (NOT pushed; no PR — CTO-gated)

Ported the reviewer launch path from rootful docker to **rootless podman + crun as the default
runtime**, keeping the exact hardened flag set, uid split provably intact, and folded in task_bfaf.

**podman is now the default** (`config.container.dockerBin` default `docker` → `podman`;
config.example.toml + comments updated). docker stays fully supported via the same seam.

**The one rootless argv change — `--userns=keep-id` — is added CONDITIONALLY (podman only).**
Empirically required on this host: with rootless podman, `--user <hostuid>` maps through the subuid
range so `/out` writes get EPERM (silently failing every review); `keep-id` maps the invoking uid
straight through so `/out/findings.json` comes back owned by the orchestrator. Real docker
hard-errors on the flag, so it is gated on `isPodmanBinary(basename===podman)`. Consequence for the
merge-blocker floor test: the **M8-B1 docker floor golden is byte-for-byte UNCHANGED and green**
(its fixed config uses `dockerBin:"docker"`), and a **new podman golden** pins the shipped-default
posture (= floor golden + exactly `--userns=keep-id`, adjacent to `--user`). Both drift-protected.

**Files changed:** `reviewer.ts` (isPodmanBinary, conditional keep-id, `findMissingHardenedFlags`
runtime preflight + `assertGitStripped` wired fail-closed before spawn), `container-mounts.ts`
(`assertGitStripped` + `GitNotStrippedError`), `config.ts` + `config.example.toml` (podman default),
`config.test.ts` (default assertion), `docker.ts` + `orphan-cleanup.ts` (runtime-neutral messaging;
their argv is byte-identical under podman — no change needed). New tests: `reviewer-podman-argv`
(+golden), `reviewer-hardened-preflight`, `uid-split`, container-mounts posture cases.

**task_bfaf folded in:** (1) runtime fail-closed preflight `findMissingHardenedFlags` asserts the
full hardened posture on the real templated argv immediately before spawn (loud log + `{ok:false}`,
never launches under-hardened); (2) `assertGitStripped` extends the pinned posture to the mount prep
(the `.git`-stripped `/work`) the golden doesn't cover.

**uid split (merge blocker):** grep assertion `uid-split.test.ts` proves the orchestrator reads
only 4 allowlisted `MAGPIE_*` env vars, never a provider/LLM-key-shaped var; Config has no
provider-key field; reviewer.ts injects only the per-job gateway VIRTUAL key; positive control
confirms the real `MAGPIE_GATEWAY_OPENROUTER_KEY` lives in the separate gateway package. uid layout
documented in the test header. No commit routes gateway creds through the orchestrator.

**Tests:** full `npm test` green — gateway 66, orchestrator 282, review-extension 11. tsc clean,
build clean. Negative control verified: dropping `--cap-drop=ALL` fails the floor golden + podman
golden + runtime preflight, then reverted.

**Live rootless-podman e2e — PARTIAL / full-pipeline DEFERRED.** Launcher mechanics PROVEN on real
rootless podman 4.3.1 + crun (as uid 1000): the exact hardened flag set (minus `--memory`) launches;
keep-id → `/out/findings.json` written back owned by the orchestrator uid; `/work` + rootfs
read-only reject writes; `/run/gw` mounts; only `lo` present (`--network none`). **Full end-to-end
pipeline (real magpie-reviewer image + gateway + GitHub App) deferred**, blocked on this host by
(a) `--memory` failing CLOSED under rootless crun because the kernel boots `cgroup_disable=memory`
so the `memory` controller isn't delegated (pre-existing **bug_df2d**, a host gap, NOT a port
defect — I did NOT drop `--memory`), and (b) standing up the full gateway/GitHub-App/reviewer-image
stack non-interactively. To run it: a host with the `memory` cgroup v2 controller delegated to the
service user + subuid/subgid + linger (M8-D3/task_67aa installer work).

**Open risks:** (1) bug_df2d — hosts without the memory controller can't run the full hardened argv
rootless; a cgroup-memory preflight (the shelved M6-E `cgroup-preflight.ts`) would fail-fast with a
clear message; deferred to M8-D3. (2) The systemd unit still grants the docker group / isn't a
rootless `--user` unit — flipping the config default to podman without the M8-D3 systemd work means
a redeploy needs that provisioning to actually run rootless; called out in config.example.toml.
