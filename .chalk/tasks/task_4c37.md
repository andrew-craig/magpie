---
id: task_4c37
title: M8-E4: micro-VM guest boots with no PATH env var — setpriv can't exec pi
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T01:23:36Z
updated_at: 2026-07-31T01:23:36Z
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
