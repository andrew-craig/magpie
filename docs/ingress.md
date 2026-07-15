# Webhook ingress options

Magpie only needs *some* public HTTPS URL forwarding to the orchestrator's
loopback webhook endpoint — by default `127.0.0.1:8787/webhook`
(`config.toml` `[server] host = "127.0.0.1"`, `port = 8787`). How that public
URL comes to exist is entirely up to you; this page documents three
supported ways to do it.

## Security note (read this first)

**HMAC signature verification makes the endpoint safe to expose regardless
of which ingress option you pick.** Every GitHub webhook delivery carries an
`X-Hub-Signature-256` header; the orchestrator verifies it against
`MAGPIE_WEBHOOK_SECRET` *before* parsing the payload
(`packages/orchestrator/src/server.ts`) and rejects anything unsigned or
mis-signed. There is no separate authentication layer to configure (no
Cloudflare Access, no basic auth, no IP allowlist) — the choice below is
purely operational (what's easiest to run given your network), not a
security decision.

Whichever option you choose, the orchestrator itself must stay bound to
`127.0.0.1` (never `0.0.0.0`) — the ingress mechanism, not the orchestrator's
bind address, is what makes it reachable from the internet.

## Option 1: Reverse proxy + your own TLS

For organisations that already run a public-facing server with a real TLS
certificate (e.g. via Let's Encrypt / ACME). Terminate TLS at your existing
reverse proxy and forward the `/webhook` path to the orchestrator's loopback
port. Nothing else on the host needs to listen publicly.

**Caddy** (`Caddyfile`):

```
magpie.example.com {
	reverse_proxy /webhook 127.0.0.1:8787
}
```

**nginx** (site config):

```nginx
server {
    listen 443 ssl;
    server_name magpie.example.com;

    # ... your existing ssl_certificate / ssl_certificate_key directives ...

    location /webhook {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Either way: the reverse proxy is the only public listener; the orchestrator
stays on `127.0.0.1:8787` and never sees a public IP directly. Point the
GitHub App's webhook URL at `https://magpie.example.com/webhook`.

## Option 2: Cloudflare Tunnel

An outbound-only tunnel — no inbound port to open, no port-forward on your
router. Run as a host service via `scripts/setup-cloudflared.sh` +
`systemd/cloudflared.service`; full runbook in `docs/cloudflared.md`.

- Works on any architecture: the setup script installs from Cloudflare's apt
  repo on Debian-family hosts (any `dpkg` arch), or the official static
  binary (verified by checksum) everywhere else — it is not limited to
  arm64/Raspberry Pi.
- You do **not** need to buy or register a domain through Cloudflare. Any
  domain whose DNS is hosted on Cloudflare (free plan included) works — point
  an existing domain's nameservers at Cloudflare, or use a subdomain of one
  you already manage there.

## Option 3: Other outbound tunnels

Any tool that punches an outbound tunnel to a public HTTPS URL and forwards
to a local port works, since the security boundary is the HMAC check, not
the tunnel mechanism. Two common options:

**Tailscale Funnel** (exposes a Tailscale node's local port to the public
internet over HTTPS):

```bash
tailscale funnel 8787
```

Tailscale prints the public `https://<host>.<tailnet>.ts.net` URL to point
the GitHub App's webhook at (append `/webhook`).

**ngrok**:

```bash
ngrok http 127.0.0.1:8787
```

ngrok prints a public `https://<random>.ngrok-free.app` forwarding URL
(append `/webhook` for the GitHub App's webhook URL). Free-tier URLs are
ephemeral (change on restart) — fine for evaluation, but prefer option 1 or 2
for a stable production URL.

## Choosing

All three are equally safe by design (HMAC verification is what actually
matters). Pick based on what you already operate:

| You have...                              | Use            |
|-------------------------------------------|----------------|
| A public server with a domain + TLS       | Option 1 (reverse proxy) |
| No public server, want a stable free setup | Option 2 (Cloudflare Tunnel) |
| An existing Tailscale/ngrok setup, or quick evaluation | Option 3 |

See also: `INSTALL.md` (host service install), `docs/cloudflared.md`
(Cloudflare Tunnel runbook), `DISTRIBUTION.md` §3.3 (design rationale).
