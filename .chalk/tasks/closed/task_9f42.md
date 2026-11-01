---
id: task_9f42
title: Release reviewer-v0.5.0 + host v0.3.5 and reinstall hub
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-31T02:16:19Z
updated_at: 2026-10-31T02:23:13Z
---


## Plan
- [x] Tag `reviewer-v0.5.0` at main 33cdabd (Pi 1.4.0); release-reviewer published index `sha256:fc601a79…1708`
- [x] Bump digest pin in config.ts, config.test.ts, config.example.toml, docs/QUICKSTART.md, docker/reviewer/README.md
- [x] Merge pin PR (#93), tag host `v0.3.5` (tarball checksum + provenance attestation verified)
- [x] Reinstall hub /opt/magpie from v0.3.5 tarball, pull new image as `magpie`, switch live config.toml image, restart, verify /healthz

## Results
Hub reinstalled 2026-10-31: stop -> wipe /opt/magpie -> unpack v0.3.5 arm64 -> `npm ci --omit=dev` -> `install.sh` -> start.
Live `/etc/magpie/config.toml` image switched to reviewer 0.5.0 (no other schema drift vs config.example.toml).
`/healthz` ok, crun tier, not degraded; service and catatonit `/var/tmp` inodes match. Config backup: /var/backups/magpie-20261031-131817.
Older reviewer images (0.4.0 and earlier) are still in magpie's podman store; remove them later with a targeted `podman rmi`.
