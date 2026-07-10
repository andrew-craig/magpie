---
id: epic_e6e6
title: Milestone 2 — Structured findings + inline PR comments
type: epic
status: closed
priority: 1
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-09T06:32:53Z
updated_at: 2026-07-10T02:55:35Z
---
Replace M1's single plain-text summary comment with structured, diff-anchored inline review comments, keeping the M1 host-subprocess model (containerization is M3, NOT in scope here).

DECISION (CTO, 2026-07-09): M2 keeps Pi running as a plain host subprocess. The report_findings extension writes findings to a host file whose path is passed via the MAGPIE_FINDINGS_PATH env var (forward-compatible with M3's mounted /out dir). No container, no gateway in this milestone.

CANONICAL FINDINGS CONTRACT (both the extension's Typebox schema AND the orchestrator's zod validator must match this exactly):
  report_findings({
    findings: Array<{
      path: string,           // repo-relative file path, matching the diff
      line: number,           // 1-based line number in the NEW file (right side of diff)
      end_line?: number,      // optional, for multi-line ranges (>= line)
      severity: 'blocking' | 'important' | 'nit',
      category: string,       // free-form short tag, e.g. 'correctness','security','clarity'
      message: string,        // the finding text
      suggestion?: string     // optional suggested fix
    }>,
    summary: string,          // overall review summary (markdown)
    verdict: 'approve' | 'comment'   // advisory only; Magpie ALWAYS posts as COMMENT regardless
  })

PIPELINE CHANGE: reviewer.ts returns findings+summary; orchestrator anchors each finding to the parsed diff hunks; anchored findings become inline comments in ONE pulls.createReview(event=COMMENT); out-of-diff findings fold into the summary body under 'Other observations'. Failure/tooLarge paths keep M1's single issues.createComment.

Task graph (3 waves): W1 = task_A(extension)+task_B(anchoring) parallel; W2 = task_C(publisher)+task_D(reviewer wiring) parallel; W3 = task_E(pipeline integration + live e2e). See PLAN.md sections 6 & 7.
