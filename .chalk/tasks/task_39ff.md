---
id: task_39ff
title: M8-C3: micro-VM tier end-to-end — port reviewer launch to krun under rootless podman (crun floor stays feature-flagged fallback)
type: task
status: open
priority: 1
labels: [microvm,security]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:10Z
updated_at: 2026-07-27T02:58:57Z
---
Brief §8 phase 3: the core port. Launch the reviewer as a rootless KVM micro-VM (podman +
krun OCI runtime) end-to-end, with the hardened crun tier remaining as the feature-flagged
fallback (it is the ladder floor, never deleted).

Plan:
- [ ] reviewer.ts: swap the container invocation for podman-with-krun; drop the gateway
      socket-dir bind mount (vsock replaces it); add guest RAM/vCPU flags.
- [ ] container-mounts.ts: /work rides a read-only virtiofs mount in the micro-VM tier; stays a
      read-only bind mount for the crun tier. (.git-strip and read-only semantics identical in
      both.)
- [ ] Concurrency: default guest RAM ~1 GB/review; queue concurrency = floor(available_RAM/guest_RAM),
      min 1, both configurable (brief §6.4).
- [ ] Dead-VM handling (OOM/panic/timeout) maps onto the existing clear-failure-note publisher
      path; add a test.
- [ ] Uid-split check (CTO edit 1): confirm the vsock/virtiofs rewiring did not move any gateway
      credential into the orchestrator; the reviewer still receives only the per-job virtual key.
- [ ] Floor test (M8-B1) still green — the crun fallback path is byte-for-byte unchanged.
- [ ] Full e2e: webhook → queue → micro-VM review → findings → published COMMENT review, on
      amd64 and the 16 KB-page arm64 box.

Done when: micro-VM tier reviews a real PR end-to-end on both arches with the crun floor intact
behind a flag.

---

## C2 collapsed into this task (2026-07-27)

Per CTO call, **M8-C2 (`task_b3f7`, closed) is folded into C3.** The direct-wiring investigation
+ hardware spike proved the "host-side per-VM vsock↔gateway forwarder" is NOT a separate
component: launch the reviewer via the **direct-libkrun launcher** (`rust/magpie-microvm-launcher`,
bin `magpie-krun-launch`) and point its `--vsock-uds` straight at the gateway's per-job
`gw.sock`. See `task_b3f7` (now in `.chalk/tasks/closed/`) for the full plan, and
`spike/m8-c2/direct-wiring-spike.md` for the passing 5-assertion spike (real `/dev/kvm`, arm64/16 KB).

Absorbed C2 responsibilities (in addition to the plan above):
- [ ] **Launch mechanism:** use `magpie-krun-launch` (direct libkrun), NOT `podman --runtime krun`
      — the M8-A1 spike found podman+krun can't reach the needed calls (TSI-off, per-VM vsock,
      `--user`). The "podman + krun OCI runtime" wording in the plan above is superseded by the
      standalone launcher (`task_76d6`, closed).
- [ ] **Consume `packages/orchestrator/src/microvm-vsock.ts`** (delivered on branch
      `m8-c2-forwarder-plan`, commit `4c6791e`): `microvmVsockChannel(gatewayKey)` →
      `{ udsPath: <socketDir>/gw.sock, port: 1234 }`, threaded into the launcher's
      `--vsock-uds`/`--vsock-port`. No separate forwarder process; no host-global vhost-vsock.
- [ ] **uid-split invariant** holds — the launcher receives only a filesystem path, never a
      credential (satisfies the C2 constraint + CTO edit 1).
- [ ] **Guest-side prerequisite:** the reviewer image entrypoint must `su-exec`/`setpriv` down
      from root before Pi (see `magpie-krun-launch` main.rs scope notes) and mount the read-only
      `/work` virtiofs device inside the guest.

### RESOLVED gate → C3 acceptance criterion: the vsock-uds teardown-vs-flush race

`bug_73b2` (P1) is CLOSED (2026-07-27, commit `91b54e1` on this branch) — root-caused and the
gate is satisfied. The finding was that the guest relay `rust/vsock-client` is **NOT** defective:
its source is byte-for-byte unchanged from `main`. The reply loss was a **timing race in
libkrun's own `--vsock-uds` bridge** (the exact transport C3 depends on): when the *host* peer
calls `shutdown(SHUT_WR)` in the same tick as `sendall()`-ing its reply, the bridge can
propagate the teardown to the guest before it finishes flushing the just-sent bytes, so the
guest sees a bare EOF instead of the reply. Fully documented in `.chalk/tasks/closed/bug_73b2.md`.

**This is a real, external-dependency transport property, not a harness quirk** — it reproduced
even against a persistent multi-accept host stub (10/10 lost), and was only masked by inserting
a gap before the host's `shutdown()`. So C3 MUST NOT assume immunity. Carry these as hard
acceptance criteria:

- [ ] **Prove the real gateway never triggers it.** `packages/gateway`'s proxy plane replies via
      Node `http.createServer` → `res.write()`/`res.end()` with keep-alive (see
      `proxy-server.ts` ~L244-261), which schedules FIN through libuv asynchronously rather than
      issuing a synchronous `shutdown()` in the last-write tick — structurally much safer than
      the spike's Python stub. But **verify, don't assume**: add a C3 integration test that
      drives a real (or faithfully-modelled) gateway reply → guest over the vsock-uds bridge and
      asserts ZERO byte loss, explicitly including the gateway's abort/error/`res.destroy()`
      teardown paths (the most likely place a prompt close-after-partial-write could sneak in).
- [ ] **If any gateway path can close promptly after writing,** either fix it to defer the close
      until bytes are flushed, or add a guest-/host-side guard — do not ship live Pi↔gateway
      traffic over a path that can silently drop a reply. Repro harness: `spike/m8-c2/`.
