---
id: task_eaf9
title: M4-C: point Pi at the gateway — base-URL override, only the virtual key in the container env
type: task
status: open
priority: 1
labels: []
blocked_by: [task_eb22,task_8667]
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:51:06Z
updated_at: 2026-07-10T21:51:06Z
---
Wave 2/3. Rewire the reviewer invocation so the container never sees the real provider key (PLAN.md §4/§5).

- Confirm how Pi overrides provider base URL + key (pi-ai provider config; PLAN.md assumes OPENAI_BASE_URL/OPENAI_API_KEY-style env). Pass the gateway URL (as reachable from magpie-net) and the per-job virtual key from M4-B into the docker run env; remove the long-lived provider key from the container invocation entirely.
- The real OpenRouter key must no longer appear anywhere in the reviewer path: not in the image, not in the container env, not on the workspace mount.
- If Pi turns out not to support a base-URL override, fall back to PLAN.md §5's transparent TLS-terminating credential-injecting proxy (injected CA, NODE_EXTRA_CA_CERTS) — but prefer the gateway; treat the fallback as a scope change worth flagging.

Done when: a real end-to-end review completes with the container holding only the per-job virtual key, verified by inspecting the container env.
