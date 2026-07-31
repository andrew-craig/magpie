---
id: task_80a4
title: M8-E7: MAGPIE_FINDINGS_PATH is an image ENV, absent in the bare-rootfs micro-VM guest
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-31T09:36:39Z
updated_at: 2026-07-31T09:36:39Z
---

## Background

Found 2026-07-31 on the Pi host during the M8-E5/E6 live micro-VM validation
(scratch PR #66, branch `m8-e2-e3-microvm-gaps`). M8-E5 worked — the guest
dropped to the host uid and `/out` became writable — and M8-E6 worked, which is
the only reason this was diagnosable at all: the newly-surfaced guest stderr
carried the smoking gun on the very first run.

## Problem

```
[magpie/review-extension] MAGPIE_FINDINGS_PATH is not set; falling back to
./magpie-findings.json in the current working directory.
```

**Exactly the same root cause as M8-E4's PATH gap, in a second variable.**
`docker/reviewer/Dockerfile` sets `ENV MAGPIE_FINDINGS_PATH=/out/findings.json`.
The crun tier gets it for free — `podman run` applies the image's OCI config.
A micro-VM guest boots a **bare exported rootfs with no OCI config at all**, so
it receives ONLY the explicit `--env` pairs the launcher was handed, and this
one was never among them (`buildMicrovmLaunchArgs`'s `env` map carries
`OPENAI_BASE_URL`, `MAGPIE_REQUIRE_MEMORY_LIMIT`, `MAGPIE_MICROVM_RAM_MIB`, and
as of M8-E5 `MAGPIE_MICROVM_REVIEWER_UID`/`_GID` — never this).

Unlike the PATH gap, nothing masked it: the baked `report_findings` extension
read an unset var, took its documented fallback, and wrote
`./magpie-findings.json` relative to its cwd — `/work`, the **read-only** PR
mount. The orchestrator then found no `/out/findings.json` and reported the
generic `"pi did not call report_findings"` **even though Pi had run and called
the tool** (`turns=1`, 4854 tokens, $0.0074 of real gateway-metered spend).

`entrypoint.sh`'s own header comment asserted the opposite, and was wrong for
this tier:

> NOT a runtime input: MAGPIE_FINDINGS_PATH. The output path is part of the
> image contract … so the baked-in report_findings extension already sees it —
> this script neither reads nor requires it.

True under crun, false under a bare rootfs.

## Plan

- [x] Export `MAGPIE_FINDINGS_PATH=/out/findings.json` in `entrypoint.sh`'s
      micro-VM branch, beside the M8-E4 PATH export.
- [x] Correct the stale "NOT a runtime input" header comment.
- [x] Regression test pinning the exported value AND that it matches the
      Dockerfile's `ENV` literal.
- [x] Crun tier untouched (still takes the value from the image config).
- [ ] Live re-validation.

## Review

**Fixed in `entrypoint.sh`, guarded on `MAGPIE_IS_MICROVM`** — a one-line
`export` next to M8-E4's PATH export, same shape and same rationale.

**Why the image and not `reviewer.ts`'s `--env` map** (both would work): the
Dockerfile documents the output path as *"part of the image contract, not
per-job config"*, explicitly so the orchestrator does not have to pass it.
Re-declaring the image's own constant inside the image keeps that contract
intact and keeps a hand-launched/manually-exported rootfs working. Same call
M8-E4 made for PATH, for the same reason.

The literal is deliberately duplicated from the Dockerfile's `ENV` rather than
derived — a bare rootfs has no way to read its own image config, so no single
source of truth exists at this layer. A test pins the two together so they
cannot drift.

**This is the third instance of one underlying defect:** the micro-VM tier
silently loses everything the OCI image config provides. PATH (M8-E4),
MAGPIE_FINDINGS_PATH (this task) — and any future `ENV`/`WORKDIR` the image
grows will fail the same way. Worth a follow-up that audits the Dockerfile's
full image-config surface against what the launcher actually injects, rather
than continuing to discover these one live run at a time.
