---
id: task_e365
title: M7-0: Feasibility spike — Pi reaches the gateway over a unix socket via an in-container forwarder
type: task
status: open
priority: 1
labels: [distribution,spike]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:34:18Z
updated_at: 2026-07-12T13:34:18Z
---
GATE for the whole epic. Prove Design D's reviewer->gateway channel works end-to-end at the pinned Pi version (0.80.3): reviewer container runs --network none (loopback only); a tiny TCP->unix forwarder listens on 127.0.0.1:4000 inside it; docker/reviewer/entrypoint.sh writes ~/.pi/agent/models.json baseUrl=http://127.0.0.1:4000/v1 (as it already does for the gateway URL, see reviewer.ts:32-41); the forwarder relays to a mounted unix socket served by the gateway; a real chat-completions request returns. reviewer.ts already relies on Pi honouring an arbitrary HTTP baseUrl, so this should work — but it gates the architecture, so verify before the build tasks proceed. Fallback: if Pi ever grows native unix-socket support, drop the forwarder.
