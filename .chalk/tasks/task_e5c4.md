---
id: task_e5c4
title: M8-E6: zero-exit reviewer failures discard all guest stderr (no diagnostics when pi produces no findings)
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T06:16:06Z
updated_at: 2026-07-31T06:16:06Z
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

**Live confirmation:** this is what made the M8-E5 live validation legible —
the full ordered entrypoint sequence now arrives on the host through the
ordinary failure path. See task_a749's live-validation section.
