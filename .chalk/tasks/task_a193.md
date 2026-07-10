---
id: task_a193
title: M5-B: incremental re-review on synchronize — review only the before...after range
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:52:09Z
updated_at: 2026-07-10T21:52:09Z
---
Wave 1 (parallel with M5-A). PLAN.md §7 re-review scope.

- On synchronize events, use the payload's before/after SHAs to compute the incremental diff (GitHub compare API before...after) instead of re-reviewing the full PR diff, so a small follow-up push doesn't re-review (and re-bill) the whole PR.
- Guard the edge cases: force-push where before is unreachable, before...after empty (e.g. rebase-only), and the existing head-SHA-mismatch race guard from the hardening pass must keep working — fall back to the full PR diff whenever the incremental range is unavailable or suspect.
- The diff-size cap applies to the incremental range; keep the existing behaviour above the cap.
- Prompt should tell the reviewer this is an incremental update to an already-reviewed PR (full changed-file list still available as context).

Done when: a synchronize after an initial review sends only the new range to Pi (observable in logs/prompt), with a clean fallback to full-diff when the range can't be resolved.
