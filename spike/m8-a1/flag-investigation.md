# M8-A1 follow-up: are we driving krun with the wrong arguments?

Investigates whether the three "silently ignored" `podman run` flags (`--user`, `--cpus`,
`--memory`) and the "`--network none` leaves a live TSI interface" observation from the
`task_1fdc` spike are actually the wrong lever for a VMM, and whether a correct lever exists.

Methodology: read `crun/src/libcrun/handlers/krun.c` (the OCI→libkrun bridge) and
`libkrun/src/libkrun/src/lib.rs` + `libkrun/src/init_blob/init/init.c` (the guest-side
consumer), then verified every claim by running the real `magpie-reviewer` image with
`podman --runtime /usr/local/bin/krun` on this host. Every command and its literal output is
below; no result is asserted without a paired run.

Host: `sg kvm -c "podman run --rm --runtime /usr/local/bin/krun --device /dev/kvm
--group-add keep-groups --network none ... "` against
`ghcr.io/andrew-craig/magpie/reviewer@sha256:e6a6e118ce46392dffaf172afa35af2ff6c8ff375d37dd403e9d6ac77c1f3aed`.

---

## 1. `--cpus`

**Correct mechanism:** OCI annotation `krun.cpus` (or a `krun_vm.json` sidecar; annotations
take precedence). Source: `krun.c:262-270`, `libkrun_configure_vm()`:

```c
cpus = libkrun_parse_resource_configuration (kconf->config_tree, container, "krun.cpus", "cpus");
if (cpus <= 0)
  {
    CPU_ZERO (&set);
    if (sched_getaffinity (getpid (), sizeof (set), &set) == 0)
      cpus = MIN (CPU_COUNT (&set), LIBKRUN_MAX_VCPUS);   /* LIBKRUN_MAX_VCPUS = 16 */
    else
      cpus = 1;
  }
```

`podman --cpus=N` writes a **quota/period** into `cpu.max`; it never touches process affinity.
The krun handler doesn't read `cpu.max` at all — its fallback path calls `sched_getaffinity()`
on crun's own process, i.e. it inherits whatever CPU **affinity mask** (cpuset, not quota) the
host process has. That's why `--cpus=2` was silently ignored and the guest saw all 4 cores:
the flag changed a value (`cpu.max`) that this code path never reads.

**Working on this host: YES.**

```
$ podman run --rm --runtime /usr/local/bin/krun --device /dev/kvm --group-add keep-groups \
    --network none --annotation krun.cpus=2 --entrypoint /bin/sh $IMG -c 'nproc'
2
```

vs. the flag, confirmed still a no-op:
```
$ podman run ... --cpus=2 --entrypoint /bin/sh $IMG -c 'nproc'
4
```

**Classification:** podman-integration gap (podman's `--cpus` maps to the wrong cgroup
knob for this handler), not a libkrun limitation — `krun.cpus` is a documented, working lever.
`config.container.cpus` in the C-phase should render `--annotation krun.cpus=<n>` instead of
(or in addition to, harmlessly) `--cpus`.

---

## 2. `--memory` / guest RAM

**Correct mechanism, in precedence order (`krun.c:272-280`):**
1. OCI annotation `krun.ram_mib` (or `krun_vm.json` `ram_mib`).
2. Else, if the OCI spec has `linux.resources.memory.limit` set (`limit_present`), guest RAM
   = `limit / (1024*1024)`.
3. Else `LIBKRUN_DEFAULT_RAM_MIB` = 1024 MiB. Minimum viable is `LIBKRUN_MINIMUM_RAM_MIB` = 128;
   the annotation/`ram_mib` path is only honoured if it's **above** 128, otherwise falls through
   to (2)/(3).

```c
ram_mib = libkrun_parse_resource_configuration (kconf->config_tree, container, "krun.ram_mib", "ram_mib");
if (ram_mib <= LIBKRUN_MINIMUM_RAM_MIB)
  {
    if (def && def->linux && def->linux->resources && def->linux->resources->memory
        && def->linux->resources->memory->limit_present)
      ram_mib = def->linux->resources->memory->limit / (1024 * 1024);
    else
      ram_mib = LIBKRUN_DEFAULT_RAM_MIB;
  }
```

Path (2) is real and does read the standard OCI cgroup-memory field — but podman only
populates `linux.resources.memory.limit` in the spec it hands to crun *as part of turning
`--memory` into a live cgroup write*, and on this host that write fails before the handler ever
runs (`cgroup_disable=memory` in `/proc/cmdline` → no `memory.max` file exists → **podman/crun
fails closed, refusing to start the container at all**, error and repro below). So path (2) is
unreachable here specifically because of the host constraint recorded in `bug_df2d` — not
because krun ignores it in general. On a host with a working memory cgroup, `--memory` would
likely work as a side effect of (2), for the same reason it always failed to be **VMM RAM
sizing** conceptually (it's still going through the cgroup, krun just also happens to read that
field back out).

Path (1), the annotation, never touches cgroups at all and is fully independent of host cgroup
availability.

**Working on this host: YES, via the annotation. Confirmed the `--memory` flag independently
hard-errors, with or without the annotation also present** (podman applies cgroup resources
before invoking the handler, unconditionally):

```
$ podman run ... --annotation krun.ram_mib=2048 --entrypoint /bin/sh $IMG -c 'grep MemTotal /proc/meminfo'
MemTotal:        2033100 kB      # ~2048 MiB, as requested

$ podman run ... --memory=512m --entrypoint /bin/sh $IMG -c 'grep MemTotal /proc/meminfo'
Error: /usr/local/bin/krun: open `memory.max` for writing: No such file or directory: OCI runtime attempted to invoke a command that was not found

$ podman run ... --memory=512m --annotation krun.ram_mib=2048 --entrypoint /bin/sh $IMG -c 'grep MemTotal /proc/meminfo'
Error: /usr/local/bin/krun: open `memory.max` for writing: No such file or directory: OCI runtime attempted to invoke a command that was not found
  # confirms --memory's cgroup write is unconditional and independent of the annotation

$ podman run ... --annotation krun.ram_mib=64 --entrypoint /bin/sh $IMG -c 'grep MemTotal /proc/meminfo'
MemTotal:        1005532 kB       # 64 <= LIBKRUN_MINIMUM_RAM_MIB(128) -> falls through to
                                   # the 1024 MiB default, exactly per the source's <= check
```

**Answer to "can guest RAM be set at all without a working host memory cgroup?": YES.** The
annotation path is completely decoupled from cgroups — this is the one place where the spike's
"stuck at libkrun's default" concern is resolved: don't pass `--memory` at all, pass
`--annotation krun.ram_mib=<n>` instead, and the cgroup-disabled host is a non-issue.

**Classification:** podman-integration gap, cleanly solved by a different lever.
`config.container.memory` should render `--annotation krun.ram_mib=<n>` and should **not**
also pass `--memory` (which is at best redundant and at worst fatal on cgroup-limited hosts).

---

## 3. `--user`

**Correct mechanism: there isn't one — this is a genuine, source-confirmed libkrun limitation,
not a podman flag/annotation problem.**

Two separate things are true simultaneously, and conflating them is what made the spike's
result look like "ignored" when it's more precise than that:

**(a) `--user` DOES take effect on the host-side hypervisor process.** `process.user` (the OCI
field `--user` populates) is applied by crun's generic `container_init_setup()` /
`apply_security_settings()` path (`container.c:1446-1451`, `container.c:1287`
`libcrun_set_caps(..., container->container_uid, container->container_gid, ...)`, which
internally calls `setresuid`/`setresgid`, `linux.c:4268`/`5701`). Critically, **this code runs
before the custom-handler dispatch** (`container.c:1674` `if (entrypoint_args->custom_handler)`
comes *after* `apply_security_settings()`), so it is not skipped for krun — it applies
uniformly to every OCI runtime invocation, handler or not. Verified empirically: with
`--user 1000:1000` under rootless podman (which always runs in a user namespace), the actual
host-visible hypervisor process is not root:

```
$ podman run -d --rm --name m8a1-usertest --runtime /usr/local/bin/krun --device /dev/kvm \
    --group-add keep-groups --network none --user 1000:1000 --entrypoint /bin/sh $IMG -c 'sleep 20'
$ ps -eo pid,uid,user,cmd | grep krun
1185338 100999 100999  [libcrun:krun] /bin/sh -c sleep 20
```
`100999` is the rootless-userns-mapped host uid for in-namespace uid 1000 (operator's
`/etc/subuid` delegation starts at 100000, so container-uid 1000 → host-uid 100999) — i.e. the
VMM/hypervisor process is confirmed non-root on the host, exactly as `--user` requested.

**(b) The GUEST's own process always runs as root, and there is no lever to change that in
libkrun v1.19.4.** The guest is a fully independent kernel + init (`libkrun/src/init_blob/init/init.c`,
1578 lines), booted fresh by the VMM. crun dumps the *entire* OCI `config.json` verbatim into
the rootfs as `.krun_config.json` (`krun.c:64,672-698`, comment at `krun.c:61-64`: "crun dumps
the container configuration into this file... which will be read by libkrun to set up the
environment for the workload"). But the guest init's parser
(`config_parse_file()`, `init.c:863-979`) only looks for four keys anywhere in that JSON:
`Env`/`env`, `args`/`Cmd`, `WorkingDir`/`Cwd`, `Entrypoint` (case-insensitive match via
`jsoneq()`, `init.c:824-831`). **`user`/`uid`/`gid` is never referenced anywhere in
`init.c`** (confirmed by exhaustive grep — the one `uid` hit in the whole file is an unrelated
TEE secrets path comment). There is also no `krun_setuid`/`krun_setgid`-equivalent OCI
annotation in `krun.c` (the only annotations the handler reads at all, confirmed by grepping
every `find_annotation`/`libkrun_parse_resource_configuration` call site, are `krun.variant`,
`krun.cpus`, `krun.ram_mib`, `krun.gpu_flags`, `krun.nested_virt`, `krun.use_passt` — no
user/uid annotation exists). Note: libkrun's public API *does* expose `krun_setuid`/
`krun_setgid` (`libkrun/src/libkrun/src/lib.rs:2299-2318`), but those set `vmm_uid`/`vmm_gid` —
the **hypervisor process's own** uid (same thing `--user` already achieves per (a)), applied via
plain `libc::setuid()` on the host side (`lib.rs:2995-3003`) — not the guest's. crun's krun
handler never calls these symbols, and even if it did, they wouldn't address guest identity.

**Working on this host: NO — confirmed unfixable with any current flag, annotation, or env var.**

```
$ podman run ... --user 1000:1000 --entrypoint /bin/sh $IMG -c 'id'
uid=0(root) gid=0(root) groups=0(root)
```

**Classification: genuine libkrun/guest-init limitation**, not a podman-integration gap and not
a host constraint. The blast radius is real but bounded differently than the spike's initial
framing suggested: it's not "our `--user` flag is being dropped somewhere," it's "the host-side
privilege drop happens exactly as configured (VMM runs unprivileged, mapped uid), and
*separately*, the guest kernel's own root filesystem is always entered as guest-root because the
shipped guest init has no user-switching code at all." Fixing this for real would mean shipping
a replacement guest init (or an in-image entrypoint shim that does `exec su-exec 1000:1000 ...`
itself, since the *reviewer image's own entrypoint* runs as guest-root and is free to drop
privileges before running Pi) — not a crun/podman-side configuration change. A cheap, real
mitigation available today: have the reviewer image's own container entrypoint (which krun
guest-execs as root) immediately `setuid`/`su-exec` to the unprivileged uid itself, since that
code path is entirely within our control and doesn't depend on krun at all.

---

## 4. `--network none` / TSI

**Correct mechanism: there isn't one to disable it — TSI-on-by-default is unconditional in this
libkrun version when no explicit network device is configured, confirmed by source, and no
lever in `crun`'s handler reaches the switch.**

`libkrun/src/libkrun/src/lib.rs:2954`:
```rust
let enable_tsi = ctx_cfg.vmr.net.list.is_empty() && ctx_cfg.legacy_net_cfg.is_none();
...
if enable_tsi || has_ipc_map {
    let (tsi_flags, host_port_map) = if enable_tsi {
        (TsiFlags::HIJACK_INET, ctx_cfg.tsi_port_map)
    } ...
```
i.e.: if the VM config's network-device list is empty (which it is, since `krun.c` only calls
`krun_add_net_unixstream()` when the opt-in `krun.use_passt` annotation is set — confirmed by
reading `libkrun_configure_vm()`, `krun.c:324-336`, and by grepping every annotation the handler
reads, §3 above), libkrun *always* falls back to enabling TSI (vsock-based transparent inet
hijacking) as the guest's default network path. This is a `krun_start_enter`-time default deep
in `lib.rs`, not something `crun`'s OCI-to-libkrun bridge exposes a switch for — there is no
annotation, no env var, no libkrun public-API call in `krun.c` that turns it off. Checked
`libkrun/include/libkrun.h` for a "no network"/"disable TSI" entry point: none exists. Checked
`libkrun/src/libkrun/Cargo.toml` `[features]`: TSI/vsock plumbing is not gated behind the `net`
feature (that only gates the tap/virtio-net device), so it can't be compiled out with a feature
flag either without patching the crate.

**Working on this host: confirmed NOT fixable via flags/annotations.** `dummy0` +
`203.0.113.0/24` (RFC 5737 TEST-NET-3) persists regardless of the working `krun.cpus`/
`krun.ram_mib` annotations (i.e. it's provably orthogonal to "are we using the right lever" —
we used every lever the handler exposes and it's still there):

```
$ podman run ... --annotation krun.cpus=2 --annotation krun.ram_mib=1024 \
    --entrypoint /bin/sh $IMG -c 'cat /proc/net/dev; cat /proc/net/route'
Inter-|   Receive ... |  Transmit
    lo:  0 0 0 0 0 0 0 0        0 0 0 0 0 0 0 0
dummy0:  0 0 0 0 0 0 0 0        0 0 0 0 0 0 0 0
---
Iface   Destination Gateway  Flags RefCnt Use Metric Mask     MTU Window IRTT
dummy0  007100CB    00000000 0001  0      0   0      00FFFFFF 0   0      0
```
(`007100CB` little-endian hex = `203.0.113.0`, confirming the TEST-NET-3 route from the original
spike.) Attempting to opt into the *alternative* backend (`krun.use_passt=1`) doesn't help
either — it's not a "disable networking" switch, it's "use passt instead of TSI for the same
purpose," and it isn't even usable on this host (no `passt` binary installed):
```
$ podman run ... --annotation krun.use_passt=1 --entrypoint /bin/sh $IMG -c 'echo ok'
Error: OCI runtime error: /usr/local/bin/krun: failed configuring mounts for handler at phase: HANDLER_CONFIGURE_AFTER_MOUNTS: start passt
```

**Classification: genuine libkrun limitation** (no lever exists in the version pinned for this
spike, v1.19.4, ABI 1) — not a podman-integration gap, not a host constraint. This corroborates
rather than overturns the original spike finding: egress is still empirically blocked (route
exists, connectivity doesn't — reconfirmed by the original spike's `ENETUNREACH` test, not
re-run here since it's independent of the flag question), but the *mechanism* is
"interface + route present but unreachable," a configuration-dependent property, not "interface
absent," a structural one. **`task_3b48` (TSI/passt built off + fail-closed in-guest assertion)
remains load-bearing** — there is no cheap annotation fix; it needs either a libkrun patch/rebuild
with TSI compiled out, or an in-guest fail-closed check that the reviewer entrypoint runs before
starting Pi (assert no route/interface reaches out, refuse to run otherwise), functionally
equivalent to what M7's Design D already does for the docker path.

---

## Summary table

| flag | right lever | works on this host | classification |
|---|---|---|---|
| `--user` | none exists for **guest** identity; `--user` *does* correctly drop the **host-side hypervisor process** via the normal OCI `process.user`/setresuid path (verified: `--user 1000:1000` → hypervisor process is host-uid 100999, not 0) | guest identity: **NO** (root, unfixable via config) | libkrun/guest-init limitation (guest init never calls setuid/setgid, confirmed absent in `init.c`) |
| `--cpus` | OCI annotation `krun.cpus` | **YES** (`nproc` → 2) | podman-integration gap — `--cpus` writes `cpu.max` quota, handler reads `sched_getaffinity()` instead |
| `--memory` | OCI annotation `krun.ram_mib` | **YES** (`MemTotal` → ~2048 MiB), and works with **no host memory cgroup at all** | podman-integration gap, fully solved by the annotation; `--memory` itself independently hard-errors on this host regardless of the annotation (unconditional cgroup write) |
| `--network none` | none exists to disable TSI; opt-in `krun.use_passt` switches backend, doesn't remove networking | **NO** (`dummy0` + TSI route persist under every annotation combination tried) | genuine libkrun limitation — no compile-time feature gate, no runtime switch, no annotation |

## Recommendation for the C-phase port (not implemented here — investigation only)

- `config.container.cpus` → render `--annotation krun.cpus=<n>` (drop or keep `--cpus` as a
  harmless no-op; keeping it costs nothing but also does nothing useful for krun).
- `config.container.memory` → render `--annotation krun.ram_mib=<n>` and **do not** also pass
  `--memory` under krun — on `cgroup_disable=memory` hosts it's fatal, and even where the cgroup
  exists it's redundant/confusing precedence with the annotation.
- `--user` → keep passing it (it correctly protects the host-side hypervisor process), but do
  not rely on it for in-guest privilege separation. If guest-side non-root matters for the
  threat model, the fix belongs in the **reviewer image's own entrypoint** (self-drop from
  root via `su-exec`/`setpriv` before invoking Pi) rather than in the runtime invocation —
  this is fully within our control and untouched by this investigation's constraints.
- Network: no config change closes this gap. `task_3b48` should be treated as a hard
  prerequisite for shipping the microVM tier, not a nice-to-have, exactly as the original spike
  concluded — this investigation adds the source-level proof that there is no cheaper fix
  available in libkrun v1.19.4.
