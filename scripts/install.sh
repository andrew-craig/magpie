#!/usr/bin/env bash
#
# install.sh — idempotent production install for magpie.
#
# Sets up the two unprivileged service users, the config/secret/state
# directories, and the two systemd units (gateway -> orchestrator) so a
# reboot brings magpie up in the correct order with no manual steps. Safe to
# re-run: it never overwrites an existing secret, env file, or config.toml,
# and never duplicates a user or a directory.
#
# Per Design D (DISTRIBUTION.md §1) there is no network-lockdown
# unit/script to install: each review container runs `--network
# none`, so there is no bridge/iptables apparatus to provision at boot
# (magpie-firewall.service and scripts/setup-network.sh do not exist).
#
# The reviewer runs under ROOTLESS podman — no root
# daemon, no `docker` group. This installer therefore provisions the rootless
# substrate for the `magpie` user instead of a docker-group grant:
#   * subuid/subgid ranges (so newuidmap/newgidmap can map the container uids),
#   * `loginctl enable-linger magpie` (a persistent per-user systemd session,
#     which is what actually ENFORCES the per-review `--memory` cap — see
#     systemd/magpie.service's header and cgroup-preflight.ts),
#   * `kvm`-group membership (so the optional micro-VM tier can open /dev/kvm),
#   * the numeric magpie uid rewritten into magpie.service's XDG_RUNTIME_DIR /
#     DBUS_SESSION_BUS_ADDRESS.
# It also installs the `magpie-tier-probe` binary and runs the KVM
# PREFLIGHT, failing loud (and requiring MAGPIE_ACK_TIER acknowledgement) when
# the host can't reach the isolation tier the operator asked for.
#
# It does NOT install dependencies or build the code, and does NOT start the
# services — that runs as the operator (not root), and enabling is a
# deliberate final step once secrets are filled in. Both are printed as clear
# next steps at the end.
#
# PRIMARY FLOW: download a release tarball (built by
# scripts/pack-host.sh / .github/workflows/release-host.yml — see
# INSTALL.md), unpack it to /opt/magpie (or MAGPIE_PREFIX), then:
#   sudo ./scripts/install.sh
#   npm ci --omit=dev            # dist/ ships prebuilt in the tarball; no build step
# A raw git checkout (no dist/ yet) instead needs the full
# `npm ci && npm run build && npm run gateway:build` — this script detects
# which case applies and prints the right next step.
#
# Usage:
#   sudo ./scripts/install.sh            # install units + scaffolding
#   sudo MAGPIE_PREFIX=/opt/magpie ./scripts/install.sh
#   sudo ./scripts/install.sh --enable   # also `systemctl enable` the units
#
# Tier preflight env vars:
#   MAGPIE_INSTALL_TIER=crun|microvm   the isolation tier you intend to run
#                                      (default: crun — today's hardened floor).
#   MAGPIE_ACK_TIER=crun               explicit acknowledgement that a
#                                      weaker-than-requested tier is acceptable
#                                      on this host (mirrors the orchestrator's
#                                      runtime MAGPIE_ACK_TIER — tier-ladder.ts).
#   MAGPIE_KVM_SETFACL=1               also grant /dev/kvm via an ACL scoped to
#                                      the magpie user (crun #1894 fallback) in
#                                      addition to the kvm-group grant.
#
# MAGPIE_PREFIX defaults to the repo root this script lives in (its scripts/..).
# systemd runs the services from that path on every boot, so the checkout must
# live somewhere stable — /opt/magpie is the documented convention. Set
# MAGPIE_PREFIX to install units that point elsewhere.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths + parse args.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFIX="${MAGPIE_PREFIX:-$REPO_ROOT}"

# The path the authored unit files hardcode; rewritten to $PREFIX on install.
UNIT_TEMPLATE_PREFIX="/opt/magpie"
# The node interpreter the authored units hardcode in ExecStart; rewritten to
# $NODE_BIN on install so hosts whose node lives elsewhere (nvm, /usr/local)
# still get a working unit. systemd ExecStart needs an ABSOLUTE path.
UNIT_TEMPLATE_NODE="/usr/bin/node"

ENABLE_UNITS=0
for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE_UNITS=1 ;;
    -h|--help) sed -n '2,63p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

ETC_MAGPIE="/etc/magpie"
ETC_GATEWAY="/etc/magpie-gateway"
STATE_DIR="/var/lib/magpie"
WORK_DIR="$STATE_DIR/work"
SYSTEMD_DIR="/etc/systemd/system"

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preconditions.
# ---------------------------------------------------------------------------

[[ "$(id -u)" -eq 0 ]] || die "must run as root (use sudo)"

for unit in magpie-gateway.service magpie.service; do
  [[ -f "$REPO_ROOT/systemd/$unit" ]] || die "missing $REPO_ROOT/systemd/$unit"
done
[[ -f "$REPO_ROOT/config.example.toml" ]] || die "missing config.example.toml"

command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this installer targets systemd hosts"

log "install prefix (unit ExecStart / script paths): $PREFIX"
if [[ "$PREFIX" != "$UNIT_TEMPLATE_PREFIX" ]]; then
  log "units will be rewritten from $UNIT_TEMPLATE_PREFIX -> $PREFIX on install"
fi

# The gateway + orchestrator units set ProtectHome=true, which makes /home,
# /root and /run/user INACCESSIBLE to the service. If the code lives under a
# home directory the service can't read its own dist/ and fails to start — a
# silent boot failure. Refuse rather than install units that can't work.
# Deploy the checkout to /opt/magpie (the documented convention) instead. The
# escape hatch is for operators who have deliberately relaxed ProtectHome.
case "$PREFIX" in
  /home/*|/root/*)
    if [[ "${MAGPIE_ALLOW_HOME_PREFIX:-0}" != "1" ]]; then
      die "install PREFIX ($PREFIX) is under a home directory, but the units set \
ProtectHome=true — the services could not read their own code and would fail to \
start. Deploy the checkout outside /home (e.g. /opt/magpie) and re-run, or set \
MAGPIE_ALLOW_HOME_PREFIX=1 if you have relaxed ProtectHome in the units."
    fi
    warn "PREFIX is under a home directory and MAGPIE_ALLOW_HOME_PREFIX=1 — ensure the units' ProtectHome is relaxed or the services will fail to start."
    ;;
esac

# Resolve the node interpreter for the units' ExecStart. Prefer an explicit
# override, then the conventional system path, then whatever `node` resolves to
# on PATH (may be absent under sudo if node is nvm-managed — hence the warning).
NODE_BIN="${MAGPIE_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  if [[ -x "$UNIT_TEMPLATE_NODE" ]]; then
    NODE_BIN="$UNIT_TEMPLATE_NODE"
  elif NODE_BIN="$(command -v node 2>/dev/null)"; then
    :
  else
    NODE_BIN="$UNIT_TEMPLATE_NODE"
    warn "no node found at $UNIT_TEMPLATE_NODE or on PATH — units will reference $NODE_BIN."
    warn "Install a system-wide node there, or re-run with MAGPIE_NODE_BIN=/path/to/node."
  fi
fi
case "$NODE_BIN" in
  /*) : ;;
  *) die "resolved node path '$NODE_BIN' is not absolute — set MAGPIE_NODE_BIN to an absolute path" ;;
esac
log "node interpreter for units' ExecStart: $NODE_BIN"

# ---------------------------------------------------------------------------
# 1. Service users (idempotent).
# ---------------------------------------------------------------------------

ensure_system_user() {
  local user="$1"
  # Create the matching primary group explicitly first: whether `useradd`
  # auto-creates a same-named group is distro-/login.defs-dependent
  # (USERGROUPS_ENAB), and the `install -g "$user"` calls below hard-depend on
  # that group existing. Being explicit keeps this robust and idempotent
  # everywhere.
  if getent group "$user" >/dev/null 2>&1; then
    log "group '$user' already exists"
  else
    log "creating system group '$user'"
    groupadd --system "$user"
  fi
  if id -u "$user" >/dev/null 2>&1; then
    log "user '$user' already exists"
  else
    log "creating system user '$user'"
    useradd --system --no-create-home --gid "$user" --shell /usr/sbin/nologin "$user"
  fi
}

ensure_system_user magpie
ensure_system_user magpie-gateway

# ---------------------------------------------------------------------------
# 1a. Rootless-podman substrate for the `magpie` user.
# ---------------------------------------------------------------------------
#
# Replaces a docker-group grant entirely: rootless podman needs NO
# privileged group, only (a) subuid/subgid ranges to map the container uids and
# (b) a lingering user session. The gateway user gets NONE of this — it must
# never be able to launch a container.

# (a) subuid/subgid ranges. newuidmap/newgidmap refuse to map a range the user
# has no /etc/subuid + /etc/subgid entry for, so a range >1 is mandatory for
# rootless podman. Idempotent: only assign when magpie has no entry yet, and
# pick a base that does not overlap any existing allocation.
SUBID_COUNT=65536
ensure_subid_range() {
  local file="$1" user="magpie"
  if grep -q "^${user}:" "$file" 2>/dev/null; then
    log "$file already has a range for '$user' ($(grep "^${user}:" "$file" | head -1))"
    return
  fi
  # Highest end-of-range already allocated in this file (0 if empty/missing), so
  # the new range starts strictly above every existing one — no overlap.
  local max_end base
  max_end="$(awk -F: 'NF>=3 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {e=$2+$3; if (e>m) m=e} END {print m+0}' "$file" 2>/dev/null)"
  base=$(( max_end > 100000 ? max_end : 100000 ))
  printf '%s:%s:%s\n' "$user" "$base" "$SUBID_COUNT" >> "$file"
  log "granted '$user' the range ${base}:${SUBID_COUNT} in $file"
}
ensure_subid_range /etc/subuid
ensure_subid_range /etc/subgid

# (b) Persistent user session (linger). This starts user@<uid>.service, whose
# delegated memory/cpu/pids cgroup controllers are what actually ENFORCE each
# review container's `--memory`/`--cpus`/`--pids-limit` (see
# systemd/magpie.service's header + cgroup-preflight.ts). Without it the caps
# silently no-op. Idempotent.
MAGPIE_UID="$(id -u magpie)"
if [[ "$(loginctl show-user magpie -p Linger --value 2>/dev/null || echo no)" == "yes" ]]; then
  log "linger already enabled for 'magpie' (user@${MAGPIE_UID}.service persists)"
else
  log "enabling linger for 'magpie' (persistent user session -> memory-cap enforcement)"
  loginctl enable-linger magpie
fi

# (c) /dev/kvm access for the OPTIONAL micro-VM tier. Preferred: kvm-group
# membership (systemd includes the User='s db groups automatically, so no
# SupplementaryGroups= line is needed in the unit). The crun floor needs no
# /dev/kvm, so a host with no kvm group is fine — this is best-effort.
if getent group kvm >/dev/null 2>&1; then
  if id -nG magpie | tr ' ' '\n' | grep -qx kvm; then
    log "user 'magpie' already in 'kvm' group (micro-VM tier can open /dev/kvm)"
  else
    log "adding 'magpie' to the 'kvm' group (micro-VM tier: opens /dev/kvm)"
    usermod -aG kvm magpie
  fi
  # crun #1894 fallback: some hosts need an ACL on /dev/kvm beyond group
  # membership. Opt-in only (MAGPIE_KVM_SETFACL=1) and scoped to the magpie
  # user — NEVER world-0666 (that would be a real permission regression).
  if [[ "${MAGPIE_KVM_SETFACL:-0}" == "1" ]]; then
    if command -v setfacl >/dev/null 2>&1 && [[ -e /dev/kvm ]]; then
      setfacl -m u:magpie:rw /dev/kvm
      log "applied ACL u:magpie:rw on /dev/kvm (MAGPIE_KVM_SETFACL=1; crun #1894 fallback)"
      warn "the /dev/kvm ACL is NOT persistent across reboot — re-apply it via a udev rule or systemd-tmpfiles if you rely on it."
    else
      warn "MAGPIE_KVM_SETFACL=1 requested but 'setfacl' (package 'acl') is missing or /dev/kvm is absent — skipping the ACL fallback."
    fi
  fi
else
  log "no 'kvm' group on this host — the micro-VM tier is unavailable here; the crun floor (default) needs no /dev/kvm."
fi

# ---------------------------------------------------------------------------
# 2. Directories: config, per-service secret dirs, and state/work.
# ---------------------------------------------------------------------------

# /etc/magpie — orchestrator config + its env file. World-readable dir is fine;
# the secret env file inside it is locked down individually below.
install -d -o root -g magpie -m 0750 "$ETC_MAGPIE"
# /etc/magpie-gateway — gateway secrets only; readable solely by its user.
install -d -o magpie-gateway -g magpie-gateway -m 0700 "$ETC_GATEWAY"
# State/work — PR checkouts. StateDirectory=magpie in the unit also ensures
# /var/lib/magpie at start, but create the work subdir now so it exists on the
# very first boot before any job runs.
install -d -o magpie -g magpie -m 0750 "$STATE_DIR"
install -d -o magpie -g magpie -m 0750 "$WORK_DIR"
log "directories ready: $ETC_MAGPIE (0750), $ETC_GATEWAY (0700), $WORK_DIR (0750)"

# ---------------------------------------------------------------------------
# 3. Secret env-file templates (seeded ONCE, never overwritten).
# ---------------------------------------------------------------------------

# seed_file <path> <owner> <mode> <heredoc-content-on-stdin>
seed_file() {
  local path="$1" owner="$2" mode="$3"
  if [[ -e "$path" ]]; then
    log "keeping existing $path (not overwritten)"
    return
  fi
  install -o "$owner" -g "$owner" -m "$mode" /dev/null "$path"
  cat > "$path"
  chown "$owner:$owner" "$path"
  chmod "$mode" "$path"
  log "seeded template $path ($mode, $owner) — FILL IN its secrets"
}

seed_file "$ETC_MAGPIE/magpie.env" magpie 0600 <<EOF
# magpie orchestrator environment (systemd EnvironmentFile). chmod 600.
# Point the loader at the installed config regardless of WorkingDirectory:
MAGPIE_CONFIG=$ETC_MAGPIE/config.toml
# GitHub App webhook secret (verifies X-Hub-Signature-256). REQUIRED.
MAGPIE_WEBHOOK_SECRET=
# Shared bearer token for the gateway management plane. REQUIRED and MUST be
# the SAME value as MAGPIE_GATEWAY_MASTER_KEY in $ETC_GATEWAY/gateway.env.
# Generate it once with: openssl rand -hex 32
MAGPIE_GATEWAY_MASTER_KEY=
EOF

seed_file "$ETC_GATEWAY/gateway.env" magpie-gateway 0600 <<'EOF'
# magpie-gateway environment (systemd EnvironmentFile). chmod 600, and this is
# the ONLY file/process that holds the real OpenRouter key.
# Real OpenRouter API key. REQUIRED.
MAGPIE_GATEWAY_OPENROUTER_KEY=
# Management-plane bearer token. REQUIRED and MUST equal the orchestrator's
# MAGPIE_GATEWAY_MASTER_KEY (one shared secret known to both processes).
# Generate it once with: openssl rand -hex 32
MAGPIE_GATEWAY_MASTER_KEY=
# No proxy-plane host/port to set: under Design D the proxy plane is a
# per-job UNIX SOCKET under systemd's RuntimeDirectory (see
# systemd/magpie-gateway.service's GATEWAY_SOCKET_DIR), not a bound TCP
# host:port — GATEWAY_PROXY_HOST/GATEWAY_PROXY_PORT no longer exist. The mgmt
# plane stays hardcoded to 127.0.0.1 in code.
# Optional: default model when a request/key specifies none.
# GATEWAY_DEFAULT_MODEL=anthropic/claude-sonnet-4.5
EOF

# ---------------------------------------------------------------------------
# 4. config.toml — seed from the example ONCE, never overwrite.
# ---------------------------------------------------------------------------

if [[ -e "$ETC_MAGPIE/config.toml" ]]; then
  log "keeping existing $ETC_MAGPIE/config.toml (not overwritten)"
else
  install -o root -g magpie -m 0640 "$REPO_ROOT/config.example.toml" "$ETC_MAGPIE/config.toml"
  log "seeded $ETC_MAGPIE/config.toml from config.example.toml (0640) — EDIT it:"
  log "  repo_allowlist, github.app_id, github.private_key_path, [llm].model."
  log "  (Egress lockdown needs no config: every review container"
  log "  runs --network none unconditionally — see DISTRIBUTION.md §1.)"
fi

# ---------------------------------------------------------------------------
# 4a. Install the KVM tier-probe binary + run the install-time preflight.
# ---------------------------------------------------------------------------
#
# `magpie-tier-probe` is the SAME binary the orchestrator shells out to at
# startup (packages/orchestrator/src/tier-ladder.ts) — a standalone,
# static-musl, per-arch native helper that opens /dev/kvm and issues a real
# KVM_CREATE_VM (no Node in this path). A release tarball ships it at
# $PREFIX/bin/magpie-tier-probe (see scripts/pack-host.sh); we install it onto
# PATH at /usr/local/bin so both this installer and the orchestrator find it via
# config.toml's default container.tier_probe_bin = "magpie-tier-probe".
TIER_PROBE_SRC="$REPO_ROOT/bin/magpie-tier-probe"
TIER_PROBE_DST="/usr/local/bin/magpie-tier-probe"
if [[ -f "$TIER_PROBE_SRC" ]]; then
  install -o root -g root -m 0755 "$TIER_PROBE_SRC" "$TIER_PROBE_DST"
  log "installed KVM tier-probe: $TIER_PROBE_DST"
elif command -v magpie-tier-probe >/dev/null 2>&1; then
  TIER_PROBE_DST="$(command -v magpie-tier-probe)"
  log "using magpie-tier-probe already on PATH: $TIER_PROBE_DST"
else
  TIER_PROBE_DST=""
  warn "magpie-tier-probe not found at $TIER_PROBE_SRC or on PATH — this is expected only for a raw git checkout (build it: cargo build --release -p magpie-tier-probe in rust/, then copy target/release/magpie-tier-probe to $TIER_PROBE_DST). The isolation-tier preflight is SKIPPED; the orchestrator will still run its own KVM probe at startup."
fi

# The tier preflight: mirror tier-ladder.ts's degrade+acknowledge semantics.
# The operator declares the tier they intend to run via MAGPIE_INSTALL_TIER
# (default: crun, today's hardened floor). We probe /dev/kvm; if they asked for
# "microvm" but KVM is unreachable, FAIL LOUD unless they have explicitly
# acknowledged the weaker tier with MAGPIE_ACK_TIER (exactly the orchestrator's
# runtime env var, so the acknowledgement is the same live, per-host decision).
REQUESTED_TIER="${MAGPIE_INSTALL_TIER:-crun}"
case "$REQUESTED_TIER" in
  crun|microvm) : ;;
  *) die "MAGPIE_INSTALL_TIER='$REQUESTED_TIER' is not a recognized tier — use 'crun' or 'microvm'." ;;
esac
if [[ -n "$TIER_PROBE_DST" ]]; then
  # The probe exits 0 for kvm:true, 1 for kvm:false (an ORDINARY negative
  # answer, not an error) and prints one line of JSON either way — so capture
  # output without letting `set -e` abort on the expected exit 1.
  KVM_JSON="$("$TIER_PROBE_DST" 2>/dev/null || true)"
  if printf '%s' "$KVM_JSON" | grep -q '"kvm":true'; then
    KVM_AVAILABLE=1
    log "KVM preflight: /dev/kvm usable (KVM_CREATE_VM succeeded) — the micro-VM tier is reachable on this host."
  else
    KVM_AVAILABLE=0
    KVM_REASON="$(printf '%s' "$KVM_JSON" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p')"
    log "KVM preflight: /dev/kvm NOT usable (${KVM_REASON:-no KVM}) — only the crun floor is reachable on this host right now."
  fi

  if [[ "$REQUESTED_TIER" == "microvm" && "$KVM_AVAILABLE" -ne 1 ]]; then
    if [[ "${MAGPIE_ACK_TIER:-}" == "crun" ]]; then
      warn "MAGPIE_INSTALL_TIER=microvm but KVM is unavailable; proceeding on the crun floor because MAGPIE_ACK_TIER=crun acknowledges the weaker tier. Set [container] tier = \"crun\" in $ETC_MAGPIE/config.toml to match, or the orchestrator will fail closed at startup."
    else
      die "isolation-tier PREFLIGHT FAILED: you requested MAGPIE_INSTALL_TIER=microvm, but /dev/kvm is not usable on this host (${KVM_REASON:-no hardware virtualization / not in the kvm group}). Magpie will not silently install a weaker isolation posture than you asked for. Fix the host (enable nested virt / add 'magpie' to the kvm group and re-login) and re-run, OR explicitly accept the crun floor by re-running with MAGPIE_ACK_TIER=crun. (This mirrors the orchestrator's own runtime MAGPIE_ACK_TIER gate — see tier-ladder.ts.)"
    fi
  fi

  if [[ "$REQUESTED_TIER" == "microvm" && "$KVM_AVAILABLE" -eq 1 ]]; then
    log "NOTE: the micro-VM tier ALSO needs the host-built magpie-microvm-launcher on PATH and [microvm] rootfs_path set in config.toml — see INSTALL.md's micro-VM opt-in section. The orchestrator re-probes all three at startup and fails closed if any is missing."
  fi
else
  log "isolation-tier preflight skipped (no probe binary); requested tier: $REQUESTED_TIER."
fi

# ---------------------------------------------------------------------------
# 5. Install the systemd units (rewriting the prefix to $PREFIX).
# ---------------------------------------------------------------------------

install_unit() {
  local unit="$1"
  local src="$REPO_ROOT/systemd/$unit"
  local dst="$SYSTEMD_DIR/$unit"
  # Rewrite the authored /opt/magpie prefix and /usr/bin/node interpreter to the
  # actual install prefix and resolved node path. The node path is replaced
  # globally rather than anchored to a specific `ExecStart=<node> ` shape so the
  # rewrite is robust to unit reformatting; the template node path only ever
  # appears in ExecStart, so a global replace has no other effect.
  #
  # For magpie.service ALSO rewrite the MAGPIE_RUNTIME_UID placeholder (in
  # XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS) to the numeric magpie uid.
  # systemd's %U specifier resolves to the MANAGER uid (not User=) on systemd
  # 252, so the uid must be baked in at install time. The gateway unit has no
  # such placeholder, so this substitution is a no-op there.
  sed -e "s|$UNIT_TEMPLATE_PREFIX|$PREFIX|g" \
      -e "s|$UNIT_TEMPLATE_NODE|$NODE_BIN|g" \
      -e "s|MAGPIE_RUNTIME_UID|$MAGPIE_UID|g" \
      "$src" > "$dst"
  chmod 0644 "$dst"
  log "installed $dst"
}

install_unit magpie-gateway.service
install_unit magpie.service

log "reloading systemd"
systemctl daemon-reload

if [[ "$ENABLE_UNITS" -eq 1 ]]; then
  log "enabling units (start on boot)"
  systemctl enable magpie-gateway.service magpie.service
fi

# ---------------------------------------------------------------------------
# 6. Next-steps notes.
# ---------------------------------------------------------------------------

DIST_ORCH="$PREFIX/packages/orchestrator/dist/index.js"
DIST_GW="$PREFIX/packages/gateway/dist/index.js"

# A release tarball (scripts/pack-host.sh) ships prebuilt dist/ for both
# services, so the only remaining step is `npm ci --omit=dev` to materialize
# node_modules — there is no TypeScript build on the adopter host. A raw git
# checkout has no dist/ yet, so it still needs the full build.
if [[ -f "$DIST_ORCH" && -f "$DIST_GW" ]]; then
  STEP4="  4. Install production dependencies (as your normal user, from $PREFIX):
       npm ci --omit=dev
     dist/ is already prebuilt (this looks like a release tarball) — no
     TypeScript build needed on this host."
else
  STEP4="  4. Build the code (as your normal user, from $PREFIX):
       npm ci
       npm run build && npm run gateway:build"
fi

cat <<NOTES

[install] Done. Remaining manual steps:

  1. Fill in secrets (the templates were seeded empty):
       sudoedit $ETC_GATEWAY/gateway.env     # OpenRouter key + shared master key
       sudoedit $ETC_MAGPIE/magpie.env       # webhook secret + SAME master key
     The master key MUST match in both files. Generate the shared master key
     once with:  openssl rand -hex 32

  2. Edit $ETC_MAGPIE/config.toml (app id, private_key_path, repo_allowlist,
     model). No network/firewall config needed — every review container runs
     --network none unconditionally (DISTRIBUTION.md §1).

  3. Place the GitHub App private key where config.toml's private_key_path
     points (default /etc/magpie/github-app.private-key.pem); make it readable
     by 'magpie' only, e.g.:
       install -o magpie -g magpie -m 0600 app.pem /etc/magpie/github-app.private-key.pem

$STEP4
NOTES

if [[ -f "$DIST_ORCH" && -f "$DIST_GW" ]]; then
  log "  (both dist entrypoints already present — build looks done)"
else
  warn "  built entrypoints not found yet:"
  [[ -f "$DIST_ORCH" ]] || warn "    missing $DIST_ORCH"
  [[ -f "$DIST_GW" ]]   || warn "    missing $DIST_GW"
fi

cat <<NOTES

  5. Pull the reviewer image AS THE magpie USER (rootless podman has per-user
     storage, so a root/other-user pull would not be visible to the service):
       sudo -u magpie XDG_RUNTIME_DIR=/run/user/$MAGPIE_UID \\
         HOME=$STATE_DIR podman pull \\
         \$(grep -E '^image *=' $ETC_MAGPIE/config.toml | cut -d'"' -f2)

  6. Cloudflare Tunnel ingress is a separate unit:
     systemd/cloudflared.service + scripts/setup-cloudflared.sh. Install/enable
     it per docs/cloudflared.md if you haven't already.

  7. (Micro-VM tier only) build + install the host launcher and set the rootfs —
     see INSTALL.md "Opt into the micro-VM tier". The crun floor (default) needs
     no extra steps.

  8. Enable + start (or reboot to prove boot ordering):
       sudo systemctl enable --now magpie-gateway.service magpie.service
     Boot order is enforced by the units: gateway -> orchestrator.
     Check: systemctl status magpie-gateway magpie

NOTES
