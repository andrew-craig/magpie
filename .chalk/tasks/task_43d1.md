---
id: task_43d1
title: Bump Pi to latest (1.1.0) + repeatable bump script
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-10T10:32:14Z
updated_at: 2026-10-10T10:32:14Z
---


## Context
Reviews were failing intermittently ("pi did not call report_findings") with `z-ai/glm-5.3`. Pi 0.80.3's model registry predates it, so it falls back to cloning `moonshotai/kimi-k2.6`'s compat/limits/cost. User direction (2026-10-10): bump Pi to **latest** (1.1.0 at time of writing), and make the bump **repeatable**.

## Plan
- [ ] `scripts/bump-pi.sh [version|latest]`: resolves the version, rewrites every pin (packages/review-extension/package.json, docker/reviewer/extension-package.json incl. pi-tui + typebox matched to pi-coding-agent's own dep), refreshes package-lock, reports remaining stale version mentions in docs/comments
- [ ] Run it → 1.1.0; review the 0.80.3 → 1.1.0 changelog for breaking changes affecting us (extension API/registerTool, `--mode json` events, models.json baseUrl override, CLI flags, --no-session etc.)
- [ ] Fix any breakage in review-extension / entrypoint / reviewer.ts parsing
- [ ] Update version-specific comments/docs (Dockerfile, README, entrypoint, config.ts, reviewer.ts, DISTRIBUTION.md, extension index.ts)
- [ ] Typecheck + full test suite green; local reviewer image build; `pi --version` in image; extension loads
- [ ] Document the bump procedure (docker/reviewer/README.md)
- [ ] Publish reviewer image + digest bump + live validation — CTO/user-gated, separate step
