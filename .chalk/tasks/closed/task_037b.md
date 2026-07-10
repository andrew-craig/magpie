---
id: task_037b
title: M3-B: orchestrator plumbing — config, docker preflight, .git-stripped read-only worktree + /out handoff
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_a580
remote_task_url: null
created_at: 2026-07-10T06:47:20Z
updated_at: 2026-07-10T09:22:13Z
---
Wave 1 (parallel with task_5b3a). Build the orchestrator-side helpers and config that the M3-C
docker runner will call, so M3-C can focus purely on assembling and running the `docker run`
invocation. All of this is unit-testable offline with fakes — no real docker or image needed to
land this task.

## Deliverables

### 1. Config additions (`config.ts` + `config.example.toml`)

Add a `container` section to the config schema (zod) and typed `Config` interface, with defaults:

- `image` (string, default `"magpie-reviewer:0.1.0"` — MUST match the tag task_5b3a builds;
  coordinate on the exact string).
- `memory` (string, default `"4g"`), `cpus` (string/number, default `"2"`),
  `pids_limit` (int, default `256`) — the PLAN.md §4 hardening limits, made configurable.
- `docker_bin` (string, default `"docker"`) — path to the docker CLI, for hosts where it isn't on
  PATH or is `podman`.
- (Optional but recommended) `network` (string, default `"bridge"`) so M4 can flip it to
  `magpie-net` via config without a code change.

Document every new field with a comment in `config.example.toml` (match the existing style — see
task_9c52). Keep the existing `limits.jobTimeoutSeconds` as the wall-clock backstop (unchanged;
M3-C uses it for `docker kill` timing, not this section).

### 2. Docker preflight (`docker.ts` or add to an existing module)

A small `assertDockerAvailable(config)` (or `checkDocker`) that runs `<docker_bin> version`
(or `info`) once at startup and throws a clear, actionable error if docker is missing/not running
(mirror config.ts's fail-fast style). Wire it into the composition root (`index.ts`) so the process
refuses to start if it can't containerize — better than failing every job at review time. Unit-test
with an injected spawn/exec fake (success + missing-binary + daemon-down cases).

### 3. `.git`-stripped, read-only-mountable worktree + `/out` handoff

Provide two helpers (new module, e.g. `container-mounts.ts`, or extend `workspace.ts` — match the
existing workspace ownership model). They must be pure host-side fs ops with tests:

- **`prepareReviewMount(workspaceDir) -> mountDir`**: produce a `.git`-free directory suitable for
  `-v <mountDir>:/work:ro`. Options (pick one, justify in code comment): (a) `git archive` the
  checked-out HEAD into a fresh dir, or (b) copy the worktree excluding `.git`, or (c) simply
  `rm -rf <workspaceDir>/.git` in place and mount `workspaceDir` (simplest — valid because the diff
  is sourced from the GitHub API, not local git, and nothing downstream re-reads `.git`). If you do
  (c), make it explicit and covered by a test asserting `.git` is gone. Whatever you choose, the
  result must contain the reviewable source files and no `.git`.
- **`createOutputDir() -> { outDir, findingsPath, cleanup }`**: make a per-job host temp dir (under
  the OS tmpdir or the configured work dir) to be mounted at `/out`, with `findingsPath =
  join(outDir, "findings.json")`. Set permissions so the container process (see epic decision #4 —
  likely running as the orchestrator's own uid) can write it. Return a `cleanup()` that `rm -rf`s it.

Tests: assert `.git` is absent from the mount; assert the out dir exists and is writable; assert
`cleanup()` removes it; assert helpers don't throw on already-clean/idempotent re-runs.

## Acceptance criteria

- `npm test` green and `tsc` clean across both workspaces.
- New config fields load with defaults, are documented in `config.example.toml`, and produce clear
  errors when malformed (add a config.test.ts case).
- Preflight throws a clear error when docker is absent (tested via fake), and is invoked from the
  composition root.
- The mount + out-dir helpers are unit-tested per the above; no real docker required for these tests.

## Out of scope

Do not touch `reviewer.ts`'s spawn logic or build the `docker run` args — that's M3-C
(task_4ed4), which will import these helpers/config. No gateway/network/egress work (M4).

Depends on: nothing. Blocks: task_4ed4 (M3-C).
