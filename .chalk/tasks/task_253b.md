---
id: task_253b
title: Upgrade Node runtime 22 -> 24 (host, reviewer base image, CI, @types/node)
type: task
status: open
priority: 2
labels: [deps]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-25T05:38:54Z
updated_at: 2026-10-25T10:51:11Z
---


Follow-up from task_d8d6 / PR #91. That PR stayed on Node 22, which is in Maintenance LTS until 2027-04-30. The current Active LTS is Node 24 (24.22.1 as of 2026-10-20). The Pi host already runs Node 24.17.0 for the orchestrator and gateway, so host and image currently differ.

## Scope (every Node 22 pin)
- `docker/reviewer/Dockerfile` base image `node:22.23.4-slim@sha256:…`: change to `node:24.x-slim` pinned by tag and index digest, and update README.md's version table
- `.github/workflows/*.yml`: `node-version: 22` → 24 in ci.yml, release-host.yml and rust.yml
- Root `@types/node` ^22 → ^24
- `engines` fields, if any, and docs/QUICKSTART/INSTALL prerequisites (scripts/install.sh Node version check)
- systemd units use `/usr/local/bin/node`; confirm the documented install version
- Check tsconfig `target`/`lib` (ES2024+ is available on 24)

## Plan
- [ ] Inventory every `22` pin: `grep -rn "node:22\|node-version: 22\|@types/node\|Node 22" --exclude-dir=node_modules --exclude-dir=target`
- [ ] Read the Node 24 breaking changes (OpenSSL 3.5, `url.parse` deprecation, stream/fs changes, removed APIs) against our code and Pi's `engines`
- [ ] Bump everything in one go and run the gate (build, tsc, npm test, entrypoint tests)
- [ ] Build the reviewer image locally and run a real-model validation through the live gateway (see the task_d8d6 validation notes)
- [ ] Release `reviewer-v*` plus host `v*`, bump the digest pin, reinstall the host
