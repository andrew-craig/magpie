# CTO decision brief — reviewer sandbox / distribution architecture

**Purpose:** choose the mid-term target architecture for how Magpie isolates the PR reviewer and
how the whole stack is packaged for self-hosting. Three design proposals are on the table
(`shim-containerisation.md`, `sandboxed-reviewer-design.md`, `single-container-systemd.md`). This
brief defines each, weighs the trade-offs against the project's two priorities, and recommends a
synthesis rather than any one proposal as-written.

**The two priorities, in order:**
1. **Secure the reviewer.** Malicious PR code cannot impact the host or other systems, and cannot
   steal secrets. (The threat is indirect prompt injection + untrusted code, not a cooperative user.)
2. **Easy Linux self-host distribution** that **minimises the permissions the app needs**.

**TL;DR recommendation:** adopt Proposal **B's rootless substrate** (no root anywhere) as the
foundation, and make the reviewer sandbox a **rootless KVM micro-VM by default** (libkrun/krun under
Podman), with **gVisor** and **hardened crun** as explicit weaker tiers for hosts without hardware
virtualization. This gives the reviewer a real, separate guest kernel — the isolation boundary that
stays correct even after the reviewer is allowed to *execute* untrusted repo code — while keeping the
whole trusted computing base unprivileged. Rationale below.

---

## 1. The three options

| | Proposal | Privileged launcher | Reviewer isolation | Deployment shape |
|---|---|---|---|---|
| **A** | Host-native **magpie-shim** + containerised orchestrator/gateway (`shim-containerisation.md`) | small audited **root-equivalent shim** fronts the root Docker daemon | `docker run --network none` — the shipped, proven mechanism | native shim service + compose stack; 2-phase rollout |
| **B** | **Rootless Podman**, orchestrator launches the sandbox directly (`sandboxed-reviewer-design.md`) | **none** — rootless, no root anywhere | rootless `podman --network none`; **gVisor (`runsc`)** where supported, else `crun` | single orchestrator binary + rootless Podman; heavier host prereqs |
| **C** | **One unprivileged userns container**, all-systemd (`single-container-systemd.md`) | **none** — no root daemon, no shim | **nested** transient systemd unit (`PrivateNetwork=yes`, cgroup caps) | one artifact, one `docker run`/compose |

All three share Magpie's existing capability-separation model: the orchestrator parses untrusted PR
content and holds the GitHub App key + gateway master key; a **separate-uid gateway** holds the real
provider key; the reviewer gets only a short-lived, budget-capped virtual key and its sole egress is a
per-job socket to the gateway. The proposals differ in *how the reviewer is sandboxed* and *what
privilege the launcher needs* — which is exactly where the two priorities bite.

---

## 2. Priority 1 — securing the reviewer

Three sub-properties matter, in descending order of importance.

### 2a. The #1 property — the reviewer must have **no network**, provably and config-independently

This is the single most consequential axis. Indirect prompt injection is defeated structurally by the
reviewer having no way out except the audited gateway socket; if the "no network" guarantee can
silently fail, the whole model is compromised.

| | Result | Why |
|---|---|---|
| **A** | **Provable, config-independent** | `docker run --network none` gives a kernel-empty netns; it does not depend on any outer-container capability. Shipped and proven. |
| **B** | **Provable** | rootless `podman --network none`: the sandbox sees only `lo`, has an empty route table, and cannot reach any external address. |
| **C** | **Fails open** | A nested `PrivateNetwork=yes` inside an unprivileged container under *default* capabilities silently runs with the **outer container's routed network still attached** — isolation only appears once the outer container is granted `CAP_SYS_ADMIN`. |

**A and B are empty-by-construction; C makes the #1 property capability-dependent.** C's failure mode
is the exact class of config-dependent security the project's "Design D" work was created to eliminate.
Making C safe requires granting `CAP_SYS_ADMIN` back to the outer container — which also widens the
outer boundary. This is disqualifying for C as a primary architecture.

### 2b. Secret separation — can a compromised untrusted-input path reach the provider key?

| | Secret separation | Note |
|---|---|---|
| **A** | **Preserved** | orchestrator and gateway stay separate container uids; the shim never sees a secret. |
| **B** | **Regressed as written** | the proposal folds credential injection into "the orchestrator's proxy injects the gateway auth header" — putting the provider key in the *same* process that parses untrusted PR content. This collapses the uid split. **Fixable, but a step down as written — and the recommendation mandates fixing it.** |
| **C** | **Preserved** | separate internal uids for orchestrator and gateway; provider key in a `0600` file the reviewer uid cannot read. |

### 2c. Escape depth and blast radius of the privileged component

- **Runtime-escape depth.** A and C both rely *solely* on the host kernel as the boundary between
  untrusted code and everything else — a single kernel 0-day is a full escape. B's gVisor interposes a
  **userspace kernel** (a second, independent kernel boundary) — but only where gVisor actually runs
  (see §4 on portability).
- **Root in the TCB.** A keeps a **root Docker daemon plus a root-equivalent shim** on the host — small
  and audited, and unreachable from the untrusted-input path, but permanently present. B and C have
  **no root anywhere** — genuinely better — except C erodes this by needing `CAP_SYS_ADMIN` on its
  outer container for §2a.
- **Resource caps.** pids limits and hard timeouts enforce in all three. Memory caps are a weak point
  for *every* container-based design — see §4.

### 2d. The long-horizon argument (why 2c will get more important, not less)

The reviewer's **read-only tool allowlist is a current product choice, not a permanent property.** The
obvious next step for a review bot — run the project's tests/linters/build and review the failures —
means the reviewer will **execute untrusted repo code**. At that point the isolation boundary stops
being "can injected text exfiltrate?" and becomes "can executing attacker code escape?"

- A and C then rest entirely on the host kernel boundary.
- Only a design with a **second kernel** between the reviewer and the host — gVisor (userspace kernel)
  or a KVM micro-VM (a real guest kernel) — stays correct.

**The right long-term architecture is the one that is still sound after the reviewer gains code
execution.** That rules for a kernel-independent isolation boundary, which neither A nor C has or can
gain without becoming a different design.

---

## 3. Priority 2 — easy install, minimal permissions

| | Host prerequisites | Permissions footprint | Implementation cost |
|---|---|---|---|
| **A** | root Docker daemon (already required) + one native shim service | removes docker-group from the orchestrator; **concentrates** root-equivalence in a small shim | **lowest** — reuses the whole existing codebase, signed reviewer image, gateway split; incremental 2-phase |
| **B** | rootless Podman + crun + (optionally) runsc + subuid/subgid + linger + unprivileged userns | **no root** — best on this axis, but the heaviest prereq matrix | **highest** — reads as a substantial rewrite of the launcher; must fix the secret-split regression |
| **C** | unprivileged container runtime + cgroup v2 delegation + userns + rootfs unpack for the reviewer image | **no root daemon, no shim** — but **needs `CAP_SYS_ADMIN`** on the outer container for §2a, partly undoing "minimal" | **high** — the least-proven path (systemd-in-userns + nested transient units + 2-level cgroup delegation) |

The tension: on the pure "minimise permissions" axis B and C look best (no root), but B's win comes with
the heaviest prerequisites, and C's is undercut by the very capability its #1-property isolation depends
on. A is the cheapest to build but permanently carries a root daemon — the thing priority 2 most wants
gone.

---

## 4. Two portability facts that shape the choice

Two findings generalize well beyond any single host and constrain the runtime options:

1. **gVisor is not universally available on arm64.** The official `runsc` arm64 build is compiled for
   **4 KB memory pages**; it cannot boot at all on **16 KB-page** (e.g. Raspberry Pi 5 default) or
   **64 KB-page** arm64 kernels — a broad arm64 boundary, not a single-device quirk. On amd64 and
   4 KB-page arm64, gVisor works on a well-trodden path. So **B's headline isolation edge is
   host-conditional**: where gVisor can't run, B degrades to `crun`, i.e. the same shared-host-kernel
   namespace isolation as A and C.

2. **Container memory caps depend on host cgroup configuration; VMM memory caps do not.** On hosts where
   the kernel memory controller is disabled or not delegated, `--memory` is silently ignored for *all*
   container-based designs (A/B/C) — the cap is a no-op and a memory bomb is uncontained. A micro-VM's
   memory ceiling is instead its guest RAM allocation, **hard-enforced by the VMM** independent of host
   cgroups — structurally closing this gap.

Together these push toward a **KVM micro-VM** as the strongest *and* most portable way to get the
"second kernel" that §2d requires: KVM is agnostic to host page size (the guest runs its own kernel and
paging), and the VMM enforces the memory ceiling regardless of host cgroup state.

---

## 5. Recommendation — rootless KVM micro-VM on B's rootless substrate

**No single proposal is adopted as-is. The recommendation is a synthesis:**

- **Foundation = B's rootless substrate.** No root daemon, no shim, no docker-group anywhere. This is
  the best answer to priority 2 ("minimise the permissions the app needs" is maximised when the app
  needs none) and removes A's permanent root liability.
- **Reviewer sandbox = a rootless KVM micro-VM by default**, with a tiered fallback for hosts without
  hardware virtualization.
- **Keep the orchestrator ⟂ gateway uid split** (fixes B's as-written secret regression from §2b — the
  provider key never lives in the untrusted-input-parsing process).
- **Absorb C's distribution ambition** — package the rootless-user / subuid / linger setup into a clean
  installer so the result *feels* as easy to run as C's one-artifact goal, without C's nested-sandbox
  weakness.

### Why a micro-VM is the right default

1. **Strongest reviewer isolation — a real, separate guest kernel.** A hardware-virtualized (KVM)
   boundary, not a shared host kernel (A/C) or a userspace kernel (gVisor). This is the boundary that
   remains load-bearing in the §2d future where the reviewer executes untrusted repo code.
2. **Portable across the arm64 page-size boundary that constrains gVisor** (§4.1). KVM runs the guest's
   own kernel, so the host page size is irrelevant.
3. **Structurally closes the memory-cap gap** (§4.2). The VMM enforces the guest RAM ceiling regardless
   of host cgroup configuration.
4. **No-network by construction** — with one caveat. A micro-VM with no network device has no network
   path at all, not even a shared host netns to misconfigure. *Caveat:* some rootless VMMs (libkrun via
   TSI/passt) can provide guest egress through a userspace socket-passthrough transport with **no
   virtio-net device to spot in a config audit** — the VMM analog of C's fail-open netns. So
   "no network" is a **mandated invariant**, not a launch flag: the reviewer VM is built with network
   transport disabled, asserted by construction + install preflight, and re-asserted **fail-closed from
   inside the guest at startup** (the way the current entrypoint already makes confinement assertions).

### The isolation ladder (all tiers on the same rootless substrate)

Ranked by isolation strength: **micro-VM (KVM) > gVisor > hardened crun.**

| Tier | Runtime | When | Requires |
|---|---|---|---|
| **Default (strongest)** | rootless KVM micro-VM — **libkrun/krun under Podman** (primary), Firecracker-direct (proven fallback) | hardware virtualization available | `/dev/kvm` (bare metal or nested-virt VM) + `kvm` group |
| **No-KVM / high-density** | **gVisor (`runsc`)** | no `/dev/kvm`, or large high-concurrency hosts where a full guest kernel per job is too costly | 4 KB-page host (arm64) or amd64 |
| **Last-resort floor** | rootless Podman + **hardened crun** | no `/dev/kvm` **and** no usable gVisor | unprivileged userns + subuid/subgid |

gVisor is deliberately ranked **below** the micro-VM, not above it — a micro-VM is strictly stronger, so
gVisor is a *coverage/density* tier (no-KVM hosts, or trading isolation depth for lower per-job overhead
at high concurrency), not an "upgrade."

> **Vehicle note.** "Rootless Kata" is **not** an option: `kata-runtime` runs as root and does not
> support Podman, so it fails the no-root requirement. **libkrun** is the one runtime that satisfies all
> three constraints at once — rootless, KVM-isolated, *and* an OCI runtime under Podman — which is why
> it's the primary vehicle. Firecracker-direct is the validated fallback at the cost of owning a
> guest-kernel/rootfs pipeline (see §6).

### Two invariants that keep the tiering honest

1. **Tier honesty.** On hosts without `/dev/kvm` the "micro-VM default" silently degrades to a weaker
   tier. This is *not* a re-import of C's fail-open sin, because the **#1 property (no network) is
   tier-invariant** — every tier delivers an empty network path by construction; only the *depth* of the
   reviewer↔host-kernel boundary varies. To keep it honest:
   - **Install-time preflight** probes `/dev/kvm` by *actually opening it and issuing a trivial
     `KVM_CREATE_VM`* (not by reading CPU ID registers, which can misreport), and **fails loud /
     requires explicit acknowledgement** before landing on a weaker tier.
   - The **active tier is surfaced** on `/healthz` and in the PR review summary footer, so "this review
     ran in a micro-VM / gVisor / crun sandbox" is visible per review.
   - All security claims in operator docs are **tier-qualified**.
2. **Floor invariant.** The last-resort crun tier must be **exactly today's shipped hardened posture** —
   seccomp + `--cap-drop=ALL` + `no-new-privileges` + read-only rootfs + pids cap + `--network none` +
   `.git`-stripped read-only `/work`. Then **no operator on any host is worse off than today's product**,
   and the micro-VM / gVisor tiers are strict gains where the hardware allows.

### Precise TCB claim (be accurate, not marketing)

"No root" means: **no root daemon and no root in any Magpie runtime process** (orchestrator, gateway,
reviewer); `/dev/kvm` is reached via `kvm`-group membership. The *only* setuid-root surface is
**`newuidmap` / `newgidmap`** — two narrow, widely-audited shadow-utils helpers that rootless Podman
invokes once at namespace setup (inherent to any rootless substrate, not new to the micro-VM). Honest
wording for docs: *"no root daemon and no root Magpie process; the only setuid-root surface is two
shadow-utils binaries at namespace setup"* — a dramatically smaller TCB than a root Docker daemon, but
not literally zero-setuid.

---

## 6. What a micro-VM changes (and what it doesn't)

Adopting a micro-VM reuses most of the existing system — the orchestrator/gateway/publisher logic, the
signed reviewer image, the virtual-key budget model — but changes four mechanics:

1. **Gateway channel: bind-mounted unix socket → vsock.** A VM guest can't share a host unix socket by
   bind mount, and virtiofs **cannot carry an `AF_UNIX` connection** (it proxies file operations, not
   socket connections). vsock is the only option, and it is **mandated to be per-VM *hybrid* vsock** —
   each job's VM gets its own host-side socket path (`uds_path`), **never a host-global `vhost-vsock`
   listener** (which shares one host CID namespace and would make the virtual key the sole cross-job
   authenticator). A small host-side forwarder bridges the per-job vsock socket to the gateway's per-job
   socket; the budget-capped virtual-key model is unchanged.
2. **Reviewer `/work` (PR checkout) delivery.** Today a read-only bind mount. Under a virtiofs-capable
   VMM (libkrun) `/work` rides a **read-only virtiofs mount** (fine for a filesystem — the virtiofs
   limitation is only for *sockets*). Under Firecracker-direct (no virtiofs) use a per-job read-only
   **ext4 image** built unprivileged with `mkfs.ext4 -d <dir>`. Workspace delivery is coupled to VMM
   choice — a reason to prefer a virtiofs-capable rootless VMM.
3. **Guest-kernel supply chain.** A micro-VM needs a guest kernel. **libkrun bundles and maintains its
   guest kernel upstream**, so the net-new supply-chain surface is "pin + cosign-verify a libkrun
   release," not "build/patch/CVE-track a kernel ourselves"; the existing signed, digest-pinned reviewer
   OCI image is reused as the guest rootfs. Firecracker-direct instead makes us own a guest-kernel +
   rootfs pipeline per architecture — real permanent scope, and the main reason to prefer libkrun.
4. **Per-job boot cost.** ~0.1–1 s VMM/kernel boot plus guest RAM per concurrent job. Negligible against
   multi-second/minute reviews. This sets a memory-bound concurrency ceiling; a sensible default is
   ~1 GB guest RAM per review and concurrency = `floor(available_RAM / 1 GB)`, min 1, both configurable.
   A dead reviewer VM (OOM/panic/timeout) maps onto the **existing clear-failure-note publisher path** —
   reviewer non-completion is already handled that way.

---

## 7. Open gates before implementation

None of these threaten the decision; they separate "proven substrate" (already validated) from "proven
vehicle" (libkrun specifically).

1. **libkrun-under-rootless-Podman spike** on a representative host (including a 16 KB-page arm64 box, the
   hardest case). libkrun's bundled aarch64 guest kernel is compiled `CONFIG_ARM64_4K_PAGES=y`, and the
   KVM stage-2 granule is independent of the guest's stage-1 granule (the same reason a 4 KB Firecracker
   guest already boots on a 16 KB host — see appendix), so it *should* boot; the spike confirms it in
   practice. Carry: **crun #1894** — krun may need an ACL on `/dev/kvm` beyond `kvm`-group membership;
   prefer `setfacl -m u:<svc>:rw /dev/kvm` over world-`0666` (which would be a real permission
   regression). Also confirm the guest-vCPU ceiling and a boot-to-userspace timing on the real reviewer
   rootfs.
2. **Network-off-by-construction assertion** for the chosen VMM (§5, caveat under "no-network"): TSI/passt
   transport must be built off and re-asserted fail-closed from inside the guest.
3. **Installer + preflight** implementing the tier-honesty and floor invariants of §5.

---

## Appendix — validation evidence

The load-bearing claims were validated on a representative arm64 self-host target (Raspberry Pi 5,
16 KB-page kernel 6.12.93, Debian 12) — deliberately the hardest case for the page-size and memory-cap
arguments. This host is only an example target; the findings are architectural, not device-specific.

| Check | Result |
|---|---|
| Real **Firecracker micro-VM with a 4 KB-page guest kernel booted on the 16 KB-page host** in **0.13 s**, as an unprivileged uid with only the `kvm` group | **PASS** — proves KVM is page-size-agnostic where gVisor is not |
| Bidirectional **guest → vsock → host-unix-socket** exchange, per-VM socket, rootless | **PASS** (0.14 s) — gateway-bridge shape works |
| **VMM-enforced memory ceiling** on a host where the cgroup memory controller is disabled (guest OOM at ~96 MB inside a 128 MiB VM) | **PASS** — structurally fixes the memory-cap gap that defeats every container `--memory` here |
| `/dev/kvm` gated **solely** by `kvm`-group membership (no root) | **PASS** |
| Container memory cap (`docker`/`podman --memory`) on this host | **FAIL (host firmware)** — "Limitation discarded", runs anyway; applies to A/B/C equally |
| gVisor `runsc` boot, rootful **and** rootless | **FAIL (identical)** — host uses 16 KB pages, official arm64 `runsc` compiled for 4 KB: `host page size (16384) does not match compiled page size (4096)` |
| B: rootless `podman --network none` / `--pids-limit` / userns host-isolation | **PASS** |
| C: nested `PrivateNetwork=yes`, default caps → **inherits outer routed network (fail-open)** | **FAIL** |
| C: nested `PrivateNetwork=yes` + outer `--cap-add=SYS_ADMIN` → fresh netns, only `lo` | PASS (only with the broad outer capability) |

The Firecracker result is the decisive one: it demonstrates, on the hardest target, that a rootless KVM
micro-VM delivers a page-size-portable, VMM-memory-capped, network-free reviewer sandbox — the exact
combination none of the three proposals achieves as written, and the basis for the §5 recommendation.
