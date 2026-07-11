---
id: task_bbdd
title: M4-D: magpie-net + host iptables — container egress default-deny, gateway only
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:51:17Z
updated_at: 2026-07-11T03:21:31Z
---
Wave 2 (parallel with M4-B/C; needs the gateway's listen address from M4-A). Network lockdown per PLAN.md §5.

- scripts/setup-network.sh: idempotent creation of the dedicated docker bridge network magpie-net with no default forwarding, plus host iptables rules: default-deny for traffic from the bridge; the ONLY permitted destination is the gateway's listen address/port. Explicitly no DNS-to-anywhere, no GitHub, no metadata endpoints.
- Filtering by hostname happens at the gateway (it only speaks to the provider); the iptables layer only needs to pin the bridge to the gateway — do NOT attempt provider IP allowlisting (§5 explains why CDN IP allowlists are inadequate).
- Orchestrator flips the container network from the default bridge to magpie-net via the config knob added in M3 (container.network).
- Script must be safe to re-run at boot (M5 wires it into a systemd oneshot).

Done when: from inside a reviewer container, the gateway is reachable and everything else (github.com, openrouter.ai directly, arbitrary IPs, DNS) is not.

---

## Review (M4-D implementation)

### What was built
- **`scripts/setup-network.sh`** — idempotent provisioning of the `magpie-net`
  bridge + host iptables lockdown. Run as root, or as any user with sudo
  (auto-prefixes sudo). `set -euo pipefail`, fail-closed. Matches house style of
  the other `scripts/*.sh` (header block, `log()` helper, env-var overrides).
- **`config.example.toml`** — updated the `[container] network` doc + example to
  `"magpie-net"` (M4 lockdown), explaining setup-network.sh and that the code
  default stays `"bridge"`. Only the `[container]` network line was touched
  (no collision with M4-B's `[gateway]` work).
- **No orchestrator code change needed.** `config.ts` validates `network` as
  `z.string().min(1)` (accepts `"magpie-net"`) and `reviewer.ts` passes it
  straight to `docker run --network`. Confirmed by read; `config.ts` is M4-B's
  file and was not edited.

### Design (locked network contract honoured)
- Network: `docker network create --driver bridge --internal --subnet
  172.31.99.0/24 --gateway 172.31.99.1 --opt bridge.name=br-magpie --opt
  enable_icc=false --opt enable_ip_masquerade=false magpie-net`.
- `--internal` is load-bearing: it removes the container's default route (only
  on-link 172.31.99.0/24 reachable) AND disables docker's embedded-resolver
  (127.0.0.11) EXTERNAL DNS forwarding. That DNS forwarding is done by dockerd
  ON THE HOST, so host iptables on the bridge structurally cannot block it —
  without `--internal` a container can still RESOLVE arbitrary names (verified:
  it resolved github.com to 4.237.22.38, though connections were still blocked).
  With `--internal`, external lookups return SERVFAIL, satisfying "no DNS".
- iptables (dedicated chains, flushed+repopulated each run, scoped to the
  subnet — NO blanket default-DROP, no policy change):
  - `DOCKER-USER -> MAGPIE-EGRESS`: `-s 172.31.99.0/24 -j DROP` and
    `-d 172.31.99.0/24 -j DROP` (FORWARD-path defense-in-depth; RETURNs for all
    non-magpie traffic so other bridges are untouched).
  - `INPUT -i br-magpie -> MAGPIE-INPUT`: ACCEPT only
    `-s 172.31.99.0/24 -d 172.31.99.1 -p tcp --dport 4000`, then
    `-s 172.31.99.0/24 -j DROP`. This restricts the host-local (INPUT) path —
    which the FORWARD rules and `--internal`'s missing default route do NOT
    cover — so the container can reach ONLY gateway:4000 on the host, not the
    host's DNS/ssh/other services on 172.31.99.1.

### Verification evidence (live, on this host — docker 29.6.1)
Real M4-A gateway run bound to `172.31.99.1:4000` (placeholder secrets;
`/healthz` is unauthenticated), probes from `docker run --rm --network
magpie-net alpine`:
- PASS — `wget http://172.31.99.1:4000/healthz` -> body `ok`, rc=0.
- BLOCKED (all rc=1 / unreachable): `https://github.com`, `https://openrouter.ai`,
  `https://1.1.1.1`, `http://169.254.169.254/...`.
- DNS BLOCKED: external resolvers `1.1.1.1:53`/`8.8.8.8:53` -> "Network
  unreachable"; host resolver `172.31.99.1:53` -> timeout; embedded resolver
  `nslookup github.com` -> SERVFAIL.
- Host-port restriction (nc): `172.31.99.1:4000` OPEN, `:53` blocked, `:22` blocked.
- CONTROL TEST (default docker bridge, after rules applied): `github.com` ->
  HTTP 200, `1.1.1.1` -> 301, DNS resolves. Unaffected. (Before/after identical —
  no regression to other containers.)
- Idempotency: script run 3x; 2nd/3rd runs report "already present" / "matches
  contract", exit 0; `iptables -S` dumps byte-identical (diff empty), network
  count stays 1.

### Left in place / follow-ups
- `magpie-net` + the iptables chains are LEFT provisioned (the intended working
  state; code default is still `"bridge"` so nothing breaks). M5 wires
  setup-network.sh into a systemd oneshot at boot and adds the gateway systemd
  unit. The placeholder test gateway process was stopped.
- iptables rules are runtime-only (not persisted across a host reboot by
  themselves) — that's by design: M5's boot oneshot re-applies them (the script
  is idempotent precisely so it can).
