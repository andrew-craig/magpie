---
id: task_a749
title: M8-E5: micro-VM /out virtiofs is unwritable by the post-setpriv reviewer uid (10001) — findings.json never lands
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T05:39:43Z
updated_at: 2026-07-31T09:48:01Z
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

## Plan

- [x] `reviewer.ts`: bind the host uid/gid ONCE and pass them to both tiers;
      add `MAGPIE_MICROVM_REVIEWER_UID`/`_GID` to the micro-VM inline `env` map.
- [x] `entrypoint.sh`: drop to those ids instead of the baked 10001, with the
      `chown -R` of `$HOME/.pi` targeting the same ids.
- [x] Fail closed on unset / non-numeric / zero; never fall back to 10001.
- [x] Refresh the now-stale comments in `entrypoint.sh` + `Dockerfile`.
- [x] Tests: micro-VM argv (builder + real `runReview` call site), entrypoint
      fail-closed cases, crun untouched.

## Review

**Done — the identity is aligned rather than the permissions widened.**

`reviewer.ts` now binds `hostUid`/`hostGid` once (right after the existing
POSIX `process.getuid` guard) and feeds BOTH tiers from them: crun's
`--user <uid>:<gid>`, and the micro-VM tier's `--uid`/`--gid` **and** the two
new inline env vars. That makes "the guest drops to the same uid the host runs
as" structural instead of a coincidence of two call sites happening to call the
same function — which is precisely how the two drifted apart in the first place.

`entrypoint.sh`'s micro-VM branch reads `MAGPIE_MICROVM_REVIEWER_UID`/`_GID`
and fails closed on unset / non-numeric (`case` glob, matching the existing
`MAGPIE_MICROVM_RAM_MIB` style) and, separately and loudly, on **zero** — uid 0
would mean running Pi, the thing that processes untrusted PR content, as
guest-root, discarding the whole point of the block. It never falls back to
10001; that fallback is now known-broken for `/out`, and taking it silently
would resurrect exactly this bug.

**Both rejected alternatives, and why.** Widening `/out`'s mode loosens a host
directory's permissions to paper over an identity mismatch. A guest-side
`chown /out` is the same rootless-virtiofs chown that already produced M8-E2's
EPERM (guest-root's uid is remapped back to the unprivileged host user for
virtiofs ownership). Aligning the identity removes the mismatch instead of
masking it.

**Posture preserved and unified:** still a drop from guest-root to an
unprivileged non-root uid before Pi runs — the same drop, now to the same uid
the crun tier has always used. The two tiers' reviewer identity is identical
rather than divergent. No passwd entry exists in the guest for that uid and
none is needed: `setpriv` takes numeric ids and `HOME` is force-set to `/tmp`
above rather than resolved via `getpwuid` (checked — nothing in the script or
Pi's startup path does a `getpwuid` lookup).

The baked `reviewer` account (uid 10001) stays in the image as its own non-root
default for anyone running the image directly; the stale comments in
`entrypoint.sh` and the `Dockerfile` that claimed the entrypoint drops to it
were corrected.

**Tests:**
- `reviewer.test.ts` — a new `runReview`-level micro-VM assertion (the REAL
  call site, since the bug was in what the call site passed) that
  `MAGPIE_MICROVM_REVIEWER_UID`/`_GID` EQUAL the `--uid`/`--gid` flags and the
  actual `process.getuid()`. Written as an equality against the flags rather
  than a hardcoded number, so the invariant pinned is "guest reviewer identity
  == host identity == virtiofs owner" on whatever uid the tests run as.
- `reviewer-microvm-argv.test.ts` — golden array + a targeted pin.
- `entrypoint-tier-memory.test.sh` — **9 new cases** (11 → 20 total). The
  existing excerpt is truncated at the M4-E confinement banner, ~400 lines
  above the privilege-drop block, so that block was genuinely unreachable from
  it and extending the truncation is not viable (everything between needs real
  network/vsock/virtiofs state). Rather than reimplement it, a SECOND excerpt
  slices the real block out of `entrypoint.sh` by marker and runs it standalone
  with `chown`/`setpriv` stubs shadowed first on PATH — so the real
  `chown -R "${UID}:${GID}"` and the real `exec setpriv --reuid=… pi` lines run
  character-for-character and just report their arguments. Cases: valid ids
  drop to exactly those ids; chown targets the same ids; uid/gid
  unset/non-numeric/zero each fail closed; crun tier skips the block entirely.

Orchestrator suite **415 passed / 4 skipped, 29 files**; gateway 75;
review-extension 11. `reviewer-crun-floor-argv.test.ts` **byte-for-byte
unchanged** (`git diff --exit-code` clean) — crun is untouched by this change.
`bash -n` clean; shellcheck clean apart from the one pre-existing, already
documented SC2016 (an intentional single-quoted literal), with the three new
literals explicitly annotated.

## Live validation — PASSED (2026-07-31)

Pi host, branch `m8-e2-e3-microvm-gaps`. Reviewer image built locally from the
branch, rootfs exported, branch-built orchestrator deployed, `[microvm]
rootfs_path` set, `require_memory_limit = true` untouched, `container.tier`
left at `"crun"` (the ladder auto-resolved `microvm` — `/healthz`
`resolvedTier: "microvm"`, `degraded: false`). Scratch PR #66, closed + branch
deleted afterward.

### THIS TASK'S FIX — proven directly before any review was run

A guest probe against the exported rootfs, with `/out` created exactly the way
`createOutputDir` creates it:

```
GUEST /out:  drwx------ 2 993 988 4096 /out
old baked uid 10001 write:  /bin/bash: /out/old.txt: Permission denied
new host uid 993 write:     993 WROTE findings.json
```

and read back on the HOST side of the same virtiofs:

```
-rw-r--r-- 1 993 988    9 findings.json
{"ok":1}
```

The exact write that was impossible before now round-trips. The live run then
logged the drop itself:

```
magpie-reviewer: micro-VM tier -- dropping to uid/gid 993:988 (the orchestrator's own unprivileged uid, matching the crun tier's --user and the /out virtiofs owner) before exec pi
```

### END TO END — the acceptance criterion, MET

`outcome: "success"`, 23.0s, $0.0037 gateway-metered. The published review is a
real `COMMENT` review with a real, correct, diff-anchored inline finding — not a
failure note:

> **Important** (correctness)
>
> `max()` initializes `best = 0`, so for a list of all-negative values it
> returns 0 (which is not an element of the list) instead of the true maximum.
> For an empty list it also returns 0 despite the JSDoc claiming to return the
> largest value in a list.

(`scripts/scratch-e5-stats.mjs:36`, review `4827358907`, state `COMMENTED`.)
`findings.json` was therefore written across the `/out` virtiofs and read back
by the orchestrator — that is the only way those findings could reach the
publisher. `workspace-cleaned` and `gateway-key-revoked` both observed.

### One more blocker was found and fixed on the way

The first run at this tier got Pi to actually CALL `report_findings` and still
failed, because `MAGPIE_FINDINGS_PATH` — a Dockerfile `ENV` — is absent in a
bare-rootfs guest, so the extension wrote to the read-only `/work` instead.
Filed and fixed as **task_80a4 (M8-E7)**, in a separate commit. It was only
diagnosable because task_e5c4 (M8-E6) had just started surfacing guest stderr.

### Host restored (verified against backups)

Config restored from `config.toml.bak-e5-1785489924`, `diff` byte-identical (no
`rootfs_path`, 0.2.0 digest, `require_memory_limit = true`, `tier = "crun"`).
Orchestrator `dist` restored from `dist.bak-e5-1785489924` (69 files, all three
branch markers absent), `.bak` removed. Services active; `/healthz`
`resolvedTier: "crun"`, `degraded: false`. Local images removed with targeted
`podman rmi` (never `prune -af`, per the M8-E4 lesson); image store verified
identical to as-found with both pinned production digests (`e6a6e118`,
`ed1985aa`) intact. Disk 67%/19G before and after.
