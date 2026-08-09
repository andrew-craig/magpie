---
id: task_ff76
title: Cut v0.3.2 release (host services + reviewer image) to deploy @magpie review + repo_allowlist glob support
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-09T04:57:23Z
updated_at: 2026-08-09T04:57:39Z
---

## Context

Live host is running v0.3.1 (tagged 2026-08-01), which predates the
`@magpie review` comment-command feature (1e0cce5, merged 2026-08-03) and
everything since (M6-B per-repo config, gVisor descope, docs reframe, repo
cleanup, PR #77 repo_allowlist glob support). GitHub App config/permissions
are already correct on the live App — only the deployed binary is stale.
User asked to cut + install a new release to bring the host current.

## Plan

- [ ] Tag+push `reviewer-v0.3.2` (docker/reviewer + review-extension changed
      since reviewer-v0.3.1) -> release-reviewer.yml builds/publishes/signs
- [ ] Get new image digest from the published GHCR tag
- [ ] Bump the reviewer image pin (tag+digest) in the 4 live places:
      packages/orchestrator/src/config.ts, config.example.toml,
      docs/QUICKSTART.md, docker/reviewer/README.md — branch + PR + merge
      (mirrors PR #68's precedent: image published *before* the pin bump)
- [ ] Tag+push `v0.3.2` from updated main -> release-host.yml builds/publishes
      per-arch tarballs + GitHub Release
- [ ] On the live host (/opt/magpie): download+verify new tarball, reinstall,
      npm ci --omit=dev
- [ ] Pull new reviewer image as the `magpie` user, cosign verify
- [ ] Update /etc/magpie/config.toml's container.image pin to match
- [ ] Restart magpie-gateway + magpie services, confirm healthy
- [ ] Smoke-test: confirm a `pull_request` review still works, and (if
      possible) confirm `@magpie review` now produces a
      comment-command-triggered log line

## Notes

Not a fresh wipe-reinstall — an in-place upgrade of /opt/magpie preserving
/etc/magpie/config.toml (only the image pin line changes) and existing
secrets.

