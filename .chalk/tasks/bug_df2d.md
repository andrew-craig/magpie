---
id: bug_df2d
title: Reviewer --memory limit silently unenforced when memory cgroup is disabled
type: bug
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-19T22:42:45Z
updated_at: 2026-07-23T12:45:16Z
---

## Problem

`reviewer.ts:371` passes `--memory=${config.container.memory}` as part of the container
hardening set. On any host where the kernel memory cgroup controller is unavailable, Docker
**accepts the flag, warns on stderr, and exits 0** — the limit is silently discarded. Nothing
in the pipeline notices.

Reproduced on the dev host (Raspberry Pi 5, Raspberry Pi OS, kernel 6.12.93+rpt-rpi-2712):

```
$ docker run --rm --memory=64m alpine sh -c 'cat /sys/fs/cgroup/memory.max'
WARNING: Your kernel does not support memory limit capabilities or the cgroup is not mounted. Limitation discarded.
NO memory.max — limit not enforced

$ cat /sys/fs/cgroup/cgroup.controllers
cpuset cpu io pids            # no `memory`
```

Root cause on this class of host: the Pi 5 device tree ships `cgroup_disable=memory` in its
`bootargs`, and the firmware prepends those to `cmdline.txt`:

```
$ strings /boot/firmware/bcm2712-rpi-5-b.dtb | grep cgroup
reboot=w coherent_pool=1M 8250.nr_uarts=1 pci=pcie_bus_safe cgroup_disable=memory ...
```

Note `CONFIG_MEMCG=y` — memcg is compiled in, it is disabled at boot. Docker is already on
cgroup v2 + systemd driver, so the commonly-cited `daemon.json` cgroupdriver fix does not
apply here.

`--cpus` and `--pids-limit` are unaffected (`cpu` and `pids` controllers are present). This is
specifically the memory ceiling.

## Impact

The reviewer container runs with **no enforced memory ceiling** on affected hosts. A runaway
or adversarially-prompted Pi run can OOM the host instead of being capped at
`config.container.memory`. This contradicts the documented hardening posture in CLAUDE.md /
`reviewer.ts:14`, where the memory limit is listed as one of the confinement guarantees.

This is a self-hosting concern beyond the dev box: Pi 5 is a plausible target host for a
small self-hosted Magpie, and the failure is silent on any host that boots with the memory
controller off.

## Design point

The M7 "Design D" principle is that confinement is *structural and asserted*, not advisory.
The reviewer entrypoint already performs fail-closed confinement assertions. A hardening flag
that is silently a no-op is exactly the class of gap those assertions exist to catch.

## Plan (implementation, concrete)

CTO-decided: fail-closed by default with a config escape hatch
(`container.requireMemoryLimit`, default `true`), BOTH preflight and
in-container assertion.

Note found while starting this task: an orphaned, uncommitted build artifact
`packages/orchestrator/dist/cgroup-preflight.{js,d.ts}` already exists on disk
(no matching `.ts` source, not imported by anything, not in git) — evidently
from an earlier session that built exactly this host-side preflight (matching
`container.requireMemoryLimit` naming and design almost exactly) but never
committed the source. Reconstructing/adapting it as the starting point for
step 1 below rather than re-deriving from scratch, since it already matches
this task's naming and reasoning closely (including the "docker fails open /
podman+crun fails closed-but-cryptic" asymmetry).

- [x] `config.ts` / `config.example.toml`: add `container.require_memory_limit`
      (bool, default `true`) → `Config.container.requireMemoryLimit`.
- [x] New module `packages/orchestrator/src/cgroup-preflight.ts`: reads
      `/sys/fs/cgroup/cgroup.controllers` (root) + `/proc/self/cgroup` ->
      own-cgroup `cgroup.controllers` (delegation) via an injectable
      `ReadFileFn` test seam (mirrors `docker.ts`'s `ExecFileFn` pattern).
      Exposes `assertMemoryControllerAvailable(config, readFileFn?, warn?)`:
      throws `MemoryControllerUnavailableError` when the controller is
      unavailable and `requireMemoryLimit` is true; logs a loud warning and
      returns when `requireMemoryLimit` is false.
- [x] Wire into `index.ts`'s `main()`, right after `assertDockerAvailable`;
      catch `MemoryControllerUnavailableError` in the top-level handler
      alongside `ConfigError`/`DockerUnavailableError` for a clean (non-stack)
      error message.
- [x] Thread `config.container.requireMemoryLimit` into the review container
      itself as a new non-secret `-e MAGPIE_REQUIRE_MEMORY_LIMIT=<true|false>`
      in `reviewer.ts`'s `buildReviewDockerArgs` (same non-secret/inline
      treatment as `OPENAI_BASE_URL`) — needed so the in-container assertion
      below can also honour the same escape hatch (the container has no other
      way to see the operator's config choice).
- [x] Update the M8-B1 byte-for-byte golden fixture
      (`__fixtures__/reviewer-crun-floor-argv.golden.json`) for the new argv
      token — this is an intentional, visible posture change per that test's
      own doc comment.
- [x] `docker/reviewer/entrypoint.sh`: add a fail-closed assertion alongside
      the existing M4-E confinement checks — verify `/sys/fs/cgroup/memory.max`
      exists and is a finite value (not literally `max`, not missing). If not
      finite: exit non-zero (loud stderr message) when
      `MAGPIE_REQUIRE_MEMORY_LIMIT` is `true`/unset; otherwise print a WARNING
      to stderr and continue (so the escape hatch actually lets a stock Pi 5
      self-hoster run reviews, not just start the daemon).
- [x] Docs: note the host requirement + Pi 5 DTB `cgroup_disable=memory`
      caveat + the `require_memory_limit` escape hatch in INSTALL.md and/or
      QUICKSTART.md.
- [x] Tests: `cgroup-preflight.test.ts` (all branches: both present, root
      missing, delegation missing, unreadable files, `requireMemoryLimit`
      false → warn-and-continue), `reviewer.test.ts` addition for the new env
      var, golden fixture update, config.test.ts addition for the new option.
      Manually verify against the live host quirk described below.

## Open questions (resolved)

- Preflight-only, in-container assertion, or both? → **Both**, per CTO
  decision above. The in-container check is the stronger guarantee (observes
  actual enforced state) but a per-job failure mode; the preflight catches it
  at startup before any GitHub token is minted, which is strictly cheaper.
- Should this block startup or block per-job? → Startup preflight blocks
  startup (fail-closed default); the in-container assertion additionally
  blocks each individual job as a defence-in-depth backstop (e.g. if the
  preflight's detection was somehow wrong, or the controller is
  revoked/un-delegated after startup).

## Host verification note

This dev host currently has `cgroup_disable=memory cgroup_enable=memory` in
its kernel cmdline (both present, `cgroup_enable` after `cgroup_disable` on
the same line — the enable wins) — i.e. the memory controller is CURRENTLY
enabled here (`cat /sys/fs/cgroup/cgroup.controllers` includes `memory`,
`docker run --rm --memory=64m alpine sh -c 'cat /sys/fs/cgroup/memory.max'`
correctly prints `67108864`), unlike the state the bug report captured. The
disabled state cannot be reproduced by rebooting this shared host as part of
this task, so the preflight/in-container logic is verified by (a) unit tests
that fake the disabled state via the injectable `ReadFileFn`/env-var seams,
and (b) confirming the currently-enabled host still passes both checks
cleanly (no regression / no false positive).

## Review

Implemented on branch `bug-df2d-memory-cgroup` (worktree
`/home/operator/magpie-wt-bugdf2d`). Two independent, both-fail-closed-by-default
defences plus a single shared escape hatch.

### What changed

Config / escape hatch:
- `packages/orchestrator/src/config.ts` — new `container.require_memory_limit`
  (zod `boolean`, default `true`) → `Config.container.requireMemoryLimit`.
- `config.example.toml` — documented the new option (fail-open Docker vs.
  fail-closed-but-cryptic podman/crun asymmetry, Pi caveat, escape-hatch
  guidance) and cross-linked it from the existing `docker_bin` note.

Host-side startup preflight:
- `packages/orchestrator/src/cgroup-preflight.ts` (new) —
  `assertMemoryControllerAvailable(config, readFileFn?, warn?)`. Reads the root
  `/sys/fs/cgroup/cgroup.controllers` and (best-effort) this process's own
  cgroup controllers via `/proc/self/cgroup` to also catch the
  present-but-not-delegated case. Throws `MemoryControllerUnavailableError`
  when `memory` is unavailable and `requireMemoryLimit` is true; warns and
  continues when false. Injectable `ReadFileFn` seam (mirrors docker.ts's
  `ExecFileFn`). Adapted from a recovered, never-committed
  `dist/cgroup-preflight.js` an earlier session had built for this exact bug.
- `packages/orchestrator/src/index.ts` — wired in right after
  `assertDockerAvailable(config)`; added `MemoryControllerUnavailableError` to
  the top-level `main().catch` clean-message branch.

In-container per-job assertion (the stronger guarantee — observes actual
enforced state):
- `packages/orchestrator/src/reviewer.ts` — `buildReviewDockerArgs` now emits
  `-e MAGPIE_REQUIRE_MEMORY_LIMIT=<true|false>` (non-secret, inline, like
  `OPENAI_BASE_URL`); updated module + flow doc comments.
- `docker/reviewer/entrypoint.sh` — new fail-closed block before the M4-E
  confinement checks: reads `/sys/fs/cgroup/memory.max`; if it's `max`,
  absent, or unreadable (i.e. the `--memory` limit is NOT enforced — the
  identical in-container observable whether Docker silently discarded the
  flag or it was never passed), aborts non-zero when
  `MAGPIE_REQUIRE_MEMORY_LIMIT` != `false`, else warns and continues. Defaults
  the var to `true` (`:=`) so an absent env var can never mean "run
  unconfined".

Tests / fixtures:
- `cgroup-preflight.test.ts` (new, 7 cases): healthy, disabled-at-root
  (reproduces the bug's exact controller list), present-but-not-delegated,
  unreadable-files (cgroup v1), escape-hatch warn-and-continue,
  self-cgroup-unreadable-but-root-ok, and memory-value-in-message.
- Both byte-for-byte golden fixtures updated for the new argv token
  (`reviewer-crun-floor-argv.golden.json` — the M8-B1 floor golden — and
  `reviewer-podman-argv.golden.json`), an intentional visible posture change
  per those tests' own doc comments. `reviewer.test.ts` asserts the new
  `-e MAGPIE_REQUIRE_MEMORY_LIMIT=true` pair. `config.test.ts` asserts the new
  option's default (`true`) and a TOML override (`false`). Every other test
  file that constructs a `Config` got the new required container field.

Docs:
- `INSTALL.md` — new §6a "Host requirement: cgroup v2 memory controller" with
  the `cat /sys/fs/cgroup/cgroup.controllers` check, the Pi
  `cgroup_enable=memory cgroup_memory=1` cmdline fix + reboot, and the
  escape-hatch fallback.
- `QUICKSTART.md` — added the controller to Prerequisites with the Pi one-liner.
- `DISTRIBUTION.md` §2.5 — honest note that `--memory` is only enforced with
  the controller enabled, cross-linked to the fix.

### How verified

- `npm run --prefix packages/orchestrator build` (tsc typecheck) — clean.
- `npm test` (all 3 workspaces) — **369 pass** (orchestrator 292, gateway 66,
  review-extension 11), 0 fail. No lint/format tooling is configured in the
  repo (tsc is the typecheck).
- `bash -n docker/reviewer/entrypoint.sh` — valid syntax.
- **Host-side preflight against the REAL live host filesystem**: loaded the
  compiled module and ran `assertMemoryControllerAvailable` with the default
  `readFile` — PASSED (no false positive on this currently-enabled host).
- **In-container assertion exercised in real containers** (extracted the exact
  shell block, run in `alpine` under docker):
  - `--memory=64m`, require=true → `memory.max=67108864`, proceeds, exit 0.
  - no `--memory`, require=true → refuses, **exit 1** (this is the faithful
    reproduction — see host note).
  - no `--memory`, require=false → warns, proceeds, exit 0.

### Host-state caveat (important for the reviewer)

The bug was filed against this host in a state where only
`cgroup_disable=memory` was on the kernel cmdline. The host has since been
reconfigured: `/proc/cmdline` now carries BOTH `cgroup_disable=memory` and a
later `cgroup_enable=memory` (the later enable wins), so the memory controller
is **currently ENABLED** here —
`docker run --rm --memory=64m alpine cat /sys/fs/cgroup/memory.max` prints
`67108864`, and `/sys/fs/cgroup/cgroup.controllers` includes `memory`. I could
NOT reproduce the literal "WARNING: ... Limitation discarded" silent-discard,
because the discard only happens when the controller is off, and I can't
reboot this shared host. I verified the fix instead against the identical
in-container observable that the silent discard produces: a `--memory` flag
that yields `memory.max = max` inside the container. Omitting `--memory` gives
exactly that state, and the in-container assertion fires (exit 1) as designed;
the disabled-at-root path is covered by the preflight unit test that feeds the
bug's exact controller list. If a reviewer wants the literal warning
reproduced, it requires booting a host with `cgroup_disable=memory` and no
`cgroup_enable=memory`.

### Open questions / trade-offs for the tech lead

1. **cgroup namespace assumption (in-container check).** The entrypoint reads
   `/sys/fs/cgroup/memory.max` expecting the container's OWN cgroup (true under
   docker/podman's default `cgroupns=private` on cgroup v2, which is what
   Magpie uses). If someone runs the image with `--cgroupns=host`, that path is
   the host root's `memory.max` (`max`), which would false-positive into a
   fail-closed refusal. Magpie never passes `--cgroupns=host`, so this is only
   a concern for hand-run images; noted rather than guarded.
2. **`dist/` artifact.** The recovered `packages/orchestrator/dist/` is
   gitignored and NOT committed; the new source is the source of truth. No
   action needed, flagging for awareness.
3. **Docs placement.** Put the operator-facing detail in INSTALL.md §6a +
   QUICKSTART Prerequisites + a short DISTRIBUTION.md note. If you'd rather the
   canonical spot be a DISTRIBUTION.md platform matrix, easy to move.
4. **Not committed to `main` / no PR** (CTO-gated, per instructions). Branch
   `bug-df2d-memory-cgroup` holds two commits (plan, then implementation);
   left `in_progress` for tech-lead review.
