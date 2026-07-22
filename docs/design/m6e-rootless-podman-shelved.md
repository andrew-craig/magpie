# M6-E rootless-Podman implementation — shelved (summary)

**Status:** SHELVED / not merged. Superseded by the host-shim + containerised
orchestrator/gateway design (`docs/design/shim-containerisation.md`, task_0f51).
This note preserves the findings from the abandoned `m6e-rootless-spike` branch
(commits `32ecbc6`, `5ac4504`, `24d7afc`, `1f5f098`, `073b8a2`; task_edbd) so
they survive the branch's deletion. No code from that branch landed on `main`.

## What the task set out to do

Remove the orchestrator's `SupplementaryGroups=docker` from `magpie.service`.
Docker-group membership is **root-equivalent** (the daemon runs as root), so an
RCE in the `magpie` orchestrator process could `docker run -v /:/host …` and
read the real OpenRouter key at `/etc/magpie-gateway/gateway.env`, defeating the
gateway/orchestrator UID separation. Goal: a compromised orchestrator cannot
read root-owned host files or gain root. This hardens the **orchestrator→host**
boundary, complementary to the reviewer→host work (gVisor / M6-C).

The orchestrator issues only five docker verbs (`version`, `run`, `kill`,
`ps --filter`, `rm -f`) behind the `config.container.dockerBin` seam, so the
runtime was already swappable.

## Approach taken: rootless Podman (Option A)

Run review containers via rootless Podman as `magpie`; drop the docker group.
Options B (socket proxy) and C (bespoke root-owned exec shim) were documented
as rejected-primary / fallback respectively; D (gVisor) was out of scope.

### Phase-0 spike verdict: CONDITIONAL GO (empirically validated on this Pi)

On Debian 12 (bookworm), kernel 6.12 aarch64, cgroup v2, systemd 252:

- **cpu / pids limits — enforced.** `--cpus=1` → container `cpu.max` = `100000
  100000`; `--pids-limit=20` → fork loop hit `Resource temporarily unavailable`,
  `pids.max` = 20. Real kernel enforcement, not accepted-and-ignored.
- **`/out` write-back — works only with `--userns=keep-id`.** Default rootless
  subuid mapping sends `--user 993:988` to host ~uid 200992 → `Permission
  denied`. With `--userns=keep-id`, files land `magpie:magpie` and are readable
  by the orchestrator after exit; `--read-only` / `/work:ro` still reject writes.
- **gateway-socket `:ro` bind mount + in-container `connect()` — works** under
  the rootless userns with the full flag set.
- **`--network none` — identical** to docker (only `lo` present; skips slirp).
- **cleanup verbs — byte-identical argv.** `podman version/ps -aq --filter
  name=magpie-/kill/rm -f` need zero changes to `docker.ts`/`orphan-cleanup.ts`.
- **`--memory` — FAIL (host-level, pre-existing).** This Pi's kernel carries
  `cgroup_disable=memory` (RPi firmware default), so there is no memory
  controller. Docker today **fails open** (discards `--memory` with a warning);
  Podman/crun **fails closed** (hard-errors container creation:
  `crun: opening file 'memory.max' … No such file or directory`). Not a Podman
  defect — the same gap already silently disables memory limits under docker.
- **Negative test (the actual success criterion) — PASS.** As `magpie`,
  `podman run --userns=keep-id … -v /:/host:ro alpine cat
  /host/etc/magpie-gateway/gateway.env` → `Permission denied` (file is
  `0600 root:root`). Today's docker-group path could read it trivially.

### Implementation (Phases 1–4) and why it was rejected

- **App code (`5ac4504`):** `--userns=keep-id` added to `reviewer.ts` **only**
  when `isPodmanBinary(dockerBin)` (basename exactly `podman`; real docker
  hard-errors on that flag). New `cgroup-preflight.ts` +
  `container.require_memory_limit` config knob (default true) fail-fast when the
  memory controller is absent under Podman, instead of a cryptic per-job crun
  error. `docker.ts` / `orphan-cleanup.ts` needed no changes. 261 tests passed.
- **systemd (`24d7afc`):** the decisive finding — enforcing cgroup limits
  **forced converting `magpie.service` into a systemd `--user` unit** (run by
  `magpie`'s lingering `user@<uid>.service`). A root-launched `User=magpie`
  *system* unit lands in `system.slice`, outside the delegated user tree, and
  Podman's cgroup driver then **silently fails to enforce** `--pids-limit` /
  `--cpus`. Making it a `--user` unit in turn required **dropping/widening
  several of the orchestrator's own hardening directives**:
  - Removed: `RestrictNamespaces` (blocks `clone`/`unshare` — can't launch any
    container), `ProtectKernelModules/Logs/Clock`,
    `CapabilityBoundingSet=`/`AmbientCapabilities=` (need `CAP_SETPCAP` the
    unprivileged user manager lacks).
  - Widened: `SystemCallFilter=@system-service` → `+ @mount sethostname seccomp`
    (rootless container creation needs all three).
  - `NoNewPrivileges=true` conflicts with `newuidmap` (setuid-root) on first
    namespace creation → needed a `magpie-podman-warmup.service` oneshot
    (`podman unshare true`) to prime the namespace once per boot.
- **install.sh / docs:** installs Podman + fuse-overlayfs/slirp4netns/uidmap/
  crun, subuid/subgid, lingering, `HOME=/var/lib/magpie` redirect; documents the
  RPi `cgroup_enable=memory cgroup_memory=1` boot-arg prerequisite.

**CTO decision (2026-07-17): declined.** Making rootless enforcement work traded
away orchestrator hardening (removed `RestrictNamespaces`, widened
`SystemCallFilter`) to buy the docker-group removal — a net-uncertain security
trade. New direction: **Option C**, a small root-owned/validated exec shim, with
orchestrator+gateway containerised (compose) and the shim as the sole native
host bridge that launches `--network none` reviewer containers. See
`docs/design/shim-containerisation.md`.

## Reusable bits (if revisited)

- Portable memory-controller preflight: `cgroup-preflight.ts` +
  `require_memory_limit` knob (fail-fast when `memory` is absent from the
  delegated cgroup controller set).
- `--userns=keep-id` + `isPodmanBinary()` conditional in `reviewer.ts` (only
  fires for a `podman` binary; verified inert for the `docker` default).
- The full per-constraint spike evidence table lived in task_edbd's review
  section on the deleted branch.

## Testing incident (self-reported, for the record)

During Phase-2 testing, a uid-scoped `sudo pkill -u magpie` (to clear spike
processes) also SIGTERM'd the live production `magpie.service` (same uid). It
drained gracefully (clean exit 0, no in-flight jobs) and was restarted within
~30s; `healthz` 200 confirmed after. Lesson: never uid-scope `pkill` on
`magpie` — the uid is shared by the deployed service and any ad hoc rootless
testing; target PIDs individually.
