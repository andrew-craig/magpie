---
id: task_711a
title: M5 bug: PrivateTmp breaks reviewer /out bind mount (reviews fail 'did not call report_findings')
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-12T08:50:55Z
updated_at: 2026-07-12T08:59:16Z
---


## Review

**Root cause:** `magpie.service` sets `PrivateTmp=true` (M5-A). `createOutputDir` in
`container-mounts.ts` created the `/out` bind-mount source via `mkdtemp` under the OS
tmpdir (`/tmp`). Under PrivateTmp the service's `/tmp` is a private mount namespace the
Docker daemon can't resolve, so `docker run -v /tmp/...:/out` mounted an empty, root-owned
dir; the `--user`-dropped reviewer container couldn't write `findings.json`, so every
review failed with `pi did not call report_findings`. `/work` was unaffected because
`work_dir=/var/lib/magpie/work` is host-visible. Not a tool-registration problem
(`report_findings` verified registered + called correctly via a live gateway run).

**Fix:** `createOutputDir(baseDir = tmpdir())` — reviewer.ts passes
`config.workspace.workDir` (host-visible StateDirectory tree). `mkdir -p` the base.

**Verification:** 192 orchestrator tests pass (incl. 2 new baseDir regression tests).
`systemd-run --property=PrivateTmp=true` repro: `/tmp` source mounts EMPTY in-container,
StateDirectory source is visible. Live end-to-end on PR #31 pending deploy.
