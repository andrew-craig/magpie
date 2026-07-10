---
id: task_5b3a
title: M3-A: magpie-reviewer container image (Dockerfile + entrypoint + build script)
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_a580
remote_task_url: null
created_at: 2026-07-10T06:47:20Z
updated_at: 2026-07-10T07:48:29Z
---
Wave 1 (parallel with task_037b). Build the `magpie-reviewer` Docker image that runs Pi
headless over a mounted worktree. Pure image/build work — no orchestrator TS changes here.
The image is the runtime contract that task_4ed4 (M3-C) `docker run`s.

## Background you need

- Today `reviewer.ts` spawns `pi` on the host with these flags (keep them identical inside the
  container): `pi -p --mode json --no-session --no-extensions -e <extension> --tools
  read,grep,find,ls,report_findings --append-system-prompt <reviewer-prompt.md>`, with the diff +
  PR metadata piped on **stdin**. Read the current `reviewer.ts` (`buildPromptPayload`, the
  `spawn` call, and the args array) to copy the exact flag set — do not invent new flags.
- The `report_findings` extension source lives at `packages/review-extension/src/index.ts`. Pi
  runs TS extension sources directly (no build step). The system prompt is `reviewer-prompt.md`
  at the repo root. Both get **baked into the image**.

## Deliverables

1. **`docker/reviewer/Dockerfile`**
   - Base `node:22-slim` (pin to a digest or exact tag, e.g. `node:22.x.y-slim` — no floating `22`).
   - Install `git` (Pi may still expect it on PATH even though we strip `.git`; keep the image
     minimal otherwise). `apt-get ... && rm -rf /var/lib/apt/lists/*`.
   - Install Pi at a **pinned exact version**: `@earendil-works/pi-coding-agent@<version>`
     (match the version currently used on the host — run `pi --version` / check the host install
     and pin to it; record the pinned version in a comment).
   - Copy the review extension and `reviewer-prompt.md` into `/opt/magpie/` (e.g.
     `/opt/magpie/review-extension/` and `/opt/magpie/reviewer-prompt.md`). Bring in only what the
     extension needs to run (its `src` + any runtime deps). If the extension imports from
     `@sinclair/typebox` or Pi's SDK, make sure those resolve inside the image.
   - Create a non-root `reviewer` user (uid/gid documented) as defence-in-depth, BUT see the epic's
     decision #4: M3-C is expected to override with `--user <hostuid>` for `/out` writability. The
     image must not *depend* on being run as `reviewer`.
   - `WORKDIR /work`. Do not bake secrets or config into the image.
   - `ENTRYPOINT` = the entry script below.

2. **`docker/reviewer/entrypoint.sh`** (or a small `entrypoint.mjs`)
   - `exec pi -p --mode json --no-session --no-extensions -e /opt/magpie/review-extension/... 
     --tools read,grep,find,ls,report_findings --append-system-prompt /opt/magpie/reviewer-prompt.md`
     — referencing the **baked-in** paths, reading the prompt payload from **stdin**, running in
     `/work`. `exec` so Pi is PID 1's replacement and receives signals (needed for `docker kill`).
   - Reads `MAGPIE_FINDINGS_PATH` (M3-C sets it to `/out/findings.json`) and
     `OPENROUTER_API_KEY` / `OPENAI_BASE_URL` from env — the entry script must NOT hardcode any of
     these. Do not echo env to logs.

3. **`scripts/build-reviewer-image.sh`** (executable, idempotent)
   - `docker build -t magpie-reviewer:<tag> -f docker/reviewer/Dockerfile .` with the build context
     at repo root (so it can COPY the extension + prompt). Tag scheme: use a content/version tag
     (e.g. `magpie-reviewer:0.1.0`) AND optionally `:latest`; the concrete default tag string must
     match what task_037b puts in config (`magpie-reviewer:0.1.0` suggested — coordinate).
   - Add an npm script alias at repo root (`"build:reviewer-image"`) that calls it, for discoverability.

4. **Docs:** a short `docker/reviewer/README.md` (or a section in the root README) covering: how to
   build, the pinned Pi/base-image versions, that the extension + prompt are baked in so a rebuild is
   required when they change, and the interim "real key still injected, no egress lockdown yet — M4"
   note from the epic.

## Acceptance criteria

- `scripts/build-reviewer-image.sh` builds cleanly on the target host (docker available).
- **Smoke test (document the exact commands + output in the task Review section):**
  - `docker run --rm magpie-reviewer:<tag> pi --version` (or equivalent) prints the pinned version.
  - A hand-run of the full entrypoint against a tiny throwaway worktree + `/out` temp dir, with a
    valid `OPENROUTER_API_KEY` and a piped prompt, produces a valid `/out/findings.json` parseable
    by the M2 schema. (This proves the baked extension + prompt + tools + findings path all work
    end-to-end inside the container, independent of the orchestrator.)
  - Confirm the image runs with `--read-only --tmpfs /tmp --user <non-root uid>` without write
    errors outside `/tmp` and `/out`.
- All versions pinned (no floating tags); no secrets in the image (`docker history` / image inspect
  shows none).

## Out of scope

No gateway, no `magpie-net`, no iptables, no egress assertion (M4). No orchestrator TS changes
(that's M3-C). Do not wire this into `reviewer.ts` — just deliver a runnable image + build script.

Depends on: nothing. Blocks: task_4ed4 (M3-C), task_d8aa (M3-D).
