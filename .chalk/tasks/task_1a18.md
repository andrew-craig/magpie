---
id: task_1a18
type: task
title: "Job queue — p-queue concurrency + per-job timeout"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a10, task_1a11]
created: 2026-07-05
---

# Job queue — p-queue concurrency + per-job timeout

Serialize review jobs with bounded concurrency and a hard timeout so a stuck or
runaway job can't wedge the service.

## Context
In-process `p-queue` with **concurrency 2** (from config) and a hard **per-job
timeout** (default 10 min). On timeout the job must be aborted and its workspace
cleaned up. Losing queued jobs on a crash is acceptable for personal use (a
re-push re-triggers review) — no Redis/BullMQ in this milestone.

## Scope
- A queue wrapper around `p-queue` with configurable concurrency.
- Enqueue a job descriptor (from task_1a14) that runs the job pipeline
  (clone → diff → Pi → post; wired in task_1a1b).
- Enforce a per-job wall-clock timeout that cancels the job and triggers cleanup
  (workspace removal; kill the Pi host process if still running).
- Structured logging per job: start, finish, duration, outcome (success / failed
  / timed-out / skipped).
- Basic dedup hook is a nice-to-have (replace a not-yet-started job for the same
  PR); full kill-and-requeue on newer SHA is a later milestone.

## Acceptance criteria
- No more than `concurrency` jobs run at once.
- A job exceeding the timeout is aborted and its workspace cleaned up.
- Each job logs a clear start/finish with outcome.

## Dependencies
- task_1a10 (scaffolding), task_1a11 (concurrency + timeout config)
