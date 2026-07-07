---
id: task_c53d
title: Pi host runner — run Pi against the diff
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:58:00Z
updated_at: 2026-07-07T21:22:12Z
---
Run the Pi coding agent DIRECTLY ON THE HOST over the PR checkout + diff and capture a plain-text review summary.

Context: M1 runs Pi as a plain host process (no container, no gateway yet — those are M3 and M4). Structured report_findings + inline comments are M2; here we only need a SINGLE text summary back. The provider key lives in the host env for now.

Scope:
- Invoke Pi headless against the workspace, e.g. pi -p --mode json --no-session --tools read,grep,find,ls --append-system-prompt "$(cat reviewer-prompt.md)" with the diff + changed-file list + PR title/description piped in as the prompt.
- CLEARLY DELIMIT PR title/description/diff as untrusted data in the prompt (prompt-injection hygiene), and instruct the reviewer to focus on correctness/security/clarity and cite file:line — no style nits a linter covers.
- Use a READ-ONLY tool allowlist (no bash, no write/edit).
- Parse Pi NDJSON stdout stream for logging/cost telemetry, and extract the final review text to hand to the publisher.
- Handle the failure case (Pi errors / never produces output / times out): return a clear failure result so the publisher can post a review-failed note rather than going silent.
- A committed reviewer-prompt.md with the reviewer instructions.

Acceptance criteria:
- Given a workspace + diff, produces a text review summary (or a clear failure result).
- Runs with read-only tools only; no shell/write tools enabled.
- NDJSON stream is parsed for basic run/cost logging.

Dependencies: task_ada6 (workspace checkout), task_0daf (diff to review).

## Plan (branch: pi-host-runner)

Verified Pi contract: Pi 0.80.3; native OpenRouter via `OPENROUTER_API_KEY` +
`--provider openrouter`; read-only tools `read,grep,find,ls` (per Pi usage.md
line 283); `--mode json` → NDJSON event stream, final assistant text in
`message_end`/`agent_end`, usage in message metadata.

Design decisions (M1): (1) OpenRouter-native provider — config `base_url`
assumed OpenRouter for now; custom base URL arrives with the M4 gateway.
(2) Text-summary only — no `report_findings` extension (that is M2).

- [x] `packages/orchestrator/src/reviewer.ts`: `runReview({ workspaceDir, diff,
      changedFiles, prTitle, prBody, config })` → `ReviewResult`
      (`{ ok: true, summary, usage? } | { ok: false, reason }`).
- [x] Invoke `pi -p --mode json --no-session --tools read,grep,find,ls
      --provider openrouter --model <config.llm.model>
      --append-system-prompt <reviewer-prompt.md>`, `cwd = workspaceDir`.
      Subprocess env: `OPENROUTER_API_KEY = config.secrets.llmApiKey` (do NOT
      inherit/leak other secrets). Prompt payload (PR title/body + changed-file
      list + diff) piped as the user message.
- [x] `reviewer-prompt.md`: reviewer instructions; fence PR title/body/diff as
      UNTRUSTED DATA (injection hygiene); focus correctness/security/clarity;
      cite file:line; skip lint-style nits.
- [x] Parse NDJSON stdout line-by-line: extract final assistant text as summary;
      log turn/token/cost telemetry from message metadata.
- [x] Failure handling: non-zero exit / no output / timeout at
      `config.limits.jobTimeoutSeconds` (default 600s) → `{ ok: false, reason }`.
- [x] `reviewer.test.ts`: offline, stub the `pi` binary with a fake
      NDJSON-emitting script — success, empty-output, and timeout paths. No
      live LLM calls.
- [x] `npm run build` + `npm test` green (64 tests).

## Review notes

Live smoke-tested against real Pi 0.80.3 + OpenRouter: NDJSON shape matches the
parser exactly; `--append-system-prompt <path>` confirmed to read the file
(Pi's `resolvePromptInput` does `existsSync ? readFileSync : literal`). The
smoke run surfaced a real gap — a failed model call exits Pi with code 0 and an
assistant `message_end` carrying `stopReason:"error"` + `errorMessage` (we saw a
provider `402 Insufficient credits`); the runner now surfaces that as
`pi review failed: <errorMessage>` instead of the opaque "no assistant text".

INFRA BLOCKER for live e2e (task_9b61): the OpenRouter account has $0 balance
(402). Key is valid; needs credits (or a funded provider) before a real review
can run. Does NOT block landing this runner.
