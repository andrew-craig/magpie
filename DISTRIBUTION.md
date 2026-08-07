# Magpie — Distribution & Self-Hosting Strategy

Magpie is distributable: any organisation can stand up its own instance on its own Linux host
without reverse-engineering the install. This document describes the architecture that makes
that possible — **"Design D"**: a host-service orchestrator, a host-process gateway, and a
single reviewer container that runs with `--network none` and reaches the gateway over a
mounted unix domain socket (or, on the opt-in micro-VM tier, a vsock channel). This gives
*provable, daemon-config-independent* egress isolation, preserves the gateway's file-based key
custody, and needs no docker-socket-in-a-container (DooD) and no host `iptables`/bridge
apparatus at all. See the appendix at the end for the alternative topologies this was chosen
over and why.

GitHub-App/secret onboarding is documentation-only (no automated App Manifest flow) — see
[QUICKSTART.md](QUICKSTART.md). The LLM provider is OpenRouter-only; multi-provider support is
tracked as a standalone backlog task, decoupled from any milestone (see `chalk ready`).

---

## 1. Target architecture — "Design D": `--network none` reviewer + unix-socket gateway

> **Tier note.** Design D as described in §1.1–§1.6 below is the **hardened crun floor** — the
> tier every Magpie install ships with by default. A ranked isolation ladder sits on top of this
> floor — micro-VM (KVM) > this crun floor — selected per host at startup; see §1.7 for the
> ladder itself and [ARCHITECTURE.md](ARCHITECTURE.md#isolation-tiers) for the canonical
> description. Every claim in §1.1–§1.6 holds **at the crun-floor tier**. The opt-in micro-VM
> tier delivers the same no-network / no-secret-in-reviewer properties by different mechanics (a
> vsock channel instead of a bind-mounted unix socket, a real guest kernel instead of
> `--network none`) — it does not weaken anything described below, it is a strictly stronger
> alternative.

### 1.1 The trust boundary (unchanged)

- **Untrusted:** the reviewer (runs Pi over attacker-influenced PR content).
- **Trusted:** the orchestrator (privileged git/GitHub/docker work) and the gateway (holds the
  real OpenRouter key).

The reviewer must **never** hold the real provider key, reach the internet except via the
gateway, reach GitHub, reach the gateway's *management* plane, or reach the orchestrator's
secrets.

### 1.2 The topology

```
┌─ Host ───────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  orchestrator (systemd service, `magpie` user, full sandbox)                 │
│    • mints GitHub token, clones, publishes review        ──HTTPS──▶ GitHub    │
│    • runs the reviewer via rootless Podman (no daemon, no root group)        │
│    • mints/revokes per-job virtual keys ──loopback──▶ gateway MGMT plane      │
│                                                                              │
│  gateway (systemd service, `magpie-gateway` user, own 0600 key file)         │
│    • holds the real OpenRouter key (file, NOT container-inspectable)         │
│    • MGMT plane  : 127.0.0.1:4100  (orchestrator mints/revokes keys)         │
│    • PROXY plane : a UNIX SOCKET   /run/magpie/jobs/<id>.sock  ──HTTPS──▶ OpenRouter │
│                                                                              │
│      per job, the orchestrator `podman run`s:                                 │
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

### 1.3 Why the egress isolation is *provable* and *config-independent*

A container run with `--network none` has **no network interfaces except its own loopback** — no
veth, no bridge, no route to the host, to other containers, to the internet, to DNS, or to the
cloud-metadata IP. This is a property of the container's network namespace, **not** of any
iptables/nftables rule, so — unlike an `--internal`-bridge model or the rejected compose
model — it does **not** depend on the adopter's daemon config, container-runtime version, IPv6
settings, or the embedded resolver. There is nothing to misconfigure.

The reviewer's *only* path off the container is the **mounted unix socket** to the gateway's proxy
plane. Pi is pointed at it exactly as described here (`reviewer.ts` documents that Pi 0.80.3 ignores
`OPENAI_BASE_URL` and is steered via a `~/.pi/agent/models.json` `baseUrl`; the entrypoint keeps
writing that file). The `baseUrl` becomes `http://127.0.0.1:4000/v1`, served by a **tiny
in-container TCP→unix forwarder** (listening on the container's loopback, which `--network none`
leaves intact) that relays to `/run/gw.sock`. The forwarder holds no secret, so it is safe to ship
inside the reviewer image (which runs untrusted content).

### 1.4 What this buys, versus the alternatives

| Property | Host-iptables model (superseded) | Rejected compose/DooD | **Design D (shipped)** |
|---|---|---|---|
| Reviewer egress | strong, but root-netfilter + daemon-config dependent | daemon-config dependent (holes: host-IP INPUT path, IPv6, `iptables:false`) | **provable, config-independent** (`--network none`) |
| OpenRouter key custody | preserved (0600 file, separate user) | **lost** (`docker inspect`/`exec` the gateway container) | **preserved** (gateway stays a host process) |
| Orchestrator privilege | host `docker` group | **host-root-equivalent pulled image** (socket in container) | rootless Podman (no root daemon); keeps full systemd cage |
| Only pulled image | none (all local) | orchestrator (**worst** — secret-holding, socket-holding) | **the reviewer** (least-privileged: no secret, no socket, no network) |
| Host `iptables`/bridge needed | yes (`setup-network.sh`) | yes-ish (INPUT rule still needed) | **none — deleted entirely** |
| systemd sandbox on the socket-holder | yes | no | **yes** |

The gateway's **virtual-key** mechanism is retained: even though a leaked key can't reach anything
but the gateway now, the key still enforces the **hard per-job spend cap** Pi lacks, and the mgmt
plane stays loopback-only for mint/revoke. Only the proxy plane's *transport* changes (TCP-on-
bridge → unix socket).

### 1.5 Reviewer hardening

Every hardening flag from the pre-Design-D container invocation is kept: `--user`,
`--read-only --tmpfs /tmp`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
`--memory/--cpus/--pids-limit`, `.git`-stripped read-only `/work`. The only changes are
`--network bridge/magpie-net` → `--network none` and the added `-v …/<id>.sock:/run/gw.sock`
mount.

Note that `--memory` is only *enforced* when the host kernel's cgroup v2 `memory` controller is
enabled — on a host where it's off (e.g. Raspberry Pi firmware defaults ship
`cgroup_disable=memory`) the container runtime silently discards the flag. Magpie fails closed
on this at startup and per job rather than running an unbounded reviewer; see `INSTALL.md` §6a
and `config.example.toml`'s `require_memory_limit`.

### 1.6 Residual details (flagged honestly)

1. **The in-container forwarder path is proven end-to-end.** Pi is steered at the gateway over a
   unix socket via the loopback forwarder + `models.json baseUrl` override, at the pinned Pi
   version, against the real gateway. Fallback if Pi ever grows native unix support: drop the
   forwarder; until then the forwarder removes the dependency.
2. **Socket lifecycle: launch ordering + permissions.** Two structural invariants make the
   per-job unix socket robust — neither is tuning.

   *Launch ordering — mount the directory, bind before run.* `podman run -v <src>:<dst>` creates
   `<src>` as a **root-owned directory** if it does not already exist, which would clobber the
   socket path and break both the gateway's `bind()` and the reviewer's connect. So the mount
   *source* is the pre-created per-job **directory** (`…/jobs/<id>/`), never the not-yet-existent
   socket file: the directory always exists at container-launch time, so the runtime can never
   invent a root-owned path, and the socket appears inside the live bind-mount view once the
   gateway binds it. Ordering is fixed — orchestrator creates the job dir → gateway mints the
   virtual key and `bind()`s the socket → orchestrator waits for gateway readiness (path exists
   and is a socket) → container launch. The in-container forwarder additionally retries
   `connect()` with backoff as belt-and-suspenders.

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
   path. Magpie runs rootless Podman by default — `--preserve-fds` remains an available future
   refinement to pass the connected fd and delete the pathname socket entirely, but is not
   implemented; the pathname-socket + `0711`/`0666` scheme above is what ships.)
3. **Fail-closed runtime assertion (cheap belt-and-suspenders).** The reviewer entrypoint asserts
   at startup that it has **no** external route (e.g. a connect to a public IP fails) and that the
   gateway socket is present, and refuses to run otherwise — the same "fail closed if any host
   other than the gateway is reachable" principle ARCHITECTURE.md's threat model describes. With
   `--network none` this should always pass; the assertion catches a mis-launch (wrong `--network`)
   rather than a daemon-config drift.
4. **Reviewer-to-reviewer isolation is now moot.** With `--network none` there is no shared L2
   segment; concurrent reviewers are network-isolated from each other by construction.
5. **Supply chain is minimised, not eliminated.** The only pulled image is the reviewer — the
   least-privileged component (no secret, no socket, no network). Still pin it by digest and sign
   it (cosign/provenance); a compromised reviewer image is far less catastrophic than a compromised
   orchestrator image would have been under the rejected compose model.

### 1.7 The isolation-tier ladder: crun floor is the default, not the ceiling

Design D above answers "how does the reviewer reach the gateway with no network egress." A
separate, ranked ladder answers a broader question — "what is the reviewer↔host-kernel boundary
itself" — rather than giving one fixed answer: **micro-VM (KVM) > hardened crun (the floor)**.
The floor is exactly the Design D mechanics of §1.1–§1.6 above and is what every install runs by
default; the micro-VM tier is an opt-in a host must explicitly provision (`/dev/kvm` +
`[microvm]` config), reaching the gateway over a per-job vsock channel instead of the
bind-mounted unix socket §1.2 describes (a VM guest can't share a host unix socket by bind
mount).

The full design — floor invariant, tier-invariant no-network property, operator-only tier
visibility, and the trusted-computing-base tradeoffs of the rootless-Podman substrate — lives in
[ARCHITECTURE.md's "Isolation tiers" section](ARCHITECTURE.md#isolation-tiers), which is the
canonical description; this section exists only to place the ladder relative to Design D. See
also `docs/design/cto-decision-brief.md` §5 and `packages/orchestrator/src/tier-ladder.ts`.

---

## 2. Distribution architecture (packaging around Design D)

### 2.1 The reviewer image (multi-arch); packaged host services

- **`magpie-reviewer`** is published to GHCR, **multi-arch (amd64 + arm64)**, pinned by digest
  and signed, built by release CI. Adopters `pull` it rather than running
  `build-reviewer-image.sh` and re-pinning Pi to their host. This is the *only* container in the
  product.
- The **orchestrator** and **gateway** are host Node services, packaged as a versioned release
  artifact (a tarball with a committed lockfile and pinned deps), with systemd units and an
  install script that don't assume a single hardcoded prefix or node path. The units keep the
  graceful-drain `TimeoutStopSec`.
  - **Per-arch host tarballs.** The host tarball also bundles the native `magpie-tier-probe`
    binary (the `/dev/kvm` `KVM_CREATE_VM` preflight, `rust/magpie-tier-probe`) at
    `bin/magpie-tier-probe`, which is per-arch (static-musl amd64 / arm64). `scripts/pack-host.sh`
    therefore emits **one tarball per arch** — `magpie-<version>-<arch>.tar.gz` — and
    `.github/workflows/release-host.yml` builds the matrix natively (amd64 on `ubuntu-24.04`, arm64
    on `ubuntu-24.04-arm`) and attaches both to a single Release. `install.sh` installs the bundled
    probe to `/usr/local/bin`. The `magpie-microvm-launcher` binary is **not** bundled (it
    dynamically links host-installed `libkrun.so`); micro-VM-tier operators build it from
    `rust/magpie-microvm-launcher` themselves (see `INSTALL.md`).

### 2.2 Config portability

There's no pinned `172.31.99.0/24` network contract to carry between hosts — the reviewer has
no network, so there's no bridge or IP to pin. The gateway proxy plane's address is a **unix
socket path** (per-job or a fixed dir), not a bridge IP. Non-secret config lives in one place
(`config.toml`); the shared gateway master key is a one-liner (`openssl rand -hex 32`). The
deliberate secret split is kept — webhook secret, master key, real OpenRouter key, and the
GitHub PEM are not all co-readable; they do **not** collapse into a single world-of-one file.

### 2.3 Pluggable ingress

Magpie only needs *some* public HTTPS URL forwarded to the orchestrator's loopback webhook port.
Three options are documented: (1) **reverse proxy + own TLS** (Caddy/nginx/Traefik) for orgs
with a public server; (2) **Cloudflare Tunnel**, set up and routed entirely from the Cloudflare
dashboard — `cloudflared` installs and manages its own systemd service via a connector token,
so this repo ships no unit or ingress config for it; (3) other outbound tunnels (tailscale funnel,
ngrok). HMAC verification makes the endpoint safe to expose regardless of which option is
chosen; see [docs/ingress.md](docs/ingress.md) for the full matrix. When a port is published to
a host reverse proxy, bind it to `127.0.0.1` explicitly.

### 2.4 Onboarding UX

Onboarding is documentation-only — no automated GitHub App Manifest flow. See
[QUICKSTART.md](QUICKSTART.md) for the end-to-end path: install prerequisites → run the install
script → fill secrets (with the `openssl rand` master-key step) → register the GitHub App →
point the webhook at your ingress → open a PR.

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
  back into the host-iptables model). Feasibility hinged on Pi speaking to an HTTP `baseUrl` the
  entrypoint controls — confirmed end-to-end before the rest of this design was built on top of it.
</content>
