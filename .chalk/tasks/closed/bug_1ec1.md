---
id: bug_1ec1
title: Log Pi's final-turn diagnostics when report_findings is never called
type: bug
status: closed
priority: 1
labels: [reviewer,telemetry]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-24T02:41:58Z
updated_at: 2026-10-24T02:49:39Z
---
17 historical 'pi did not call report_findings' failures (latest: cairn-reader#436, job 0f8a0d8e, 2026-10-21T20:52Z, 58 turns, $0.72) are undiagnosable: reviewer.ts parses Pi's NDJSON stdout but discards the last assistant message, and only stopReason=error is surfaced. Can't distinguish (a) model ended with plain text, (b) stopReason=length truncated the tool call, (c) report_findings rejected by schema validation and not retried. Fix: include last assistant stopReason, a bounded/redacted snippet of its text, and whether a report_findings toolCall / error toolResult was seen, in result.reason (logged locally only since PR #88) and treat stopReason=length as a distinct reason.

## Review

- [x] `describeMissingReport()` in `reviewer.ts`: the zero-exit, no-findings-file reason now includes the last turn's `stopReason`, report_findings call count, rejected (isError toolResult) count with the last rejection text, and a redacted snippet (capped at 400 chars) of the final text. These diagnostics come before the stderr tail.
- [x] `stopReason=length` now gets its own lead phrase ("pi hit the output-token limit before report_findings completed").
- [x] Tests for the plain-text stop, length, and rejected-call cases, plus redaction and the length bound.
- [x] Fixed the pre-existing race in the abort-path test: it aborted after a fixed 50ms, sometimes before the fake docker had started. It now polls for invocation.json. Before the fix it failed in about half of full-suite runs.
- Since PR #88 the reason is logged locally only (`review-failed` event and telemetry) and never posted to the PR.
- Follow-up: once the next real failure happens, read the job's reason to tell apart (a) plain-text stop, (b) length, (c) a schema rejection. If `calls>0` but `rejected=0`, Pi reported the rejection some other way. The cost discrepancy is tracked separately in bug_40f2.
