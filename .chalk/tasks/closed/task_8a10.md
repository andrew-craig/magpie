---
id: task_8a10
title: M5-D: cost logging + per-job telemetry
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:52:34Z
updated_at: 2026-07-24T13:04:28Z
---
Wave 1 (parallel; independent of M5-B/C). PLAN.md §6 post-hoc cost logging.

- The reviewer already parses Pi's NDJSON usage events (M1 reviewer.ts) and the PR comment carries a usage footer; extend this into durable per-job telemetry: structured log line (and/or an append-only JSONL under /var/lib/magpie) per job with repo, PR, head SHA, outcome, wall-clock, tokens in/out, and cost.
- Cross-check reported usage against the gateway: the custom TypeScript gateway (M4-A `packages/gateway`, NOT LiteLLM — see PLAN.md §5 deviation box) tracks spend per virtual key in its in-memory keystore (`recordSpend`, debited from each upstream response's usage/cost by proxy-server.ts). Log the key's final spend alongside Pi's self-reported usage — the gateway number is the authoritative one for cost. NOTE (switch consequence): unlike LiteLLM, our gateway's management plane currently exposes only mint (`POST /admin/keys`) and revoke (`DELETE /admin/keys/:id`, 204 no body) — there is NO endpoint to read a key's accumulated spend. M5-D must add a way to surface it, e.g. a `GET /admin/keys/:id` returning `{ spendUsd, ... }`, or have revoke return the final spend in its response body, then thread that value through gateway.ts's `revokeGatewayKey`/pipeline cleanup into the telemetry record. This is net-new gateway + orchestrator work, not just wiring an existing API.
- Log budget exhaustion and timeout kills distinctly so runaway-cost patterns are visible.
- Keep it greppable: one summary line per job is the interface; no dashboards in scope.

Done when: after any review (success or failure) a single structured record exists with cost + outcome, and gateway-reported spend is included when the gateway is in play.

## Plan (branch: m5-d-cost-logging)

### 1. Gateway: net-new spend-read surface (revoke returns final spend)
- [x] `packages/gateway/src/keystore.ts`: change `revoke(id)` to return the removed entry's
      `{ id, spentUsd, budgetUsd }` (or `undefined` if the id was unknown/already revoked),
      instead of `void`. Stays idempotent/never-throws.
- [x] `packages/gateway/src/admin-server.ts`: `DELETE /admin/keys/:id` now responds
      `200 { id, revoked: boolean, spentUsd?, budgetUsd? }` instead of bare `204` (a 204 can't
      carry a body). Still idempotent — unknown/already-gone id -> `200 { id, revoked: false }`,
      never an error.
- [x] Update `packages/gateway/src/keystore.test.ts` / `admin-server.test.ts` for the new
      return shape/status code.
- [x] Update `packages/gateway/README.md`'s management-plane section for the new DELETE contract.

### 2. Orchestrator: thread spend through revoke
- [x] `packages/orchestrator/src/gateway.ts`: `revokeGatewayKey`/`revokeGatewayKeyFromConfig` now
      resolve `{ spentUsd, budgetUsd } | undefined` (best-effort — still never throws; `undefined`
      on any non-2xx/unreachable/unparseable response, same as today's silent-log behavior).
- [x] `packages/orchestrator/src/gateway.test.ts`: update/add cases for the new parsed return
      value (200 body, missing body, malformed body).
- [x] `packages/orchestrator/src/pipeline.ts`: capture the resolved spend from the (now
      non-void) revoke call for use in the telemetry record.

### 3. Reviewer: surface Pi's usage on FAILURE paths too
- [x] `packages/orchestrator/src/reviewer.ts`: `ReviewResult`'s `{ ok: false }` branch gains an
      optional `usage?: ReviewUsage` field. Compute a best-effort `usage` from the raw streamed
      `assistantMessages` right after the stdout flush (before the timeout/aborted/non-zero-exit
      branches) and attach it to those `finish()` calls; the missing-findings/invalid-findings
      failure branches already have `usage` in scope by the time they call `finish()` — attach it
      there too. No change to the `ok: true` computation.

### 4. New telemetry module + config
- [x] `packages/orchestrator/src/telemetry.ts` (new): `JobOutcome` enum (`success`,
      `diff-too-large`, `already-reviewed`, `head-sha-mismatch`, `timeout-kill`, `aborted`,
      `budget-exhausted`, `error`), `JobTelemetryRecord` shape (repo, owner, prNumber, headSha,
      jobId, outcome, durationMs, costUsd (authoritative), usage (Pi self-reported), gateway
      (spentUsd/budgetUsd/keyId), reason), and `recordJobTelemetry()`: always emits one
      structured log line (so it's greppable even with a read-only filesystem), THEN
      best-effort appends one JSONL line to a configurable path (`mkdir -p` the parent dir first),
      swallowing/logging any write failure rather than throwing.
- [x] `packages/orchestrator/src/config.ts`: new `[telemetry]` section, `path` field, default
      `/var/lib/magpie/telemetry.jsonl`.
- [x] `config.example.toml`: document the new `[telemetry]` section.
- [x] `packages/orchestrator/src/telemetry.test.ts` (new): covers JSONL append, log-line
      fallback on an unwritable dir, and record shape.

### 5. Wire telemetry into the pipeline
- [x] `packages/orchestrator/src/pipeline.ts`: wrap `runJob`'s body so exactly one
      `recordJobTelemetry` call happens on every exit path (early return, thrown error, or
      normal completion) via an outer `try/finally`, classifying `outcome` from: early-exit
      markers (aborted/already-reviewed/head-sha-mismatch) captured inline, the `ReviewResult`
      (success vs diff-too-large vs timeout-kill vs aborted vs budget-exhausted-or-error), and
      the gateway-reported spend (>= budget on an otherwise-generic failure reclassifies it as
      `budget-exhausted` — this is the authoritative signal, not string-matching Pi's error text).
- [x] `packages/orchestrator/src/pipeline.test.ts`: new tests asserting one telemetry record is
      emitted for a success, a timeout, a budget-exhausted failure (via gateway spend >=
      budget), and a generic failure; assert the gateway spend is threaded in when the fake
      revoke returns it.

### 6. Verification
- [x] `npm run build` (typecheck) + `npm test` across both packages.
- [x] Manually eyeball an example JSONL line for shape/readability.

## Review

### Gateway spend-API decision
Chose **revoke returns the final spend in its response body** over a separate `GET /admin/keys/:id`
(as the task recommended). Rationale: spend is read at exactly the cleanup point the lifecycle
already has (one round-trip, no new endpoint, no window where a key is revoked-but-not-yet-read).
`DELETE /admin/keys/:id` changed from bare `204` to `200 { id, revoked, spentUsd?, budgetUsd? }`
(a 204 can't carry a body). Still idempotent: unknown/already-revoked id -> `200 { id, revoked: false }`,
no spend fields, never an error. `KeyStore.revoke()` now returns the pre-deletion
`{ id, spentUsd, budgetUsd }` snapshot (or `undefined`).

### Cost of record
`costUsd` = the gateway's own tracked spend (`spentUsd`, from OpenRouter's `usage.cost`) when a
key was in play; falls back to Pi's self-reported cost, then 0. Pi's self-report is still logged
under `usage` for cross-checking but is never authoritative. `budget-exhausted` is decided from
the gateway's reported spend (`spentUsd >= budgetUsd`), NOT by string-matching Pi's error text.

### Distinct outcome classes
`success` / `diff-too-large` / `already-reviewed` / `head-sha-mismatch` / `timeout-kill` /
`aborted` / `budget-exhausted` / `error` — classified by the pure, exported `classifyJobOutcome`.
Timeout/abort kills win over budget (a job killed on time is a timeout-kill even if spend hit the cap).

### Telemetry sinks
Two, by design: ALWAYS one structured `logger.info` line (the floor guarantee — greppable via
journald), THEN a best-effort JSONL append to `config.telemetry.path`
(default `/var/lib/magpie/telemetry.jsonl`, under the existing systemd `StateDirectory=magpie`).
A JSONL write failure (e.g. dev box without /var/lib/magpie) is logged (`telemetry-write-failed`)
and never thrown — the job is unaffected.

### Example JSONL line (real output from the telemetry module)
```
{"event":"job-telemetry","timestamp":"2026-07-24T07:32:22.487Z","jobId":"job-8f3a2c","owner":"acme","repo":"widgets","prNumber":42,"headSha":"deadbeef1234","outcome":"success","durationMs":41230,"costUsd":0.0317,"usage":{"turns":3,"inputTokens":18422,"outputTokens":1204,"totalTokens":19626,"costUsd":0.0301},"gateway":{"keyId":"gw-3c1f","spentUsd":0.0317,"budgetUsd":0.5}}
{"event":"job-telemetry","timestamp":"2026-07-24T07:32:22.488Z","jobId":"job-11b7","owner":"acme","repo":"widgets","prNumber":43,"headSha":"cafef00d","outcome":"budget-exhausted","durationMs":92110,"costUsd":0.5,"usage":{...},"gateway":{"keyId":"gw-9a2e","spentUsd":0.5,"budgetUsd":0.5},"reason":"pi review failed: 402 budget exhausted for this key"}
```

### Files changed
Gateway: `keystore.ts` (revoke returns spend snapshot + `RevokedKeySpend`), `admin-server.ts`
(DELETE 200+body), `keystore.test.ts`, `admin-server.test.ts`, `README.md`.
Orchestrator: `telemetry.ts` (NEW), `telemetry.test.ts` (NEW), `gateway.ts` (revoke parses+returns
`GatewayKeyRevocation`), `gateway.test.ts`, `pipeline.ts` (outer try/finally telemetry wrapper +
exported `classifyJobOutcome`), `pipeline.test.ts`, `reviewer.ts` (`{ok:false}` gains optional
`usage`, populated on timeout/abort/exit/missing-findings paths), `config.ts` (`[telemetry].path`),
and the 8 test files that build a full `Config` (added `telemetry` field). Root: `config.example.toml`.

### Verification
- `npm test`: gateway 68 pass, orchestrator 306 pass, review-extension 11 pass.
- `npm run build` (tsc typecheck) clean for both packages. No lint tooling in repo.
- Ran the telemetry module directly via tsx to eyeball the real serialized line (above): success
  path (gateway spend authoritative) + budget-exhausted kill path both render correctly on both
  sinks (log line carries `level:"info"`, JSONL line doesn't).
- Pipeline-level tests assert exactly one `job-telemetry` record on success, generic error,
  budget-exhausted, already-reviewed (no key minted, cost 0), and a post-mint thrown error.

### Open questions (for tech-lead)
- The mid-review abort race where `runReview` returns `{ok:true}` in the same tick the signal
  aborts is currently recorded as `success` (the review DID complete; we just don't publish).
  Left as-is; flag if you'd prefer it recorded `aborted`.
- No log-rotation/size-cap on telemetry.jsonl (append-only, unbounded). Out of scope per "no
  dashboards"; an operator can logrotate it. Note if you want a cap.

