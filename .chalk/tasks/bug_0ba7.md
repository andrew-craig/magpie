---
id: bug_0ba7
title: Reviewer containers flood journald with Pi streaming deltas
type: bug
status: open
priority: 3
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-24T20:35:58Z
updated_at: 2026-10-24T20:35:58Z
---

Found during bug_40f2 (2026-10-25). Each reviewer container's stdout (Pi's NDJSON event stream, including every `message_update` thinking/text delta) lands in the host journal under `magpie-<jobId>` identifiers. The 207M journal on the Pi host only reaches back to 2026-10-11, so gateway/orchestrator logs rotate out after about 2 weeks (e.g. the gateway's startup line from 2026-09-27 is gone). Likely cause: podman's journald log driver, or conmon forwarding container stdout. Fix options: `--log-driver none`/`k8s-file` with a size cap for reviewer containers (the orchestrator already consumes stdout directly), or filtering delta events. Check that the orchestrator's own NDJSON parsing is unaffected.
