---
id: task_8f90
title: Release reviewer-v0.5.1 + host v0.3.6 and reinstall hub
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-11-05T07:01:52Z
updated_at: 2026-11-05T07:15:18Z
---

## Plan
- [x] Tag `reviewer-v0.5.1` at main 3d03c55 (report_findings fixes, PR #95)
- [x] Verify published index `sha256:ceb2af63…95a8` provenance (SLSA attestation: release-reviewer.yml @ reviewer-v0.5.1, 3d03c55)
- [x] Bump digest pin in config.ts, config.test.ts, config.example.toml, docs/QUICKSTART.md, docker/reviewer/README.md
- [x] Merge pin PR (#96), tag host `v0.3.6` (tarball checksum + provenance attestation verified)
- [x] Reinstall hub /opt/magpie from v0.3.6 tarball, pull new image as `magpie`, switch live config.toml image, restart once idle, verify /healthz

## Results
Hub reinstalled 2026-11-05: stop -> move /opt/magpie aside -> unpack v0.3.6 arm64 -> `npm ci --omit=dev` -> `install.sh` -> start.
Live `/etc/magpie/config.toml` image switched to reviewer 0.5.1 (no other schema drift vs config.example.toml).
`/healthz` ok, crun tier, not degraded; service and catatonit `/var/tmp` inodes match. Config backup: /var/backups/magpie-20261105-181049.
Reviewer 0.5.0 and older images are still in magpie's podman store; remove them later with a targeted `podman rmi`.
