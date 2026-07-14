---
id: task_de02
title: M7-8: Reframe docs to self-hostable; platform matrix; add Distribution milestone to PLAN.md
type: task
status: closed
priority: 3
labels: [distribution,docs]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-14T22:33:23Z
---
Reframe README/PLAN.md/CLAUDE.md from 'a personal Linux server' to 'self-hostable by any organisation'. Add a supported-platform matrix (any Linux host with Docker available to run the reviewer image; amd64 + arm64; cloud VM or Pi). Add the Distribution work as a milestone (M7) in PLAN.md and cross-link DISTRIBUTION.md.

## Review / results (2026-07-15)

Reframe docs to self-hostable + platform matrix + M7 milestone, per DISTRIBUTION.md §3.4/§4. Docs-only (sonnet subagent, tech-lead reviewed line-by-line).

**Changes (3 files — note CLAUDE.md is a symlink → AGENTS.md, the real edited file):**
- `AGENTS.md`/`CLAUDE.md` line 3: "for a personal Linux server" → "that any organisation can run on its own Linux host". SINGLE sentence changed; all operational/task-tracking instructions byte-identical (verified via diff).
- `README.md`: headline reframed to "any organisation can stand up its own instance" (with honest single-host/single-tenant caveat) + cross-links DISTRIBUTION/QUICKSTART/INSTALL; new "## Supported platforms" table (systemd, Docker, amd64+arm64, cloud VM or Pi, pluggable ingress → docs/ingress.md). Sits above the existing from-source Prerequisites/Setup section — different audience, no conflict.
- `PLAN.md`: line-3 reframe (preserves single-host/single-tenant honesty) + top-of-file DISTRIBUTION.md cross-link; milestone **7. Distribution / self-hosting (M7)** appended after "6. Nice-to-haves" (Design D --network none + unix socket, GHCR multi-arch signed image, host-service tarball, portable config + openssl rand master key, pluggable ingress, QUICKSTART onboarding; cross-links DISTRIBUTION.md). Two scale-rationale mentions of "personal use"/"personal project" (~L118/L171) reworded to "single-host deployment" with the technical reasoning preserved exactly.

**Accuracy guardrails honored:** no multi-tenant/horizontal-scale overclaim (explicit single-host/single-tenant caveat kept); OpenRouter-only not contradicted; in-process-queue tradeoff rationale intact. `git diff --stat` = only README.md, PLAN.md, AGENTS.md. All cross-linked paths exist.
