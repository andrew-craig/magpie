#!/usr/bin/env node
// Dev-only smee.io relay for the magpie orchestrator's webhook endpoint.
//
// DEV-ONLY: this has no role in production. It forwards GitHub webhook
// deliveries from a smee.io channel to the orchestrator's local webhook
// server (see packages/orchestrator/src/server.ts, WEBHOOK_PATH) so you can
// receive real GitHub deliveries during development without a public inbound
// port or a Cloudflare Tunnel (that's the production path, docs/cloudflared.md).
//
// This script is deliberately standalone: it does NOT import the
// orchestrator's config loader (packages/orchestrator/src/config.ts), which
// throws if secrets like MAGPIE_WEBHOOK_SECRET aren't set. The relay only
// needs a URL, a port, and a path — none of which are secret.
//
// Env vars read:
//   MAGPIE_SMEE_URL   (required) the smee.io channel URL, e.g.
//                     https://smee.io/abc123 — create one at
//                     https://smee.io/new
//   MAGPIE_SMEE_PORT  (optional) local port to forward to; defaults to 8787,
//                     matching the orchestrator's default config.toml
//                     [server] port.
//   MAGPIE_SMEE_PATH  (optional) local path to forward to; defaults to
//                     "/webhook", matching WEBHOOK_PATH in server.ts.
//
// See docs/smee.md for the full dev setup guide.

import SmeeClient from "smee-client";

const source = process.env.MAGPIE_SMEE_URL;
if (!source) {
  console.error(
    [
      "MAGPIE_SMEE_URL is not set — nothing to relay.",
      "",
      "To fix this:",
      "  1. Create a channel at https://smee.io/new",
      "  2. Set MAGPIE_SMEE_URL to that channel's URL, e.g. in the repo-root .env:",
      "       MAGPIE_SMEE_URL=https://smee.io/your-channel-id",
      "  3. Point the GitHub App's webhook URL at the same channel URL.",
      "  4. Re-run: npm run dev:smee",
      "",
      "See docs/smee.md for the full walkthrough.",
    ].join("\n"),
  );
  process.exit(1);
}

const port = process.env.MAGPIE_SMEE_PORT || 8787;
const path = process.env.MAGPIE_SMEE_PATH || "/webhook";
const target = `http://localhost:${port}${path}`;

console.log(`[dev-smee] relaying ${source} -> ${target}`);

const smee = new SmeeClient({ source, target, logger: console });

try {
  await smee.start();
  console.log(`[dev-smee] relay active: ${source} -> ${target}`);
} catch (err) {
  // Don't let a bad/unreachable channel surface as an uncaught stack trace —
  // this is a dev convenience script, not something that should crash loudly.
  console.error(
    `[dev-smee] failed to connect to ${source}: ${err instanceof Error ? err.message : err}`,
  );
  console.error(
    "[dev-smee] check that MAGPIE_SMEE_URL is a real smee.io channel (create one at https://smee.io/new)",
  );
  process.exitCode = 1;
}
