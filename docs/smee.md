# smee.io dev relay (webhook ingress, dev-only)

This is the **development** path for getting GitHub App webhook deliveries to
your local orchestrator: no public inbound port, no Cloudflare Tunnel. A
[smee.io](https://smee.io) channel receives deliveries on GitHub's behalf and
an outbound `smee-client` (this repo's `scripts/dev-smee.mjs`) relays them to
`http://localhost:8787/webhook` on your machine.

The **production** counterpart — outbound-only Cloudflare Tunnel, no
third-party relay — is [`docs/cloudflared.md`](cloudflared.md). Don't use
smee.io in production; it's a convenience for local development only.

## How it works

```
GitHub  --->  smee.io channel  --->  smee-client (outbound)  --->  localhost:8787/webhook
```

smee-client makes an *outbound* connection to your smee.io channel and
forwards each delivery's raw body and headers, untouched, to the target URL.
Because the body and headers pass through unmodified, the orchestrator's
`X-Hub-Signature-256` verification (`packages/orchestrator/src/server.ts`,
keyed by `MAGPIE_WEBHOOK_SECRET`) still applies exactly as it would for a real
GitHub delivery — the webhook secret gate is not weakened or bypassed by
using a relay.

## Setup

### 1. Create a smee.io channel

Go to <https://smee.io/new> and note the channel URL it gives you, e.g.
`https://smee.io/AbCdEfGhIjKlMnOp`.

### 2. Point the GitHub App at the channel

In the GitHub App's settings (dev/test app, not production), set:

- **Webhook URL:** the smee.io channel URL from step 1
- **Webhook secret:** matches `MAGPIE_WEBHOOK_SECRET` in your `.env`

### 3. Configure the relay

Add the channel URL to the repo-root `.env` (git-ignored; see
`.env.example`):

```
MAGPIE_SMEE_URL=https://smee.io/AbCdEfGhIjKlMnOp
```

`MAGPIE_SMEE_PORT` and `MAGPIE_SMEE_PATH` are optional overrides; they default
to `8787` and `/webhook`, matching the orchestrator's own defaults
(`config.toml` `[server]` and `WEBHOOK_PATH` in `server.ts`) — you shouldn't
need to set them unless you've also changed the orchestrator's port.

### 4. Run it

In one terminal, start the orchestrator as usual:

```bash
npm run dev
```

In a second terminal, start the relay:

```bash
npm run dev:smee
```

You should see a line like:

```
[dev-smee] relaying https://smee.io/AbCdEfGhIjKlMnOp -> http://localhost:8787/webhook
```

Deliveries to the smee.io channel now arrive at
`http://localhost:8787/webhook`, get HMAC-verified against
`MAGPIE_WEBHOOK_SECRET` exactly as they would in production, and flow into
the orchestrator's normal handling.

### 5. Verify

In the GitHub App settings → **Advanced** → **Recent Deliveries**, redeliver
a past delivery (or trigger a new one) and confirm the orchestrator responds
`200`. You can also watch the smee.io channel's page in a browser — it shows
each delivery as it's relayed.

## Troubleshooting

- **`MAGPIE_SMEE_URL is not set` and the process exits** — you haven't
  created a channel yet, or forgot to add it to `.env`. See step 1/3 above.
- **Relay logs the target but nothing arrives at the orchestrator** — check
  the orchestrator is actually running and listening on the port the relay
  is targeting (`npm run dev`, default `8787`).
- **Orchestrator responds 400** — signature mismatch: the GitHub App's
  webhook secret doesn't match `MAGPIE_WEBHOOK_SECRET` in your `.env`.
