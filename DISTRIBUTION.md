# Magpie — Distribution & Self-Hosting Strategy

Magpie today is built to run on *one specific* always-on Linux box (a Raspberry Pi):
host-native systemd services, a hand-registered GitHub App, host `iptables` egress rules on a
pinned docker subnet, a locally-built reviewer image version-matched to the host, and
Cloudflare-Tunnel-via-`apt` ingress that assumes arm64 + a Cloudflare-managed domain. It works
well, but a second organisation cannot adopt it without reverse-engineering the install.

This document proposes how to make Magpie **distributable and easy for a new organisation to
stand up**, and — critically — shows that we can do so **without weakening the per-run isolation
of the (untrusted, prompt-injectable) Pi reviewer**, which is the whole point of the project.

> **Scope of this proposal (per product decision):** primary target is a **containerised
> `docker compose` stack**, *conditional on* preserving reviewer isolation (analysed in §2).
> GitHub-App/secret onboarding is addressed with **documentation only** (no automated App
> Manifest flow this round). LLM provider stays **OpenRouter-only** (multi-provider remains the
> existing M6-D task). Host-native systemd remains supported as an **advanced / maximum-hardening**
> path, not the default.

---

## 1. What ties Magpie to one server today

| Area | Current state | Why it blocks distribution |
|---|---|---|
| **Deployment** | 3 host systemd units + 2 Unix users; `install.sh` `sed`-rewrites a hardcoded `/opt/magpie` prefix and `/usr/bin/node` path into the units. | Linux/systemd/root only; bespoke path handling; no portable artifact. |
| **Reviewer egress** | Host `iptables` (`MAGPIE-EGRESS`/`MAGPIE-INPUT`) on a pinned `172.31.99.0/24` `--internal` bridge; gateway IP baked into config. | Requires root netfilter control on the host; pinned IPs; not portable to arbitrary Docker hosts / cloud VMs. |
| **Reviewer image** | Built locally by `build-reviewer-image.sh`, Pi version pinned to match the *host's* `pi --version`. | Every adopter must build and re-pin; nothing published. |
| **GitHub App** | Hand-registered: operator sets permissions/events/webhook, copies App ID, downloads `.pem`, invents webhook secret. | Highest onboarding friction (docs-only fix this round). |
| **Secrets** | Spread across `magpie.env`, `gateway.env`, `config.toml`, and a `.pem`; a shared master key must be typed identically into two files. | Error-prone; no single source of truth. |
| **Ingress** | `setup-cloudflared.sh` installs cloudflared via arm64 `apt` and assumes a Cloudflare-managed domain. | Vendor + arch locked; no option for orgs with a normal reverse proxy. |
| **Framing** | README/PLAN/CLAUDE all say "personal Linux server"; roadmap has no distribution milestone. | Signals "not for you" to other orgs. |

---

## 2. Can we containerise the stack without weakening reviewer isolation? — **Yes.**

This is the load-bearing question. The security model (PLAN.md §"Threat model", CLAUDE.md
"capability separation") assumes the reviewer is **fully prompt-injectable** and defends
*structurally*: the reviewer holds no secret worth stealing, and its network egress is
default-deny to everything except the gateway. Any containerised packaging must reproduce those
guarantees exactly.

### 2.1 The trust boundary that must not move

- **Untrusted:** the reviewer (runs Pi over attacker-influenced PR content).
- **Trusted:** the orchestrator (privileged git/GitHub/docker work) and the gateway (holds the
  real OpenRouter key).

The reviewer must **never** hold the real provider key, reach the internet except via the
gateway, reach GitHub, reach the gateway's *management* plane, or reach the orchestrator's
secrets. Everything below is judged against keeping that true.

### 2.2 The reviewer stays an ephemeral `docker run`, **not** a compose service

The reviewer is **not** declared in `docker-compose.yml`. It stays exactly what it is today: an
ephemeral, per-job container the **orchestrator launches** with its full hardening set —
`--user`, `--read-only --tmpfs /tmp`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
`--memory/--cpus/--pids-limit`, `.git`-stripped read-only `/work` mount, per-job virtual key
only. **None of that changes** — it is applied by `reviewer.ts`'s `docker run`, which is
orthogonal to how the orchestrator itself is packaged. Compose changes how the *long-lived*
services run, not how the reviewer runs.

### 2.3 Egress lockdown moves from host `iptables` to a Docker **internal network topology**

Today: `--internal` bridge (no default route, no external DNS) **plus** host `iptables` as
defense-in-depth, **plus** a host-process gateway on the bridge IP. The compose model reproduces
the *primary* control declaratively and kernel-enforced:

```
                    ┌─────────────────────────────────────────────┐
   GitHub ◀────────▶│ orchestrator  (DooD: host docker.sock)       │
   (egress net)     │   • mints GitHub token, clones, publishes    │
                    │   • calls gateway MGMT plane                 │
                    └───────┬──────────────────────────┬───────────┘
                            │ egress net               │ egress net
                            ▼                          ▼
   OpenRouter ◀────── ┌───────────── gateway ──────────────┐
   (egress net)       │  MGMT plane  → egress net only      │  ← orchestrator reaches mgmt here
                      │  PROXY plane → reviewers net only   │  ← reviewers reach proxy here
                      │  holds the real OpenRouter key      │
                      └───────────────────┬─────────────────┘
                                          │ reviewers net (internal: true — NO internet)
                                          ▼
                    ┌─────────────────────────────────────────────┐
                    │ reviewer container(s)  (ephemeral docker run)│
                    │   • attached ONLY to reviewers net          │
                    │   • per-job virtual key; no real key        │
                    │   • can reach ONLY gateway:PROXY            │
                    └─────────────────────────────────────────────┘
```

Two compose networks:

- **`magpie-egress`** — normal bridge with internet. Orchestrator (→ GitHub), gateway (→
  OpenRouter), and the gateway's **management plane** live here.
- **`magpie-reviewers`** — declared **`internal: true`**. This is the same `--internal` property
  the current bridge already uses: **no route off the network, no external DNS.** The reviewer
  attaches **only** here. The gateway's **proxy plane** listens here.

Mapping every current guarantee to its compose equivalent:

| Guarantee (today) | Mechanism today | Mechanism under compose | Verdict |
|---|---|---|---|
| Reviewer has no internet egress | `--internal` + host `iptables` DROP | `magpie-reviewers` is `internal: true` (kernel/Docker-enforced) | **Equivalent** |
| Reviewer's only reachable dest is the gateway | bridge → gateway host IP only (`MAGPIE-INPUT :4000`) | reviewer's only interface is `magpie-reviewers`; only the gateway proxy plane listens there | **Equivalent / cleaner** (no host in the path at all) |
| Reviewer can't reach other host services | `MAGPIE-INPUT` allows only `:4000` on the bridge IP | there is no host IP on the reviewer's network; the host is unreachable by construction | **Stronger** |
| Orchestrator↔gateway mgmt plane is reviewer-unreachable | mgmt bound to `127.0.0.1` | mgmt plane bound to `magpie-egress` only; reviewer isn't on that network | **Equivalent** |
| Real provider key isolated from reviewer | separate `magpie-gateway` Unix user | separate gateway **container** (own image, own env, no docker socket) | **Equivalent** |
| Reviewer can't reach GitHub | not on any GitHub route | not on `magpie-egress`; `magpie-reviewers` has no internet | **Equivalent** |
| Reviewer hardening (caps, ro-rootfs, limits) | `docker run` flags | **unchanged** `docker run` flags | **Identical** |

### 2.4 The one genuine change: how the orchestrator launches containers (DooD)

A containerised orchestrator launches the reviewer via **Docker-out-of-Docker**: the host's
`/var/run/docker.sock` is mounted into the orchestrator container, and it calls `docker run`
against the host daemon (reviewer = sibling container on `magpie-reviewers`). Points to be
explicit about:

- Mounting the docker socket grants the orchestrator container **host-root-equivalent** power.
  This is **not a new grant** — today the `magpie` user is in the host `docker` group, which is
  the same privilege. The socket is held only by **trusted** orchestrator code; the **reviewer
  never sees it**. The untrusted boundary is unchanged.
- **Docker-in-Docker (nested daemon) is explicitly rejected** — more complex, and its
  `--privileged` requirement would *weaken* isolation. DooD is the right call.
- The orchestrator attaches each reviewer to `magpie-reviewers` by its stable compose network
  name (`docker run --network magpie-reviewers …`); this is already parameterised
  (`config.container.network`).

### 2.5 Residual differences to decide on (small, flagged honestly)

1. **Reviewer-to-reviewer isolation.** Today `enable_icc=false` blocks two concurrent reviewers
   from talking. On a shared internal bridge with a *containerised* gateway, `enable_icc=false`
   would also block reviewer→gateway (the gateway is now a container on that bridge), so it can't
   be used as-is. Options: (a) **accept** reviewer↔reviewer reachability — low value to an
   attacker: each reviewer holds only its own budget-capped virtual key and a read-only checkout
   of another PR's already-public code; or (b) **per-job internal network** — the orchestrator
   creates an ephemeral `internal` network per job, connects the gateway to it, and tears it down
   on cleanup (full parity, more orchestration). Recommend **(a) for the default profile, (b)
   available for max-hardening**.
2. **Loss of the "auditable host `iptables`, survives a stray default route" defense-in-depth.**
   For the **max-hardening profile** we keep `setup-network.sh` as an *optional extra* layer on
   top of the internal network. For the portable default, the `internal` network is the boundary
   (Docker itself enforces it with netfilter rules under the hood).
3. **gVisor (M6-C)** remains an orthogonal add-on (`--runtime=runsc` on the reviewer `docker
   run`) in either model.

**Conclusion:** the containerised stack preserves every isolation guarantee that matters, and is
*cleaner* on two of them (no host in the reviewer's network path). The only real trade is host-
`iptables` defense-in-depth, which we retain as an opt-in hardening layer.

---

## 3. Proposed distribution architecture

### 3.1 Published, multi-arch images (removes the local-build / version-match dance)

- Publish `magpie-orchestrator`, `magpie-gateway`, and `magpie-reviewer` to **GHCR**, built
  **multi-arch (amd64 + arm64)** by CI on tagged releases, pinned by digest. Adopters `pull`
  instead of `npm ci && build` + `build-reviewer-image.sh` + re-pinning Pi to their host.
- The reviewer image keeps its existing pinned-version discipline; the orchestrator's default
  `container.image` points at the published tag.

### 3.2 The compose stack (the default adopter experience)

- `docker-compose.yml`: `orchestrator` + `gateway` services, the two networks from §2.3, the DooD
  socket mount on the orchestrator only, healthchecks, restart policies, and boot ordering
  (gateway before orchestrator) expressed via `depends_on`.
- **All config via a single `.env`** consumed by compose — collapses the current 4-file spread
  for the container path. Gateway addressing becomes **service DNS** (`gateway:4000`) instead of
  the pinned `172.31.99.1`, so nothing is IP-hardcoded.
- Optional **cloudflared ingress** as a compose *profile* using the official
  `cloudflare/cloudflared` image (drops the arm64/`apt` install and the Pi assumption entirely).

### 3.3 Pluggable ingress (documented matrix)

Magpie only needs *some* public HTTPS URL forwarded to the orchestrator's loopback webhook port.
Document three supported options instead of one: (1) **reverse proxy + own TLS** (Caddy/nginx/
Traefik) for orgs with a public server; (2) **Cloudflare Tunnel** (now as a container profile);
(3) other outbound tunnels (tailscale funnel, ngrok). The HMAC verification makes the endpoint
safe to expose regardless of which is chosen.

### 3.4 Config portability & the two supported profiles

- **Default (portable):** compose + internal-network egress. No root netfilter, no pinned subnet,
  runs on any Docker host or cloud VM, amd64 or arm64.
- **Max-hardening (advanced):** the existing host-native systemd units + `setup-network.sh` host
  `iptables`, documented as the extra-assurance path. Both profiles share **one config schema**
  so switching is a deployment choice, not a rewrite.

### 3.5 Onboarding UX (documentation-only this round)

- A **`QUICKSTART.md`**: "clone → fill one `.env` → `docker compose up` → register the GitHub App
  (clear step-by-step) → point its webhook at your ingress → open a PR."
- Auto-generate the shared gateway master key with a documented `openssl rand -hex 32` and set it
  once in the single `.env` (no more keeping two files in sync for the container path).
- Reframe README/PLAN/CLAUDE from "personal server" to "self-hostable by any organisation," and
  add a **supported-platform matrix**.

---

## 4. Roadmap (tracked as a chalk epic — "Distribution / M7")

Ordered so each builds on the last; the isolation-equivalence work (task 3) is the gate.

1. **Publish multi-arch images to GHCR** + release CI. Removes local build/re-pin.
2. **Compose stack** — services, two networks, single `.env`, DooD socket, service-DNS addressing.
3. **Reviewer isolation under compose** — two-plane gateway topology; reviewer on the `internal`
   net with unchanged hardening; decide ICC/per-job-network; **add an egress-equivalence test**
   proving the reviewer can reach *only* the gateway. (Security gate for the whole epic.)
4. **Config portability** — service-DNS gateway addressing; demote `setup-network.sh`/pinned
   subnet to the opt-in max-hardening profile; compose-friendly defaults.
5. **Pluggable ingress** — cloudflared-as-container profile + reverse-proxy docs; keep systemd
   cloudflared as advanced.
6. **Onboarding docs** — `QUICKSTART.md`, single `.env`, generated master key, secret
   consolidation for the container path.
7. **Host-native systemd as the documented max-hardening path** — shared config schema; keep
   `/opt/magpie` + node-path handling for that path only.
8. **Framing & platform matrix** — reframe README/PLAN/CLAUDE; add the Distribution milestone to
   PLAN.md.

Out of scope this round (existing tasks): GitHub App Manifest one-click flow; multi-provider
gateway (M6-D); gVisor (M6-C).
</content>
</invoke>
