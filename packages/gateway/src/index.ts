// Entrypoint for the magpie gateway (M4-A).
//
// Composition root: load config -> build the in-memory key store -> start
// the two independent HTTP listeners (proxy/data plane, admin/mgmt plane) ->
// graceful shutdown on SIGINT/SIGTERM. Mirrors
// packages/orchestrator/src/index.ts's shape (load config, wire modules,
// listen, signal-driven shutdown) but with no job queue to drain — a proxy
// request in flight when SIGTERM arrives is simply left to finish or be cut
// off by the client/orchestrator's own timeout; there is no per-job
// workspace to clean up on this side of the gateway boundary.
//
// SECURITY: this process is the ONLY place `config.secrets.openrouterKey`
// exists after M4 (see config.ts, PLAN.md §5). This module never logs
// `config.secrets` — the one startup log line below intentionally lists
// only non-secret fields.

import { pathToFileURL } from "node:url";
import { createAdminServer } from "./admin-server.js";
import { loadGatewayConfig, GatewayConfigError } from "./config.js";
import { createKeyStore } from "./keystore.js";
import { createProxyServer } from "./proxy-server.js";

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const keyStore = createKeyStore();

  const proxyServer = createProxyServer(config, keyStore);
  const adminServer = createAdminServer(config, keyStore);

  await Promise.all([proxyServer.listen(), adminServer.listen()]);

  console.log(
    JSON.stringify({
      level: "info",
      event: "magpie-gateway-started",
      proxy: { host: config.proxy.host, port: config.proxy.port },
      mgmt: { host: config.mgmt.host, port: config.mgmt.port },
      upstreamBaseUrl: config.upstream.baseUrl,
      defaultModel: config.defaultModel ?? null,
    }),
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", event: "gateway-shutting-down", signal }));
    Promise.all([proxyServer.close(), adminServer.close()])
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ level: "error", event: "gateway-shutdown-failed", message }));
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Only auto-run `main()` when this module is the actual process entrypoint,
// not when it's imported for its exports — mirrors
// packages/orchestrator/src/index.ts's identical guard (see that module's
// comment for why: importing this file for tests must never call
// loadGatewayConfig()/process.exit() for real).
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    if (err instanceof GatewayConfigError) {
      console.error(`[magpie-gateway] ${err.message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[magpie-gateway] fatal startup error: ${message}`);
    }
    process.exit(1);
  });
}
