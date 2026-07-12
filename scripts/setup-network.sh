#!/usr/bin/env bash
#
# setup-network.sh — provision the locked-down `magpie-net` docker bridge and
# the host iptables rules that pin it to the credential-injecting gateway
# (Milestone 4, task_bbdd — see PLAN.md §5 and CLAUDE.md's capability-
# separation principle).
#
# The review container is treated as fully compromisable (indirect prompt
# injection is the threat model). Its ONLY permitted network destination is
# the host-side gateway's proxy plane (172.31.99.1:4000 by default). Every
# other destination — github.com, openrouter.ai directly, arbitrary public
# IPs, external DNS resolvers, the cloud-metadata IP 169.254.169.254, and any
# OTHER service on this host — must be unreachable from the bridge. Hostname/
# SNI filtering to the provider happens AT the gateway; this script only has
# to pin the bridge to the gateway (see PLAN.md §5 "Why not an IP allowlist"
# for why we deliberately do NOT try to allowlist provider CDN IPs here).
#
# This script is IDEMPOTENT and is intended to run at boot (M5 wires it into a
# systemd oneshot ordered before the gateway and orchestrator services). Re-
# running it never duplicates a rule and never errors on already-existing
# state:
#   - the docker network is created only if absent (and its subnet/gateway are
#     verified to match if it already exists);
#   - the iptables rules live in two DEDICATED chains (`MAGPIE-EGRESS` in the
#     FORWARD path via DOCKER-USER, `MAGPIE-INPUT` in the INPUT path) that are
#     FLUSHED and REPOPULATED on every run, so the rule set is always exactly
#     what this script defines — no drift, no duplicates.
#
# SCOPING / SAFETY: all rules are scoped to the `magpie-net` subnet
# (172.31.99.0/24) and its bridge interface. There is NO blanket default-DROP
# and NO change to any chain's default policy — containers on the default
# docker bridge and every other docker network keep their normal outbound
# connectivity (the dedicated chains RETURN for any non-magpie-net traffic).
# The rules never touch the host's own connectivity (the orchestrator reaching
# GitHub, the gateway reaching OpenRouter): those originate from the host, not
# from the `magpie-net` bridge.
#
# PRIVILEGES: needs root for `docker network` and `iptables`. Run as root, or
# as a user with passwordless sudo (the script auto-prefixes sudo when not
# already root). FAILS CLOSED — any error applying a rule aborts the script
# with a non-zero exit (set -euo pipefail) rather than leaving the bridge
# half-locked.
#
# Usage:
#   sudo ./scripts/setup-network.sh
#   ./scripts/setup-network.sh                 # auto-sudo if not root
#
# Env vars (all optional — defaults are the PINNED network contract, do not
# change them without updating packages/orchestrator config + gateway bind):
#   MAGPIE_NET_NAME       docker network name.        (default: magpie-net)
#   MAGPIE_NET_BRIDGE     host bridge interface name. (default: br-magpie)
#   MAGPIE_NET_SUBNET     bridge subnet (CIDR).       (default: 172.31.99.0/24)
#   MAGPIE_NET_GATEWAY_IP host/gateway IP on bridge.  (default: 172.31.99.1)
#   MAGPIE_NET_GATEWAY_PORT gateway proxy-plane port. (default: 4000)
#   DOCKER_BIN            docker CLI to use.           (default: docker)
#   IPTABLES_BIN          iptables CLI to use.         (default: iptables)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (the PINNED network contract — see header).
# ---------------------------------------------------------------------------

NET_NAME="${MAGPIE_NET_NAME:-magpie-net}"
BRIDGE_NAME="${MAGPIE_NET_BRIDGE:-br-magpie}"
SUBNET="${MAGPIE_NET_SUBNET:-172.31.99.0/24}"
GATEWAY_IP="${MAGPIE_NET_GATEWAY_IP:-172.31.99.1}"
GATEWAY_PORT="${MAGPIE_NET_GATEWAY_PORT:-4000}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
IPTABLES_BIN="${IPTABLES_BIN:-iptables}"

# Dedicated iptables chains this script owns end-to-end (created, flushed, and
# repopulated here — nothing else writes to them, which is what makes re-runs
# idempotent).
EGRESS_CHAIN="MAGPIE-EGRESS"   # in the FORWARD path, hooked from DOCKER-USER
INPUT_CHAIN="MAGPIE-INPUT"     # in the INPUT path, hooked from INPUT

log() { printf '[setup-network] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ---------------------------------------------------------------------------
# Privilege handling: run privileged commands via $SUDO (empty when root).
# ---------------------------------------------------------------------------

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    log "not running as root; privileged commands will use sudo"
  else
    die "must run as root and sudo is not available"
  fi
fi

command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "'$DOCKER_BIN' not found on PATH — is docker installed?"
$SUDO "$IPTABLES_BIN" -S >/dev/null 2>&1 || die "cannot run '$IPTABLES_BIN' (need root/sudo and a working iptables)"

docker_net()  { $SUDO "$DOCKER_BIN" "$@"; }
ipt()         { $SUDO "$IPTABLES_BIN" "$@"; }

# ---------------------------------------------------------------------------
# 1. Create the dedicated bridge network (idempotent).
#
#    Options chosen for the "container can only reach the gateway" goal:
#      - --internal                : the load-bearing routing-layer block. It
#                                    gives the container NO default route (only
#                                    the on-link 172.31.99.0/24 is reachable) and
#                                    disables docker's embedded-resolver (127.0.0.11)
#                                    EXTERNAL DNS forwarding. The latter matters:
#                                    that forwarding is done by dockerd ON THE HOST,
#                                    so host iptables on the bridge structurally
#                                    cannot block it — without --internal a container
#                                    can still RESOLVE arbitrary names (though not
#                                    connect). With --internal, external lookups
#                                    return SERVFAIL, satisfying "no DNS to anywhere".
#      - enable_icc=false          : no container-to-container traffic within
#                                    magpie-net (two concurrent reviewers can't
#                                    talk to each other).
#      - enable_ip_masquerade=false: no SNAT for this bridge — defense in depth
#                                    so that even if a forwarded packet slipped
#                                    past the iptables DROP it could not be NAT'd
#                                    out to the internet with a routable source.
#      - bridge.name=br-magpie     : a DETERMINISTIC host interface name so the
#                                    INPUT rules below can pin to `-i br-magpie`
#                                    (docker's auto-generated br-<hash> names are
#                                    not stable across recreation).
#    Reaching the gateway still works even with --internal: the gateway listens
#    on the bridge's own host IP (172.31.99.1), which IS on-link for the
#    container, so container->gateway is delivered locally via the host INPUT
#    path (never masqueraded or forwarded). The iptables rules below are NOT
#    made redundant by --internal: --internal is a docker-managed property that
#    only pins ROUTING and DNS, whereas the MAGPIE-INPUT chain restricts which
#    host-local port on 172.31.99.1 the container may reach (only :4000 — so the
#    host's own DNS/ssh/other bridge services on that IP stay blocked), and
#    MAGPIE-EGRESS is auditable, always-present FORWARD defense-in-depth that
#    survives a stray default route or a future removal of --internal.
# ---------------------------------------------------------------------------

log "network:  $NET_NAME  subnet=$SUBNET  gateway=$GATEWAY_IP  bridge=$BRIDGE_NAME"
log "gateway proxy plane: ${GATEWAY_IP}:${GATEWAY_PORT} (the ONLY reachable destination)"

if docker_net network inspect "$NET_NAME" >/dev/null 2>&1; then
  # Already exists — verify it matches the pinned contract rather than silently
  # trusting (or destructively recreating) it; recreating would disrupt any
  # running reviewer container attached to it.
  existing_subnet="$(docker_net network inspect "$NET_NAME" \
    --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
  existing_gw="$(docker_net network inspect "$NET_NAME" \
    --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
  if [[ "$existing_subnet" != "$SUBNET" || "$existing_gw" != "$GATEWAY_IP" ]]; then
    die "network '$NET_NAME' exists but does not match the pinned contract "\
"(subnet='$existing_subnet' gateway='$existing_gw', expected subnet='$SUBNET' "\
"gateway='$GATEWAY_IP'). Remove it (docker network rm $NET_NAME) and re-run."
  fi
  log "docker network '$NET_NAME' already present and matches contract — leaving as is"
else
  log "creating docker network '$NET_NAME'"
  docker_net network create \
    --driver bridge \
    --internal \
    --subnet "$SUBNET" \
    --gateway "$GATEWAY_IP" \
    --opt "com.docker.network.bridge.name=${BRIDGE_NAME}" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.enable_ip_masquerade=false \
    "$NET_NAME" >/dev/null
  log "created docker network '$NET_NAME'"
fi

# ---------------------------------------------------------------------------
# Helpers for idempotent chain management.
# ---------------------------------------------------------------------------

# ensure_chain <table-args...> <chain>: create the chain if it doesn't exist,
# then flush it so we repopulate from a known-empty state (this is what makes
# the whole script safe to re-run — the rule set is always exactly what we add
# below, never accumulated).
ensure_chain() {
  local chain="$1"
  ipt -N "$chain" 2>/dev/null || true   # -N errors if it exists; that's fine
  ipt -F "$chain"
}

# ensure_jump <parent> <position> <match-args...> -j <target>: insert a jump
# rule into a docker/builtin chain only if that exact rule isn't already there
# (checked with -C). Inserted at <position> so our rules run BEFORE docker's
# own ACCEPTs for the bridge. Any match args (e.g. `-i br-magpie`) are part of
# the -C check, so a re-run never duplicates and never leaves a stray unscoped
# variant behind.
ensure_jump() {
  local parent="$1" pos="$2"; shift 2
  if ipt -C "$parent" "$@" 2>/dev/null; then
    log "jump into ${parent} already present: $*"
  else
    ipt -I "$parent" "$pos" "$@"
    log "inserted into ${parent} (position $pos): $*"
  fi
}

# ---------------------------------------------------------------------------
# 2. FORWARD-path lockdown via DOCKER-USER -> MAGPIE-EGRESS.
#
#    DOCKER-USER is the documented, docker-safe place for user filter rules on
#    bridged traffic (docker never clobbers it). We jump from it into our own
#    chain and DROP every FORWARDED packet whose source OR destination is the
#    magpie-net subnet. All legitimate container->gateway traffic is host-local
#    (INPUT path), never forwarded, so dropping ALL forwarded magpie-net
#    traffic is correct: it blocks github.com, openrouter.ai, 1.1.1.1,
#    169.254.169.254, and cross-bridge hops in one rule, while any packet NOT
#    involving the subnet falls through to RETURN (default-bridge and other
#    networks are untouched — no blanket DROP). With --internal the container
#    has no default route so most such packets are never emitted; this chain is
#    the auditable, always-present defense-in-depth layer behind that.
# ---------------------------------------------------------------------------

log "configuring FORWARD-path rules (${EGRESS_CHAIN} via DOCKER-USER)"
# Make sure DOCKER-USER exists (docker creates it, but be robust at early boot).
ipt -N DOCKER-USER 2>/dev/null || true
ensure_chain "$EGRESS_CHAIN"
ipt -A "$EGRESS_CHAIN" -s "$SUBNET" -j DROP
ipt -A "$EGRESS_CHAIN" -d "$SUBNET" -j DROP
ensure_jump DOCKER-USER 1 -j "$EGRESS_CHAIN"

# ---------------------------------------------------------------------------
# 3. INPUT-path lockdown via INPUT -> MAGPIE-INPUT.
#
#    Traffic from the bridge to a host-local IP (the gateway IP, but also the
#    host's LAN IP and every other bridge gateway) is delivered via INPUT, not
#    FORWARD — so the FORWARD rules above do NOT cover it. Without this, a
#    compromised container could reach any host service bound to a non-loopback
#    address. We ALLOW only ${GATEWAY_IP}:${GATEWAY_PORT} and DROP everything
#    else arriving on the magpie-net bridge (this is what blocks the container
#    from reaching the host's DNS resolver, sshd, other docker services, etc.).
#    Scoped to `-i ${BRIDGE_NAME}` so no other interface's INPUT is affected;
#    INPUT's default policy is left untouched.
# ---------------------------------------------------------------------------

log "configuring INPUT-path rules (${INPUT_CHAIN} via INPUT, gateway :${GATEWAY_PORT} only)"
ensure_chain "$INPUT_CHAIN"
ipt -A "$INPUT_CHAIN" -s "$SUBNET" -d "$GATEWAY_IP" -p tcp --dport "$GATEWAY_PORT" -j ACCEPT
ipt -A "$INPUT_CHAIN" -s "$SUBNET" -j DROP
# Jump is interface-scoped to the magpie-net bridge so only its ingress to the
# host is inspected; no other interface's INPUT path is touched.
ensure_jump INPUT 1 -i "$BRIDGE_NAME" -j "$INPUT_CHAIN"

# ---------------------------------------------------------------------------
# 4. Report the resulting state.
# ---------------------------------------------------------------------------

log "done. effective rules:"
log "  FORWARD hook:  $(ipt -S DOCKER-USER | grep -- "-j ${EGRESS_CHAIN}" || echo '(missing!)')"
log "  ${EGRESS_CHAIN}:"
while IFS= read -r line; do log "    $line"; done < <(ipt -S "$EGRESS_CHAIN")
log "  INPUT hook:    $(ipt -S INPUT | grep -- "-j ${INPUT_CHAIN}" || echo '(missing!)')"
log "  ${INPUT_CHAIN}:"
while IFS= read -r line; do log "    $line"; done < <(ipt -S "$INPUT_CHAIN")
log "magpie-net is locked to ${GATEWAY_IP}:${GATEWAY_PORT}; all other egress denied."
