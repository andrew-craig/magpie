---
id: task_bfaf
title: M8-B1b: runtime crun-floor preflight assertion + mount-prep/.git-strip coverage
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-22T21:02:13Z
updated_at: 2026-07-23T08:28:41Z
---


Follow-up split from task_89c4 (M8-B1), whose PR #47 delivered the CI byte-for-byte golden
drift-test (+ ci.yml so it gates PRs) but deliberately scoped out two items:
- **Runtime preflight assertion** (CTO edit #3's "or preflight" leg / defence-in-depth): before a
  crun-tier job runs, assert the same hardened flag set is present and fail closed with a loud log
  otherwise. Likely folds into the M8-B2 rootless-substrate launcher port (task_08ec).
- **Extend the pinned posture beyond the docker-run argv** to the mount preparation in
  `container-mounts.ts` — the `.git`-stripped read-only `/work` and mount assembly — which the argv
  golden does not currently cover.

Done when: a crun-tier job fails closed at runtime on a missing hardened flag, and the golden/
assertion set covers the mount-prep posture, not just the argv.
