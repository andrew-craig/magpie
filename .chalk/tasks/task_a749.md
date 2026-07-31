---
id: task_a749
title: M8-E5: micro-VM /out virtiofs is unwritable by the post-setpriv reviewer uid (10001) — findings.json never lands
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T05:39:43Z
updated_at: 2026-07-31T05:39:43Z
---

## Background

Found 2026-07-31 during the LIVE micro-VM end-to-end validation of the M8-E4
PATH fix (`task_4c37`) on the Pi host, branch `m8-e2-e3-microvm-gaps` @
`f267e94`. Reviewer image built locally from the branch, exported to
`/var/lib/magpie/reviewer-rootfs-e4`, `[microvm] rootfs_path` pointed at it,
branch-built orchestrator `dist` temporarily deployed, ladder auto-resolved
`microvm` (`/healthz` `resolvedTier: "microvm"`, `degraded: false`),
`require_memory_limit = true` throughout. Scratch PR #65, closed + branch
deleted afterward.

**M8-E4 is CONFIRMED FIXED.** `exec pi` succeeded — Pi actually ran inside the
guest for the first time ever:

```
[reviewer] pi run complete: turns=3 tokens(in/out/total)=8203/1738/14037 cost=$0.0136
```

Three real turns, real token usage, real spend metered by the gateway
(`spentUsd: 0.017166906`) — impossible unless `setpriv … pi` exec'd. The
`setpriv: failed to execute pi: No such file or directory` of the previous run
is gone.

## Problem

The job still did not complete. Telemetry:

```
"outcome":"error", "reason":"pi did not call report_findings", "durationMs":46520
```

and the published review was the failure-note form, not real findings.

**Root cause, proven empirically (not inferred): the `/out` virtiofs the guest
mounts is host-owned `magpie:magpie` mode `0700`, but Pi runs as guest uid
10001 after the M8-C3 privilege drop — so Pi cannot write `/out/findings.json`
at all.**

`container-mounts.ts`'s `createOutputDir` uses `mkdtemp`, whose default mode is
`0700`, owned by the orchestrator's uid (993/`magpie`). That is correct and
sufficient for the **crun tier**, where `podman run --user <hostuid>:<hostgid>`
runs the whole container — Pi included — as uid 993, the dir's owner (that
module's own doc comment says exactly this: *"the container process runs as the
orchestrator's own uid … so no extra chmod/chown is needed beyond `mkdtemp`'s
default `0o700`"*).

The **micro-VM tier breaks that assumption.** `--uid/--gid` only confine the
HOST-side VMM process (`krun_setuid`/`krun_setgid`); the guest boots as root,
and `entrypoint.sh`'s micro-VM branch then does
`exec setpriv --reuid=10001 --regid=10001 … pi`. So the uid that actually
writes findings is 10001, not 993 — and 10001 has no access to a `0700`
directory owned by 993.

### Direct reproduction (observed, guest probe against the same rootfs)

Booted `magpie-krun-launch` with an `--out-mount` created exactly the way
`createOutputDir` creates it, mounted the `out` virtiofs, and tried both uids:

```
HOST outdir: /var/lib/magpie/work/magpie-out-vd79gp
drwx------ 2 magpie magpie 4096 Jul 31 15:34 /var/lib/magpie/work/magpie-out-vd79gp
magpie-krun-launch: booting rootfs="/var/lib/magpie/reviewer-rootfs-e4" ... out_mount=out
GUEST: id=0:0
GUEST: ls -ld /out ->
drwx------ 2 993 988 4096 Jul 31 05:34 /out
GUEST root write test:
  root write OK
GUEST uid10001 write test:
/bin/bash: line 1: /out/reviewer.txt: Permission denied
  uid10001 write FAILED
```

Guest-root writes fine (CAP_DAC_OVERRIDE); uid 10001 — the uid Pi runs as —
gets EACCES. Note virtiofs presents the host owner numerically (993:988) rather
than squashing it, so this is a plain DAC denial, not a mapping quirk.

**Scope note (honest):** what is PROVEN is that `report_findings` *cannot*
succeed at writing `/out/findings.json` under the shipped configuration. Whether
Pi in the failing run called the tool and hit EACCES, or never called it, was
not separately observed — the orchestrator only surfaces guest stderr when the
container exits non-zero, and this run exited 0. Either way the write path is
provably blocked, so this must be fixed before the tier can complete a review.

## Fix directions

Needs a decision; several plausible options, all micro-VM-only:

- Have `createOutputDir` (or a micro-VM-tier-specific wrapper) widen the out
  dir's mode — e.g. `0777`/`0770` — so the guest's reviewer uid can write.
  Simplest, but loosens a host-side directory's permissions and needs thought
  about what else on the host could then write there (it lives under
  `/var/lib/magpie/work`, mode `0750`, owned by `magpie`, so exposure is
  limited to the `magpie` user's own tree — worth stating explicitly rather
  than assuming).
- Have `entrypoint.sh`'s micro-VM branch `chown 10001:10001 /out` as guest-root
  before the drop. **Likely does NOT work** — this is the same rootless-virtiofs
  chown limitation M8-E2/`task_76b8` hit on `/tmp` (guest-root's uid is remapped
  back to the unprivileged host user for virtiofs ownership purposes). Needs an
  empirical check before being chosen.
- Drop to the HOST uid (993) instead of the baked-in 10001 in the micro-VM
  branch, mirroring the crun tier's `--user <hostuid>` exactly. Makes the two
  tiers' uid posture identical and needs no permission change at all, but the
  guest would then run Pi as a uid that means something on the host (though the
  guest is a separate kernel/VM, so the host-uid collision is far weaker than it
  would be under crun).
- Have the guest write findings to a guest-local path and have the entrypoint
  (still guest-root, post-Pi) copy it onto `/out` — needs the entrypoint to
  outlive Pi, i.e. gives up the current `exec` and its direct-signal property.

Do NOT touch the crun tier's `/out` handling — it works today precisely because
its container process IS the dir's owner.

## Acceptance

- A micro-VM-tier live review writes `findings.json` across the `/out` virtiofs
  and the orchestrator reads it back.
- One real `COMMENT` review posted with actual inline findings (not the failure
  note); telemetry `outcome` is a success outcome.
- No regression to the crun tier's `/out` handling or to
  `reviewer-crun-floor-argv.test.ts`.
- No weakening of the micro-VM tier's confinement posture (in particular, Pi
  must still not run as guest-root).
