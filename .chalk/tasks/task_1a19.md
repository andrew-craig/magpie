---
id: task_1a19
type: task
title: "Pi host runner — run Pi against the diff"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a16, task_1a17]
created: 2026-07-05
---

# Pi host runner — run Pi against the diff

Run the Pi coding agent **directly on the host** over the PR checkout + diff and
capture a plain-text review summary.

## Context
Milestone 1 runs Pi as a plain host process (no container, no gateway yet — those
are milestones 3 and 4). Structured `report_findings` + inline comments are
milestone 2; here we only need a **single text summary** back. The provider key
lives in the host env for now.

## Scope
- Invoke Pi headless against the workspace, e.g.
  `pi -p --mode json --no-session --tools read,grep,find,ls
  --append-system-prompt "$(cat reviewer-prompt.md)"` with the diff + changed-file
  list + PR title/description piped in as the prompt.
- **Clearly delimit PR title/description/diff as untrusted data** in the prompt
  (prompt-injection hygiene), and instruct the reviewer to focus on
  correctness/security/clarity and cite file:line — no style nits a linter covers.
- Use a **read-only tool allowlist** (no `bash`, no `write`/`edit`).
- Parse Pi's NDJSON stdout stream for logging/cost telemetry, and extract the
  final review text to hand to the publisher (task_1a1a).
- Handle the failure case (Pi errors / never produces output / times out): return
  a clear failure result so task_1a1a can post a "review failed" note rather than
  going silent.
- A committed `reviewer-prompt.md` with the reviewer instructions.

## Acceptance criteria
- Given a workspace + diff, produces a text review summary (or a clear failure
  result).
- Runs with read-only tools only; no shell/write tools enabled.
- NDJSON stream is parsed for basic run/cost logging.

## Dependencies
- task_1a16 (workspace checkout), task_1a17 (diff to review)
