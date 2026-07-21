# M8-A1 follow-up — alternate front-ends for libkrun (the networking question)

**Question:** the `--network none` → TSI-on behaviour is a property of *what sits in front of
libkrun*, not of libkrun itself. libkrun's C API can disable TSI; crun's krun handler never calls
the relevant primitive. So: is there a front-end that gives us a **provable no-network** guest —
and how does that interact with the per-VM gateway vsock channel M8 already needs
(`task_a163`/`task_b3f7`)?

**Method:** primary-source read of libkrun v1.19.4's `include/libkrun.h` and shipped
`examples/chroot_vm.c`, plus a hands-on experiment: a ~60-line direct-libkrun launcher
(`magpie-krun-launch.c`) booting the real reviewer rootfs. All boot results verified on this host
(RPi 5, 16 KB pages) via `sg kvm`. krunvm assessed from its design, **not** run.

## The stack today, and where networking is decided

```
Podman 4.3.1  →  crun (--with-libkrun, `krun` symlink)  →  krun HANDLER  →  libkrun.so.1 (v1.19.4)
                                                            ^^^^^^^^^^^^
                          crun/src/libcrun/handlers/krun.c — decides what TSI does
```

crun's handler only ever touches networking via `krun_add_net_unixstream`, gated behind
`if (kconf->use_passt)` (`krun.c:324-333`). With no `krun.use_passt` annotation it calls **no**
`krun_add_net_*` and **no** `krun_add_vsock`, so libkrun's implicit default (TSI hijacking on)
takes over. The handler never calls the off-switches libkrun exposes.

## libkrun's API already has everything crun's shim withholds

From `include/libkrun.h` (all four symbols confirmed present in the built `libkrun.so.1.19.4` via
`nm -D`):

- `krun_disable_implicit_vsock(ctx)` + `krun_add_vsock(ctx, 0)` — **TSI off** (0 = no hijack
  features). This is the no-network lever. (`libkrun.h:952,1213`)
- `krun_add_vsock_port2(ctx, port, uds_path, listen)` — **per-VM gateway channel**: a vsock port
  mapped to a host-side UNIX socket *path*, one per VM. This is exactly the "per-VM HYBRID vsock,
  never a host-global listener" the brief §6.1 mandates. (`libkrun.h:929`)
- `krun_setuid(ctx, uid)` / `krun_setgid(ctx, gid)` — **non-root guest**, the `--user` gap.
  (`libkrun.h:996,1012`)
- `krun_set_vm_config(ctx, vcpus, ram_mib)` — vcpu + RAM directly (no cgroup/annotation dance).
- `krun_set_root` / `krun_add_virtiofs*` / `krun_set_workdir` / `krun_set_exec` / `krun_set_env`
  — the rest of our mount/env/argv contract.

The full launch is ~8 calls; `chroot_vm.c`'s 338 lines are almost all CLI parsing.

## Experiment: does a direct front-end give provable no-network? YES

`magpie-krun-launch.c` (this dir) adds exactly the two calls crun omits —
`krun_disable_implicit_vsock` + `krun_add_vsock(ctx, 0)` — then boots the reviewer rootfs.
Side-by-side, same rootfs, same host:

| probe | crun handler (default) | direct launcher (TSI off) |
|---|---|---|
| `dummy0` operstate | `unknown` | **`down`** |
| routes | `203.0.113.0/24` (TSI plumbing) | **none** |
| egress `1.1.1.1:443` | `ENETUNREACH` | `ENETUNREACH` |
| TSI syscall hijack | **on** | **off** |

Egress is blocked either way, but the *guarantee* differs. Under crun it's "an interface is up and
TSI is live, but this destination has no route" — configuration-dependent, the exact thing M7's
Design D was written to avoid. Under the direct launcher it's "TSI is disabled at the vsock device;
the only non-loopback interface is a down, routeless, address-less dummy that black-holes traffic
by construction." The second is auditable and is what `task_3b48` needs.

`dummy0` persists in both (a libkrun guest-init artifact, not TSI) but with TSI off it is inert. A
fail-closed in-guest assertion (`task_3b48`) — "no non-lo interface is UP, route table empty,
`connect()` to any host fails" — is cheap on top of this and makes the property provable at
runtime rather than assumed.

## Build note (real, non-obvious)
`krun_add_vsock(ctx, tsi_features)` **requires** a prior `krun_disable_implicit_vsock(ctx)` in
v1.19.4 (`libkrun.h:939`), else the implicit device is already attached. Also: libkrun packs
`exec`+args into the kernel cmdline, which must be **plain ASCII** — passing an inline multi-line
shell script as argv panics host-side with `InvalidAscii` at `builder.rs:1073` before the guest
boots. Put scripts in the rootfs and exec the path. (Both learned the hard way here.)

## Options weighed

1. **Patch crun's krun handler** (add e.g. a `krun.no_net` annotation routing to
   `krun_disable_implicit_vsock`+`krun_add_vsock(ctx,0)`). Smallest diff, keeps podman/crun image
   plumbing. Cost: we fork+build+sign crun, and we *still* don't get `krun_setuid` or the gateway
   `krun_add_vsock_port2` unless we patch those in too — at which point we're maintaining a
   growing patch against crun's shim for every libkrun feature it declines to expose.
2. **krunvm** (containers' own libkrun CLI). Not tested. It wraps libkrun+buildah for
   *interactive* single microVMs and manages its own image store; it's a CLI, so per-job
   programmatic control (unique gateway socket path per VM, TSI off, non-root, ephemeral teardown)
   would be driven by shelling out and is not obviously exposed. Wrong shape for an orchestrator
   spawning locked-down per-PR VMs. Worth a short spike only if option 3 is rejected.
3. **Direct-libkrun launcher** (what the experiment used). A small binary that links libkrun and
   makes the calls ourselves. This is the only option that gets **all** of it in one place — TSI
   off, `krun_add_vsock_port2` gateway channel, `krun_setuid` non-root, vcpu/RAM — with no shim in
   the way and nothing to patch upstream. Cost: we take over OCI-image→rootfs prep (podman/buildah
   gives that for free today); here I unpacked via `podman export` to a dir for virtiofs, which is
   a viable path, or `krun_set_root_disk` with an ext4 image (brief §6.2 already anticipated an
   `mkfs.ext4 /work` path).

## Recommendation

**Option 3 (direct launcher) is the front-end, and the networking issue is the reason but not the
whole reason.** The same launcher is where three of the four spike caveats and the M8 gateway
transport all converge — they are all libkrun calls crun's handler simply doesn't make. Fighting
the shim (option 1) means re-adding them one patch at a time; krunvm (option 2) is the wrong shape.

Architecture inputs this surfaces, for the CTO brief / Go-adoption epic (`epic_6955`):
- libkrun is a **C API** (Rust lib). A host-side launcher linking it is naturally C or Rust, which
  cuts against "host-side forwarder could stay Node." The **guest-side** vsock client stays Go as
  mandated; the **host-side** launcher+forwarder is the piece this pushes toward Rust/C.
- Taking over image→rootfs prep is net-new work not in the current C-phase estimate (podman does
  it today). Feeds `task_08ec` scope and the effort number.
- The merge-blocker secret split (CTO edit 1) is unaffected and arguably cleaner: the launcher is
  the orchestrator-side privileged process; the gateway keeps its own uid and its socket is handed
  to the VM via `krun_add_vsock_port2`.

## Addendum (2026-07-22) — guest-side vsock client in Rust: PROVEN end-to-end

Question: can the guest-side vsock client (mandated Go in `epic_6955`) be Rust instead? Built and
tested it, full round-trip on this host. Artifacts: `vsock-client/` (Cargo project),
`magpie-vsock-client` binary, launcher extended with `krun_add_vsock_port2`, `vsock-host-listener.py`.

- **Static musl binary — yes.** `cargo build --release --target aarch64-unknown-linux-musl` →
  `file` reports **"statically linked", `ldd` "not a dynamic executable", 389 KB, stripped.** No
  runtime deps, so it bakes into the reviewer image exactly like the mandated Go binary would. Uses
  only the `libc` crate for `AF_VSOCK` (`socket`/`connect`/`sockaddr_vm`/`VMADDR_CID_HOST`).
- **Runs inside the guest and does a real vsock round-trip — yes.** The launcher wires the per-VM
  channel with `krun_add_vsock_port2(port, uds_path, listen=false)` (TSI still off). Host side is a
  plain UNIX-socket listener; libkrun connects out to it when the guest dials the vsock port
  (confirmed against `muxer.rs:578`). Observed:
  ```
  guest: vsock connect OK (cid=2 port=1234)
  host : received b'PING from rust guest\n'
  guest: vsock round-trip OK, host replied: PONG from host gateway (uid=1000)
  ```
  i.e. bidirectional guest↔host over vsock, network otherwise isolated.
- Gotcha for the real forwarder (`task_b3f7`): the host must `shutdown(SHUT_WR)` + drain before
  closing; an immediate `close()` after `sendall` raced the teardown and the guest saw EOF before
  the reply (first attempt failed exactly this way — a forwarder bug we'd otherwise hit later).

**Conclusion:** Rust satisfies the guest-side client's every requirement (static, self-contained,
`AF_VSOCK`) as well as Go does. Combined with the launcher needing Rust/C anyway, this removes the
last reason to keep Go on the guest side — a **TS + Rust** two-language stack is viable, retiring
the Go mandate. This also de-risks **`task_a163`** (vsock transport spike) and **`task_b3f7`**
(host-side forwarder): the channel shape and the per-VM HYBRID socket are now demonstrated.

## Not done / honest gaps
- krunvm not installed or tested — assessment is from its design only.
- The direct launcher is a boot/no-network proof only; it does **not** yet wire
  `krun_add_vsock_port2` to a live gateway socket or `krun_setuid` — those are the obvious next
  experiments if option 3 is chosen (and overlap `task_a163`).
- amd64 still untested (no hardware), as with the rest of the spike.
