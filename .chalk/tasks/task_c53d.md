---
id: task_c53d
title: Pi host runner — run Pi against the diff
type: task
status: open
priority: 1
labels: []
blocked_by: [task_ada6,task_0daf]
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:58:00Z
updated_at: 2026-07-05T22:58:00Z
---
Run the Pi coding agent DIRECTLY ON THE HOST over the PR checkout + diff and capture a plain-text review summary.

Context: M1 runs Pi as a plain host process (no container, no gateway yet — those are M3 and M4). Structured report_findings + inline comments are M2; here we only need a SINGLE text summary back. The provider key lives in the host env for now.

Scope:
- Invoke Pi headless against the workspace, e.g. pi -p --mode json --no-session --tools read,grep,find,ls --append-system-prompt "$(cat reviewer-prompt.md)" with the diff + changed-file list + PR title/description piped in as the prompt.
- CLEARLY DELIMIT PR title/description/diff as untrusted data in the prompt (prompt-injection hygiene), and instruct the reviewer to focus on correctness/security/clarity and cite file:line — no style nits a linter covers.
- Use a READ-ONLY tool allowlist (no bash, no write/edit).
- Parse Pi NDJSON stdout stream for logging/cost telemetry, and extract the final review text to hand to the publisher.
- Handle the failure case (Pi errors / never produces output / times out): return a clear failure result so the publisher can post a review-failed note rather than going silent.
- A committed reviewer-prompt.md with the reviewer instructions.

Acceptance criteria:
- Given a workspace + diff, produces a text review summary (or a clear failure result).
- Runs with read-only tools only; no shell/write tools enabled.
- NDJSON stream is parsed for basic run/cost logging.

Dependencies: task_ada6 (workspace checkout), task_0daf (diff to review).
