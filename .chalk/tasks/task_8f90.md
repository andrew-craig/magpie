---
id: task_8f90
title: Release reviewer-v0.5.1 + host v0.3.6 and reinstall hub
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-11-05T07:01:52Z
updated_at: 2026-11-05T07:02:05Z
---

## Plan
- [x] Tag `reviewer-v0.5.1` at main 3d03c55 (report_findings fixes, PR #95)
- [x] Verify published index `sha256:ceb2af63…95a8` provenance (SLSA attestation: release-reviewer.yml @ reviewer-v0.5.1, 3d03c55)
- [x] Bump digest pin in config.ts, config.test.ts, config.example.toml, docs/QUICKSTART.md, docker/reviewer/README.md
- [ ] Merge pin PR, tag host `v0.3.6` (verify tarball checksum + provenance)
- [ ] Reinstall hub /opt/magpie from v0.3.6 tarball, pull new image as `magpie`, switch live config.toml image, restart once idle, verify /healthz
