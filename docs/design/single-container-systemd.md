# Single-container, all-systemd Magpie — plan summary + validation spike

Status: **proposal, no code.** An alternative to `docs/design/shim-containerisation.md`'s
shim + compose-split. Supersedes the goal of "front the root docker daemon with a shim" with
"remove the root docker daemon from the picture entirely and ship the whole stack as one
easy-to-run, host-isolated artifact." Written to be validated by the spike in §3 before any
implementation.

## 1. Goal

**Trivially easy to self-host, without weakening the capability-separation security model.**
One artifact, one `docker run` (or one-line compose), on any modern Linux host with a
user-namespaced container runtime — no host root, no host `docker` group, no host `iptables`,
and no access to the host's real filesystem.

## 2. The architecture

Ship Magpie as a **single, unprivileged (user-namespaced) container** that runs an init
(systemd, or a light supervisor) and hosts all three components as **separate internal users**:

```
┌─ one unprivileged / userns container (the host-isolation boundary) ──────────────┐
│  init (container-root, supervises only; never parses untrusted input)            │
│                                                                                  │
│  orchestrator   (uid O)  webhook, queue, git, diff, publisher   ──▶ GitHub       │
│    • holds GitHub App key + gateway master key; NO provider key                  │
│    • mints/revokes virtual keys via gateway loopback (same netns — free)         │
│                                                                                  │
│  gateway        (uid G)  holds real OpenRouter key in a 0600 file  ──▶ OpenRouter │
│    • uid G ≠ uid O → orchestrator RCE cannot read the key (kernel-enforced)      │
│    • mgmt plane: 127.0.0.1 (shared container localhost); proxy plane: unix socket │
│                                                                                  │
│  reviewer       per job, launched as a NESTED transient unit                     │
│    • own fresh netns (network-none equiv) · own uid · read-only rootfs           │
│    • cap-drop · seccomp · mem/cpu/pids caps · hard timeout                        │
│    • only channel out = the bind-mounted gateway unix socket                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Why this is not weaker than today's bare-host deployment:**

| Separation | Bare host today | Single container | Verdict |
|---|---|---|---|
| orchestrator ⟂ gateway provider key | separate host uids, `0600` file | separate internal uids, `0600` file | **equal** — same kernel uid check |
| whole stack ⟂ the host | RCE→root owns the machine | userns: even container-root ≠ host root, no host FS | **container is stronger** |
| untrusted reviewer ⟂ everything | host kernel builds the sandbox | container init builds it **nested** | **the one real question — see §3** |

**Bonuses over the shim/compose-split design:** the mgmt-plane `network_mode: service:gateway`
gymnastics disappear (orchestrator + gateway share container localhost for free); the root docker
daemon and the root-equivalent shim are both deleted; deployment collapses to one artifact.

**What replaces docker for the reviewer:** the reviewer's entire requirement set — fresh network
namespace, read-only `/work`, one writable `/out`, the gateway socket, cap-drop, seccomp,
mem/cpu/pids caps, hard timeout — maps one-for-one onto a nested transient systemd unit
(`PrivateNetwork=yes`, `RootImage=`/`RootDirectory=`, `BindReadOnlyPaths=`, `CapabilityBoundingSet=`,
`SystemCallFilter=`, `MemoryMax`/`CPUQuota`/`TasksMax`, `RuntimeMaxSec=`). The in-container
TCP→unix `forwarder.mjs` still works because `PrivateNetwork` leaves loopback intact.

## 3. The spike — what must be proven before committing

Everything above reduces to **one empirical question: does the nested reviewer sandbox hold up
under an unprivileged/userns container across the target host kernels?** Build a minimal
prototype (userns container running an init + a transient `magpie-reviewer@.service` inside it)
and prove the following. All are pass/fail; any hard failure is a no-go for this architecture on
that host class.

### Must-pass assertions

1. **Nested network isolation.** The reviewer unit gets a fresh netns with only `lo`. From inside
   the reviewer: a `connect()` to any public IP and to the host fails; the only reachable
   endpoint is the bind-mounted gateway socket. (Proves `--network none` equivalence nests.)
2. **Provider-key confinement.** From a shell running as the reviewer's uid, the gateway's `0600`
   key file is unreadable; from the orchestrator's uid it is unreadable. (Proves internal uid
   separation survives inside the container.)
3. **Resource caps enforced nested.** The reviewer cannot exceed its `MemoryMax`/`TasksMax` — a
   fork-bomb / alloc-bomb inside the reviewer is contained, not the whole container. **This is the
   fragile one: it depends on cgroup v2 delegation to the container.** Record whether delegation
   is present and whether caps hold when it is/ isn't.
4. **Host isolation.** A simulated container-root compromise cannot read the host filesystem or
   escalate to host root (verify the userns uid mapping; confirm no host bind mounts leak a
   writable path).
5. **Clean lifecycle.** Per-job start/stop/timeout works via the init (`RuntimeMaxSec` timeout,
   `systemctl stop` kill, no orphaned units after crash) — replacing today's docker
   `run`/`kill`/`ps`/`rm` verbs.

### Must-answer questions (feasibility / portability)

6. **Kernel prerequisites matrix.** On which of the target self-hoster kernels is
   `unprivileged_userns_clone` enabled and cgroup v2 delegation available out of the box
   (Debian 12, Ubuntu 22.04/24.04, Fedora, RHEL 9, and at least one hardened/locked-down kernel)?
   Document the minimum supported baseline and the failure mode where it's absent.
7. **Init choice.** systemd-in-a-container vs. a lighter supervisor (s6/tini+runner) for hosting
   three long-lived services + nested transient reviewer units — pick the smallest thing that can
   create the nested sandbox reliably.
8. **Reviewer rootfs delivery.** The reviewer image is a published, cosign-signed, digest-pinned
   OCI artifact today; systemd `RootImage`/`RootDirectory` needs a rootfs. Confirm the
   `skopeo copy` + unpack (or equivalent) path, preserving digest pinning + signature verification.
9. **Runtime & multi-arch.** Confirm the story on both amd64 and arm64, and whether the outer
   container runs under rootless podman, rootless docker, or both.

### Explicitly out of scope for the spike

- Rewriting orchestrator/gateway application code (transport to the reviewer changes; their logic
  does not).
- The GitHub App onboarding / secrets-injection UX (unchanged; secrets are runtime-injected via
  env/mounted files, never baked into the image).

## 4. Decision gate

- **All must-pass assertions green + a workable kernel baseline (§3.6):** adopt this as the target
  architecture; retire the shim + compose-split plan.
- **Resource caps (§3.3) fail on important host classes:** fall back to documenting cgroup
  delegation as a prerequisite, or keep the host-native systemd-reviewer variant (no outer
  container) for those hosts.
- **userns/nesting unavailable on the target baseline:** the single-container goal is not reachable
  there; revert to the host-native "all systemd services, no docker" variant, which still deletes
  the root docker daemon and the shim.
