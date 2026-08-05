# Magpie — Distribution & Self-Hosting Strategy

Magpie today is built to run on *one specific* always-on Linux box (a Raspberry Pi):
host-native systemd services, a hand-registered GitHub App, host `iptables` egress rules on a
pinned docker subnet, a locally-built reviewer image version-matched to the host, and
Cloudflare-Tunnel-via-`apt` ingress that assumes arm64 + a Cloudflare-managed domain. It works
well, but a second organisation cannot adopt it without reverse-engineering the install.

This document proposes how to make Magpie **distributable and easy for a new organisation to
stand up** — *without weakening, and in fact strengthening,* the per-run isolation of the
(untrusted, prompt-injectable) Pi reviewer, which is the whole point of the project.

> **Design decision (after two review rounds — see history at the end).** The distributable
> architecture is **"Design D": host-service orchestrator + host-process gateway + a single
> reviewer container that runs with `--network none` and reaches the gateway over a mounted unix
> domain socket.** This gives *provable, daemon-config-independent* egress isolation, preserves
> the gateway's file-based key custody, and needs **no** docker-socket-in-a-container (DooD) and
> **no** host `iptables`/bridge apparatus at all. The earlier idea of shipping the whole stack as
> a `docker compose` DooD deployment was **rejected**: it would ship a host-root-equivalent
> pulled orchestrator image, which is off-brand for a capability-separation project. Packaging
> effort goes into making the **host-service install excellent**, not into a one-command compose
> that trades away isolation.
>
> **Scope also fixed:** GitHub-App/secret onboarding is **documentation-only** this round (no
> automated App Manifest flow). LLM provider stays **OpenRouter-only** (multi-provider remains the
> existing M6-D task).

---

## 1. What ties Magpie to one server today

| Area | Current state | Why it blocks distribution |
|---|---|---|
| **Reviewer egress** | Host `iptables` (`MAGPIE-EGRESS`/`MAGPIE-INPUT`) on a pinned `172.31.99.0/24` `--internal` bridge; gateway IP baked into config. | Requires **root netfilter control** on the host; pinned IPs; correctness depends on the adopter's `daemon.json` (`iptables:true`, `ip6tables`, Docker version). Not portable. |
| **Reviewer image** | Built locally by `build-reviewer-image.sh`, Pi version pinned to match the *host's* `pi --version`. | Every adopter must build and re-pin; nothing published. |
| **Deployment** | 3 host systemd units + 2 Unix users; `install.sh` `sed`-rewrites a hardcoded `/opt/magpie` prefix and `/usr/bin/node` path. | Bespoke path handling; no release artifact; assumes system node at a fixed path. |
| **GitHub App** | Hand-registered: operator sets permissions/events/webhook, copies App ID, downloads `.pem`, invents webhook secret. | Highest onboarding friction (docs-only fix this round). |
| **Secrets** | Spread across `magpie.env`, `gateway.env`, `config.toml`, and a `.pem`; a shared master key must be typed identically into two files. | Error-prone; no single source of truth. |
| **Ingress** | `setup-cloudflared.sh` installs cloudflared via arm64 `apt` and assumes a Cloudflare-managed domain. | Vendor + arch locked; no option for orgs with a normal reverse proxy. |
| **Framing** | README/PLAN/CLAUDE all say "personal Linux server"; roadmap has no distribution milestone. | Signals "not for you" to other orgs. |

**Key insight:** the single biggest portability blocker is the **host-iptables egress lockdown**.
Design D removes it entirely rather than porting it, so most of the rest becomes ordinary
packaging work.

---

## 2. Target architecture — "Design D": `--network none` reviewer + unix-socket gateway

> **Tier note (M8).** Design D as described in §2.1–§2.6 below is the **hardened crun floor** —
> the tier every Magpie install ships with by default, unchanged in substance since M7. M8
> layers a ranked isolation ladder on top of this floor — micro-VM (KVM) > this crun floor —
> selected per host at startup; see §2.7 for the ladder itself. Every claim
> in §2.1–§2.6 holds **at the crun-floor tier**. The opt-in micro-VM tier delivers the same
> no-network / no-secret-in-reviewer properties by different mechanics (a vsock channel instead
> of a bind-mounted unix socket, a real guest kernel instead of `--network none`) — it does not
> weaken anything described below, it is a strictly stronger alternative.

### 2.1 The trust boundary (unchanged)

- **Untrusted:** the reviewer (runs Pi over attacker-influenced PR content).
- **Trusted:** the orchestrator (privileged git/GitHub/docker work) and the gateway (holds the
  real OpenRouter key).

The reviewer must **never** hold the real provider key, reach the internet except via the
gateway, reach GitHub, reach the gateway's *management* plane, or reach the orchestrator's
secrets.

### 2.2 The topology

```
┌─ Host ───────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  orchestrator (systemd service, `magpie` user, full sandbox)                 │
│    • mints GitHub token, clones, publishes review        ──HTTPS──▶ GitHub    │
│    • talks to LOCAL docker daemon (docker group) to run the reviewer         │
│    • mints/revokes per-job virtual keys ──loopback──▶ gateway MGMT plane      │
│                                                                              │
│  gateway (systemd service, `magpie-gateway` user, own 0600 key file)         │
│    • holds the real OpenRouter key (file, NOT container-inspectable)         │
│    • MGMT plane  : 127.0.0.1:4100  (orchestrator mints/revokes keys)         │
│    • PROXY plane : a UNIX SOCKET   /run/magpie/jobs/<id>.sock  ──HTTPS──▶ OpenRouter │
│                                                                              │
│      per job, the orchestrator `docker run`s:                                 │
│  ┌─ reviewer container (ephemeral, hardened) ───────────────────────────┐    │
│  │  --network none        ← NO interfaces except loopback               │    │
│  │  --cap-drop=ALL --read-only --user <uid> --memory/--cpus/--pids      │    │
│  │  -v <workspace>:/work:ro   (.git-stripped)                          │    │
│  │  -v /run/magpie/jobs/<id>.sock:/run/gw.sock   (the ONLY channel out) │    │
│  │  in-container forwarder: 127.0.0.1:4000  ─────▶ /run/gw.sock         │    │
│  │  Pi → models.json baseUrl http://127.0.0.1:4000/v1 → forwarder → gw  │    │
│  │  credential: per-job virtual key only (budget-capped, worthless)    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Why the egress isolation is *provable* and *config-independent*

A container run with `--network none` has **no network interfaces except its own loopback** — no
veth, no bridge, no route to the host, to other containers, to the internet, to DNS, or to the
cloud-metadata IP. This is a property of the container's network namespace, **not** of any
iptables/nftables rule, so — unlike the current `--internal`-bridge model or the rejected compose
model — it does **not** depend on the adopter's `daemon.json`, Docker version, IPv6 settings, or
the embedded resolver. There is nothing to misconfigure.

The reviewer's *only* path off the container is the **mounted unix socket** to the gateway's proxy
plane. Pi is pointed at it exactly as today (`reviewer.ts` documents that Pi 0.80.3 ignores
`OPENAI_BASE_URL` and is steered via a `~/.pi/agent/models.json` `baseUrl`; the entrypoint keeps
writing that file). The `baseUrl` becomes `http://127.0.0.1:4000/v1`, served by a **tiny
in-container TCP→unix forwarder** (listening on the container's loopback, which `--network none`
leaves intact) that relays to `/run/gw.sock`. The forwarder holds no secret, so it is safe to ship
inside the reviewer image (which runs untrusted content).

### 2.4 What this buys, versus today and versus the rejected compose model

| Property | Today (host iptables) | Rejected compose/DooD | **Design D** |
|---|---|---|---|
| Reviewer egress | strong, but root-netfilter + daemon-config dependent | daemon-config dependent (holes: host-IP INPUT path, IPv6, `iptables:false`) | **provable, config-independent** (`--network none`) |
| OpenRouter key custody | preserved (0600 file, separate user) | **lost** (`docker inspect`/`exec` the gateway container) | **preserved** (gateway stays a host process) |
| Orchestrator privilege | host `docker` group (as today) | **host-root-equivalent pulled image** (socket in container) | host `docker` group (as today); keeps full systemd cage |
| Only pulled image | none (all local) | orchestrator (**worst** — secret-holding, socket-holding) | **the reviewer** (least-privileged: no secret, no socket, no network) |
| Host `iptables`/bridge needed | yes (`setup-network.sh`) | yes-ish (INPUT rule still needed) | **none — deleted entirely** |
| systemd sandbox on the socket-holder | yes | no | **yes** |

The gateway's **virtual-key** mechanism is retained: even though a leaked key can't reach anything
but the gateway now, the key still enforces the **hard per-job spend cap** Pi lacks, and the mgmt
plane stays loopback-only for mint/revoke. Only the proxy plane's *transport* changes (TCP-on-
bridge → unix socket).

### 2.5 Reviewer hardening is unchanged

Every existing `docker run` flag stays: `--user`, `--read-only --tmpfs /tmp`, `--cap-drop=ALL`,
`--security-opt=no-new-privileges`, `--memory/--cpus/--pids-limit`, `.git`-stripped read-only
`/work`. The only changes are `--network bridge/magpie-net` → `--network none` and the added
`-v …/<id>.sock:/run/gw.sock` mount.

Note that `--memory` is only *enforced* when the host kernel's cgroup v2 `memory` controller is
enabled — on a host where it's off (e.g. Raspberry Pi firmware defaults ship
`cgroup_disable=memory`) rootful Docker silently discards the flag. Magpie fails closed on this
at startup and per job rather than running an unbounded reviewer; see `INSTALL.md` §6a and
`config.example.toml`'s `require_memory_limit`.

### 2.6 Feasibility gate + residual details (flagged honestly)

1. **Feasibility spike first.** Confirm the in-container forwarder + `models.json baseUrl` path
   works end-to-end against the gateway over a unix socket with the pinned Pi version. `reviewer.ts`
   strongly implies it will (Pi already talks to an arbitrary HTTP `baseUrl`), but this gates the
   architecture, so prove it before the rest of the epic proceeds. Fallback if Pi ever grows native
   unix support: drop the forwarder; until then the forwarder removes the dependency.
2. **Socket lifecycle: launch ordering + permissions.** Two structural invariants make the
   per-job unix socket robust — neither is tuning.

   *Launch ordering — mount the directory, bind before run.* `docker run -v <src>:<dst>` creates
   `<src>` as a **root-owned directory** if it does not already exist, which would clobber the
   socket path and break both the gateway's `bind()` and the reviewer's connect. So the mount
   *source* is the pre-created per-job **directory** (`…/jobs/<id>/`), never the not-yet-existent
   socket file: the directory always exists at `docker run` time, so Docker can never invent a
   root-owned path, and the socket appears inside the live bind-mount view once the gateway binds
   it. Ordering is fixed — orchestrator creates the job dir → gateway mints the virtual key and
   `bind()`s the socket → orchestrator waits for gateway readiness (path exists and is a socket) →
   `docker run`. The in-container forwarder additionally retries `connect()` with backoff as
   belt-and-suspenders.

   *Permissions — directory traversal, not a shared group.* Access control is the bind mount plus
   directory perms, not socket-level ACLs. The gateway's runtime tree is `0700 magpie-gateway`, so
   every *other* host user is stopped at the top (the socket path is visible in `/proc/net/unix`
   but untraversable); the reviewer never walks those host-side ancestors — it enters through the
   bind mount directly onto the job dir. Layout:
     - `/run/magpie-gateway/` — `magpie-gateway:magpie-gateway`, **0700** (systemd `RuntimeDirectory`).
     - `…/jobs/<id>/` — `magpie-gateway:magpie-gateway`, **0711**: the reviewer gets search (to reach
       the socket) but **no write**, so a compromised reviewer cannot `unlink` the socket or squat a
       replacement in the dir.
     - `…/jobs/<id>/<id>.sock` — **0666** (explicit `chmod` after `bind()`, not umask-dependent):
       `connect()` needs write on the socket inode, and the reviewer shares neither owner nor group
       with the gateway, so the grant lives on the socket while the `0711` dir prevents tampering.
       The dir is bind-mounted **read-only** — the kernel's read-only-mount check fires only on
       filesystem *mutations*, not on `connect()`, so the socket still works while every FS write
       from inside the container is refused.

   This deliberately drops the shared-`magpie-ipc`-group scheme. Given the reviewer is already
   `--network none`, holds no secret, and the socket only reaches a spend-capped, key-custodial
   gateway, a shared group defends against nothing the `0700` directory does not — its only real
   payoff is surviving a *future* privileged misconfiguration, which does not justify permanently
   entangling the two principals this architecture exists to separate. (Abstract-namespace sockets
   are likewise rejected: they are scoped to the network namespace, so `--network none` cannot see
   them; and random socket *names* are not access control, since `/proc/net/unix` lists every bound
   path. **Update (M8-B2): Magpie now runs rootless Podman by default** — `--preserve-fds` remains
   an available future refinement to pass the connected fd and delete the pathname socket entirely,
   but is not implemented; the pathname-socket + `0711`/`0666` scheme above is what ships.)
3. **Fail-closed runtime assertion (cheap belt-and-suspenders).** The reviewer entrypoint asserts
   at startup that it has **no** external route (e.g. a connect to a public IP fails) and that the
   gateway socket is present, and refuses to run otherwise — mirroring PLAN.md M4's "fail closed if
   any host other than the gateway is reachable" idea. With `--network none` this should always
   pass; the assertion catches a mis-launch (wrong `--network`) rather than a daemon-config drift.
4. **Reviewer-to-reviewer isolation is now moot.** With `--network none` there is no shared L2
   segment; concurrent reviewers are network-isolated from each other by construction.
5. **Supply chain is minimised, not eliminated.** The only pulled image is the reviewer — the
   least-privileged component (no secret, no socket, no network). Still pin it by digest and sign
   it (cosign/provenance); a compromised reviewer image is far less catastrophic than a compromised
   orchestrator image would have been under the rejected compose model.

### 2.7 The isolation-tier ladder (M8): crun floor is the default, not the ceiling

Design D above answers "how does the reviewer reach the gateway with no network egress." M8
answers a broader question — "what is the reviewer↔host-kernel boundary itself" — with a
ranked, auditable ladder rather than one fixed answer (see
`docs/design/cto-decision-brief.md` §5 and `packages/orchestrator/src/tier-ladder.ts`):

**micro-VM (KVM) > hardened crun (the floor).** The floor is exactly the Design D mechanics of
§2.1–§2.6, and is what every install runs by default. The micro-VM tier is an opt-in a host must
explicitly provision (`/dev/kvm` + `[microvm]` config): a rootless libkrun micro-VM gives a real,
separate guest kernel instead of a shared host kernel, with the gateway reached over a per-job
hybrid-vsock channel instead of the bind-mounted unix socket §2.2 describes (a VM guest can't
share a host unix socket by bind mount).

**No unqualified isolation claims.** Nothing in this document should be read as "the reviewer
always runs in a micro-VM" — say which tier, every time. The crun floor is the shipped default.

**Floor invariant.** `packages/orchestrator/src/reviewer-crun-floor-argv.test.ts` (M8-B1,
`task_89c4`) pins the crun tier's full container-runtime argv against a golden fixture, so §2.5's
"reviewer hardening is unchanged" claim is enforced by a regression test, not just prose — the
floor cannot silently erode while attention is on the micro-VM path.

**No-network is the one tier-invariant property.** §2.3's `--network none` argument is specific
to the crun floor's container network namespace; the micro-VM tier achieves the identical
"no network path at all" property by different, VM-native means — the guest is built with no
network transport and this is preflight-asserted fail-closed (no virtio-net device, no TSI/passt
socket passthrough — see reviewer.ts's `findMicrovmNetworkTransportViolations`). Whichever tier
is active, the reviewer has no network egress; only the depth of the isolation boundary varies.

**Tier visibility is operator-only.** The resolved tier is exposed on `GET /healthz` and in
structured orchestrator logs — never in the published PR review (publisher.ts's M8-D2
tier-silence guard test asserts this). The rationale is attacker recon: a PR is untrusted-input
territory, so a field on it that says "this deployment runs the weaker crun floor" would hand a
prospective attacker free information about which target is worth an escape attempt.

**Trusted computing base.** M8 also moved the orchestrator's own reviewer-launching substrate to
rootless Podman, which changes the honest TCB claim to: *"no root daemon and no root Magpie
process; the only setuid-root surface is two shadow-utils binaries (newuidmap/newgidmap) at
namespace setup."* Those two setuid helpers are exactly what elevate to write the container's
uid/gid map during rootless namespace setup — and that is also why several of
`systemd/magpie.service`'s own seccomp-based hardening directives (`SystemCallFilter`,
`RestrictAddressFamilies`, `RestrictSUIDSGID`, `LockPersonality`, most `Protect*`) had to be
*removed* rather than kept: every one of them forces `NoNewPrivileges=1`, which blocks
`newuidmap`/`newgidmap` from elevating and breaks every rootless review launch (verified
on-target; see that unit's header comment for the full, per-directive account). This is a real,
honest reduction in the orchestrator's own sandbox, not a paper cut to gloss over — the
compensating argument is that the orchestrator is *trusted* host code whose only job is to
launch the sandbox around *untrusted* PR content, so the confinement that matters lives in the
reviewer container/micro-VM guest, not in the orchestrator's own seccomp profile. What the unit
keeps: `RestrictNamespaces` (narrowed to an explicit allow-list, verified not to force
`NoNewPrivileges`), `ProtectSystem=strict`, `PrivateTmp`, and `StateDirectory` confinement.

---

## 3. Distribution architecture (packaging around Design D)

### 3.1 Publish the reviewer image (multi-arch); package the host services well

- Publish **`magpie-reviewer`** to GHCR, **multi-arch (amd64 + arm64)**, pinned by digest and
  signed, built by release CI. Adopters `pull` instead of running `build-reviewer-image.sh` and
  re-pinning Pi to their host. This is the *only* container in the product.
- The **orchestrator** and **gateway** are host Node services. Package them for a clean install:
  a versioned release artifact (tarball or npm package with a committed lockfile and pinned deps),
  the existing systemd units, and an install script that no longer assumes a single hardcoded
  prefix or node path. Keep the graceful-drain `TimeoutStopSec` the units already have.
  - **Per-arch host tarballs (M8-D3).** The host tarball was pure-JS and therefore
    architecture-independent through M7. As of the isolation-tier work it also bundles the native
    `magpie-tier-probe` binary (the `/dev/kvm` `KVM_CREATE_VM` preflight, `rust/magpie-tier-probe`)
    at `bin/magpie-tier-probe`, which is per-arch (static-musl amd64 / arm64). `scripts/pack-host.sh`
    therefore now emits **one tarball per arch** — `magpie-<version>-<arch>.tar.gz` — and
    `.github/workflows/release-host.yml` builds the matrix natively (amd64 on `ubuntu-24.04`, arm64
    on `ubuntu-24.04-arm`) and attaches both to a single Release. `install.sh` installs the bundled
    probe to `/usr/local/bin`. The `magpie-microvm-launcher` binary is **not** bundled (it
    dynamically links host-installed `libkrun.so`); micro-VM-tier operators build it from
    `rust/magpie-microvm-launcher` themselves (see `INSTALL.md`).

### 3.2 Config portability

- Delete the pinned `172.31.99.0/24` / `172.31.99.1` network contract and `setup-network.sh` — the
  reviewer has no network, so there is no bridge or IP to pin. The gateway proxy plane's address
  becomes a **unix socket path** (per-job or a fixed dir), not a bridge IP.
- Consolidate config: one place for non-secret settings; document generating the shared gateway
  master key with `openssl rand -hex 32`. (Keep the deliberate secret split — webhook secret,
  master key, real OpenRouter key, and the GitHub PEM should not all be co-readable; do **not**
  collapse all secrets into a single world-of-one file.)

### 3.3 Pluggable ingress (documented matrix)

Magpie only needs *some* public HTTPS URL forwarded to the orchestrator's loopback webhook port.
Document three supported options instead of one: (1) **reverse proxy + own TLS** (Caddy/nginx/
Traefik) for orgs with a public server; (2) **Cloudflare Tunnel** (as a host service — drop the
arm64/`apt`-only assumption; the official binary is multi-arch); (3) other outbound tunnels
(tailscale funnel, ngrok). HMAC verification makes the endpoint safe to expose regardless. When a
port is published to a host reverse proxy, document binding it to `127.0.0.1` explicitly.

### 3.4 Onboarding UX (documentation-only this round)

- A **`QUICKSTART.md`**: install prerequisites → run the install script → fill secrets (with the
  `openssl rand` master-key step) → register the GitHub App (clear step-by-step: `contents:read` +
  `pull_requests:read/write`, subscribe `pull_request` events, webhook URL + secret, App ID,
  download `.pem`) → point the webhook at your ingress → open a PR.
- Reframe README/PLAN/CLAUDE from "a personal Linux server" to "self-hostable by any organisation,"
  and add a **supported-platform matrix** (any Linux host with Docker, amd64 + arm64, cloud VM or
  Pi).

---

## 4. Roadmap (tracked as chalk epic — "Distribution / M7")

The feasibility spike (task 0) gates everything; the Design-D isolation core (task 1) is the
security deliverable.

0. **Feasibility spike — Pi over a unix socket via the in-container forwarder.** Prove the
   `models.json baseUrl` → loopback forwarder → unix socket → gateway path works end-to-end at the
   pinned Pi version. Gate for the whole epic.
1. **Design-D reviewer isolation (core).** `--network none` + per-job unix socket mount + the
   in-container forwarder; gateway proxy plane served over the socket (mgmt plane stays loopback);
   socket ownership; fail-closed startup assertion. Delete `setup-network.sh` and the pinned
   network contract. Add a test proving the reviewer has zero egress and can reach only the gateway.
2. **Publish `magpie-reviewer` to GHCR** — multi-arch (amd64+arm64), digest-pinned, signed;
   release CI. Orchestrator default image points at the published tag.
3. **Package the host services** — versioned release artifact for orchestrator + gateway; rework
   `install.sh` to drop the single-hardcoded-prefix/node-path assumptions; keep the systemd units +
   graceful drain.
4. **Config portability** — remove pinned IPs/subnet; gateway address becomes a socket path;
   consolidate non-secret config while keeping the secret split.
5. **Pluggable ingress** — reverse-proxy + Cloudflare-Tunnel (multi-arch host binary) + other-tunnel
   docs; drop the arm64/`apt`-only assumption in `setup-cloudflared.sh`.
6. **Onboarding docs** — `QUICKSTART.md`, generated master key, secret consolidation.
7. **Framing & platform matrix** — reframe README/PLAN/CLAUDE; add the Distribution milestone to
   PLAN.md and cross-link this doc.

Out of scope this round (existing tasks): GitHub App Manifest one-click flow; multi-provider
gateway (M6-D).

---

## Appendix — design history (why not the other topologies)

Two review rounds with a second reviewer (fable) evaluated four topologies. The reviewer container
is a non-negotiable isolation primitive, so the only axis was where the orchestrator and gateway
run and how the reviewer reaches the gateway.

- **Design B (all-compose, DooD):** everything containerised, orchestrator mounts the docker
  socket. Rejected: ships a **host-root-equivalent pulled orchestrator image** (supply-chain), loses
  the systemd sandbox on the internet-facing socket-holder, adds a `-v` host-path translation
  landmine, and exposes the gateway key via `docker inspect`. Egress isolation also stays
  daemon-config-dependent.
- **Design C (host orchestrator + containerised gateway + reviewer on a Docker `internal` net):**
  strictly better than B on security, but the gateway key custody still collapses to `docker
  inspect`, egress isolation still depends on daemon config (host-IP INPUT path, IPv6,
  `iptables:false`), and it still needs a host INPUT rule. A safe intermediate, not the target.
- **Design D (chosen):** `--network none` reviewer + unix-socket gateway channel. The only option
  that gives *provable, config-independent* egress **and** preserves file-based key custody **and**
  needs no DooD **and** deletes the host-iptables apparatus. Dead ends also considered and rejected:
  a docker-socket-proxy in front of a containerised orchestrator (endpoint allowlisting can't stop a
  malicious `container create -v /:/host`), and a separate/rootless daemon for key custody (collapses
  back into the host-iptables model). Feasibility hinges on Pi speaking to an HTTP `baseUrl` the
  entrypoint controls, which the code already relies on — hence the task-0 spike.
</content>
