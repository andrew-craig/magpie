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

The findings **output path** is also baked in, as `ENV
MAGPIE_FINDINGS_PATH=/out/findings.json` — it's part of the image contract (the
mounted `/out` dir), not per-job config, so the baked-in `report_findings` extension
sees it without the caller passing anything. The only genuine runtime inputs are the
model/provider (container args), the gateway virtual-key credential
(`-e OPENROUTER_API_KEY`), and the gateway's proxy-plane URL (`-e OPENAI_BASE_URL`),
covered under Running below.

## Running

The entrypoint (`docker/reviewer/entrypoint.sh`) execs `pi` with a fixed set of baked
flags — the exact flags `packages/orchestrator/src/reviewer.ts` uses for the M1/M2
host subprocess, minus `--provider`/`--model` — and then appends whatever trailing
args the caller passes (`"$@"`). So the runtime inputs are:

- **Model + provider — as trailing container ARGV.** They're non-secret and are
  already CLI flags in the host spawn, and a container inherits no ambient host env,
  so M3-C passes them explicitly on the command line rather than via env:

  ```
  docker run ... magpie-reviewer:0.1.0 --provider openrouter --model <model-id>
  ```

  These land after the baked flags via `"$@"` in the entrypoint.
- **`OPENROUTER_API_KEY` — via `-e OPENROUTER_API_KEY=...`.** The one input that
  legitimately comes from the environment because it's a secret; pi-ai reads it
  directly. As of M4-C this is always a short-lived, budget-capped **gateway virtual
  key** (packages/gateway), never a real OpenRouter key — the orchestrator no longer
  holds one at all. The entrypoint fails fast if it's unset.
- **`OPENAI_BASE_URL` — via `-e OPENAI_BASE_URL=...`, required as of M4-C.** The
  container-facing proxy/data plane. As of M7-1 (Design D — see
  `DISTRIBUTION.md` §2) this is always `http://127.0.0.1:4000/v1`: an address
  inside the container's OWN `--network none` network namespace, served by
  the in-container forwarder (`forwarder.mjs`, baked into the image) that
  relays to the gateway's real unix socket bind-mounted read-only at
  `/run/gw/gw.sock`. **Pi itself does not read this env var** — verified
  empirically against a stub HTTP server that a bare `OPENAI_BASE_URL` is silently
  ignored by Pi 0.80.3. The entrypoint instead writes it into
  `~/.pi/agent/models.json` as an `openrouter` provider `baseUrl` override before
  exec'ing `pi` (see `entrypoint.sh`'s doc comment for the full explanation) — that
  file-based override is the mechanism that actually redirects Pi's OpenRouter
  traffic.

The prompt payload (PR title/body/diff) is read from Pi's **stdin**, so the container
must be run attached (`docker run -i ...`). See `entrypoint.sh`'s own doc comment for
the full flag list.

### Gateway wiring (M4-C)

As of M4-C, the review container **never holds a real OpenRouter key**. It
authenticates to the host-side gateway (`packages/gateway`) with a per-job,
budget-capped, short-lived virtual key minted by the orchestrator
(`packages/orchestrator/src/gateway.ts`) and revoked on cleanup. As of M7-1
(Design D — `DISTRIBUTION.md` §2) it reaches the gateway's proxy plane through
a per-job **unix domain socket** bind-mounted read-only at `/run/gw`
(`/run/gw/gw.sock`), via an in-container TCP→unix forwarder (`forwarder.mjs`)
— the container itself runs `--network none` and has no network interfaces
except its own loopback, so that socket is its only channel out at all. (The
pre-M7-1 design routed this over a dedicated `magpie-net` docker bridge +
host iptables; that apparatus — `scripts/setup-network.sh`,
`magpie-firewall.service` — is deleted, since `--network none` makes the
isolation a property of the container's network namespace instead of a
daemon-config-dependent firewall rule — see `DISTRIBUTION.md` §2.3.) The real
OpenRouter key lives only in the gateway process's own environment
(`MAGPIE_GATEWAY_OPENROUTER_KEY`). Containerizing Pi (M3) bought process/filesystem
isolation and a read-only, `.git`-free worktree; M4 removed the long-lived
provider credential; M7-1 made the egress lockdown provable and
config-independent on top of that.

### Fail-closed startup confinement assertions (M4-E)

Before `exec`ing Pi, `entrypoint.sh` now verifies its OWN confinement and aborts
non-zero (surfaced by the orchestrator as a review-failure comment) if either
invariant below is violated — PLAN.md milestone 4's explicit acceptance check:

1. **`OPENROUTER_API_KEY` must be a magpie gateway virtual key** (`sk-magpie-`
   prefix, per `packages/gateway/src/keystore.ts`'s `KEY_PREFIX`), never a real
   OpenRouter key (`sk-or-...`) or anything else. Note this reconciles the
   original M4-E task text ("fail if a real key is *present*") against what
   M4-C actually built: the container now *always* legitimately holds
   `OPENROUTER_API_KEY` (it's how Pi's OpenRouter provider resolves its
   credential), so "present" can no longer be the bar — "wrong shape" is.
2. **Network confinement**: a couple of canaries that must be UNREACHABLE (a
   raw public IP, `1.1.1.1:443`, plus a name-based one, `github.com:443`,
   which is expected to fail at DNS resolution — as of M7-1 the container runs
   `--network none` and has no interfaces, let alone a resolver, at all) and
   the gateway's proxy-plane `GET /healthz` (host:port parsed from
   `OPENAI_BASE_URL`, not a second hardcoded copy — this now transits the
   in-container forwarder and `/run/gw/gw.sock`) which must SUCCEED. Both
   probes use bash's builtin `/dev/tcp` plus `timeout` — no new image
   dependency (curl/wget/nc) was added for this.

**Manual check** (M7-1, Design D — `--network none` + the mounted gateway
socket; see also `scripts/test-zero-egress.sh` for a scripted, self-contained
version of the same proof):

- Happy path: `docker run ... --network none -v <job-dir>:/run/gw:ro
  -e OPENROUTER_API_KEY=<a freshly minted sk-magpie- key>
  -e OPENAI_BASE_URL=http://127.0.0.1:4000/v1 ...
  magpie-reviewer:latest --provider openrouter --model <id>` completes a
  real review through the gateway (forwarder → `/run/gw/gw.sock` → gateway),
  exit `0`.
- Real-key injection: same command with `OPENROUTER_API_KEY=sk-or-v1-deadbeef...`
  aborts immediately with `magpie-reviewer: refusing to run: OPENROUTER_API_KEY
  is not a magpie gateway virtual key ...`, exit `1`, no LLM traffic (verify
  against the gateway's own log — no new request line).
- Missing/wrong gateway mount: the SAME image run without the
  `-v <job-dir>:/run/gw:ro` mount (or `--network bridge` instead of `none`)
  aborts with either the forwarder-startup timeout
  (`the in-container forwarder never came up on 127.0.0.1:4000`) or, under
  `--network bridge`, `magpie-reviewer: refusing to run: network canary
  1.1.1.1:443 is REACHABLE from this container ...` (since `1.1.1.1` becomes
  routable again on a real bridge) — proving the probes genuinely detect an
  escape rather than trusting the network name.

## Smoke-testing a build

See task_5b3a's Review section (`.chalk/tasks/closed/task_5b3a.md` once closed, or
`.chalk/tasks/task_5b3a.md` until then) for the exact commands and captured output
from the last verified build, including:

- `docker run --rm --entrypoint pi magpie-reviewer:0.1.0 --version` prints `0.80.3`
  (the fixed `ENTRYPOINT` runs Pi in review mode and ignores appended args, so
  override `--entrypoint` to invoke Pi directly for a version check).
- A hand-run of the full entrypoint against a throwaway worktree + `/out` dir, invoked
  the production way (`... magpie-reviewer:0.1.0 --provider openrouter --model <id>`,
  `-e OPENROUTER_API_KEY=... -e OPENAI_BASE_URL=...`, prompt on stdin), producing a
  valid `/out/findings.json` matching the M2 findings schema
  (`packages/orchestrator/src/findings.ts`).
- A `--read-only --tmpfs /tmp --user <uid>:<gid>` run, proving the image doesn't
  depend on writing anywhere but `/tmp` (including `~/.pi/agent/models.json`, M4-C)
  and the mounted `/out`.
- `docker history --no-trunc magpie-reviewer:0.1.0` showing no secrets baked into any
  layer.

See task_eaf9's Review section for M4-C's own verification evidence: the empirical
provider-override finding, a full gateway-routed live review through the real
`magpie-reviewer` image, and confirmation the container holds only the per-job
virtual key.
