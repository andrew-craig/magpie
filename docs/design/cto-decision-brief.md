# CTO decision brief — reviewer sandbox / distribution architecture (3-way)

**Purpose:** decide on the mid-term target architecture for Magpie. This document reviews options and recommends a new architecture.

**The two priorities for the project architecture, in order:**
1. **Secure the reviewer** — malicious PR code cannot impact the host or other systems, or steal
   secrets.
2. **Easy Linux self-host distribution** that **minimises the permissions the app needs**.



---

##  Summary of Options

| | Proposal | Privileged launcher | Reviewer isolation mechanism | Deployment shape |
|---|---|---|---|---|
| **A** | host-native **magpie-shim** + containerised orchestrator/gateway - see `shim-containerisation.md`  | small audited **root-equivalent shim** fronts the root docker daemon | `docker run --network none` (unchanged, proven) | native shim + compose stack; 2-phase |
| **B** | **rootless Podman + gVisor**, orchestrator launches directly - see `sandboxed-reviewer-design.md`  | none — rootless, no root anywhere | rootless `podman --network none`, `runsc` where available else `crun` | single Go orchestrator, rootless podman; heavy host prereqs |
| **C** | **one unprivileged userns container**, all-systemd - see `single-container-systemd.md`  | none — no root daemon, no shim | **nested** transient systemd unit (`PrivateNetwork=yes`, cgroup caps) | one artifact, one `docker run`/compose |

---

## Priority 1 — securing the reviewer: how the three differ

### 1a. The #1 property: the reviewer must have NO network, provably and config-independently

| | Result | Evidence |
|---|---|---|
| **A** | **Provable, config-independent** | `docker run --network none` = kernel-empty netns; does not depend on any outer-container capability. This is the shipped, proven mechanism. |
| **B** | **Provable** *[validated]* | rootless `podman --network none`: container sees only `lo`, empty route table, connect to `1.1.1.1` → Network unreachable. |
| **C** | **FAILS OPEN** *[validated]* | Nested `PrivateNetwork=yes` inside the unprivileged container under **default** caps *silently ran with the outer container's routed network still attached* — journal shows `network namespace setup failed, ignoring`, and curl to `1.1.1.1` returned 301 (reached the internet). Correct isolation only appeared after granting the **outer** container `--cap-add=SYS_ADMIN`. |

**This is the single most consequential result in the brief.** For the property that matters most,
A and B are empty-by-construction; **C degrades to a silent fail-open** unless the deployment recipe
grants the outer container a broad capability — i.e. C makes the #1 security property *config- and
capability-dependent*, exactly the class of reasoning Design D was created to eliminate. Even done
"right," C's reviewer netns is only as good as `CAP_SYS_ADMIN` being present on the outer container,
which also widens the outer boundary.

### 1b. Secret separation (can a compromised untrusted-input path reach the provider key?)

Magpie's current model: orchestrator (parses untrusted PR content; holds GitHub key + gateway master
key) is a **different uid** from the gateway (holds the real OpenRouter key). The reviewer gets only a
spend-capped virtual key.

| | Secret separation | Note |
|---|---|---|
| **A** | **Preserved** | orchestrator ⟂ gateway kept as separate container uids; shim never sees any secret. Unchanged from today. |
| **B** | **Regressed as written** | the design folds credential injection into "the orchestrator's proxy … injects the gateway auth header" — i.e. the untrusted-input-parsing process holds the provider credential. Collapses the orchestrator/gateway uid split. Fixable, but the doc as written is a step *down* on priority 1. |
| **C** | **Preserved** | separate internal uids O ≠ G, gateway key in a 0600 file; `/tmp/host-only` and non-mounted host files unreachable, container-root maps to unprivileged host uid *[validated]*. |

### 1c. Runtime-escape depth & blast radius of the privileged component

- **gVisor (B's headline):** strongest in principle (userspace kernel). On this box B **degrades to `crun`**, i.e. the same namespace/seccomp isolation A and C use
  — so B's security *edge* is conditional and non-portable, while its costs are certain.
- **Root-equivalence:** A keeps a root docker daemon + a root-equivalent shim on the host (concentrated
  in a ~500-line audited component, **unreachable from the untrusted-input path**). B and C have **no
  root anywhere** — genuinely better on this axis — **except** C's fail-open netns pushes you toward
  `CAP_SYS_ADMIN` on the outer container, eroding that advantage.
- **pids cap + hard timeout:** enforce in all three *[validated]*.

---

## Priority 2 — easy install / minimal permissions

| | Host prerequisites | Permissions footprint | Rework |
|---|---|---|---|
| **A** | root docker daemon (already the requirement since M3) + one native shim service | removes docker-group from orchestrator; **concentrates** root-equivalence in the shim | **lowest** — reuses the entire TS codebase, signed reviewer image, gateway; 2-phase, incremental |
| **B** | rootless podman + crun + **runsc** + subuid/subgid + linger + userns + slirp4netns | **no root** (best on paper) — but the prereq matrix is the heaviest, and runsc/arm64 is the weakest link | **highest** — reads as a **Go rewrite** of the orchestrator; abandons current gateway split |
| **C** | an unprivileged container runtime (rootless podman/docker) + cgroup v2 delegation + userns; skopeo/rootfs unpack for the reviewer image | **no root daemon, no shim** (best on paper) — but **needs `CAP_SYS_ADMIN` on the outer container** for reviewer netns, partly undoing "minimal" | **high** — least-proven path (systemd-in-userns-container + nested transient units + 2-level cgroup delegation) |

Note the tension: on the *pure* "minimise permissions" axis B and C look best (no root), but B's win is
undercut by an unshippable prereq matrix on low-end targets, and C's is undercut by the `CAP_SYS_ADMIN`
requirement its own #1-property isolation depends on. **A's root-equivalence can itself be made
optional** — see the recommendation.

---


## Bigger-picture


### The structural facts that remain

- **A permanently has a root docker daemon in its TCB.** Intrinsic to "front docker with a shim,"
  not an implementation detail. Against priority 2 ("minimize the permissions the app needs") that is a
  **structural liability**.
- **B has no root anywhere *and* a second kernel.** Rootless ⇒ the whole TCB is unprivileged
  (permanent). gVisor ⇒ the reviewer sits behind a userspace kernel **independent of host-kernel
  correctness** — a boundary neither A nor C has or can gain without becoming B. B's empty netns is a
  *superset* of A's (empty-netns **plus** gVisor).
- **C's reviewer boundary is intrinsically nested.** The fail-open netns is a symptom, not a bug: a
  sandbox built inside a deliberately-unprivileged container has guarantees **bounded by what the outer
  container can delegate** (hence needing `CAP_SYS_ADMIN` back on the outer container). A first-class
  sandbox is always easier to *prove* than a sandbox-in-a-sandbox.

### The long-horizon argument (the actual "think bigger")

The reviewer's **read-only tool allowlist is a current product choice, not a permanent property.** The
natural product evolution — run the tests/linters/build and review the failures — means the reviewer
**executes untrusted repo code.** At that point:
- A and C rely *solely* on the host kernel boundary between executing-attacker-code and root.
- B's gVisor userspace kernel becomes the **load-bearing** boundary — and it's the only design with one.

Pick the architecture that stays correct **after** the reviewer gains code execution. That is B. This is
the difference between the right *today* decision (A: familiar, low-rework) and the right *long-term*
decision (B: structurally sound as the product grows).

### Revised recommendation: **Design B's substrate is the target architecture**

Rootless Podman + gVisor, a **first-class (non-nested) reviewer sandbox**, no root anywhere.

- **Priority 1:** zero-root TCB + host-kernel-independent isolation + a provable, non-nested reviewer
  boundary. **Strictly dominates A**; **structurally more provable than C**.
- **Priority 2:** "minimize the permissions the app needs" is maximized by "the app needs none." B is
  the only design whose entire TCB is unprivileged (A can't beat "there is a root daemon"; C is rootless
  too but reclaims `CAP_SYS_ADMIN` for its reviewer boundary).

**Mandatory refinements (not costs):**
1. Keep the **orchestrator ⟂ gateway uid split** — provider key in a separate-uid gateway, never in the
   untrusted-input-parsing orchestrator. (Fixes B's as-written regression.)
2. **Absorb C's distribution ambition** — package the rootless-user / subuid / linger / cgroup-delegation
   / runsc setup into a clean installer so B *feels* as easy to install as C's one-artifact goal.

**A** demotes to "the familiar, low-rework option" — but those were the excluded considerations; what's
left is a permanent root daemon. **C** remains the **north star for distribution UX**, and its packaging
idea is absorbed into B, but its nested reviewer boundary loses on the priority that ranks first.

### gVisor validated on this box — result: host-conditional, not universal *[validated 2026-07-19]*

`runsc` installs cleanly (release-20260714.0, systrap platform) but **cannot boot a single sandbox on
this box, rootful or rootless** — the kernel uses **16 KB pages** (`getconf PAGE_SIZE` = 16384) while the
official `runsc` arm64 build is hard-compiled for **4 KB pages**: `FATAL ERROR: host page size (16384)
does not match compiled page size (4096)`, no override flag. Rootful and rootless fail **identically**,
proving the blocker is the host page size, not rootless mechanics (userns/cgroup/ptrace were never
reached). The reviewer-workload/overhead tests were therefore unreachable on this box.

**Decision impact — gVisor moves from "installable dependency" to "host-conditional layer":**
- The official gVisor **arm64** build assumes 4K pages, so it fails on **16K-page arm64 (RPi 5 default)
  and 64K-page arm64 (some arm64 server distros)** — a broad arm64 boundary, not a Pi quirk.
- On the **mainstream target — amd64, and 4K-page arm64 — gVisor works** (well-trodden path; *expected*,
  not validated here since this box is arm64/16K).
- **B's own doc already plans for this** ("runsc where it works; fall back to crun") — consistent, not a
  contradiction.

**Refined recommendation (supersedes the flat "B" above but keeps its core):**
> **B's _rootless substrate_ (rootless Podman, no root anywhere, first-class `--network none` reviewer
> sandbox — validated PASS on this box) is the right foundation. gVisor is the strongest
> _kernel-independent isolation layer_ to stack on top _where the host supports it_ (amd64 / 4K-arm64);
> B degrades cleanly to rootless-podman + crun where it doesn't (16K/64K arm64) — still rootless, still
> first-class, still ahead of A's permanent root daemon on priority 2.**

**Bigger-picture hedge:** the architectural goal is "a reviewer isolation boundary independent of the
host kernel." gVisor is one implementation; a **KVM-backed microVM (Kata/Firecracker)** is another (this
box *has* `/dev/kvm`) and may be the more portable way to get the same "second kernel" where gVisor's
page-size constraint bites. Same principle as B, different mechanism — worth scoping if arm64 is
first-class.

**Sharpened CTO question:**
1. **amd64-first matrix?** → B + gVisor is a clean win; long-term recommendation stands.
2. **arm64 (incl. RPi 5 / 16K-page) first-class?** → gVisor can't be assumed; adopt B's rootless
   substrate as baseline, treat kernel-independent isolation (gVisor *or* a KVM microVM) as a
   host-conditional layer.

*(runsc left installed on this box as a non-default Docker runtime; default runtime unchanged = runc.)*

---

## Recommendation — rootless microVM default, gVisor future upgrade

**Supersedes every recommendation above.** The reviewer isolation boundary is a **rootless KVM-backed
microVM (Kata Containers / Firecracker) by default**, built on **Design B's rootless substrate** (no
root anywhere; the orchestrator ⟂ gateway uid split is preserved — the provider key never lives in the
untrusted-input-parsing process). **gVisor is a deferred, optional upgrade** for larger / high-density
or no-KVM hosts — not built this round.

### Why microVM is the right default
1. **Strongest reviewer isolation — a real, separate guest kernel.** A hardware-virtualized (KVM)
   boundary, not a shared host kernel (A/C) or a userspace kernel (gVisor). This is the correct
   long-term choice for the "reviewer will execute untrusted repo code" future: code execution inside
   the reviewer faces a full VM boundary, not just namespaces.
2. **Portable across the arm64 page-size boundary that just sank gVisor.** KVM is agnostic to host page
   size — the guest runs its own kernel/paging. Works on this RPi 5 (`/dev/kvm` present, 16K pages)
   where the official gVisor arm64 build cannot boot at all.
3. **Structurally solves the memory-cap gap.** A microVM's memory ceiling is its guest RAM allocation,
   hard-enforced by the VMM — independent of host cgroup controllers. This sidesteps the
   `cgroup_disable=memory` gap that leaves `--memory` unenforced for *all* container-based designs
   (A/B/C) on this box.
4. **network-none by construction, stronger than a container** — *with one libkrun caveat (below).* A
   microVM with no virtio-net device has no network path — not even a shared host netns to misconfigure.
   **CAVEAT (review round 2):** libkrun can also provide guest egress via **TSI/passt** (a userspace
   socket-passthrough transport with *no* virtio-net device to spot in a config audit) — the libkrun
   analog of Design C's fail-open netns. So `--network none` under libkrun is a **mandated invariant**:
   the reviewer VM is built/launched with **network transport explicitly disabled**, asserted *by
   construction + preflight* and re-asserted **fail-closed from inside the guest at startup** (the way the
   current entrypoint already makes confinement assertions) — never left to a launch flag.
5. **Rootless — precise TCB claim (review round 2).** No root *daemon* and no root in any Magpie runtime
   process (orchestrator/gateway/reviewer); `/dev/kvm` is reached via the `kvm` group. The *only* setuid
   surface is **`newuidmap`/`newgidmap`** — two narrow, widely-audited shadow-utils helpers rootless
   podman invokes once at namespace setup (inherent to Design B's rootless substrate, not new to
   libkrun). Honest wording: *"no root daemon and no root Magpie process; the only setuid-root surface is
   two shadow-utils binaries at namespace setup"* — a dramatically smaller TCB than a root docker daemon,
   but not literally zero-setuid.

### gVisor is the no-KVM / high-density tier — ranked BELOW microVM (framing corrected post-review)
Tiers ranked by isolation strength: **microVM (KVM) > gVisor > crun-hardened.** gVisor is *not* an
"upgrade" (a microVM is strictly stronger); it is a deliberate isolation *downgrade* taken for coverage
and density where a microVM isn't the right fit:
- Needs **no `/dev/kvm`** → the tier for hosts **without hardware/nested virtualization** (most non-metal
  cloud instances) — the gap the microVM default cannot cover, and where gVisor should be the preferred
  floor over bare crun.
- On **larger, high-concurrency hosts**, its lower per-sandbox memory overhead (no full guest kernel per
  job) improves review density.
- Deferred: an optional runtime on the same rootless substrate, still gated on the arm64 page-size story
  (needs a 4K-page host, or an upstream/self-built 16K `runsc`).

### The isolation ladder (host-conditional, all on B's rootless substrate)
Ranked by isolation strength: **microVM (KVM) > gVisor > crun-hardened.**

| Tier | Runtime | When | Requires |
|---|---|---|---|
| **Default (strongest)** | rootless KVM microVM — **libkrun/krun under podman** (primary), Firecracker-direct (proven fallback) | hardware virt available | `/dev/kvm` (bare metal or nested-virt VM) + `kvm` group |
| **No-KVM / high-density** | gVisor (runsc) | no `/dev/kvm`, or large high-concurrency hosts | 4K-page host (arm64) or amd64 |
| **Last-resort fallback** | rootless podman + crun (hardened namespaces) | no `/dev/kvm` **and** no gVisor | userns + subuid (validated on this box) |

("Rootless Kata" is **not** a runtime option — see resolutions Q1: `kata-runtime` runs as root and does
not support Podman.)

### New architectural wrinkles a microVM introduces (corrected post-review)
1. **Gateway channel: bind-mounted unix socket → vsock (NOT virtiofs).** Today the reviewer's only egress
   is a bind-mounted `/run/gw` unix socket. A microVM guest can't share a host unix socket by bind mount,
   and **virtiofs cannot carry an `AF_UNIX` connection** (it proxies file ops, not socket connections —
   confirmed in review). **vsock is the only option**, and it is **mandated to be per-VM _hybrid_ vsock**
   (each job's VM gets its own host-side UDS path, e.g. Firecracker/libkrun `uds_path`), **never a
   host-global `vhost-vsock` listener** (which shares one host CID namespace and would make the virtual
   key the sole cross-job authenticator). Per-VM UDS keeps per-job channel isolation *by construction*,
   consistent with Design D. A small host-side forwarder bridges the per-job vsock UDS ↔ the gateway's
   per-job socket; the budget-capped virtual-key model is unchanged.
2. **Reviewer `/work` (PR checkout) delivery.** Read-only bind mount today. With **libkrun/Kata-virtiofs**
   `/work` rides a read-only **virtiofs** mount (fine for a filesystem — the virtiofs limitation is only
   for the *socket*). With **Firecracker-direct** (no virtiofs) use a per-job read-only **ext4 image**
   built unprivileged via `mkfs.ext4 -d <dir>` (confirmed unprivileged in review). Workspace delivery is
   coupled to VMM choice — a reason to prefer a virtiofs-capable rootless VMM.
3. **Reviewer rootfs/guest-kernel delivery + supply chain.** A microVM needs a guest kernel (and, for FC,
   a rootfs). **libkrun bundles + maintains its guest kernel upstream**, so our net-new supply-chain
   surface is "pin + cosign-verify a libkrun release," not "build/patch/CVE-track a kernel ourselves"; the
   existing signed, digest-pinned reviewer OCI image is reused as the guest rootfs. Firecracker-direct
   instead makes us own a guest-kernel + rootfs pipeline per arch — real permanent scope. (Preference:
   libkrun, precisely to externalize the kernel supply chain.)
4. **Per-job boot cost.** ~125 ms–1 s VMM/kernel boot (**validated: 0.13 s to userspace on this Pi 5**) +
   guest RAM per concurrent job. Fine for multi-second/minute reviews; sets the memory-bound concurrency
   ceiling (~2–4 concurrent at ~1 GB guest RAM on an 8 GB host — validated).

### Tier honesty is a first-class invariant (not a nicety)
On hosts with **no `/dev/kvm`** (most non-metal cloud VMs) the "microVM default" silently degrades to a
weaker tier. **Why this is *not* a re-import of Design C's sin (review round 2):** the #1 north-star
property — *reviewer has no network, provable by construction* — is **tier-invariant.** All three tiers
deliver an empty network path by construction and that guarantee never degrades down the ladder; only the
*isolation depth* of the reviewer↔host-kernel boundary varies (separate guest kernel → userspace kernel →
hardened shared-kernel namespaces), and that variation is preflighted and surfaced. Design C's
disqualifier was that the #1 property *itself* silently failed open; here it holds identically in every
tier. Requirements:
- **Install-time tier preflight** probes `/dev/kvm` by *actually opening it + a trivial `KVM_CREATE_VM`*
  (do **not** trust EL0 CPU ID registers — they mis-report on this box; review row 13) and **fails loud /
  requires explicit acknowledgement** before landing on a weaker tier.
- **Runtime tier surfacing:** the active isolation tier is exposed on `/healthz` and in the PR review
  summary footer, so "this review ran in a microVM / gVisor / crun sandbox" is visible per review.
- **All security claims are tier-qualified** in operator docs.
- **Floor invariant (review round 2): the crun last-resort tier must be exactly today's shipped hardened
  posture** — seccomp + `--cap-drop=ALL` + `no-new-privileges` + read-only rootfs + pids-cap +
  `--network none` + `.git`-stripped RO `/work`. If crun-floor == current production isolation, **no
  operator on any host is worse off than today's shipped product**, and microVM/gVisor are strict gains
  where KVM/4K-page hosts exist. The fallback must never silently regress below today's baseline.

### Open questions → resolved (see "Fable review — resolutions" section below)
The vehicle, socket, workspace, supply-chain, tier-honesty, and framing questions are resolved there. The
**one remaining gate**: validate **libkrun/krun under rootless podman** (the chosen vehicle — keeps OCI
images *and* rootless, unlike Kata) on this exact 16K-page box. Firecracker-direct is the proven rootless
fallback (booted here). "Rootless Kata" is **dropped** — it is not real (root `kata-runtime`, no Podman).

---

## Fable review — validation outcome & resolutions (2026-07-19)

**Verdict from review: sound-with-conditions.** The core bet was **validated harder than the doc
claimed** — on this exact box (RPi 5, 16K pages, kernel 6.12.93), as uid 1000 with *only* the `kvm`
group (no root), the reviewer:
- booted a real **Firecracker microVM with a 4K-page guest kernel on the 16K-page host in 0.13 s** →
  proves KVM is page-size-agnostic where gVisor was not (decision claim #2);
- ran a bidirectional **guest → vsock → host-unix-socket** exchange in 0.14 s → the gateway-bridge shape
  works, rootless, with per-VM UDS isolation;
- got a **VMM-enforced memory ceiling on a `cgroup_disable=memory` host** (guest OOM at ~96 MB in a
  128 MiB VM; host FC RSS 126 MB) → the memory-cap gap that defeats every container `--memory` on this
  box is structurally fixed (claim #3);
- confirmed `/dev/kvm` is gated **solely** by the `kvm` group (claim #5 / priority-2).

**Resolutions to the reviewer's 7 questions (ranked as it ranked them):**

1. **Vehicle → libkrun/krun under rootless podman (primary); Firecracker-direct (proven fallback); Kata
   dropped.** The reviewer proved "rootless Kata" is not real (root `kata-runtime`, Podman unsupported),
   so Kata is incompatible with our no-root requirement and is removed. **libkrun** uniquely satisfies all
   three constraints at once — rootless, KVM-isolated, *and* an OCI runtime under podman (keeps the signed
   reviewer image + bundles/maintains its own guest kernel). It is the target vehicle, **gated on a
   libkrun-on-this-16K-box spike**. Firecracker-direct is the validated backup (booted here) at the cost
   of owning a guest-kernel/rootfs pipeline and per-job ext4 for `/work`.
2. **KVM-less hosts → tier honesty is now a mandated invariant** (added above): loud install-time
   `/dev/kvm` preflight (open + `KVM_CREATE_VM`, not CPU-ID regs), runtime tier surfaced on `/healthz` +
   the PR review footer, and tier-qualified security claims. The "microVM default" is explicitly a
   *bare-metal / nested-virt* default; on KVM-less clouds the preferred floor is **gVisor**, then crun.
3. **`/work` into the guest → virtiofs-ro (libkrun) or per-job `mkfs.ext4 -d` image (FC).** Added to
   wrinkle #2. Note the split the review forced: **virtiofs is fine for `/work` (a filesystem) but not for
   the gateway *socket*** (vsock only).
4. **Per-VM hybrid vsock is now a stated invariant; host-global vhost-vsock is forbidden** (wrinkle #1).
   Preserves per-job channel isolation by construction — another reason to prefer libkrun/FC (hybrid
   vsock) over Kata (vhost-vsock).
5. **Guest-kernel supply chain → externalized to libkrun** (pin + cosign-verify a libkrun release rather
   than build/CVE-track a kernel), reviewer OCI image reused as guest rootfs. Added to wrinkle #3 — a
   decisive reason to prefer libkrun over FC-direct.
6. **"Upgrade" framing corrected** to a strength-ranked ladder (microVM > gVisor > crun); gVisor relabeled
   the **no-KVM / high-density tier**, an intentional downgrade for coverage/density.
7. **Failure semantics + sizing:** a dead reviewer VM (OOM/panic/timeout) maps to the **existing
   clear-failure-note publisher path** (reviewer non-completion is already handled that way). Default guest
   RAM **~1 GB/review** (Pi agent is Node); default concurrency = `floor(available_RAM / 1 GB)`, min 1,
   guest RAM configurable.

**Net:** the decision stands; the substrate is empirically proven on the hardest target. Before
implementation the **libkrun-under-rootless-podman spike (Q1)** is the one open gate; everything else is
resolved and folded into the sections above.

### Fable confirmation (round 2) — all conditions resolved, 3 refinements folded in

The reviewer confirmed its answers and closed all blocking conditions, with hard evidence, plus three
refinements now incorporated above:

1. **Page-size gate green in principle.** libkrunfw's aarch64 kernel config is
   `CONFIG_ARM64_4K_PAGES=y` / `PAGE_SHIFT=12` — a **4K-page bundled guest kernel that does not inherit
   host page size** (KVM stage-2 granule is independent of the guest's stage-1 granule — exactly why the
   Firecracker 4K-on-16K boot worked). So libkrun should boot on this 16K box; the spike confirms it in
   practice.
2. **`--network none` under libkrun is by-construction, not a flag (folded into claim #4).** libkrun's
   TSI/passt transport can grant egress with no virtio-net device to audit — must be built off and
   asserted fail-closed from inside the guest.
3. **Precise "no root" wording (folded into claim #5):** no root daemon/process; only `newuidmap`/
   `newgidmap` setuid helpers at namespace setup.

**Remaining gates before implementation (none threaten the decision — they separate "proven substrate"
from "proven vehicle"):**
- **The libkrun-on-this-16K-box spike**, carrying: **crun #1894** (krun may need an ACL on `/dev/kvm`
  beyond `kvm`-group membership — **prefer `setfacl -m u:<svc>:rw /dev/kvm` over world-`0666`**, which
  would be a real permission regression vs. the group gate already proven); the `CONFIG_NR_CPUS=8`
  guest-vCPU ceiling; and a boot-to-userspace timing on the *real* reviewer rootfs.
- **The TSI/network-off by-construction assertion** (refinement 2).
- **The "no root anywhere" wording fix** naming the setuid shadow-utils helpers (refinement 3).

Floor invariant added: the crun tier must not be weaker than today's shipped hardened posture (so no
host regresses below the current product).

## Appendix — validation log (this box, aarch64 Debian 12)

| Check | Result |
|---|---|
| `cgroup_disable=memory` on kernel cmdline; memory controller absent hierarchy-wide | confirmed (direct) |
| `docker run --memory=64m` → "Limitation discarded", runs anyway | confirmed (direct) |
| rootless podman: works, crun, rootless=true | PASS |
| rootless `--network none`: only `lo`, no route out | PASS |
| rootless `--pids-limit`: fork bomb contained | PASS |
| rootless userns: container-root → host uid 1000; non-mounted host files unreachable | PASS |
| rootless `--memory`: hard error (systemd mgr) / silent no-op (cgroupfs) | FAIL (firmware) |
| C: nested `PrivateNetwork=yes`, default caps → **inherits outer routed network, fail-open** | FAIL |
| C: nested `PrivateNetwork=yes` + outer `--cap-add=SYS_ADMIN` → fresh netns, only `lo` | PASS |
| C: nested `MemoryMax=64M` → 200MB alloc not killed | FAIL (firmware) |
| C: nested `TasksMax`, `RuntimeMaxSec`, host-file isolation, uid mapping | PASS |
| gVisor/runsc present | absent on box; **installable on arm64** (per CTO) — runs-rootless-here still to be validated |

---

