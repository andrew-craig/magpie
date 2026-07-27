# M8-C2 direct-wiring spike (task_b3f7) — findings

> **Note (review hygiene):** the executable harness that produced these findings
> (the `run-assertion*.sh`, `run-diag-*.sh`, `gw-stub-listener*.py`,
> `m8c2-*.mjs`/`.sh`, and the C3 `c3-*.sh`/`c3-gw-listener.mjs` scripts) was
> removed from the working tree before this branch went for review, to keep the
> reviewable diff focused on the product change. Every script remains recoverable
> from git history at commits `0f9ce82` (C2 direct-wiring spike), `91b54e1`
> (bug_73b2 root-cause) and `2dfdcef` (C3 live e2e). This writeup is the
> self-contained record of what they proved.

Empirical spike run on the physical arm64/16KB-page Raspberry Pi box (the same box
`spike/m8-a1` and `rust/magpie-microvm-launcher/smoke-test.sh` already use), validating the
"direct wiring" hypothesis from `.chalk/tasks/task_b3f7.md`'s "Gate: one-shot vsock
round-trip spike" checklist: can `--vsock-uds` point straight at the gateway's per-job
`gw.sock` with **no separate host-side forwarder process**?

## Box / environment

```
$ uname -a
Linux hub 6.12.93+rpt-rpi-2712 #1 SMP PREEMPT Debian 1:6.12.93-1+rpt1 (2026-06-12) aarch64 GNU/Linux
$ getconf PAGE_SIZE
16384
```

- `/dev/kvm`: present, `crw-rw---- root kvm`; `operator` is in the `kvm` group (real gid
  becomes `kvm` under `sg kvm -c '...'`, same as the existing smoke-test's own convention).
- libkrun: `libkrun.so.1` at `/usr/local/lib64/libkrun.so.1`, plus `libkrunfw.so.5`. ABI pin
  reported by the launcher at boot: `v1.19.4 (ABI 1)`.
- `spike/m8-a1/rootfs/` exists and contains `/vsock-client` (the m8-a1 spike's static,
  one-shot round-trip binary) and Node/bash/dash — no `nc`/`socat`/Python in the guest, but
  Node is present and was used as the guest-side TCP test client (also how the existing
  `smoke-probe.sh` tests egress).
- Build: `cargo build --release -p magpie-microvm-launcher -p magpie-vsock-client` — clean,
  no warnings.

**Preflight: all green, no blockers.**

## Baseline (assertion 1)

`rust/magpie-microvm-launcher/smoke-test.sh`, run unmodified via
`sg kvm -c 'rust/magpie-microvm-launcher/smoke-test.sh'`:

```
ALL ASSERTIONS PASSED
```

All 8 of its own assertions passed, including the existing single-round-trip vsock check
against a `mktemp -d` (0700) directory. **PASS.**

## Assertion 2 — gateway-permissions variant

**Command:** `sg kvm -c 'spike/m8-c2/run-assertion2-gwperms.sh'`

Host listener (`spike/m8-c2/gw-stub-listener-oneshot.py`) reproduces
`packages/gateway/src/job-sockets.ts`'s exact posture: job directory `chmod 0711`, socket file
`chmod 0666` (both applied explicitly after creation, not via umask), nested one level under a
0700 root (mirroring `<socketDirRoot>/<jobId>/gw.sock`). Guest is the launcher (running as
`operator`, uid 1000) dialing via the m8-a1 one-shot `/vsock-client`.

Key evidence:
```
job_dir 711 /tmp/magpie-m8c2-gwperms.XmWBdj/job-abc123
socket   666 /tmp/magpie-m8c2-gwperms.XmWBdj/job-abc123/gw.sock
...
vsock connect OK (cid=2 port=1234)
vsock round-trip OK, host replied: PONG from host gateway (uid=1000)
...
HOST[gwperms]: received b'PING from rust guest\n'
PASS: guest completed vsock round-trip against 0711/0666 host socket
PASS: job directory really is mode 0711
PASS: socket file really is mode 0666
PASS: host listener actually received the guest's vsock PING through the 0711/0666 posture
ALL ASSERTION-2 CHECKS PASSED
```

**PASS** — the launcher's uid can `connect()` a real gateway-postured `gw.sock` with no
elevated permissions or shared group needed; `0711`/`0666` (directory traversal, not a shared
group — exactly `job-sockets.ts`'s own doc comment) is sufficient.

(One harness note: an earlier attempt at this assertion hung forever because my own draft
listener used a read-until-EOF loop, which deadlocks against the m8-a1 one-shot client's
actual protocol — one write, then blocking read, no half-close. Fixed by giving assertion 2 a
listener that does a single `recv()` then replies, matching the proven baseline listener's
shape exactly. Not a libkrun/vsock finding, a test-harness bug on my end, caught before it
produced a false result.)

## Assertion 3 — multiple connections (sequential + parallel)

Two different clients were used here, and they gave **different verdicts** — that
divergence is itself the most important empirical finding of this spike.

### 3a. Raw direct dial (bypassing any relay) — PASS, thoroughly

**Sequential**, `spike/m8-c2/run-diag-oneshot-loop.sh`: 8 sequential one-shot `/vsock-client`
dials, in a single guest boot, against a host listener that accepts up to 8 connections
sequentially (single `recv()`+reply protocol per connection). Run **3 times**:

```
guest reported 8/8 successful round-trips   (x3 runs — 24/24 total)
```

**Parallel**, `spike/m8-c2/run-diag-parallel-oneshot.sh`: 5 one-shot `/vsock-client`
processes launched as concurrent background jobs in the guest (`&` + `wait`), all dialing the
*same* `uds_path` at once. Run **3 times**:

```
guest reported 5/5 successful PARALLEL round-trips   (x3 runs — 15/15 total)
```

Host log for one parallel run, showing correct per-connection demux (each client got its own
distinctly-numbered reply, not a mix-up):
```
HOST[par]: conn#1 received b'PING from rust guest\n' -> PONG#4
HOST[par]: conn#2 received b'PING from rust guest\n' -> PONG#2
HOST[par]: conn#3 received b'PING from rust guest\n' -> PONG#1
HOST[par]: conn#4 received b'PING from rust guest\n' -> PONG#5
HOST[par]: conn#5 received b'PING from rust guest\n' -> PONG#3
```
(guest side matched every PONG#N to the process that should have received it — no cross-talk,
just out-of-order arrival, which is expected/harmless for concurrent independent dials).

**Verdict for 3a: PASS.** libkrun's "fresh host dial per guest `connect()`" model holds up
under both back-to-back sequential and truly concurrent connections, 39/39 across 6 runs, zero
failures, against the same `uds_path` throughout.

### 3b. Through the real production guest relay (`magpie-vsock-client`) — FLAKY, and this is a genuine finding

Per the task's instruction to prefer driving load through the existing relay rather than a
bypass, `spike/m8-c2/run-assertion345.sh` copies the actual, unmodified
`rust/target/release/magpie-vsock-client` binary into the guest (as `/m8c2-relay`) and drives
5 sequential + 5 parallel HTTP-shaped TCP requests against its `127.0.0.1:4000` listener via a
Node test client (`m8c2-relay-client.mjs`), reusing the real per-connection
TCP→vsock relay path Pi's traffic will actually take in production.

**Result: intermittent, reproducible data loss on the relay's first 1–2 real connections
after startup.** Across 4 runs of this exact script:

| run | outcome |
|---|---|
| 1 | 1/10 empty (last parallel conn) |
| 2 | 10/10 empty |
| 3 | 4/10 empty (all after the first) |
| 4 | 10/10 empty |

In every failing case, the **host-side listener log shows it received the request and
successfully replied** (`recv()` got the bytes, `sendall()`+`shutdown()`+`close()` all
succeeded, no exception) — the reply is lost somewhere between the host unix socket and the
guest's Node `data` event, i.e. inside the vsock hop or the relay's own thread-per-direction
`io::copy` in `rust/vsock-client/src/main.rs`'s `relay()`.

Follow-up diagnostics narrowed this further:
- **Single connection, fresh process each time** (`run-diag-relay-debug.sh`, instrumented
  client logging every socket event with a timestamp): **3/3 clean**, full byte-for-byte
  correct replies, `end`/`close` firing in the expected order every time.
- **5 sequential connections, same Node process, 300ms delay between each**
  (`run-diag-relay-delay.sh`): only the **first** real connection came back empty; the
  remaining 4 were clean:
  ```
  M8C2-DELAYSEQ label=delayseq-0 reply="" saw_host_eof=true
  M8C2-DELAYSEQ label=delayseq-1 reply="ACK[delay]:MSG from delayseq-1\n" saw_host_eof=true
  M8C2-DELAYSEQ label=delayseq-2 reply="ACK[delay]:MSG from delayseq-2\n" saw_host_eof=true
  M8C2-DELAYSEQ label=delayseq-3 reply="ACK[delay]:MSG from delayseq-3\n" saw_host_eof=true
  M8C2-DELAYSEQ label=delayseq-4 reply="ACK[delay]:MSG from delayseq-4\n" saw_host_eof=true
  ```
- With no delay (back-to-back), the failure window widens to cover more of the batch (as the
  table above shows) — consistent with a startup/"warm-up" race in the relay rather than a
  per-connection coin-flip that persists indefinitely.

**This defect is in `rust/vsock-client` (the already-merged M8-C1/`task_2d6c` guest-side
relay), not in the direct-wiring host posture this spike is chartered to evaluate.** It
reproduces identically regardless of which host listener or permission posture is used, and
raw direct dials through the *exact same* vsock mechanism (3a, above) never show it — the only
variable that changes is which guest-side client speaks to the vsock port. It looks like a
race in `relay()`'s thread-per-direction handoff (`rust/vsock-client/src/main.rs:275-292`)
specific to the first one or two connections a freshly-started relay process handles, not
something this investigation-only spike should try to root-cause or fix in place (that's
implementation work against an already-closed task, out of scope here) — but it is squarely
**C3's problem**, because C3 (`task_39ff`) is exactly where this relay binary starts carrying
real Pi↔gateway traffic in production.

**Verdict for assertion 3: PASS at the wiring-mechanism level (3a); a separate, reproducible
relay-startup defect found and flagged for follow-up (3b) — not a reason to fall back to a
host-side relay, since the defect is guest-side and host-side wiring is not implicated.**

## Assertion 4 — half-close propagation, both directions

Demonstrated cleanly via the instrumented single-connection relay client
(`run-diag-relay-debug.sh`, 3/3 clean runs) and via every successful connection in the batch
tests: each client calls `socket.end()` right after writing (guest→host half-close), and the
host listener always logs `EOF from guest (half-close observed)` for **every** connection in
every run (12/12, 12/12, etc. — never missed, even in the runs where the *reply* was lost).
Symmetrically, the host does `shutdown(SHUT_WR)` after its reply, and every successful
connection's guest-side log shows `saw_host_eof=true` / the debug client's explicit
`end event (remote FIN)` line.

Example (instrumented client, one connection):
```
[3ms] connect event fired
[5ms] write() returned true
[5ms] end() called
[6ms] finish event (our writes flushed)
[120ms] data event: 24 bytes: "ACK[dbg]:MSG from conn1\n"
[121ms] end event (remote FIN)
[122ms] close event (hadError=false)
```

**PASS** — half-close propagates correctly in both directions (guest EOF → host sees EOF;
host EOF → guest sees EOF) whenever the connection completes at all. This held even in the
"flaky" assertion-3b runs: the host always observed the guest's EOF, and the guest always
observed the host's EOF — it was specifically the *data* in between that occasionally went
missing, not the half-close signaling.

## Assertion 5 — per-job isolation

**Command:** `sg kvm -c 'spike/m8-c2/run-assertion5-isolation.sh'`, run 3 times.

Boots two independent micro-VMs **concurrently**, each with its own directory
(`job-A`/`job-B`) and its own `gw-stub-listener-oneshot-multi.py` instance, each configured
with `max_connections=1`. Uses the raw one-shot client (3a proved this path rock-solid;
avoids conflating this test with the 3b relay defect, which is orthogonal to isolation).
Since the one-shot client's payload text is a fixed constant, isolation is verified by
**accept count per listener** (exactly 1, never 0 or 2) rather than payload content — a
cross-job leak would show up as one listener accepting twice and the other timing out.

```
VM A exited with status 0; VM B exited with status 0
listener A accepted 1 connection(s); listener B accepted 1 connection(s)
PASS: listener A (VM A's own socket) received EXACTLY one connection
PASS: listener B (VM B's own socket) received EXACTLY one connection
ALL ASSERTION-5 (ISOLATION) CHECKS PASSED
```

Identical result across all 3 runs. **PASS** — two concurrent VMs, each with a distinct
`uds_path`, never cross-connect. (This is structurally guaranteed by the design — each VM's
own `krun_add_vsock_port2` dials only *its own* configured path, there is no shared listener
or CID namespace for a guest to escape into — but it's now also empirically confirmed rather
than just architecturally asserted.)

## Summary table

| # | Assertion | Verdict |
|---|---|---|
| 1 | Baseline (`smoke-test.sh` unmodified) | **PASS** |
| 2 | Gateway 0711/0666 permission posture | **PASS** |
| 3 | Multiple connections, sequential + parallel | **PASS** (raw dial, 39/39); relay-specific defect found and flagged separately |
| 4 | Half-close propagates both directions | **PASS** |
| 5 | Per-job isolation, two concurrent VMs | **PASS** (3/3 runs) |

Nothing here was marked INCONCLUSIVE — every assertion the task listed was actually exercised
on real hardware, including genuine parallel guest connections (background jobs in the guest,
not just sequential).

## VERDICT

**Direct wiring is viable.** Every assertion specific to the host-side wiring question — can
`--vsock-uds` point straight at a gateway-postured `gw.sock`, with the launcher's own uid, no
shared group, handling multiple/parallel connections and clean half-close, with per-job
isolation across concurrent VMs — passed cleanly and repeatably. **No separate host-side
forwarder process is needed; C2 collapses into C3 as `task_b3f7`'s own plan section
predicted**, and this spike is the empirical confirmation the plan's gate asked for.

### Caveat C3 (`task_39ff`) must account for

**A reproducible data-loss defect exists in the already-built guest-side relay
(`rust/vsock-client`, M8-C1/`task_2d6c`), affecting the first 1–2 real connections a
freshly-started relay process handles after its own preflight dial**, under back-to-back or
tightly-spaced TCP proxy traffic. This is NOT a direct-wiring/host-permission problem (raw
direct dials through the identical vsock mechanism never show it, 39/39), and it is NOT
something a host-side Rust relay fallback would fix either (the defect is entirely on the
guest side of the channel, downstream of any host-side wiring decision). Recommend, before C3
wires this launcher into the production pipeline:

1. File a follow-up bug/task against `rust/vsock-client`'s `relay()` (likely around the
   thread-per-direction handoff in `src/main.rs:264-292`) to root-cause and fix the
   first-connection data loss under connection churn.
2. Until fixed, treat Pi's *first* request per job (or first request after any relay restart)
   as at elevated risk of a silently-dropped/empty response — worth a retry-on-empty-body
   guard somewhere in the chain, or simply prioritizing the fix before this ships live traffic.
3. C3's own wiring/pipeline tests should include an early-connection-reliability check (e.g.
   the `run-diag-relay-delay.sh` shape here) rather than only a single-request smoke test,
   since a single-request check is exactly the shape that would miss this.

## Spike artifacts (this directory)

- `gw-stub-listener.py` — multi-accept host stub matching gateway 0711/0666 posture, used by
  assertion 3b (relay path) and the delay diagnostic.
- `gw-stub-listener-oneshot.py` — single-accept variant matching the m8-a1 one-shot client's
  actual protocol (single `recv()`, no read-until-EOF); used by assertion 2.
- `gw-stub-listener-oneshot-multi.py` — multi-accept version of the above; used by the raw
  sequential/parallel diagnostics and assertion 5.
- `m8c2-relay-client.mjs` / `m8c2-relay-client-debug.mjs` / `m8c2-relay-client-delay.mjs` —
  Node guest-side test clients against the real `magpie-vsock-client` relay (seq/par batch,
  single-connection instrumented, and delayed-batch variants respectively).
- `m8c2-driver.sh` / `m8c2-oneshot-loop.sh` / `m8c2-parallel-oneshot.sh` — guest bootstrap
  scripts installed into `spike/m8-a1/rootfs` at runtime (same convention
  `smoke-test.sh` already uses for `smoke-probe.sh`; that rootfs dir is gitignored/
  regenerable, so this isn't an edit of any committed m8-a1 file).
- `run-assertion2-gwperms.sh`, `run-assertion345.sh`, `run-assertion5-isolation.sh` — the
  three new numbered-assertion harnesses.
- `run-diag-oneshot-loop.sh`, `run-diag-parallel-oneshot.sh`, `run-diag-relay-debug.sh`,
  `run-diag-relay-delay.sh` — supporting diagnostics that isolated the assertion-3b relay
  defect from the direct-wiring hypothesis itself.

None of `rust/magpie-microvm-launcher/smoke-test.sh`, `spike/m8-a1/vsock-host-listener.py`, or
any other committed m8-a1 file was modified.

## Addendum (2026-07-27) — correcting the assertion-3b attribution

The follow-up investigation (`bug_73b2`, see that task file's own "Root cause + fix" section
for the full writeup) found that the data loss described above in "Assertion 3 ... 3b" is
**not** a defect in `rust/vsock-client`. Root-caused with instrumentation (per-fd,
microsecond-timestamped logging of every `read`/`dup`/`shutdown`/`close` call added
temporarily to `relay()` and `VsockStream`, then reverted): the unmodified relay's blocking
read on the host-reply direction genuinely waits the full round trip and then returns a bare
`Ok(0)` (EOF, zero bytes) -- not an instantly-poisoned read. The proven mechanism is a timing
race in the direct `--vsock-uds` bridge (libkrun's own vsock-to-unix-socket proxying, the
subject of this very spike) between (a) a peer finishing `sendall()` of its reply and (b) that
same peer immediately calling `shutdown(SHUT_WR)` with no gap: `gw-stub-listener.py` did
exactly that, and the bridge's propagation of "peer is done" to the guest can outrun its own
forwarding of the just-sent reply bytes, so the guest observes EOF instead of data.

This was confirmed two ways: (1) two independent guest-side mitigations in
`rust/vsock-client` (deferring the close of the dup'd vsock write-half until after the whole
relay completes; and eliminating `dup()` entirely by sharing the raw fd across threads)
**each helped inconsistently** across repeated runs -- neither reliably eliminated the loss,
which is itself evidence the defect isn't in the relay's dup/thread/close ordering; (2) a
single change with no code touched at all -- inserting a delay in the **host stub** between
`sendall()` and `shutdown()` -- eliminated the loss **reliably and reproducibly** (0/10 lost
replies across 7 repeated runs of assertion 3's 5-sequential + 5-parallel batch, versus
10/10 lost on every un-delayed control run). `gw-stub-listener.py` has been fixed accordingly
(see its own updated comment); `rust/vsock-client` was left completely unmodified -- `cargo
test --workspace` and a full release build are unchanged and green.

This reframes assertion 3's verdict: the wiring-mechanism PASS (3a, raw dials) stands, and
the relay path (3b) now ALSO passes cleanly once the host-side test double stops racing its
own write against its own teardown -- there is no evidence of a `rust/vsock-client` defect.
The residual, genuine risk this surfaces for C3 (`task_39ff`) is at the *transport* layer, not
the relay: whatever plays the "host" role over this direct vsock-uds bridge must not shut down
or close a connection immediately after writing its final bytes, or it risks this same race.
The real `packages/gateway` is a standard Node `http.createServer` responding via `res.end()`
(no synchronous same-tick `shutdown()`/`destroy()` after writing), which is structurally much
safer than this spike's tight, synchronous Python stub -- but this is a property of the
transport (very likely libkrun's vsock-uds bridge itself, an external dependency of this repo)
that C3's own wiring/pipeline tests should still probe directly, rather than assuming Node's
timing is inherently immune.
