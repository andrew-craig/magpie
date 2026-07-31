---
id: task_e5c4
title: M8-E6: zero-exit reviewer failures discard all guest stderr (no diagnostics when pi produces no findings)
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T06:16:06Z
updated_at: 2026-07-31T09:48:01Z
---

## Background

Found during the M8-E4 live micro-VM validation (2026-07-31). The run failed
with `"pi did not call report_findings"` and it was impossible to say why from
the host: the guest's entire ordered `entrypoint.sh` log — the confinement,
mount, memory-ceiling and privilege-drop narration — had been buffered in
`reviewer.ts`'s `stderrTail` and was then thrown away, because the container
exited **0**.

`reviewer.ts` includes `stderrTail` in its failure reason only on the
`code !== 0` path. The zero-exit failure paths do not:

- `pi did not call report_findings`
- `pi review failed: <provider detail>`
- `pi wrote an invalid findings file: <parse error>`
- `failed to process findings: <throw>`

That is exactly backwards for this image. `entrypoint.sh` narrates everything
to stderr, and Pi exits 0 even when a provider call failed — so the zero-exit
paths are the COMMON failure mode, and they are the ones with no diagnostics.

## Plan

- [x] Add a `withStderr(reason)` helper inside `runReview`'s spawn closure that
      appends the retained tail (same `STDERR_TAIL_BYTES` budget — the tail is
      already capped as it accumulates, so nothing new is buffered).
- [x] Apply it to all four zero-exit failure paths above.
- [x] Redact the gateway virtual key from the tail defensively.
- [x] Audit the other failure paths for the same hole; document any deliberate
      carve-out.
- [x] Unit coverage.

## Review

**Done.** `withStderr` is defined next to `clearTimers` in `runReview`'s spawn
closure (where `stderrTail` is in scope) and applied to the four zero-exit
paths. Reason strings gain
`". Sandbox stderr (last 4000 bytes): <tail>"` only when there is a non-empty
tail, so existing exact-match expectations on the bare reasons still hold when
the sandbox was silent.

**Redaction.** The tail is echoed into a telemetry record and, via
`publisher.ts`, into a **public PR comment**. Nothing is expected to print the
gateway virtual key (`entrypoint.sh`'s key assertions deliberately report only
the expected `sk-magpie-` PREFIX, never the value), but the key is scrubbed
here anyway so a future change that started echoing it cannot leak it through
this path. Guarded on a non-empty key so a keyless dev/test run can't turn
every byte into `[redacted]` via `split("").join(...)`.

**Deliberate carve-out — the `aborted` / `timeout after …` reasons are NOT
wrapped**, even though they discard stderr too. `pipeline.ts`'s
`classifyJobOutcome` derives a job's telemetry outcome by STRING-MATCHING those
two reasons (`reason === "aborted"`, `reason.startsWith("timeout after")`).
Appending a tail would silently reclassify every aborted job as a generic
`error` — trading a real telemetry regression for diagnostics. Found by reading
`classifyJobOutcome` before touching those paths, not by a failing test. The
carve-out is documented in the helper's doc comment (with the correct fix if
they ever need stderr: a separate `ReviewResult` field, not string
concatenation) and pinned by a regression test.

**Tests** (`reviewer.test.ts`, 4 new):
- zero-exit + no findings + stderr → reason carries the entrypoint lines
- zero-exit + unparsable findings + stderr → reason carries the tail
- stderr containing the gateway key → `[redacted]`, key absent from the reason
- abort with chatty stderr → reason is still exactly `"aborted"` (the
  carve-out guard)

Orchestrator suite **415 passed / 4 skipped, 29 files** (was 409/4);
gateway 75; review-extension 11. `reviewer-crun-floor-argv.test.ts` byte-for-byte
unchanged (`git diff --exit-code` clean).

**Live confirmation — this fix immediately paid for itself.** On the first live
micro-VM run of the M8-E5 fix (scratch PR #66), the whole ordered entrypoint
sequence arrived on the host through the ordinary failure path for the first
time ever, and carried the cause of the next blocker in its last line:

```
magpie-krun-launch: booting rootfs="/var/lib/magpie/reviewer-rootfs-e5" exec="/opt/magpie/entrypoint.sh" vcpus=2 ram_mib=1024 uid=993 gid=988 vsock=1234 work_mount=work out_mount=out (libkrun ABI: v1.19.4 (ABI 1))
magpie-reviewer: micro-VM memory ceiling verified -- guest MemTotal 1005696 KiB is within the expected bound for MAGPIE_MICROVM_RAM_MIB=1024
magpie-reviewer: /dev/vsock present -- starting vsock-client (127.0.0.1:4000 -> AF_VSOCK host port 1234)
magpie-reviewer: micro-VM tier -- mounting /work + /out virtiofs devices
[vsock-client] preflight vsock connect to host port 1234 OK
[vsock-client] listening on 127.0.0.1:4000 -> vsock cid=host port=1234
magpie-reviewer: micro-VM tier -- mounting guest-local tmpfs at /tmp (mirrors the crun tier's --tmpfs /tmp; see task_76b8)
[vsock-client] relaying connection -> vsock cid=host port=1234
magpie-reviewer: relay is up
[vsock-client] relaying connection -> vsock cid=host port=1234
magpie-reviewer: micro-VM egress channel confirmed -- /dev/vsock present, port 1234
magpie-reviewer: network confinement verified -- no non-lo interface, empty route table, canaries unreachable, gateway reachable only via the permitted forwarder/vsock channel
magpie-reviewer: micro-VM tier -- dropping to uid/gid 993:988 (the orchestrator's own unprivileged uid, matching the crun tier's --user and the /out virtiofs owner) before exec pi
[vsock-client] relaying connection -> vsock cid=host port=1234
[magpie/review-extension] MAGPIE_FINDINGS_PATH is not set; falling back to ./magpie-findings.json in the current working directory.
```

That last line is the entire diagnosis of **task_80a4 (M8-E7)**, delivered on
the first attempt. Under the old behaviour the run would have reported nothing
but `"pi did not call report_findings"` — the same opaque string that cost the
M8-E4 session an entire extra live cycle to root-cause by hand.

**Scope note:** this surfaces stderr on FAILURE paths only. A SUCCESSFUL review
still discards the tail (there is no failure reason to attach it to), which is
deliberate — the reason string is the carrier, and a successful `ReviewResult`
has none. So the ordered sequence above is from the failing run; the subsequent
successful run's sequence was not captured. See task_a749's live section.
