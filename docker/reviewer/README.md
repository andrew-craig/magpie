# magpie-reviewer image (M3-A)

Containerized runtime for the Pi coding agent. Runs `pi` headless over a mounted,
read-only, `.git`-free PR worktree (`/work`) and writes structured findings to a
mounted `/out`, using the `report_findings` extension and reviewer system prompt
baked into the image at build time. This image is a pure runtime artifact — it holds
no secrets and no per-repo/per-job config; those are supplied by the orchestrator at
`docker run` time (see `packages/orchestrator` M3-C/M3-D, task_4ed4/task_d8aa).

## Building

```
npm run build:reviewer-image
# or directly:
./scripts/build-reviewer-image.sh
```

The build context is the **repo root** (not `docker/reviewer/`), because the
Dockerfile copies in `packages/review-extension/src` and `reviewer-prompt.md`, both
of which live outside `docker/reviewer/`. The default tag is `magpie-reviewer:0.1.0`
(also tagged `magpie-reviewer:latest`) — this exact string is coordinated with the
`container.image` default in `packages/orchestrator/src/config.ts` (task_037b); if
you change the tag here, update that default too.

## Pinned versions (current as of 2026-07-10)

| Component | Pinned to | Where |
|---|---|---|
| Base image | `node:22.23.1-slim` | `Dockerfile` `FROM`, pinned by tag **and** digest (`sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf`) |
| Pi coding agent | `@earendil-works/pi-coding-agent@0.80.3` | `docker/reviewer/extension-package.json` — matches the host's `pi --version` (0.80.3) at the time this image was built |
| Extension runtime deps | `@earendil-works/pi-tui@0.80.3`, `typebox@1.1.38` | `docker/reviewer/extension-package.json` — must match `packages/review-extension/package.json`'s resolved versions on the host |

None of these are floating tags or semver ranges. **Re-pinning checklist**, if the
host's Pi version or the extension's deps ever move:

1. Update `docker/reviewer/extension-package.json`'s pinned versions to match.
2. Update the base image tag+digest in `Dockerfile` if you're also bumping Node
   (`docker pull node:22-slim && docker inspect node:22-slim --format '{{.RepoDigests}}'`
   to find the current digest, then pin both the resolved tag and that digest).
3. Rebuild (`npm run build:reviewer-image`) and re-run the smoke tests below.
4. Update the version table above and the "current as of" date.

## Baked in vs. mounted (rebuild required when these change)

The `pi` binary, the `report_findings` extension source
(`packages/review-extension/src`), and `reviewer-prompt.md` are **baked into the
image** at `/opt/magpie/review-extension/` and `/opt/magpie/reviewer-prompt.md`
respectively — none of them are mounted from the host at run time. **If you change
the extension or the system prompt, you must rebuild this image** (`npm run
build:reviewer-image`) for the change to take effect; editing those files alone does
nothing to a running container or a previously-built image.

Everything else — the model, provider, provider credential, and the findings output
path — is read from the environment at container start (see `entrypoint.sh`'s own
doc comment for the exact variable names) and is never baked in.

## Running

The entrypoint (`docker/reviewer/entrypoint.sh`) execs `pi` with the exact flag set
`packages/orchestrator/src/reviewer.ts` uses for the M1/M2 host subprocess — see that
file's doc comment and this image's `entrypoint.sh` doc comment for the full flag
list and the required/optional environment variables. The prompt payload (PR
title/body/diff) is read from Pi's **stdin**, so the container must be run attached
(`docker run -i ...`).

### Interim security note (M3 — read before wiring this into production)

**In M3, the real `OPENROUTER_API_KEY` is still injected directly into the
container, and network egress is NOT locked down.** The container can reach
OpenRouter (and anything else) on the default bridge network, exactly as the M1/M2
host subprocess could. The host-side LiteLLM gateway, per-job short-lived virtual
keys, and the `magpie-net` egress lockdown that remove the last secret from the
container are **Milestone 4** (see `PLAN.md` §5 and `epic_a580`) — not built yet.
Containerizing Pi (this milestone) buys process/filesystem isolation and a read-only,
`.git`-free worktree; it does not yet buy egress control or credential minimization.

## Smoke-testing a build

See task_5b3a's Review section (`.chalk/tasks/closed/task_5b3a.md` once closed, or
`.chalk/tasks/task_5b3a.md` until then) for the exact commands and captured output
from the last verified build, including:

- `docker run --rm magpie-reviewer:0.1.0 pi --version` prints `0.80.3`.
- A hand-run of the full entrypoint against a throwaway worktree + `/out` dir with a
  real API key, producing a valid `/out/findings.json` matching the M2 findings
  schema (`packages/orchestrator/src/findings.ts`).
- A `--read-only --tmpfs /tmp --user <uid>:<gid>` run, proving the image doesn't
  depend on writing anywhere but `/tmp` and the mounted `/out`.
- `docker history --no-trunc magpie-reviewer:0.1.0` showing no secrets baked into any
  layer.
