#!/usr/bin/env bash
#
# install.sh — idempotent production install for magpie (Milestone 5, task_56ad).
#
# Sets up the two unprivileged service users, the config/secret/state
# directories, and the two systemd units (gateway -> orchestrator) so a
# reboot brings magpie up in the correct order with no manual steps. Safe to
# re-run: it never overwrites an existing secret, env file, or config.toml,
# and never duplicates a user or a directory.
#
# As of M7-1 (Design D — DISTRIBUTION.md §2) there is no network-lockdown
# unit/script to install any more: each review container runs `--network
# none`, so there is no bridge/iptables apparatus to provision at boot
# (magpie-firewall.service and scripts/setup-network.sh are deleted).
#
# It does NOT install dependencies or build the code, and does NOT start the
# services — that runs as the operator (not root), and enabling is a
# deliberate final step once secrets are filled in. Both are printed as clear
# next steps at the end.
#
# PRIMARY FLOW (M7-3): download a release tarball (built by
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
    -h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}"; exit 0 ;;
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

# The orchestrator needs docker socket access to run review containers; the
# gateway deliberately does NOT (it must never be able to launch a container).
if getent group docker >/dev/null 2>&1; then
  if id -nG magpie | tr ' ' '\n' | grep -qx docker; then
    log "user 'magpie' already in 'docker' group"
  else
    log "adding 'magpie' to the 'docker' group (needed to run review containers)"
    usermod -aG docker magpie
  fi
else
  warn "no 'docker' group on this host — install docker and run 'usermod -aG docker magpie' before starting magpie.service"
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
# No proxy-plane host/port to set: as of M7-1 (Design D) the proxy plane is a
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
  log "  (Egress lockdown needs no config as of M7-1: every review container"
  log "  runs --network none unconditionally — see DISTRIBUTION.md §2.)"
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
  sed -e "s|$UNIT_TEMPLATE_PREFIX|$PREFIX|g" \
      -e "s|$UNIT_TEMPLATE_NODE|$NODE_BIN|g" \
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
     --network none unconditionally (M7-1, DISTRIBUTION.md §2).

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

  5. Cloudflare Tunnel ingress (from Milestone 1) is a separate unit:
     systemd/cloudflared.service + scripts/setup-cloudflared.sh. Install/enable
     it per docs/cloudflared.md if you haven't already.

  6. Enable + start (or reboot to prove boot ordering):
       sudo systemctl enable --now magpie-gateway.service magpie.service
     Boot order is enforced by the units: gateway -> orchestrator.
     Check: systemctl status magpie-gateway magpie

NOTES
