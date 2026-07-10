---
id: task_4ed4
title: M3-C: reviewer.ts — replace host subprocess with hardened docker run
type: task
status: open
priority: 1
labels: []
blocked_by: []
parent: epic_a580
remote_task_url: null
created_at: 2026-07-10T06:47:25Z
updated_at: 2026-07-10T09:22:13Z
---
Wave 2 (depends on task_5b3a image + task_037b plumbing). The core of M3: rewrite the internals
of `reviewer.ts` so `runReview` runs the reviewer inside a hardened `docker run` instead of a host
`spawn` of `pi`. **The public contract must not change** — same `RunReviewParams` in, same
`ReviewResult` out — so pipeline.ts and every existing test keep working with minimal edits.

## Read first

- `packages/orchestrator/src/reviewer.ts` in full: `RunReviewParams`, `ReviewResult`, the `spawn`
  call, the args array, the `env.MAGPIE_FINDINGS_PATH` / `OPENROUTER_API_KEY` setup, the
  MAGPIE_*-secret stripping, the SIGTERM→SIGKILL grace kill, the abort-signal handling, and the
  NDJSON stdout parsing that produces `ReviewUsage`.
- The M3-A image contract (baked entrypoint, flags, `/work`, `/out/findings.json`) and the M3-B
  helpers/config (`prepareReviewMount`, `createOutputDir`, `container.*` config, docker preflight).

## What changes inside `runReview`

Replace the host-`pi` `spawn` with a `spawn` of `<config.container.dockerBin> run ...`. Keep the
surrounding structure (abort guard, kill-grace helper, NDJSON parsing, findings read + `parseFindings`)
as intact as possible — you are swapping the child process, not rewriting the module.

1. **Build the mounts:** call `prepareReviewMount(workspaceDir)` and `createOutputDir()` (M3-B).
   `try/finally` so both are cleaned up on every exit path (success/failure/abort). If `runReview`
   is not the natural owner of mount cleanup, coordinate with M3-D on where it lives — but do NOT
   leak temp dirs.

2. **Assemble the hardened `docker run` argv** (mirror PLAN.md §4 exactly; values from config):
   ```
   run --rm
   --name magpie-<jobId>            # need a stable per-job name for docker kill (see below)
   --user <hostuid>:<hostgid>       # epic decision #4 — for /out writability
   --read-only --tmpfs /tmp
   --cap-drop=ALL --security-opt=no-new-privileges
   --memory=<container.memory> --cpus=<container.cpus> --pids-limit=<container.pidsLimit>
   --network <container.network>    # "bridge" in M3; M4 flips to magpie-net
   -v <mountDir>:/work:ro
   -v <outDir>:/out
   -e OPENAI_BASE_URL=<config.llm.baseUrl>   # confirm the exact env var Pi honours for base URL
   -e OPENROUTER_API_KEY=<provider key>      # same key reviewer.ts injects today (interim, M4 removes)
   -e MAGPIE_FINDINGS_PATH=/out/findings.json
   -i                               # keep stdin open; prompt payload is piped in
   <config.container.image>
   ```
   - The prompt payload (from `buildPromptPayload`) is written to the container's **stdin** exactly
     as today. Ensure `-i` and that you write+end stdin the same way.
   - **jobId / container name:** `runReview` currently has no jobId. Add an optional `jobId` (or a
     `containerName`) to `RunReviewParams` threaded from pipeline.ts, OR generate a name from the
     existing `randomBytes` id already used for the findings temp file. It must be unique per run and
     known to the kill path. Sanitize to docker's `[a-zA-Z0-9_.-]` name charset.
   - **Secrets never on argv:** the provider key and findings path go via `-e NAME` **referencing the
     child env** (i.e. pass `-e OPENROUTER_API_KEY` with the value set in the spawned process's `env`,
     not `-e OPENROUTER_API_KEY=<literal>` on the command line) — preserve reviewer.ts's existing
     "secrets via env, never argv" invariant. Verify the value does not appear in any log line or in
     `ps`/argv.
   - Continue stripping all `MAGPIE_*` secrets from the child env (only the ones you deliberately pass
     via `-e` should reach the container).

3. **NDJSON telemetry:** Pi's NDJSON still comes out on the container's stdout (docker forwards it),
   so the existing parser should work unchanged. Verify the `turns/tokens/cost` `ReviewUsage` is still
   populated. Watch for docker prepending its own lines — filter to valid JSON lines as today.

4. **Findings read:** after the container exits 0, read `<outDir>/findings.json`
   (== `MAGPIE_FINDINGS_PATH` inside), pass through `parseFindings` (unchanged trust boundary), return
   the same `ReviewResult` shapes (`{ok:true, findings, summary, usage}` / `{ok:false, reason}`).

5. **Timeout / abort → kill the container, not just the process.** Killing the `docker run` client
   process does NOT reliably stop the container. On abort/timeout, run
   `<dockerBin> kill magpie-<jobId>` (best-effort; ignore "no such container"), in addition to the
   existing child-process kill. Keep the SIGTERM→SIGKILL grace for the client. `--rm` handles removal
   on normal exit; after a `kill`, confirm `--rm` still removes it (it does) or `docker rm -f` as a
   backstop. Preserve the `{ok:false}` reason messaging for timeout vs crash vs abort.

## Tests (reviewer.test.ts)

The existing tests fake the child process; keep that pattern. Update fakes so the "child" is now the
`docker run` invocation and assert on the constructed argv:
- Asserts the argv contains the hardening flags (`--rm`, `--read-only`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, `--memory`, `--cpus`, `--pids-limit`, `--user`, `--network`,
  `-v <mount>:/work:ro`, `-v <out>:/out`) and the image tag from config.
- Asserts the provider key is passed via env (present in child `env`) and is NOT present as a literal
  argv token (regression guard for the secrets-on-argv invariant).
- Asserts `MAGPIE_FINDINGS_PATH=/out/findings.json` and that findings are read back from the out dir.
- Asserts abort/timeout triggers a `docker kill <name>` call (fake and assert it was invoked).
- Asserts mount + out dir cleanup runs on success, failure, and abort.
- Keeps the existing NDJSON-parsing / usage-footer and failure-path assertions green.

## Acceptance criteria

- `npm test` green + `tsc` clean across both workspaces. Public `runReview` signature/return
  unchanged except the additive `jobId`/`containerName` param.
- No secret appears on argv or in logs. All temp dirs cleaned on every path.
- (If docker + the M3-A image are available on your box) one manual `runReview`-level smoke run
  producing a real findings.json — otherwise leave live e2e to M3-D and note it.

## Out of scope

Pipeline wiring and the full live e2e (M3-D). Gateway/egress (M4).

Depends on: task_5b3a, task_037b. Blocks: task_d8aa (M3-D).
