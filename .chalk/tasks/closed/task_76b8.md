---
id: task_76b8
title: M8-E2: micro-VM privilege-drop fails EPERM chown on rootless-virtiofs rootfs
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-30T02:02:35Z
updated_at: 2026-07-30T23:17:15Z
---

## Background

Found during a full reinstall + live validation of `main` on the Pi host
(2026-07-30, see memory `magpie-m8-reinstall-validation`). This is blocker
#3 of 3 for the micro-VM tier — reached only after building a current image
(task_1709) and setting `require_memory_limit=false` (task_2541). This is
the **structural** blocker; it needs a real fix, not a config flag.

## Problem

`docker/reviewer/entrypoint.sh`'s micro-VM privilege-drop step
(`MAGPIE_IS_MICROVM=1` branch, "dropping to uid/gid 10001 (reviewer) before
exec pi") chowns runtime state under `/tmp/.pi` (created by `pi` itself, not
present in the image layer) from guest-root to uid 10001. That chown fails:

```
magpie-reviewer: micro-VM tier -- dropping to uid/gid 10001 (reviewer) before exec pi
chown: changing ownership of '/tmp/.pi/agent/models.json': Operation not permitted
chown: changing ownership of '/tmp/.pi/agent': Operation not permitted
chown: changing ownership of '/tmp/.pi': Operation not permitted
```

Root cause: the guest rootfs is served over **rootless virtiofs**
(`magpie-krun-launch`'s `--work-mount`/`--out-mount`, and implicitly the root
device itself). Guest-root's uid is mapped back to the unprivileged host
`magpie` user by the rootless krun setup, so guest-root does not actually
have chown authority inside virtiofs-backed paths the way it would on a
normal (non-virtiofs) filesystem. This is a known category of rootless-VMM
limitation, not a Magpie logic bug — but Magpie's entrypoint assumes chown
"just works" for root.

Confirmed via: `docker run --user 0 magpie-reviewer:m8-local stat /tmp/.pi`
— path doesn't exist in the image; it's created fresh at guest boot on
whatever filesystem `/tmp` resolves to in the guest, which is why this only
surfaces under the micro-VM tier and never under crun (real cgroup-backed
container filesystem, no virtiofs uid remapping).

## Fix directions (needs design, not obvious which is right)

- Make `/tmp` (or specifically `/tmp/.pi`) a guest-local tmpfs instead of
  living on the virtiofs-backed root, so it's a normal in-guest filesystem
  chown works on. Check whether `magpie-krun-launch` needs a new mount-tag
  option or whether the guest's own init/entrypoint can `mount -t tmpfs`
  before the privilege drop.
- Alternatively, avoid the chown entirely: launch `pi` directly as uid 10001
  from the start (rather than root-then-drop) if nothing before it genuinely
  needs guest-root, so there's no `/tmp/.pi` ownership mismatch to fix.
- Whatever fix lands, it must not weaken the crun tier's privilege-drop
  behavior — mirror the `MAGPIE_IS_MICROVM` branching already used for the
  network-confinement checks.

## Acceptance

- A micro-VM-tier live review (with a current image, task_1709, and correct
  memory-ceiling handling, task_2541) completes and posts a review, matching
  the crun tier's already-validated end-to-end behavior.
- No regression to the crun tier's privilege-drop or to the byte-for-byte
  crun-floor golden-argv test.

## Plan (m8-e2-e3-microvm-gaps branch)

- [x] Do task_2541 (E3) first — it moves `MAGPIE_IS_MICROVM` tier detection
      earlier in `entrypoint.sh`, which this fix's ordering reasoning also
      depends on.
- [x] Preferred fix direction #1: mount a guest-local tmpfs at `/tmp` inside
      the existing `MAGPIE_IS_MICROVM=1` virtiofs-mount block, early — before
      `$HOME/.pi/agent/models.json` is written and before the chown/
      privilege-drop, both much further down the script.
- [x] Fail-closed handling for the new mount, matching the existing /work,
      /out mount error style.
- [x] Confirm no ordering hazard: nothing between the virtiofs-mount block
      and the chown writes under `/tmp` before the tmpfs is mounted.
- [x] Leave the crun tier's privilege-drop and golden-argv test untouched
      (this whole fix lives inside `if [ "${MAGPIE_IS_MICROVM}" = "1" ]`
      blocks).
- [x] Add a comment on the chown/setpriv block itself explaining why the
      chown now succeeds (tmpfs, not virtiofs).
- [x] Verify: `bash -n` + `shellcheck` on entrypoint.sh; full orchestrator
      test suite (unaffected — this fix is entrypoint.sh-only, no
      orchestrator-side change was needed for E2).

## Review

Implemented on branch `m8-e2-e3-microvm-gaps`, alongside task_2541 (E3, done
first per its own instruction since E2's ordering commentary references the
already-relocated `MAGPIE_IS_MICROVM` detection).

**Approach used:** the preferred tmpfs approach (fix direction #1), not the
uid-10001-from-the-start alternative. It worked cleanly with no obstacles —
no reason to deviate.

**Files changed:**
- `docker/reviewer/entrypoint.sh` — in the existing `MAGPIE_IS_MICROVM=1`
  virtiofs-mount block (after mounting `/work` and `/out`), added
  `mkdir -p /tmp && mount -t tmpfs tmpfs /tmp`, fail-closed on mount failure
  (same error-message style as the /work,/out mounts above it). This runs
  well before `$HOME/.pi/agent/models.json` is written (`HOME=/tmp` is set
  later, and models.json is written after that) and before the
  chown/privilege-drop step, so `/tmp` is a fresh, empty, normal guest-local
  filesystem by the time either happens — chown-by-guest-root on it now
  behaves exactly like it does under the crun tier's own `--tmpfs /tmp`,
  instead of hitting the rootless-virtiofs uid-remap EPERM. Also added a
  comment on the chown/setpriv block itself cross-referencing why the chown
  now succeeds.
- No orchestrator (TypeScript) changes were needed for this task — the fix
  is entirely inside entrypoint.sh's micro-VM branch.

**Verified statically:** `bash -n` + `shellcheck` clean on the modified
entrypoint.sh; full orchestrator vitest suite green (409 passed/4 skipped,
unaffected by this task since it touches no TS). No shell test targets this
specific mount directly (it needs an actual virtiofs-vs-tmpfs distinction to
observe the EPERM-vs-success difference, which requires real mount
namespaces this sandbox doesn't have) — covered instead by careful reading
and the ordering argument above.

**Still needs a live micro-VM run on the Pi host to confirm:**
- That `mount -t tmpfs tmpfs /tmp` actually succeeds inside a real libkrun
  guest at this point in boot (guest-root's mount capability inside a
  rootless-virtiofs-backed root wasn't verified live here — no KVM in this
  environment).
- That the subsequent `chown -R 10001:10001 "$HOME/.pi"` and
  `setpriv --reuid=10001 ... pi` succeed against the new tmpfs (the actual
  EPERM this task fixes).
- End-to-end: a micro-VM-tier review completes and posts a review, matching
  the crun tier's already-validated behavior (this task's stated
  acceptance criterion).
