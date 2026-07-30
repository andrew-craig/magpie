---
id: task_76b8
title: M8-E2: micro-VM privilege-drop fails EPERM chown on rootless-virtiofs rootfs
type: task
status: open
priority: 1
labels: []
blocked_by: [task_1709]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-30T02:02:35Z
updated_at: 2026-07-30T02:03:41Z
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
