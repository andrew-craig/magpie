---
id: task_9f42
title: Release reviewer-v0.5.0 + host v0.3.5 and reinstall hub
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-31T02:16:19Z
updated_at: 2026-10-31T02:16:29Z
---


## Plan
- [x] Tag `reviewer-v0.5.0` at main 33cdabd (Pi 1.4.0); release-reviewer published index `sha256:fc601a79…1708`
- [x] Bump digest pin in config.ts, config.test.ts, config.example.toml, docs/QUICKSTART.md, docker/reviewer/README.md
- [ ] Merge pin PR, tag host `v0.3.5`
- [ ] Reinstall hub /opt/magpie from v0.3.5 tarball, pull new image as `magpie`, switch live config.toml image, restart, verify /healthz
