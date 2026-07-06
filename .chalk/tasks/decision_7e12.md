---
id: decision_7e12
title: M1 execution decisions (tech-lead session)
type: decision
status: open
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-06T04:29:18Z
updated_at: 2026-07-06T04:29:18Z
---
Governing decisions for the M1 build session (tech lead + sonnet subagents).

INFRA / CREDENTIALS: 'Provision as we go.' No GitHub App, test repo, or LLM key present on host yet. Agents build REAL interfaces + code now, unit-tested against mocks/fixtures. CTO provisions each credential as it lands; live wiring/verification happens at that point. task_9b61 (live E2E) stays blocked until creds exist.

PI AGENT: Not installed on host. Decision: install & pin real Pi (@earendil-works/pi-coding-agent) when we reach task_c53d; build runner against the real binary.

CADENCE: Wave-by-wave. Tech lead dispatches a wave of sonnet subagents, reviews their code + test evidence, reports summary to CTO, waits for go-ahead before next wave.

REPO CONVENTIONS (set this session):
- Test runner: vitest (established by config task, first to need tests). npm 'test' script at root.
- Config: TOML (smol-toml) + zod validation. Secrets via env, non-secrets in TOML.
- Env var scheme: MAGPIE_WEBHOOK_SECRET, MAGPIE_GITHUB_PRIVATE_KEY (PEM contents) OR private_key_path in TOML, MAGPIE_LLM_API_KEY. Non-secret app_id / provider base URL / model in TOML.
- ESM, strict TS, Node 22 target (host runs Node 24, fine).

DEP GRAPH (waves): W0 config(9c52) -> W1 webhook(9af4)+queue(6431)+github-auth(b5cf) -> W2 event-filter(3c49)+smee(d4a8)+clone(ada6) -> W3 diff(0daf) -> W4 pi-runner(c53d) -> W5 post-comment(292c) -> W6 e2e(9b61).
