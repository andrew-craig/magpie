# Cloudflare Tunnel setup (webhook ingress)

This is the production path for exposing the magpie orchestrator's webhook
endpoint to GitHub (PLAN.md Milestone 5), replacing the `smee.io` dev relay
used during the Milestone 1 walking skeleton. It uses a Cloudflare **named
tunnel**: `cloudflared` makes an *outbound-only* connection from this host to
Cloudflare's edge — there is no inbound port to open, no port-forward on your
router, and your home IP is never exposed.

Related files:

- `scripts/setup-cloudflared.sh` — automates everything below that can be
  automated; prints exact commands for the parts that can't (interactive
  browser login).
- `cloudflared/config.example.yml` — the ingress config template the script
  renders from.
- `systemd/cloudflared.service` — long-lived service unit for `cloudflared`.

## Security notes (read this first)

- **Outbound-only.** `cloudflared` never listens for inbound connections on
  this host. It dials out to Cloudflare; Cloudflare's edge terminates TLS and
  forwards matched requests back down that connection.
- **Target must stay loopback.** The tunnel's ingress rule forwards
  `https://<hostname>/webhook` to `http://localhost:8787` — the orchestrator's
  default bind (`config.toml` `[server] host = "127.0.0.1"`, `port = 8787`).
  Do **not** change the orchestrator to bind `0.0.0.0`; the tunnel, not the
  orchestrator, is what makes it internet-reachable.
- **HMAC is the auth gate, not Cloudflare Access.** GitHub webhook deliveries
  are unauthenticated HTTP POSTs that carry an `X-Hub-Signature-256` HMAC
  header, verified by the orchestrator itself
  (`packages/orchestrator/src/server.ts`) using the App's webhook secret
  (`MAGPIE_WEBHOOK_SECRET`). **Do not** put a Cloudflare Access / Zero Trust
  login policy in front of the webhook hostname — it will intercept and
  block every GitHub delivery before the HMAC check ever runs.
  - *Optional* belt-and-suspenders: a Cloudflare WAF/firewall rule that
    restricts the webhook hostname to GitHub's published webhook source IP
    ranges (see `https://api.github.com/meta`, the `"hooks"` key). This is a
    network-layer allowlist, not an auth challenge, so it's safe to add
    without breaking deliveries — but it's optional and not required for
    correctness or security (the HMAC check is what actually matters).
- **No secrets committed.** `cloudflared tunnel login` writes
  `~/.cloudflared/cert.pem` (your Cloudflare account credential); `cloudflared
  tunnel create` writes `~/.cloudflared/<TUNNEL-UUID>.json` (the tunnel's
  credentials). Both are secrets that stay on the host filesystem — nothing
  in this repo contains them, only their *paths*. The public hostname/domain
  is operator-specific and is never hardcoded in committed files; it's always
  a placeholder (`magpie.example.com`) or a parameter you supply.

## Prerequisites

- A domain (or subdomain) whose DNS is managed by Cloudflare (free plan is
  fine). You'll route something like `magpie.yourdomain.com` to the tunnel.
- This host: aarch64 (Raspberry Pi / Raspberry Pi OS or other Debian arm64).
- The magpie orchestrator already runs and listens on `127.0.0.1:8787`
  (default `config.toml` `[server]` — see `README.md` for orchestrator setup).

## Setup

### 1. Install cloudflared

Either run the script (installs from Cloudflare's official apt repo, arm64
package, gpg-keyed — idempotent, skips if already installed):

```bash
./scripts/setup-cloudflared.sh --dry-run magpie.yourdomain.com   # preview
./scripts/setup-cloudflared.sh magpie.yourdomain.com             # or via
MAGPIE_TUNNEL_HOSTNAME=magpie.yourdomain.com ./scripts/setup-cloudflared.sh
```

or install by hand, following [Cloudflare's install docs][cf-install] for
"Debian/Ubuntu" (works on Raspberry Pi OS), selecting the `arm64` package.

[cf-install]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

### 2. Authenticate (interactive, one-time)

```bash
cloudflared tunnel login
```

Opens a browser, asks you to pick the Cloudflare zone (domain) to authorize.
Writes `~/.cloudflared/cert.pem`. The setup script detects this file and will
tell you to run this step (then exit with guidance) if it's missing — it
cannot be automated headlessly.

### 3. Create the named tunnel

```bash
cloudflared tunnel create magpie
```

Writes `~/.cloudflared/<TUNNEL-UUID>.json` (the credentials file — a secret,
never commit it) and registers the tunnel with Cloudflare. Idempotent in
practice: the setup script checks `cloudflared tunnel list` first and skips
creation if a tunnel named `magpie` already exists.

### 4. Route DNS

```bash
cloudflared tunnel route dns magpie magpie.yourdomain.com
```

Creates a CNAME for `magpie.yourdomain.com` pointing at the tunnel. Safe to
re-run.

### 5. Render the ingress config

The script renders `/etc/cloudflared/config.yml` from
`cloudflared/config.example.yml`, substituting your hostname, tunnel
name/UUID, and credentials-file path. If an existing config is present it's
backed up first (`config.yml.bak.<timestamp>`), never clobbered silently.

To do this by hand instead: copy `cloudflared/config.example.yml` to
`/etc/cloudflared/config.yml` and fill in the placeholders (`<USER>`,
`<TUNNEL-UUID>`, the real hostname).

Steps 2–5 all run automatically (where possible) via:

```bash
./scripts/setup-cloudflared.sh magpie.yourdomain.com
```

Re-running it is safe — every step checks whether its effect already exists
before changing anything.

### 6. Install and start the systemd service

```bash
sudo cp systemd/cloudflared.service /etc/systemd/system/cloudflared.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared.service
sudo systemctl status cloudflared.service
```

Note: `cloudflared` also ships a `cloudflared service install` command that
generates and installs a unit for you. We commit `systemd/cloudflared.service`
instead so the unit is reviewable and reproducible from source control, like
every other magpie systemd unit (`systemd/magpie.service`, etc. per
`PLAN.md`) — install it by copying it into place, not by running that
subcommand.

### 7. Point the GitHub App at the tunnel hostname

In the GitHub App settings, set:

- **Webhook URL:** `https://magpie.yourdomain.com/webhook`
- **Webhook secret:** matches `MAGPIE_WEBHOOK_SECRET` in the orchestrator's
  environment (see `README.md` / `.env.example`).

### 8. Verify end-to-end

GitHub App settings → **Advanced** → **Recent Deliveries** → pick a past
delivery (or trigger a new one, e.g. by opening/updating a PR on an allow-
listed repo) → **Redeliver**. A response of **HTTP 200** confirms the full
path works: GitHub → Cloudflare edge → tunnel → orchestrator → HMAC verified
→ handled.

If it fails, check in order:

1. `sudo systemctl status cloudflared.service` — is the tunnel connected?
2. `sudo journalctl -u cloudflared.service -n 50` — connection/config errors.
3. Is the orchestrator running and listening on `127.0.0.1:8787`
   (`sudo systemctl status magpie.service` / `curl http://127.0.0.1:8787/`)?
4. Does the webhook secret in GitHub match `MAGPIE_WEBHOOK_SECRET`? A
   mismatch causes the orchestrator to reject with 401, not a tunnel-level
   failure — Recent Deliveries will still show the request reaching the
   server, just with a non-200 response.
