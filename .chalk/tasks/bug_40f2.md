---
id: bug_40f2
title: Investigate Pi-reported vs gateway-metered cost discrepancy
type: bug
status: open
priority: 2
labels: [telemetry,gateway,cost]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-24T02:41:58Z
updated_at: 2026-10-24T02:41:58Z
---
Job 0f8a0d8e (cairn-reader#436, 2026-10-21T20:52Z): Pi usage reported costUsd=$0.3237 (in/out/total tokens 65666/43184/2995314) but gateway virtual key spentUsd=$0.7206 (budget $1). Telemetry top-level costUsd uses the gateway figure. Determine which is right (check OpenRouter activity for the generations), why they diverge >2x (cache-read pricing? Pi's model price table for z-ai/glm-5.3 stale/missing? gateway double-counting retries/streams? unmetered requests e.g. failed/aborted calls?), and whether the gap is systematic across telemetry.jsonl. Fix whichever side is wrong and/or document.
