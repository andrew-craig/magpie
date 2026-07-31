---
id: task_4c37
title: M8-E4: micro-VM guest boots with no PATH env var — setpriv can't exec pi
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T01:23:36Z
updated_at: 2026-07-31T04:35:36Z
---

## Background

Found 2026-07-31 during a LIVE micro-VM validation run of the M8-E2/E3 fixes
(task_2541, task_76b8) on the Pi host, branch `m8-e2-e3-microvm-gaps`. Built
the reviewer image locally from that branch, exported a rootfs, set
`[microvm] rootfs_path`, and ran a scratch PR (#64, closed+deleted after)
through the resolved `microvm` tier with an orchestrator build that actually
injects `MAGPIE_MICROVM_RAM_MIB` (the live `/opt/magpie` install is a packed
release from `main` that predates that env var — a branch build was deployed
temporarily and reverted afterward).

**E3 and E2 both verified live and both PASS:**
- E3: guest `/proc/meminfo` MemTotal was **1,005,696 KiB** against a
  1,101,004 KiB bound (`ram_mib=1024` × 1.05) — comfortably inside tolerance
  (~95,308 KiB / ~93 MiB of headroom; the guest sees ~95.9% of the configured
  1024 MiB, consistent with normal kernel/firmware-reserved overhead). Log
  line: `magpie-reviewer: micro-VM memory ceiling verified -- guest MemTotal
  1005696 KiB is within the expected bound for MAGPIE_MICROVM_RAM_MIB=1024`.
- E2: `mount -t tmpfs tmpfs /tmp` succeeded as guest-root on the
  rootless-virtiofs rootfs, and the subsequent `chown -R 10001:10001
  "$HOME/.pi"` succeeded with **no EPERM** — the bug task_76b8 fixed is
  confirmed gone.

## Problem

Past both of those fixes, the job hit a **new, previously-unreachable**
failure at the very last step — `setpriv --reuid=10001 --regid=10001
--clear-groups --no-new-privs pi "$@"`:

```
setpriv: failed to execute pi: No such file or directory
```

Root-caused via direct `magpie-krun-launch` invocations against the same
rootfs (bypassing the full entrypoint): the guest's process environment has
**no `PATH` variable at all** — `printenv PATH`, `export -p | grep PATH`, and
`env | grep -i path` are all empty inside the guest. `bash` itself still
resolves bare commands (`mount`, `chown`, `setpriv`, …) because it falls back
to its own compiled-in default search path for its *own* command lookups
when `PATH` is unset in its environment — but that fallback is internal to
bash and is **not** exported to child processes. So when `setpriv` (a plain C
program) does its own `execvp("pi", …)`, it calls `getenv("PATH")`, gets
`NULL`, and falls back to the POSIX default `_PATH_DEFPATH` (`/bin:/usr/bin`
on this glibc), which does not include `/usr/local/bin` — where the `pi`
symlink (→ `/opt/magpie/review-extension/node_modules/.bin/pi` →
`.../@earendil-works/pi-coding-agent/dist/cli.js`, `#!/usr/bin/env node`)
actually lives. Confirmed directly: `/usr/bin/env node --version` inside the
guest fails with `'node': No such file or directory`, but
`/usr/local/bin/node --version` (absolute path) and `env -i
PATH=/usr/local/bin:/usr/bin:/bin node --version` (explicit PATH) both
succeed.

**Why this was never seen before:** every prior live micro-VM attempt died
earlier in the script — task_1709 hit the (then-unfixed) `require_memory_limit`
issue, then task_76b8's chown EPERM — so execution never reached the
`setpriv … pi` line until today.

**Why the crun tier never hits this:** `podman run` starts the container
using the image's own OCI config, which carries the base image's baked-in
`ENV PATH=...` (from `node:22-slim`'s own Dockerfile) automatically — no
explicit `-e PATH=...` needed. `magpie-krun-launch` boots a bare exported
rootfs directory with no equivalent image-config concept; the guest gets
**only** whatever `--env KEY=VALUE` pairs the caller passes (confirmed by
reading `rust/magpie-microvm-launcher/src/cli.rs`'s `parse()` — `env` starts
as an empty `Vec` and is populated ONLY by explicit `--env`/`--env-from-host`
flags; the `PATH=/usr/bin:/bin` value visible in `config.rs`/`cli.rs` is a
**test fixture** constant, not a runtime default). `reviewer.ts`'s
`buildMicrovmLaunchArgs` call site's `env` map currently sets only
`OPENAI_BASE_URL`, `MAGPIE_REQUIRE_MEMORY_LIMIT`, and (as of task_2541)
`MAGPIE_MICROVM_RAM_MIB` — never `PATH`. This is a **pre-existing gap**, not
a regression introduced by the E2/E3 branch; it was simply unreachable until
now.

## Fix directions (needs a decision, not obviously either/or)

- Have `docker/reviewer/entrypoint.sh` `export PATH=...` explicitly near its
  top, inside (or ahead of) the `MAGPIE_IS_MICROVM=1` branch — self-contained
  in the image, no orchestrator change needed, and it's the same script that
  already branches on tier for the memory check / tmpfs mount / privilege
  drop.
- Alternatively/also: have `reviewer.ts`'s `buildMicrovmLaunchArgs` call site
  pass `PATH` explicitly in its inline `env` map (mirrors how it already
  passes `OPENAI_BASE_URL`/`MAGPIE_REQUIRE_MEMORY_LIMIT`/
  `MAGPIE_MICROVM_RAM_MIB`), so the guest's env is fully specified by the
  orchestrator rather than assumed by the image.
- Either way, don't touch the crun tier's env handling (it works today
  precisely because it does NOT need this).

## Acceptance

- A micro-VM-tier live review (rootfs built from whatever branch fixes this)
  gets past the `setpriv … pi` exec and Pi actually starts.
- No regression to crun-tier PATH/env handling.
- Confirm end-to-end: `findings.json` written across the `/out` virtiofs, one
  `COMMENT` review posted, telemetry record written, cleanup — completing
  what M8-E2/E3's own acceptance criteria describe as "matching the crun
  tier's already-validated end-to-end behavior."

## Live validation evidence (2026-07-31)

Full ordered entrypoint log from the scratch PR #64 run (tier=microvm,
`ram_mib=1024`, branch-built image+orchestrator):

```
magpie-krun-launch: booting rootfs="/var/lib/magpie/reviewer-rootfs-e2e3" exec="/opt/magpie/entrypoint.sh" vcpus=2 ram_mib=1024 uid=993 gid=988 vsock=1234 work_mount=work out_mount=out (libkrun ABI: v1.19.4 (ABI 1))
magpie-reviewer: micro-VM memory ceiling verified -- guest MemTotal 1005696 KiB is within the expected bound for MAGPIE_MICROVM_RAM_MIB=1024
magpie-reviewer: /dev/vsock present -- starting vsock-client (127.0.0.1:4000 -> AF_VSOCK host port 1234)
magpie-reviewer: micro-VM tier -- mounting /work + /out virtiofs devices
[vsock-client] preflight vsock connect to host port 1234 OK
[vsock-client] listening on 127.0.0.1:4000 -> vsock cid=host port=1234
magpie-reviewer: micro-VM tier -- mounting guest-local tmpfs at /tmp (mirrors the crun tier's --tmpfs /tmp; see task_76b8)
magpie-reviewer: relay is up
[vsock-client] relaying connection -> vsock cid=host port=1234
[vsock-client] relaying connection -> vsock cid=host port=1234
magpie-reviewer: micro-VM egress channel confirmed -- /dev/vsock present, port 1234
magpie-reviewer: network confinement verified -- no non-lo interface, empty route table, canaries unreachable, gateway reachable only via the permitted forwarder/vsock channel
magpie-reviewer: micro-VM tier -- dropping to uid/gid 10001 (reviewer) before exec pi
setpriv: failed to execute pi: No such file or directory
```

Job telemetry recorded this as `"outcome":"error"`, container exit code 127.
Host was fully restored afterward (crun floor, 0.2.0 digest,
`require_memory_limit=true`, original `/opt/magpie`, `/healthz`
`resolvedTier=crun`/`degraded=false`) — see the "Live validation (M8-E2/E3)"
sections appended to `.chalk/tasks/closed/task_2541.md` and
`.chalk/tasks/closed/task_76b8.md` for the full restore/cleanup record.

## Plan

- [x] Fix in `docker/reviewer/entrypoint.sh`'s micro-VM branch (keeps the
      rootfs self-sufficient — a PATH entry in the orchestrator's env map
      would leave a hand-launched/manually-exported rootfs still broken).
- [x] Guard on `MAGPIE_IS_MICROVM` so the crun tier is untouched.
- [x] Regression coverage in `entrypoint-tier-memory.test.sh`.
- [x] Full suite + crun-floor golden-argv must stay green.

## Review

**Done.** One-line fix in `entrypoint.sh`, placed immediately after the M8-E3
tier detection (so anything added later inherits a sane PATH too):

```sh
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi
```

**Correction to this task's original diagnosis — the mechanism is subtler than
"the guest has no PATH", and getting it wrong produces a no-op fix.** Writing
the regression test surfaced it: when PATH is absent from its environment,
bash does *not* run without one — it assigns its own COMPILED-IN default to
the PATH **shell variable** at startup (observed on this image's bash:
`/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.`, which
already contains `/usr/local/bin`). That is why every bare command this script
runs resolved fine all along. But that variable is **not marked for export**,
so it is still absent from the environment handed to children. `setpriv`
`execvp`s `pi` itself, and glibc's execvp with no PATH in the environment
falls back to `confstr(_CS_PATH)` == `/bin:/usr/bin` — which excludes
`/usr/local/bin`, where the Dockerfile symlinks `pi`.

So the operative fix is the **`export`**, not a value default: a
`PATH="${PATH:-...}"` style default would be dead code here, since bash has
already made PATH non-empty. The first draft of this fix used exactly that
form and the new test caught it as a no-op.

Set unconditionally to an explicit literal rather than re-exporting bash's
invented value: that default is an implementation detail varying by bash
build, and a fail-closed security script should not depend on it to locate
the binary it hands control to.

**Tests:** `entrypoint-tier-memory.test.sh` 11/11 (2 new, run with PATH
genuinely absent from the environment via `env -i` + absolute-path bash — the
one condition the existing `run_case` cannot reproduce, since it injects PATH
itself). The pair is a positive (micro-VM manufactures the PATH) plus a
`refute` (crun does NOT get it, proving tier-scoping). The crun assertion
deliberately checks ABSENCE rather than pinning bash's compiled-in default,
which would make the test a hostage to the base image's bash build.
Orchestrator suite 409 passed / 4 skipped, 29 files — crun-floor golden-argv
unchanged. `bash -n` + shellcheck clean (the one SC2016 hit is an intentional
single-quoted literal appended to the generated excerpt).

**NOT yet live-validated** — needs the micro-VM run that reaches `exec pi` and
completes a review end-to-end. That run is the remaining acceptance step.

## Live validation (M8-E4 / end-to-end)

**Date:** 2026-07-31, Pi host (arm64, 16 KB pages), branch
`m8-e2-e3-microvm-gaps` @ `f267e94`. Reviewer image rebuilt locally from this
branch (rootless podman as `magpie`; the usual local-only
`FROM docker.io/library/…` qualification applied in a throwaway `git archive`
export under `/tmp`, NOT in the repo), exported to
`/var/lib/magpie/reviewer-rootfs-e4`, `[microvm] rootfs_path` pointed at it, and
a branch-built orchestrator `dist` temporarily deployed to `/opt/magpie` (needed
for `MAGPIE_MICROVM_RAM_MIB`; backed up and restored afterward). Ladder
auto-resolved `microvm` (`/healthz` `resolvedTier: "microvm"`,
`requestedTier: "crun"`, `degraded: false`) with `container.tier` left at
`"crun"` and `require_memory_limit = true` untouched. Scratch PR #65, closed +
branch deleted afterward.

### THIS TASK'S FIX: PASS — `exec pi` SUCCEEDED

This is the question the run existed to answer, and it is answered
affirmatively. Pi executed inside the guest for the first time ever:

```
[reviewer] pi run complete: turns=3 tokens(in/out/total)=8203/1738/14037 cost=$0.0136
```

Three real turns, real token usage, and real spend metered by the gateway
(`gateway.spentUsd: 0.017166906` against a `0.5` budget) — none of which is
producible unless `setpriv --reuid=10001 … pi` actually exec'd the binary. The
previous run's `setpriv: failed to execute pi: No such file or directory` is
**gone**. The `export PATH=…` one-liner works.

### E3 re-confirmed on this build — verbatim

```
magpie-reviewer: micro-VM memory ceiling verified -- guest MemTotal 1005696 KiB is within the expected bound for MAGPIE_MICROVM_RAM_MIB=1024
```

Byte-identical to the M8-E2/E3 run's measurement (`1005696` KiB against the
`1101004` KiB bound, ~93 MiB margin). The 1.05 tolerance was **not** touched.
Captured from a direct `magpie-krun-launch` reproduction against the same rootfs
with `--ram-mib 1024` and the same env, because the live job's guest stderr was
not available (see the caveat below).

### End-to-end: NOT ACHIEVED — a 5th blocker, filed as task_a749 (M8-E5)

Past `exec pi`, the job still failed:

```
"outcome":"error", "reason":"pi did not call report_findings", "durationMs":46520
```

and the posted review was the failure-note form
(https://github.com/andrew-craig/magpie/pull/65#issuecomment-5139627529):

```
<!-- magpie-review -->
## 🐦 Magpie review

Magpie could not complete a review of this PR.

Reason:
```
pi did not call report_findings
```
```

**Root cause proven empirically:** `/out` is host-owned `magpie:magpie` mode
`0700` (`createOutputDir`'s `mkdtemp` default — correct for the crun tier, whose
container process IS uid 993), but the micro-VM tier drops Pi to guest uid 10001
before exec. A direct guest probe against the same rootfs:

```
GUEST: ls -ld /out ->  drwx------ 2 993 988 4096 /out
GUEST root write test:      root write OK
GUEST uid10001 write test:  /bin/bash: /out/reviewer.txt: Permission denied
```

So `report_findings` **cannot** write `findings.json` regardless of whether Pi
called it. Full analysis + fix options in `task_a749`.

### Acceptance, item by item

- **"gets past the `setpriv … pi` exec and Pi actually starts"** — **PASS**,
  observed directly.
- **"No regression to crun-tier PATH/env handling"** — **PASS**: branch suite
  green, and after restore the host's crun floor resolves and serves normally.
- **"Confirm end-to-end: `findings.json` … one `COMMENT` review posted,
  telemetry record, cleanup"** — **NOT MET**, and not because of this fix.
  `findings.json` was never written (task_a749). A review WAS posted (failure
  note), a telemetry record WAS written (`outcome: "error"`), and
  workspace/gateway-key cleanup both ran (`workspace-cleaned`,
  `gateway-key-revoked` observed).

### Observed-vs-inferred caveats (honest scope)

- The live job's **guest entrypoint stderr was never captured**: `reviewer.ts`
  only surfaces `stderrTail` when the container exits NON-ZERO, and this run
  exited 0. So the ordered `magpie-reviewer:` log sequence for the live PR #65
  job is NOT available; the sequence and the MemTotal line above come from a
  manual `magpie-krun-launch` reproduction against the identical rootfs. What IS
  from the live job: the tier resolution, `pi run complete`, the telemetry
  record, the published comment, and the cleanup events.
- Whether Pi called `report_findings` and hit EACCES, or never called it, was
  **not separately observed** — for the same stderr reason. What is PROVEN is
  that the write could not have succeeded either way.

### Host restored (verified, not assumed)

Scratch PR #65 closed + branch deleted. `/etc/magpie/config.toml` restored from
`config.toml.bak-e4-1785472853` and `diff`'d byte-identical (no `rootfs_path`,
0.2.0 digest, `require_memory_limit = true`, `tier = "crun"`). `/opt/magpie`
orchestrator `dist` restored from `dist.bak-e4-1785472824` and `diff -r`'d
identical (69 files, `MAGPIE_MICROVM_RAM_MIB` absent), backup dir then removed.
Services `magpie`/`magpie-gateway`/`cloudflared` all active; `/healthz`
`resolvedTier: "crun"`, `degraded: false`. Local `magpie-reviewer:e4` image and
`/var/lib/magpie/reviewer-rootfs-e4` deleted.

**Cleanup misstep, corrected:** an over-broad `podman image prune -af` in the
`magpie` user's store also removed the pre-existing pinned reviewer images
(0.2.0 and the 0.3.0 leftover from M8-E1). Both were re-pulled by digest to
restore the as-found state; `operator`'s separate podman store was untouched.
Prefer targeted `podman rmi <id>` over `prune -af` on this host.
