---
id: task_f84f
title: Post short failure comment with error ID; log full reason locally
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-24T01:25:45Z
updated_at: 2026-10-24T01:27:57Z
---


## Plan
- [x] publisher.ts: failure note no longer embeds `result.reason`; shows a short message + `Error ID: <id>`
- [x] pipeline.ts: log `review-failed` (logger.error) with the full reason + errorId (= job.id) before publishing; pass errorId to publishReview
- [x] Remove now-dead `fenceReason` and its tests; update publisher/pipeline tests

## Review
Error ID is the job's existing UUID, so it also matches every other log line for the job
(`id` field) and the `jobId` in the telemetry JSONL record, which already stores the full
`reason`. Full detail is in journald (`journalctl -u magpie | grep <id>`) and
`/var/lib/magpie/telemetry.jsonl`.
