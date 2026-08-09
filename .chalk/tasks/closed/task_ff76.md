---
id: task_ff76
title: Cut v0.3.2 release (host services + reviewer image) to deploy @magpie review + repo_allowlist glob support
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-09T04:57:23Z
updated_at: 2026-08-09T05:12:34Z
---

## Context

Live host is running v0.3.1 (tagged 2026-08-01), which predates the
`@magpie review` comment-command feature (1e0cce5, merged 2026-08-03) and
everything since (M6-B per-repo config, gVisor descope, docs reframe, repo
cleanup, PR #77 repo_allowlist glob support). GitHub App config/permissions
are already correct on the live App — only the deployed binary is stale.
User asked to cut + install a new release to bring the host current.

## Plan

- [x] Tag+push `reviewer-v0.3.2` (docker/reviewer + review-extension changed
      since reviewer-v0.3.1) -> release-reviewer.yml builds/publishes/signs
- [x] Get new image digest from the published GHCR tag
- [x] Bump the reviewer image pin (tag+digest) in the 5 live places (PR #78,
      merged): packages/orchestrator/src/{config.ts,config.test.ts},
      config.example.toml, docs/QUICKSTART.md, docker/reviewer/README.md
      (mirrors PR #68's precedent: image published *before* the pin bump)
- [x] Tag+push `v0.3.2` from updated main -> release-host.yml builds/publishes
      per-arch tarballs + GitHub Release
- [x] On the live host (/opt/magpie): download+verify new tarball, reinstall,
      npm ci --omit=dev
- [x] Pull new reviewer image as the `magpie` user
- [x] Update /etc/magpie/config.toml's container.image pin to match
- [x] Restart magpie service (gateway untouched — no packages/gateway changes
      this cycle), confirm healthy
- [x] Smoke-test: `pull_request` review confirmed working (this task's own
      PRs #78/#79 got reviewed by the pre-upgrade v0.3.1 build); post-upgrade
      `/healthz` green, deployed dist confirmed to contain comment-command.js
      + issue_comment handling. Live `@magpie review` comment trigger itself
      not re-tested in this session — next real PR comment on an allowlisted
      repo will exercise it.

## Result

Shipped as v0.3.2 (host) + reviewer-v0.3.2 (image), both live on the host as
of 2026-08-09. Along the way, cutting v0.3.2 caught a real bug:
`scripts/pack-host.sh` still referenced a root-level `INSTALL.md` that #76
had moved to `docs/INSTALL.md` — every release-host.yml run since #76 merged
would have failed the same way. Fixed + merged as PR #79 before re-tagging
v0.3.2. See PRs #78 (reviewer pin bump) and #79 (pack-host.sh fix).

## Notes

Not a fresh wipe-reinstall — an in-place upgrade of /opt/magpie preserving
/etc/magpie/config.toml (only the image pin line changed) and existing
secrets.

