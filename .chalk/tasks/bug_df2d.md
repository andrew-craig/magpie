---
id: bug_df2d
title: Reviewer --memory limit silently unenforced when memory cgroup is disabled
type: bug
status: open
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-19T22:42:45Z
updated_at: 2026-07-19T22:42:45Z
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

## Plan

- [ ] Add a startup preflight in the orchestrator: query `docker info` (or read
      `/sys/fs/cgroup/cgroup.controllers`) for the `memory` controller; refuse to start, or
      log a loud structured warning, when `config.container.memory` is set but unenforceable
- [ ] Decide fail-closed vs. warn-and-continue — fail-closed matches the M7 posture, but
      would hard-block Magpie on a stock Pi 5, so it likely needs a config escape hatch
      (`container.requireMemoryLimit = true` default?)
- [ ] Add a fail-closed assertion in `docker/reviewer/` entrypoint alongside the existing
      confinement checks (verify `memory.max` is finite inside the container)
- [ ] Document the host requirement + the Pi 5 DTB caveat in INSTALL.md / QUICKSTART.md
- [ ] Test on a host with the controller both present and absent

## Open questions

- Preflight-only, in-container assertion, or both? In-container is the stronger guarantee
  (it observes the actual enforced state) but fails later in the job lifecycle.
- Should this block startup or block per-job? Per-job costs a GitHub token mint before
  failing.

## Review

(to be completed)
