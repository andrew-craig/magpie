---
id: bug_40f2
title: Investigate Pi-reported vs gateway-metered cost discrepancy
type: bug
status: in_progress
priority: 2
labels: [telemetry,gateway,cost]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-24T02:41:58Z
updated_at: 2026-10-24T20:25:09Z
---
Job 0f8a0d8e (cairn-reader#436, 2026-10-21T20:52Z): Pi usage reported costUsd=$0.3237 (in/out/total tokens 65666/43184/2995314) but gateway virtual key spentUsd=$0.7206 (budget $1). Telemetry top-level costUsd uses the gateway figure. Determine which is right (check OpenRouter activity for the generations), why they diverge >2x (cache-read pricing? Pi's model price table for z-ai/glm-5.3 stale/missing? gateway double-counting retries/streams? unmetered requests e.g. failed/aborted calls?), and whether the gap is systematic across telemetry.jsonl. Fix whichever side is wrong and/or document.

## Findings (2026-10-25)

**The gateway figure is right. Pi's figure is a static price-table estimate.**

- Pi's `usage.cost` comes only from its bundled price table (`@earendil-works/pi-ai@1.1.0` `dist/providers/data/openrouter.json`). For `z-ai/glm-5.3` that table has $0.062 / $3.39 / $0.06 per M tokens (input / output / cache-read). `65666*0.062 + 43184*3.39 + 2886464*0.06` per M = **$0.323653**, which is exactly Pi's reported figure. Pi never sees what OpenRouter actually billed.
- OpenRouter routes glm-5.3 across about 48 provider endpoints (checked live on 2026-10-25). Prices range from $0.075 to $2.80 input, $1.40 to $8.80 output, and $0.075 to $0.56 cache-read, all per M. Pi's table entry is below even today's cheapest endpoint. Cache reads dominate (2.89M of the 3.0M tokens), so the cache-read price spread drives the gap.
- The gateway charges OpenRouter's own per-request `usage.cost` (`determineCost`). It logs a warning whenever it falls back to an estimate. The journal (which retains from 2026-10-11 onward, covering this job) has **zero** `fell back` lines from magpie-gateway. Every request in that window was metered from OpenRouter's real cost, so nothing points to double-counting.
- **The gap is systematic across telemetry.jsonl, but not in one direction.** Over 339 jobs, gateway/Pi has median 0.81 and ranges from 0.12 to 9.1, in tight per-period bands: 0.12 (2026-08-09), about 0.34–0.39 (Aug/Sep), about 0.8, and 2–4× since about 2026-10-10. All-time totals: Pi $29.63, gateway $28.50. Each band lines up with a stale table row against whatever price OpenRouter was actually routing at.
- Not done: spot-checking against the OpenRouter activity dashboard (needs account access).

**Where the wrong number leaks:**
- `telemetry.ts` / `pipeline.ts`: already correct. The top-level `costUsd` is the gateway spend (cost of record, by design). `usage.costUsd` is Pi's estimate, kept only for cross-checking, but nothing labels it as an estimate.
- **PR comment footer** (`publisher.ts` `formatUsageFooter`): shows **Pi's estimate**, currently understating the real cost by 2–4×. This is the user-visible bug.
- `reviewer.ts` "pi run complete … cost=$" log line: also Pi's estimate.

**Side finding (separate issue):** reviewer containers stream every Pi `message_update` delta (thinking deltas etc.) into journald. That is why the 207M journal only reaches back to 2026-10-11, and why the gateway's startup lines have already rotated out.

## Plan
- [ ] Gateway: add `GET /admin/keys/:id` (loopback management plane, master key auth) returning `{spentUsd, budgetUsd}` without revoking.
- [ ] Orchestrator `gateway.ts`: `getGatewayKeySpend` (best-effort, never throws, like revoke).
- [ ] Pipeline: read the key's spend just before publishing and pass it to the publisher. The footer shows the gateway-metered cost. If the read fails, fall back to Pi's figure labelled as an estimate (`cost≈$… (est.)`).
- [ ] Label the Pi number as an estimate everywhere it remains: the telemetry.ts doc comment, the reviewer log line (`est_cost=`). Leave the `usage.costUsd` JSONL field name unchanged for compatibility with existing records.
- [ ] Tests: admin route, client helper, footer formatting (metered vs fallback), pipeline wiring.
- [ ] Docs: note in docs/review-flow.md (or the gateway README) that the cost of record is OpenRouter's billed `usage.cost` and Pi's number is a price-table estimate.
- [ ] Separate chalk bug for the journald flooding from reviewer streaming deltas.
