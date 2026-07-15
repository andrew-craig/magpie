// Entrypoint for the magpie gateway (M4-A; per-job unix-socket proxy plane
// added in M7-1, DISTRIBUTION.md §2.6 "Design D").
//
// Composition root: load config -> build the in-memory key store and the
// per-job socket manager -> start the ONE HTTP listener this process binds
// at startup (the admin/mgmt plane) -> graceful shutdown on SIGINT/SIGTERM.
// Mirrors packages/orchestrator/src/index.ts's shape (load config, wire
// modules, listen, signal-driven shutdown) but with no job queue to drain —
// a proxy request in flight when SIGTERM arrives is simply left to finish or
// be cut off by the client/orchestrator's own timeout; there is no per-job
// workspace to clean up on this side of the gateway boundary.
//
// Design D note: there is no longer a global proxy/data-plane listener
// started here. Each job gets its own proxy `http.Server`, bound to a unix
// socket on demand when the orchestrator mints that job's virtual key (see
// admin-server.ts's mint handler -> job-sockets.ts's `JobSocketManager.bind`)
// and torn down on revoke. This module's only startup-time responsibility
// toward that mechanism is making sure the socket-dir ROOT exists.
//
// `config.socketDirRoot`'s PARENT permissions are deliberately NOT set by
// this module: in production it is systemd's `RuntimeDirectory` (created
// 0700, owned by the gateway's own unix user — see DISTRIBUTION.md §2.6),
// and this process chmod'ing it would either be a redundant no-op or, worse,
// accidentally widen a mode systemd intentionally locked down. `mkdir`ing it
// here is still correct/needed for local dev (`npm run dev`, tests that
// don't run under systemd), where nothing else creates it first; `recursive:
// true` makes this a no-op if it already exists (any pre-existing mode is
// left untouched).
//
// SECURITY: this process is the ONLY place `config.secrets.openrouterKey`
// exists after M4 (see config.ts, PLAN.md §5). This module never logs
// `config.secrets` — the one startup log line below intentionally lists
// only non-secret fields.

import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAdminServer } from "./admin-server.js";
import { loadGatewayConfig, GatewayConfigError } from "./config.js";
import { createJobSocketManager } from "./job-sockets.js";
import { createKeyStore } from "./keystore.js";

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const keyStore = createKeyStore();
  const jobSockets = createJobSocketManager(config, keyStore);

  // See module doc comment: create the root if missing (local-dev
  // convenience), but never chmod it — that's systemd's `RuntimeDirectory`
  // job in production.
  await mkdir(config.socketDirRoot, { recursive: true });

  const adminServer = createAdminServer(config, keyStore, jobSockets);

  await adminServer.listen();

  console.log(
    JSON.stringify({
      level: "info",
      event: "magpie-gateway-started",
      socketDirRoot: config.socketDirRoot,
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
    Promise.all([jobSockets.closeAll(), adminServer.close()])
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
