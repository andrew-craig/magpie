---
id: task_220f
title: M6-B: per-repo config — .magpie.toml read from the base branch only
type: task
status: open
priority: 3
labels: []
blocked_by: []
parent: epic_3c41
remote_task_url: null
created_at: 2026-07-10T21:53:08Z
updated_at: 2026-07-10T21:53:08Z
---
PLAN.md milestone 6. Allow repos to tune magpie without touching the server config.

- Read .magpie.toml via the GitHub contents API from the repo's DEFAULT/base branch only — NEVER from the PR head — so PR authors cannot alter review behaviour (config stays out of attacker control; this constraint is explicit in PLAN.md).
- Sensible overridable subset only: e.g. model choice within an allowed set, diff-size cap (never above the server cap), extra reviewer guidance appended as clearly-untrusted repo preferences, path ignore globs. Security-relevant knobs (budgets, network, tool allowlist, allowlist membership) remain server-side only.
- Validate with zod; a malformed file falls back to server defaults with a logged warning, never a failed review.

Done when: an allowlisted repo with a valid .magpie.toml on its default branch gets its overrides applied, and the same file on a PR branch has no effect.
