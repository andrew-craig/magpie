# M6-E/M7 topology redesign: host-native `magpie-shim` + containerised orchestrator/gateway

Status: **design document, no code**. Tracks `task_0f51`, superseding the shelved rootless-Podman
implementation on `m6e-rootless-spike` (see `.chalk/tasks/task_edbd.md`'s "PIVOT" section). Written
for CTO sign-off; see "Open questions / risks" (§8) for the specific decisions requested.

**CTO decisions (2026-07-17), pushed for broader review:**
- Direction **endorsed**: proceed on this design — **3b (root-socket shim)**, **Phase 1 (shim-only,
  native) shipped independently** as the M6-E fix, containerisation as Phase 2.
- **§8.6 resolved: the shim is a small static binary in Go or Rust** (not TS/Node) — smallest
  attack/supply-chain surface for the single most-privileged component; Go-vs-Rust sub-choice deferred
  to the pre-Phase-1 spike (§8.5), leaning Go for stdlib unix-socket + `SO_PEERCRED` simplicity.
- Remaining §8 items (blocking `launch-reviewer`, `network_mode: service:gateway`, Phase 2 as its own
  epic) accepted as the doc recommends, but left visible here for broader-review input.

## 0. Recap: why we're here

`task_edbd` (M6-E) set out to remove `SupplementaryGroups=docker` from `magpie.service` — the
orchestrator's docker-group membership is root-equivalent on the host (the daemon runs as root, so
RCE-as-`magpie` can `docker run -v /:/host …` and read `/etc/magpie-gateway/gateway.env`, the real
OpenRouter key). The chosen-then-reverted fix, **rootless Podman**, worked mechanically (Phase 0-4
spike, all green) but forced converting `magpie.service` — the process that parses attacker-influenced
webhook/PR content — into a systemd `--user` unit, which in turn forced *removing or widening several
of that unit's own hardening directives* (`RestrictNamespaces` gone, `SystemCallFilter` widened to add
`@mount sethostname seccomp`, capability-drop directives gone; see `systemd/magpie.service`'s own doc
comment and DISTRIBUTION.md §5.3 for the full empirical record). CTO declined this trade: it protects
against the docker-group threat by weakening the orchestrator's own sandbox against the threat that
matters more (a compromised/prompt-injected process parsing untrusted PR content).

**CTO's new direction (task_edbd's PIVOT):**
1. Pursue **Option C** — a small, root-owned, argument-validated exec shim — instead of rootless.
2. Reevaluate the whole topology: **containerise the orchestrator + gateway** (a `docker compose`
   stack) and run **only the shim** natively on the host, as the sole component with container-launch
   privilege. This explicitly replaces the M7 DooD plan that PLAN.md's Design-D writeup never actually
   adopted for the orchestrator itself (DISTRIBUTION.md's Appendix rejected all-compose/DooD for the
   *orchestrator* — see Appendix "Design B" — precisely because it reintroduces root-equivalence; the
   shim is what makes containerising the orchestrator safe *without* reintroducing it).

This document designs that target architecture and the path to it.

---

## 1. Target architecture

### 1.1 Diagram

```
                          GitHub (PR webhooks)  ────────────────HTTPS────────────────▶  ingress (per docs/ingress.md)
                                                                                              │ localhost:8787
┌─ Host (bare metal / VM) ─────────────────────────────────────────────────────────────────────────────┐
│                                                                                                        │
│  magpie-shim  (native systemd service, dedicated `magpie-shim` user/group)                            │
│    • ONLY component with container-launch privilege (docker/podman socket or CLI)                     │
│    • listens on a unix socket: /run/magpie-shim/shim.sock                                              │
│    • verb: launch-reviewer / kill-reviewer / sweep-orphans / ping  (§2)                                │
│    • fixes: image digest, flag set, uid, mount-path allowlist — caller supplies only job identity      │
│                                                                                                          │
│  ┌─ docker compose stack ────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                                                 │    │
│  │  orchestrator container (`magpie` image, fixed non-root --user)         ──HTTPS──▶ GitHub API   │    │
│  │    • webhook server, queue, git clone, diff, publisher                                          │    │
│  │    • NO docker socket, NO provider key, NO container-launch capability                           │    │
│  │    • calls magpie-shim over the bind-mounted shim.sock for every review job                      │    │
│  │    • calls gateway mgmt plane over a SHARED network namespace (loopback-equivalent, §4.3)         │    │
│  │    • writes PR checkouts to a HOST bind mount (identical host/container path, §4.1)               │    │
│  │                                                                                                 │    │
│  │  gateway container (`magpie-gateway` image, fixed non-root --user, own uid)                      │    │
│  │    • holds the real OpenRouter key (env, container-only)             ──HTTPS──▶ openrouter.ai    │    │
│  │    • mgmt plane: loopback-equivalent, orchestrator-only (§4.3)                                    │    │
│  │    • proxy plane: mints one unix socket per job under a HOST bind mount (identical path, §4.1)     │    │
│  │                                                                                                 │    │
│  └────────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                       │ launch-reviewer(jobId, workspaceDir, outDir, socketDir, …)       │
│                                       ▼                                                                  │
│                            magpie-shim validates + execs:                                                │
│                     docker run --rm --name magpie-<jobId> --network none …                               │
│                                       │                                                                  │
│                                       ▼                                                                  │
│                    ┌─ reviewer container (ephemeral, per job) ─────────────────┐                         │
│                    │  --network none · --read-only · --cap-drop=ALL           │                         │
│                    │  -v <workspaceDir>:/work:ro  -v <outDir>:/out            │                         │
│                    │  -v <socketDir>:/run/gw:ro   (only channel off-box)      │                         │
│                    └───────────────────────────────────────────────────────────┘                         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Per-component trust table

| Component | Runs as | Privilege held | Secrets reachable | Untrusted input touched | Blast radius if compromised |
|---|---|---|---|---|---|
| **magpie-shim** | native systemd, dedicated `magpie-shim` user | container-launch (docker/podman socket or CLI) — see §3 for whether this is root-equivalent | none directly (never sees the gateway key or GitHub token; sees only the opaque gateway *virtual* key string, which it forwards, never inspects) | **one RPC call from the orchestrator container** — not raw PR/webhook content. The orchestrator has already parsed/validated the job before calling the shim. | Depends on §3's model choice — worst case (3b) root-equivalent on host; but the shim's own attack surface is a handful of validated fields, not arbitrary docker args (§2.5) |
| **orchestrator container** | container, fixed non-root uid, own image | mints GitHub installation tokens; mints/revokes gateway virtual keys; calls the shim | GitHub App private key (mounted secret), gateway master key (mgmt-plane auth) — **no docker socket, no provider key** | full PR content: diff, title, body, filenames — this is Magpie's highest-attack-surface trusted process, unchanged from today | today's status quo *minus* docker-group root-equivalence: RCE here can mint tokens/keys and forge shim RPC calls within the shim's validated envelope, but cannot itself launch an arbitrary container or read arbitrary host files |
| **gateway container** | container, fixed non-root uid, own image, separate from orchestrator's | mints/revokes per-job virtual keys; forwards LLM calls to OpenRouter | the real OpenRouter key (container-only env) | none directly — only ever talks to the orchestrator (mgmt plane, trusted caller) and the reviewer (proxy plane, a spend-capped virtual key, not the real key) | a compromise yields the real OpenRouter key (unchanged from today) but nothing else — no GitHub token, no docker access |
| **reviewer container** | ephemeral, `--network none`, launched only by the shim | none — read-only rootfs, cap-drop=ALL, no network | none — a spend-capped, short-lived *virtual* key only, worthless to exfiltrate | **the entire threat surface**: runs Pi over attacker-controlled diff/title/body, the indirect-prompt-injection target | at worst, garbage findings a human reads before acting (PLAN.md's core thesis) — unchanged from today, this design touches nothing about reviewer hardening itself |

This table is the concrete version of CLAUDE.md's capability-separation principle for this topology:
the shim is the **new** most-privileged component (replacing "orchestrator has docker-group") but it
is deliberately the *only* one, deliberately minimal, and deliberately never touches PR content
directly.

---

## 2. The shim contract

### 2.1 Verbs (four, not one — see rationale below)

`task_0f51`'s brief frames this as "one verb: launch-reviewer-for-job," but the M6-E problem statement
(`task_edbd.md`, "The docker surface we must preserve") enumerates **five** docker verbs the
orchestrator issues today: `version` (preflight), `run` (the one with mounts), `kill` (timeout/abort),
`ps --filter` + `rm -f` (orphan sweep). Folding `kill`/`ps`/`rm` into "launch" isn't possible — they
fire independently, at different times, sometimes with no live caller at all (orphan sweep runs at
*startup*, before any job exists). The shim's real contract is **four small, fixed, enumerable verbs**,
all far narrower than "run docker with these args":

| Verb | Caller-supplied fields | Fires when | Maps to (today's code) |
|---|---|---|---|
| `ping` | none | shim startup self-check + orchestrator startup preflight | replaces `docker.ts:67`'s `<docker_bin> version` |
| `launch-reviewer` | `jobId`, `workspaceDir`, `outDir`, `gatewaySocketDir`, `gatewayApiKey` (opaque), `provider`, `model` | once per review job | `reviewer.ts:359-401`'s `dockerArgs` construction + `spawn` at `reviewer.ts:429` |
| `kill-reviewer` | `jobId` only | timeout (`reviewer.ts`'s `startKillSequence`, `KILL_GRACE_MS` at `reviewer.ts:85`) or abort signal | `reviewer.ts:466`'s `spawn(dockerBin, ["kill", containerName])` |
| `sweep-orphans` | none | orchestrator startup, right after `ping` | `orphan-cleanup.ts:71-87`'s `ps -aq --filter name=magpie-` + `rm -f` |

`sweep-orphans` and `kill-reviewer` take **zero or one field** — there is no argument surface to
validate beyond a job-id format check. All the real validation work concentrates in `launch-reviewer`.

### 2.2 `launch-reviewer` — what the caller may specify vs. what the shim fixes

| Field | Caller supplies | Shim behavior |
|---|---|---|
| `jobId` | yes, free string | **Regenerated, not trusted verbatim.** Shim re-derives the container name itself via the same sanitization `reviewer.ts:207-211`'s `buildContainerName` already does (`[^a-zA-Z0-9_.-]` → `-`, `magpie-<sanitized>` prefix) — never accepts a caller-supplied container name directly, so a malformed/adversarial `jobId` can't collide with or spoof another job's name. |
| `workspaceDir` | yes, absolute path | **Constrained to a shim-configured allowlist root** (e.g. `/var/lib/magpie/work/**`, matching `config.workspace.work_dir`, `config.ts:59-69`). Shim resolves the real path (`realpath`, following symlinks) and rejects unless the resolved path is still under the root — closes a symlink-escape class the M3/M4 code never had to consider because the orchestrator *was* the thing calling docker directly. Rejects any `..` component pre-resolution too, defense in depth. |
| `outDir` | yes, absolute path | Same allowlist treatment, root e.g. `/var/lib/magpie/out/**` — see §4.1 for why this must be a fresh, shim-side–visible directory, not a caller-chosen name. |
| `gatewaySocketDir` | yes, absolute path | Same allowlist treatment, root `/var/lib/magpie-gateway/jobs/**` (or wherever §4.1 lands the gateway's socket root under this topology). |
| `gatewayApiKey` | yes, opaque string | **Never inspected, logged, or validated for shape** — passed straight to the container's env (`-e OPENROUTER_API_KEY`, name-only on argv, exactly `reviewer.ts:388-389`'s existing discipline). The shim's job is transport, not credential policy. |
| `provider`, `model` | yes, strings | Constrained to a narrow charset (`[a-zA-Z0-9_.:/-]`) before being placed as trailing container args (mirrors `reviewer.ts:397-400`). `spawn`'s argv-array form (never a shell) already prevents injection; this is belt-and-suspenders against a future refactor that adds a shell. |
| reviewer **image** | **no** | Fixed to the shim's own pinned digest reference from the shim's own config file — never caller-suppliable, not even as a tag hint. (Today's `config.container.image` default is already digest-pinned — `config.ts:89-93`, `ghcr.io/…/reviewer:0.2.0@sha256:…` — this just moves ownership of that value from the orchestrator's config to the shim's.) |
| every hardening flag (`--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--memory`, `--cpus`, `--pids-limit`, `--network none`, `--user`) | **no** | **100% shim-fixed**, not passed through from the caller at all. `--memory`/`--cpus`/`--pids-limit` may be *configured* on the shim's own config file (an operator-tunable ceiling), but the orchestrator cannot request a different value per job — no per-job override channel exists. `--user` is a shim-side constant, not derived from the caller's uid at all (§4.2 explains why). |

### 2.3 Rejection rules (the shim refuses the call, no partial execution)

1. `jobId` empty, over 64 chars, or (after the shim's own sanitization) collides with an
   already-running container name → reject with `409`-equivalent, do not kill-and-replace silently
   (unlike `job-sockets.ts:117-142`'s gateway socket rebind logic, which *does* tear down and replace —
   deliberately different here: a colliding launch is more likely a caller bug than a legitimate retry,
   and silently replacing a live review container mid-run is worse than refusing).
2. Any of the three path fields is not absolute, contains a `..` segment pre-resolution, or resolves
   (post-symlink-following) outside its configured allowlist root → reject.
3. Any of the three path fields does not already exist as a directory at call time → reject (mirrors
   DISTRIBUTION.md §2.6 point 2's "mount the directory, bind before run" invariant: the shim must never
   be the thing that causes Docker to invent a root-owned path — the caller/gateway must have created it
   first, same ordering as today).
4. `provider`/`model` contain a character outside the allowed charset → reject.
5. More than N `launch-reviewer` calls are in flight at once (shim-side concurrency ceiling, independent
   of and in addition to the orchestrator's own `p-queue` concurrency) → reject. Defense in depth against
   a compromised/buggy orchestrator trying to fork-bomb the host via container spawns.
6. `kill-reviewer`/anything referencing a `jobId` the shim has no record of launching → no-op success
   (idempotent, mirrors `killContainerBestEffort`'s existing "no such container" tolerance,
   `reviewer.ts:453-474`), not an error — a kill racing a normal exit is expected, not exceptional.

### 2.4 What stays owned by the orchestrator vs. moves to the shim

The **timeout clock, retry policy, and NDJSON stdout parsing stay in the orchestrator** — the shim
only starts/stops containers and streams their stdout/stderr back over the RPC connection (or the
orchestrator attaches to the container's stdout via a mechanism the shim's `launch-reviewer` response
hands back, e.g. a container id it can itself `docker logs -f` **only if that specific verb is also
added to the shim's allowlist** — see open question in §8). This keeps the shim's own logic free of any
NDJSON/Pi-protocol awareness, which is exactly the kind of scope creep that would turn it into a second
copy of `reviewer.ts`'s complexity inside the crown-jewel component. **Recommendation: the shim's
`launch-reviewer` call blocks until the container exits (or the caller's RPC connection is severed,
which the shim treats as an implicit kill request) and returns `{exitCode, stdout, stderr}` in one
shot**, mirroring `child_process.execFile`'s shape rather than a streaming protocol — this is the
simplest contract that satisfies today's actual usage (reviewer.ts already buffers all of stdout/stderr
itself, `reviewer.ts:444-681`) and avoids building a bidirectional streaming RPC into the audited
surface. The tradeoff (no live progress until the whole run completes) matches how `runReview` is
consumed today (nothing observes partial output — `pipeline.ts` only awaits the final `ReviewResult`)
so it costs nothing in practice.

### 2.5 The shim's own attack surface

The shim is now the single most consequential piece of code in the system — smaller than `dockerd`,
but the **entire** validated-argument surface described above must be treated as security-critical,
audited code, not routine application logic. Concretely, to keep it minimal and auditable:

- **No shell.** Every subprocess spawn is an argv array (`execve`, not `/bin/sh -c`), same discipline
  `workspace.ts` and `reviewer.ts` already use.
- **No dynamic image resolution.** The image reference is a single string constant read from the
  shim's own config at startup, never touched by request handling.
- **No general-purpose docker/podman CLI passthrough of any kind** — not even for verbs that "seem
  safe" (e.g. no `docker inspect`, no `docker logs` as a *separate* generic verb — see §2.4's
  recommendation to fold output capture into `launch-reviewer` itself specifically to avoid needing a
  second, more general verb).
- **Small enough to read in one sitting.** Target: under ~500 lines of the shim's own logic (excluding
  whatever docker/podman client library or CLI-wrapping it uses) — if the RPC/validation logic grows
  past that, it's a signal the contract has scope-crept and needs to be pushed back down into the
  orchestrator or gateway instead.
- **No third-party RPC framework.** A newline-delimited JSON protocol over the unix socket (mirrors
  Pi's own NDJSON convention the codebase already parses in `reviewer.ts`) — consistent with
  PLAN.md §5's precedent of rejecting LiteLLM specifically to avoid extra operational/audit surface for
  a single-purpose internal component; the same reasoning applies here even more strongly, since this
  component is root-equivalent.
- **SO_PEERCRED check on connect**, in addition to unix-socket directory permissions (§4.3): the shim
  reads the connecting process's uid via `SO_PEERCRED` and rejects any peer whose uid isn't the
  orchestrator's configured uid — cheap, kernel-enforced, and not spoofable by anything short of root
  (which would already have the same privilege the shim guards).

---

## 3. Shim privilege model — evaluate 3a vs 3b

### 3.1 The two options

**(a) Shim runs rootless Podman as a dedicated `magpie-shim` user.** No component anywhere holds
root-equivalent privilege; the M6-E Phase-0 spike (`task_edbd.md`'s "Spike results") already proves the
mechanics work — cgroup delegation, `--userns=keep-id`, socket bind-mount, `--network none`, verb
compatibility all passed. The negative test (`podman run -v /:/host:ro … cat gateway.env` →
`Permission denied`) is the strongest possible evidence this closes the threat for real.

**(b) Shim talks to the root docker socket (or runs as root directly) but only ever issues the one
validated `launch-reviewer`/`kill-reviewer`/`sweep-orphans` invocation.** The shim itself is
root-equivalent; nothing else on the host is. Security rests entirely on the shim's own code being
small, argument-validated, and audited (§2.5) — not on any namespace boundary.

### 3.2 Comparison

| Dimension | 3a — rootless Podman shim | 3b — root-socket shim |
|---|---|---|
| Where does root-equivalence live? | Nowhere (genuinely eliminated) | Concentrated in one small, audited component |
| Reuses M6-E spike work? | Yes, directly — `cgroup-preflight.ts`, `--userns=keep-id`/`isPodmanBinary` conditional (both already flagged as reusable in the PIVOT note) port almost unchanged, just retargeted at a new `magpie-shim.service` instead of `magpie.service` | No — none of that machinery is needed |
| Platform prerequisites (M7 matrix) | subuid/subgid ranges, `loginctl enable-linger`, cgroup v2 delegation, **the memory-cgroup-controller gap** (DISTRIBUTION.md §5.5 — fails *closed* on Podman, unlike Docker's fail-open) — the exact set of constraints that made M6-E "conditional GO," not unconditional | Only "docker (or podman) is installed and reachable" — the same bar the product has cleared since M3 |
| Does it reintroduce the problem that killed the *previous* rootless attempt? | **No** — the objection that sank the earlier attempt was specifically that *the webhook-facing, PR-content-parsing* orchestrator had to shed its own hardening (`RestrictNamespaces`, `SystemCallFilter`) to host rootless container creation. The shim touches no PR content and isn't network-facing at all, so the same directive changes land on a component with a much smaller/different threat model — a materially different trade than before | N/A |
| Deployment complexity | High: subuid provisioning, lingering, a warmup unit for the `NoNewPrivileges` vs. `newuidmap` conflict (DISTRIBUTION.md §5.4), a HOME redirect, per-platform memory-controller remediation docs | Low: one more native service, same install pattern as `magpie.service`/`magpie-gateway.service` today |
| Auditability | Correctness depends on kernel/systemd namespace *and* the shim's own validation both holding | Correctness depends on the shim's own validation holding, full stop — a smaller, more legible property to reason about and test |
| Consistent with why Option C was chosen at all | Partially undercuts it — Option C's whole selling point (per `task_edbd.md`'s own text) was "small fixed root-owned exec shim... kept as fallback if rootless can't meet resource-limit/uid needs on a target distro," i.e. C exists *because* rootless has platform gaps. Building C *on top of* rootless imports those same gaps back in | Fully consistent — this is what "Option C" meant in the original task doc |

### 3.3 Recommendation: **3b (root-socket shim), as the primary and only required model**

Reasoning, in order of weight:

1. **3a doesn't actually solve the portability problem C was chosen to solve.** The CTO's stated reason
   for rejecting the rootless path wasn't "rootless is insecure" — the Phase-0 spike *proved* it secure.
   It was "getting there forced weakening the orchestrator's hardening" *and*, reading between the lines
   of the M7 platform-matrix concern threaded through both `task_edbd.md` and DISTRIBUTION.md §5.5-5.6,
   rootless's platform prerequisites (subuid delegation, cgroup v2 unified hierarchy, a working memory
   controller) are not universal across the M7 self-hoster matrix. Recommending 3a for the shim
   re-imports every one of those prerequisites under a new name.
2. **3b's residual risk is exactly the risk Option C was designed to accept.** A small, argument-
   validated, shell-free, ~500-line surface is a qualitatively different (and much smaller) audit
   burden than "the orchestrator has an open docker-group membership" — which is the actual thing
   `task_edbd` set out to fix. Trading "unbounded docker access from a large, network-facing,
   PR-content-parsing process" for "one fixed RPC verb from a small, audited, non-network-facing
   process" is the real security win here, independent of whether the shim itself runs as root.
3. **Uniform deployability wins for a self-hostable product.** DISTRIBUTION.md's whole premise is "any
   Linux host with Docker" (§3.4's platform matrix, no rootless/subuid/cgroup-delegation caveat listed
   anywhere in the current adopter-facing docs). Making the shim require 3a's prerequisites would put
   that caveat back into the onboarding story that M7 spent several milestones removing.
4. **3a is not lost work — keep it as a documented, optional v2 hardening.** Because the shim's RPC
   contract (§2) is deliberately runtime-agnostic (it validates *inputs*, not the mechanism that
   executes them), a future `magpie-shim` could internally swap `docker run` for rootless `podman run`
   as `magpie-shim`'s own user, on hosts where the operator has done the subuid/cgroup-delegation setup,
   **without changing the RPC contract at all**. This is the natural place to point an operator who
   wants defense-in-depth beyond what 3b offers, once the M7 platform-matrix caveats are acceptable to
   them specifically. Flag this in install docs as an advanced/optional path, not a default.

**One-line summary: 3b, because Option C's entire value proposition was "small and auditable instead of
namespaced," and layering rootless underneath it re-imports the exact platform-portability cost that
made C the fallback (not the primary) in the original M6-E task.**

---

## 4. Shared filesystem + socket topology (the plumbing crux)

This is where naive containerisation breaks. Three things must cross the
container/shim/host boundary and land at *the same path* from every viewpoint that touches them:
the PR workspace (`/work`), the findings output dir (`/out`), and the gateway's per-job socket
(`/run/gw`).

### 4.1 The core rule: **identical host-path == container-path bind mounts, no named volumes**

Today, `container-mounts.ts:77-97`'s `createOutputDir` doc comment (echoed at its `reviewer.ts:292-298`
call site) already documents *why* this matters in
miniature: under `PrivateTmp=true`, a directory created in the orchestrator's private `/tmp` is
invisible to the docker daemon's own mount namespace, so a `-v <tmp-path>:/out` mount silently resolves
to an empty, root-owned directory the container can't write into (this is the M5 "PrivateTmp bug" —
see the user's memory note on it). **The compose topology generalises this exact failure mode**: if the
orchestrator container writes PR checkouts into a Docker *named volume* (e.g. `magpie-work:/var/lib/
magpie/work`), the path visible *inside* the orchestrator container (`/var/lib/magpie/work/<job>`) is
**not** the host path the shim needs for its own, sibling `docker run -v <hostpath>:/work:ro` — named
volumes only resolve to a host path via `docker volume inspect`, which the shim would then need to call,
expanding its own attack surface for zero benefit, and racing on volume-driver quirks across
docker/podman.

**Decision: every directory that crosses the shim boundary is a HOST BIND MOUNT, mounted at the
identical absolute path inside its owning container as it has on the host.** Concretely:

| Tree | Host path | Orchestrator/gateway container mount | Why identical paths |
|---|---|---|---|
| PR workspaces | `/var/lib/magpie/work` (unchanged from today, `config.ts:68`'s default) | `-v /var/lib/magpie/work:/var/lib/magpie/work` | `workspace.ts:137`'s `join(workDir, …)` already produces this path; if it's identical inside and outside the orchestrator container, the value the orchestrator hands the shim as `workspaceDir` is *already* a valid host path — no translation table anywhere |
| Findings output | `/var/lib/magpie/out` (new; today this reuses `config.workspace.workDir` as `createOutputDir`'s base per `reviewer.ts:292-298` — kept as a sibling tree here for clarity, not required to be split) | same identical-path bind mount | same reasoning |
| Gateway per-job sockets | `/var/lib/magpie-gateway/jobs` (was `/run/magpie-gateway/jobs`, a systemd `RuntimeDirectory=` — see §4.4 for why this must change) | same identical-path bind mount into the gateway container | `job-sockets.ts:144`'s `socketDir = path.join(this.#root, sanitizedJobId)` return value becomes directly usable by the shim with zero translation, exactly like the workspace path above |

This is the single most important decision in this document: **it eliminates path-translation logic
from the shim entirely.** The shim's path-allowlist check (§2.2) becomes a pure string-prefix-after-
`realpath` comparison against these three host roots — no volume inspection, no container-id-to-
mountpoint lookup, nothing that could itself be tricked or race.

### 4.2 UID/ownership: fix `--user` at the shim, not per caller

Today, `reviewer.ts:364-365` sets `--user ${process.getuid()}:${process.getgid()}` — the *orchestrator
process's own* uid/gid, so the `/out` write-back is trivially readable by the same process that reads
it back (`reviewer.ts:632`'s `readFile(output.findingsPath, …)`). Once the orchestrator runs inside a
container, `process.getuid()` reports the **container's own** uid mapping, which is only meaningful if
that container is deliberately run with a fixed, known `--user` on the compose side too.

**Decision:**
1. `docker-compose.yml` pins `user: "993:993"` (or whatever uid the install script provisions — reuse
   the existing `magpie` uid/gid the native install already creates, so upgraded hosts don't need a
   fresh uid) on **both** the orchestrator and, separately, a *different* fixed uid for the gateway
   container (mirrors today's separate `magpie`/`magpie-gateway` OS users — the whole point of that
   split, per PLAN.md §5's threat model, is that a compromised orchestrator still can't read the
   gateway's files; giving both containers the same uid would quietly undo that).
2. The shim does **not** read `--user` from the RPC call at all (§2.2). It is a **shim-config
   constant** — `shim.toml`'s `reviewer_uid`/`reviewer_gid`, set once at install time to match the
   orchestrator container's own fixed uid (since it's the orchestrator that reads `/out` back).
   This is stricter than today's code (which derives `--user` from the live caller) but strictly
   safer: nothing about who's allowed to *read the output* is caller-influenceable per request.
3. `--userns=keep-id` (§3's rootless-only flag) is irrelevant under the recommended 3b model — plain
   `--user <uid>:<gid>` against a root-owned docker daemon already round-trips to the real host uid, no
   userns remapping involved. (If a future host layers 3a underneath the shim per §3.3's v2 note, the
   `--userns=keep-id`-conditional-on-`isPodmanBinary` logic already written and proven — not on `main`,
   but on the shelved `m6e-rootless-spike` branch, commit `5ac4504` — ports over into the shim mostly
   unchanged; that branch is not merged, so nothing here assumes it exists in the current codebase.)

### 4.3 Gateway mgmt-plane reachability: share the network namespace, don't reroute the code

`gateway/config.ts:22` hardcodes the mgmt-plane bind host to `127.0.0.1` specifically so it is
"structurally unreachable from `magpie-net` regardless of container compromise" (DISTRIBUTION.md §2.2).
Splitting orchestrator and gateway into separate containers breaks the literal loopback sharing this
guarantee depends on — two containers' `127.0.0.1` are two different addresses unless something makes
them the same network namespace.

**Decision: run the orchestrator container with `network_mode: "service:gateway"`** (compose's
share-the-gateway-container's-netns mode), rather than putting both on a shared bridge network and
changing `GATEWAY_MGMT_PORT`'s bind host. This means:
- `gateway/config.ts` needs **zero code changes** — `127.0.0.1:4100` inside the gateway container is
  the literal same address the orchestrator's `fetch(gateway.baseUrl)` (`gateway.ts:170`) already
  reaches, byte-for-byte the same as today's two-host-processes-sharing-real-loopback setup.
- The "mgmt plane is structurally unreachable from anywhere but the trusted caller" property is
  actually *stronger* than a bridge-network + `internal: true` approach would give: there is no docker
  network layer to misconfigure at all for this specific channel — it's the same kernel netns.
- Cost: the orchestrator container's own outbound egress (to GitHub) and inbound webhook listener now
  ride on whatever network config the *gateway* container declares (compose's `network_mode:
  service:X` means X owns the network config for both). This is a real coupling — the gateway
  container's compose network stanza must be written with the orchestrator's needs in mind too — but
  it is one line of compose config, not an app-code change, and it's the only way to preserve the
  existing loopback-only guarantee without touching `gateway/config.ts`'s `LOOPBACK_HOST` constant.
- **Alternative considered and rejected as primary**: keep separate netns, put both containers on a
  compose-internal (unpublished) network, and change `LOOPBACK_HOST` to bind `0.0.0.0` (relying on the
  internal network's lack of a route from the reviewer or the host to make it "safe"). Rejected because
  it reintroduces exactly the class of daemon-config-dependent reasoning ("safe because nothing else can
  route here, assuming the compose network is configured as expected") that DISTRIBUTION.md's whole
  Design-D argument (§2.3) rejected for the reviewer's egress lockdown. Sharing the netns is provable by
  construction; a network-policy-dependent bind is not.

### 4.4 Gateway's `RuntimeDirectory=` doesn't exist under compose — replace with a provisioned bind mount

`systemd/magpie-gateway.service`'s `RuntimeDirectory=magpie-gateway` is a systemd primitive (creates
`/run/magpie-gateway`, mode 0700, on unit start, removes it on stop) with no compose equivalent.
**Decision:** the install/compose bootstrap step creates `/var/lib/magpie-gateway/jobs` on the host
ahead of time (mode `0700`, owned by the gateway container's fixed uid — §4.2), and the compose file
bind-mounts it at the identical path into the gateway container (per §4.1's rule). The
`job-sockets.ts` permission model itself (root `0700`, per-job dir `0711`, socket `0666` — all
unchanged, `job-sockets.ts:20-38`) needs **no code changes**: it was already written in terms of
directory-permission traversal control, not systemd-specific ownership semantics, so it transplants
directly onto a plain bind-mounted directory. Only the *provisioning* of the root directory moves from
"systemd does it automatically per-boot" to "install script does it once, persists across restarts" —
a `rm -rf` of stale per-job subdirectories at gateway startup (defensive, mirrors `orphan-cleanup.ts`'s
own "state doesn't survive a crash cleanly" posture) is worth adding since the directory now persists
rather than being freshly created by systemd every boot.

### 4.5 Summary table: every crossing point, resolved

| Crossing | Old mechanism | New mechanism | Code change needed? |
|---|---|---|---|
| Orchestrator writes PR checkout, shim's reviewer reads it | same host process, same fs view | identical-path host bind mount (§4.1) into orchestrator container; shim passes the same path straight through | No — `workspace.ts` unchanged |
| Reviewer writes `/out`, orchestrator reads it back | same host process reads a `mkdtemp` dir it created | identical-path host bind mount (§4.1); `--user` fixed by shim config, matched to orchestrator's fixed container uid (§4.2) | Minor — `createOutputDir`'s `baseDir` becomes a fixed compose-provisioned path instead of `config.workspace.workDir`; `reviewer.ts`'s uid-args logic moves into the shim |
| Gateway binds per-job socket, reviewer connects | `RuntimeDirectory=`, systemd-managed | identical-path host bind mount, install-script-provisioned (§4.4) | No — `job-sockets.ts` unchanged |
| Orchestrator mints/revokes gateway keys | shared real loopback | shared network namespace (`network_mode: service:gateway`, §4.3) | No — `gateway.ts`/`gateway/config.ts` unchanged |
| Orchestrator calls the shim | N/A (didn't exist) | unix socket, bind-mounted into the orchestrator container from a host path the shim owns (§5's migration section covers this explicitly) | New — this is the one genuinely new integration point |

---

## 5. Networking / egress lockdown

Nothing about the **reviewer's** isolation changes: it still launches `--network none` (shim-fixed,
§2.2 — the caller cannot request otherwise), still reaches the gateway only through the mounted
`/run/gw` socket, still has zero route to the internet, GitHub, or the host. DISTRIBUTION.md §2.3's
"provable, config-independent" argument for `--network none` is a property of the container's own
network namespace regardless of who launches it — the shim launching it instead of the orchestrator
process directly changes nothing about that property.

What's new is the orchestrator's and gateway's **own** egress, now mediated by docker's network stack
for the first time (today they're bare host processes with the host's own routing):

| Egress path | Needed? | How it's provided |
|---|---|---|
| Orchestrator → GitHub API (HTTPS) | Yes | Gateway container's compose network stanza (§4.3: orchestrator rides on gateway's netns) needs a normal outbound route — default bridge/compose network is sufficient, no lockdown needed (this is a *trusted* component reaching a *fixed, expected* destination, unlike the reviewer) |
| Gateway → OpenRouter (HTTPS) | Yes | Same default outbound route. Optional defense-in-depth (not required, not currently implemented even in the native deployment): an SNI/domain allowlist on the gateway container's own egress, restricting it to `openrouter.ai` — DISTRIBUTION.md §2's Design-D writeup already scoped this as optional hardening on the gateway's *own* outbound, independent of topology |
| Orchestrator ↔ Gateway mgmt plane | Yes | Shared netns (§4.3) — not a "network" path at all in the docker sense |
| Ingress → orchestrator webhook listener | Yes | Published port bound to `127.0.0.1` only (matches today's `docs/ingress.md` guidance of binding any reverse-proxy-fronted port to loopback), fronted by whichever ingress option (§ docs/ingress.md's 3-option matrix) the operator chose — unaffected by this redesign |
| Reviewer → anything | **No** (by design) | `--network none`, unchanged |

No new default-deny apparatus is needed for the orchestrator/gateway containers' own egress — they are
trusted components reaching known-good destinations, exactly like today's bare host processes. The
egress lockdown that matters (the reviewer's) was already solved by Design D and this redesign doesn't
touch it.

---

## 6. Migration path

### 6.1 Current state → target state

| | Today | Target |
|---|---|---|
| Orchestrator | native systemd system unit, `magpie` user, `docker` group | container, compose-managed, fixed non-root uid, no docker group |
| Gateway | native systemd system unit, `magpie-gateway` user | container, compose-managed, fixed non-root uid |
| Reviewer launch | orchestrator process calls `docker run` directly | orchestrator calls `magpie-shim` over a unix socket; shim calls `docker run` |
| Docker/podman access | orchestrator (`docker` group) | `magpie-shim` only |

### 6.2 Recommended sequence — **confirm CTO's leaning: shim first, containerisation second**

The CTO's instinct (per the task brief) is right, and independently justified by this design, for a
reason beyond "smaller diffs first":

**Phase 1 — shim only, orchestrator/gateway stay native.** Replace `reviewer.ts`'s direct `spawn(docker,
…)` calls and `orphan-cleanup.ts`'s direct `execFile` calls with RPC calls to a new native
`magpie-shim.service`. Remove `SupplementaryGroups=docker` from `magpie.service`; add `magpie` to
whatever group/ACL lets it reach the shim's unix socket instead. **This alone closes M6-E's entire
original problem statement** — the orchestrator can no longer reach the docker daemon at all, on the
current, already-hardened, already-shipped systemd unit, with **zero changes to `magpie.service`'s
existing hardening directives** (no `--user`-unit conversion, no `RestrictNamespaces` removal — none of
the M6-E rootless attempt's collateral damage, because the shim's own process is what talks to docker
now, not `magpie.service`). Low blast radius: it's purely additive, testable against the exact current
deployment, and independently valuable even if Phase 2 (containerisation) is deferred or never
happens.

**Phase 2 — containerise orchestrator + gateway.** Once the shim exists and its RPC contract is proven
in production against the native orchestrator, wrap the orchestrator and gateway in containers per §§4-5.
Because the shim's contract (§2) never assumed its caller was a native process — it only assumed *a*
unix-socket-connected peer with a validated uid (§2.5's `SO_PEERCRED` check) — this phase is a pure
**transport/packaging change on the caller side**: bind-mount the shim's socket into the orchestrator
container the same way the gateway's per-job sockets are bind-mounted into the reviewer (§4.1's
identical-path rule applies here too — `/run/magpie-shim/shim.sock` bind-mounted at the same path
inside the orchestrator container). No change to the shim itself should be needed in this phase if
Phase 1's contract was designed with this in mind from the start (which is the point of doing it in
this order).

**Confirmed: this ordering is correct, and for a stronger reason than "sequencing convenience" — Phase
1 is the actual M6-E fix, deliverable independently and immediately, while Phase 2 is a topology
preference that can proceed on its own timeline (or be reconsidered) without blocking the security fix
this whole epic exists to ship.**

### 6.3 Self-hoster install/upgrade story

- **Fresh install, target state:** `install.sh` installs `magpie-shim` as a native systemd service
  (own dedicated user, `docker`-or-equivalent access — §3.3's 3b model), then either starts native
  `magpie.service`/`magpie-gateway.service` (Phase-1-only deployment) or runs `docker compose up`
  for the orchestrator+gateway stack (Phase-2 deployment) — both are legitimate end states per the
  phased rollout; the compose path is not mandatory for every adopter, just the CTO's preferred
  long-term default.
- **Upgrade from today's native-only deployment to Phase 1:** install the shim, flip
  `magpie.service`'s docker access to shim-RPC access (one config value + one systemd unit dependency
  change), remove `magpie` from the `docker` group. No unit-type change, no uid change, no data
  migration — this is the cleanest upgrade this project has shipped in the M6/M7 series, specifically
  *because* it avoids the `--user`-unit conversion pain the rootless attempt required.
- **Upgrade from Phase 1 to Phase 2 (containerise):** heavier — orchestrator/gateway config moves from
  `/etc/magpie/config.toml` + `EnvironmentFile=` to container env/mounted files; the `magpie`/
  `magpie-gateway` OS users' role shrinks to "owns the host bind-mount directories" rather than "runs
  the process directly"; `docker compose up` replaces two `systemctl start` calls. Document this as an
  explicit, opt-in migration (mirrors DISTRIBUTION.md §5.6's "known limitation, upgrading in place" for
  the earlier `--user`-unit change) rather than something `install.sh` does automatically on an existing
  install.

---

## 7. Threat-model delta

**Strengthened:**
- The orchestrator's docker-group root-equivalence is eliminated (M6-E's original goal), on the
  *current* hardened unit, with no hardening trade-off — Phase 1 alone is a strict security
  improvement with no offsetting cost.
- If Phase 2 ships, a code-execution compromise of the orchestrator *container* is now also contained
  by whatever the container boundary itself adds (no access to the gateway's files, no access to the
  shim's own process memory/env, a smaller filesystem view than a bare host process would have) — this
  is on top of, not instead of, the shim fix.
- The gateway/orchestrator UID separation (PLAN.md §5's original design point) becomes genuinely
  load-bearing again, exactly as `task_edbd.md`'s "Goal / success criterion" describes — a compromised
  orchestrator (container or native) cannot read `/etc/magpie-gateway/gateway.env`-equivalent secrets,
  whether via a docker escape or a plain file read, because neither the docker group nor a shared uid
  is available to it anymore.

**New risks introduced (call these out honestly):**
1. **The shim is a new root-equivalent single point of failure** (§3's 3b model, chosen). Its own bug
   surface, however small, is now the thing standing between "PR content triggers RCE somewhere
   upstream" and "attacker gets root." This is a deliberate, accepted concentration, not an oversight —
   but it means the shim needs its own dedicated review/audit discipline going forward (see §8).
2. **A compromised orchestrator container can still forge `launch-reviewer` calls within the validated
   envelope** — e.g. launch a reviewer container against a `workspaceDir` the orchestrator itself
   controls the contents of (it already does, legitimately, every job) with a `gatewayApiKey` it
   legitimately minted. This is not a new capability beyond what the orchestrator already has today
   (it already decides what diff/prompt content the reviewer sees) — flagged for completeness, not as a
   regression.
3. **Phase 2's `network_mode: service:gateway` coupling (§4.3)** means the orchestrator's own network
   config is no longer independently declarable — an operator customizing the gateway container's
   network setup (e.g. adding an egress SNI filter per §5) must remember it now also governs the
   orchestrator's networking. Worth a doc callout so it isn't a surprise.
4. **Bind-mount provisioning becomes a new install-time correctness requirement** (§4.1, §4.4): if
   `install.sh`/compose bootstrap ever creates these directories with the wrong owner/mode, the failure
   mode is the same "silent, confusing findings-parsing failure" class as the M5 PrivateTmp bug — this
   needs explicit preflight validation (mirrors `cgroup-preflight.ts`'s existing philosophy of failing
   loud at startup rather than on the first job) rather than trusting install-time provisioning alone.
5. **The shim's `SO_PEERCRED`-based auth (§2.5) is only as strong as uid separation on the host** — if
   the orchestrator container's fixed uid is ever accidentally shared with another, less-trusted
   process (e.g. a misconfigured compose file reusing a uid), that process could reach the shim's
   full privilege. Not a new *class* of risk (today's docker-group membership has the same "whoever
   has this uid gets this privilege" shape) but worth calling out as a property that must be actively
   preserved through every future compose/install-script change.

---

## 8. Open questions / risks for CTO sign-off

1. **§2.4/§2.3: does `launch-reviewer` block for the full job duration, or does the shim need a
   separate `attach`/`logs` verb?** Recommended: block-and-return-buffered-output (simplest, matches
   today's actual consumption pattern). Confirm this doesn't conflict with any planned M8+ feature
   (e.g. live progress streaming to a PR comment) that would want partial output before job completion.
2. **§3: confirm 3b (root-socket shim) over 3a (rootless-podman shim) as the shipped default**, per
   this document's recommendation — and confirm 3a stays a documented-optional v2 path, not a
   commitment for this round.
3. **§4.3: confirm `network_mode: service:gateway` (shared netns) as the mgmt-plane transport**, versus
   the rejected alternative (separate netns + `0.0.0.0` bind + internal compose network). This is the
   one place this design deliberately trades "the two containers' networking is coupled in the compose
   file" for "zero `gateway/config.ts` code changes and a provably-shared-namespace guarantee." Worth an
   explicit yes/no rather than defaulting silently.
4. **§6.2: confirm Phase 1 (shim-only) is worth shipping and merging on its own**, independent of
   whether/when Phase 2 (containerisation) proceeds — this document's position is that Phase 1 is the
   actual M6-E deliverable and shouldn't be gated on the larger, CTO-preference-driven Phase 2 decision.
5. **Needs a spike before Phase 1 implementation begins:** the shim's RPC protocol details (exact
   wire format, `SO_PEERCRED` availability/ergonomics from Node's `net` module for a unix-socket
   server, and confirming a blocking `launch-reviewer` call doesn't reintroduce a head-of-line-blocking
   problem against the shim's own concurrency ceiling, §2.3 rule 5) — none of this is architecturally
   risky per se, but "does Node's `net.Socket` expose peer credentials cleanly" is an empirical question
   worth 30 minutes before committing to §2.5's auth design.
6. **RESOLVED (CTO, 2026-07-17): small static binary in Go or Rust**, not TS/Node — the smallest-
   possible-attack-surface option for the crown-jewel component wins over "one language." Go-vs-Rust
   sub-choice deferred to the §8.5 spike (leaning Go for stdlib unix-socket + `SO_PEERCRED` ergonomics).
   Consequence: the shim does NOT reuse the existing TS fake-binary test seam; it gets its own test
   harness, and the repo gains a second toolchain (build/CI wiring is part of Phase 1 scope).
7. **§6.3: does Phase 2's heavier upgrade story (config relocation, compose adoption) need its own
   dedicated M-series task/epic**, separate from Phase 1's, given it's explicitly a topology preference
   rather than a security-blocking fix? Recommend yes, but flagging for confirmation since it affects
   how this gets tracked in chalk going forward.
