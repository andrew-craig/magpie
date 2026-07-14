// Management plane (control) for the magpie gateway: virtual-key lifecycle.
//
// SECURITY BOUNDARY: this is the plane that must NEVER be reachable from
// magpie-net (the review container's network) — only the host orchestrator
// (and an operator on the host) may mint/revoke keys. Enforced two ways,
// deliberately redundant (see M4-A task contract's "Prefer two separate
// http.Server listeners" guidance):
//   1. This server is only ever bound to 127.0.0.1 (config.ts hardcodes
//      `mgmt.host`, it is not an env-configurable value — see config.ts's
//      doc comment on that field).
//   2. Every request is ALSO checked against `isLoopbackRequest` here, so
//      even a future refactor that accidentally passed a non-loopback host
//      into `listen()` would still fail closed rather than silently open
//      the control plane to the network.
// Both checks must hold; this module enforces #2, index.ts enforces #1 by
// construction (it never reads a host from config for this listener).
//
// Auth: `Authorization: Bearer <master key>` (constant-time compared via
// `timingSafeEqual`, matching the care `@octokit/webhooks` uses for webhook
// signatures elsewhere in this codebase). The master key is never logged.

import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { extractBearerToken, isLoopbackRequest, readBody, sendJson, sendJsonError } from "./http-util.js";
import type { JobSocketManager } from "./job-sockets.js";
import type { KeyStore } from "./keystore.js";

const mintKeyBodySchema = z
  .object({
    // The orchestrator's job id — REQUIRED as of Design D (M7-1): every
    // minted key gets its own proxy-plane unix socket keyed by this value
    // (see job-sockets.ts's `JobSocketManager.bind`), so there is no longer
    // a mint request that doesn't need one.
    jobId: z.string().min(1),
    model: z.string().min(1).optional(),
    budgetUsd: z.number().positive(),
    ttlSeconds: z.number().int().positive(),
  })
  .strict();

/** A running (or ready-to-run) admin server. Mirrors server.ts's `WebhookServer` shape/lifecycle. */
export interface AdminServer {
  readonly server: http.Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Constant-time bearer-token comparison — avoids a timing side-channel on the master key, same rationale as GitHub webhook signature verification elsewhere in this codebase. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  // Hash both inputs to fixed-length SHA-256 digests first, then compare the
  // digests in constant time. Because the digests are always the same length
  // regardless of the inputs', there is no length-based branch here at all —
  // eliminating the length side-channel a raw buffer comparison would leak
  // (an attacker learns nothing about the master key's length from timing).
  const hashA = createHash("sha256").update(a, "utf-8").digest();
  const hashB = createHash("sha256").update(b, "utf-8").digest();
  return timingSafeEqual(hashA, hashB);
}

function isAuthorized(req: http.IncomingMessage, masterKey: string): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;
  return timingSafeEqualStrings(token, masterKey);
}

/**
 * Build the management-plane HTTP server.
 *
 * Routes:
 *  - `POST   /admin/keys`     — mint a virtual key AND bind its per-job proxy socket. Body: `{ jobId, model?, budgetUsd, ttlSeconds }`. 201 `{ id, key, socketDir }` (`socketDir` is the directory the orchestrator bind-mounts — see job-sockets.ts).
 *  - `DELETE /admin/keys/:id` — revoke a virtual key AND tear down its per-job socket. 204, idempotent (unknown/already-revoked id is still 204).
 *  - anything else            — 404.
 *
 * Every route requires `Authorization: Bearer <config.secrets.masterKey>`
 * (401 otherwise) AND a loopback remote address (403 otherwise — see module
 * doc comment). The returned server is not listening yet; call
 * {@link AdminServer.listen}. Binding uses `config.mgmt.host`/`config.mgmt.port`.
 */
export function createAdminServer(config: GatewayConfig, keyStore: KeyStore, jobSockets: JobSocketManager): AdminServer {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, config, keyStore, jobSockets);
  });

  return {
    server,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(config.mgmt.port, config.mgmt.host, () => {
          server.removeListener("error", onError);
          const address = server.address();
          const port = address && typeof address === "object" ? address.port : config.mgmt.port;
          console.log(`[magpie-gateway] admin (mgmt) plane listening on http://${config.mgmt.host}:${port}`);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig,
  keyStore: KeyStore,
  jobSockets: JobSocketManager,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Defense-in-depth: reject non-loopback callers even though this
    // listener should only ever be bound to 127.0.0.1 (see module doc
    // comment). Checked before auth so a network-position attacker can't
    // even brute-force the master key from off-host.
    if (!isLoopbackRequest(req)) {
      sendJsonError(res, 403, "management plane is loopback-only", "forbidden");
      return;
    }

    if (!isAuthorized(req, config.secrets.masterKey)) {
      sendJsonError(res, 401, "missing or invalid master key", "unauthorized");
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/keys") {
      await handleMintKey(req, res, keyStore, jobSockets);
      return;
    }

    const revokeMatch = /^\/admin\/keys\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && revokeMatch) {
      const id = decodeURIComponent(revokeMatch[1]);
      keyStore.revoke(id); // idempotent by contract — no existence check needed.
      await jobSockets.teardown(id); // also idempotent by contract — see job-sockets.ts.
      res.writeHead(204);
      res.end();
      return;
    }

    sendJsonError(res, 404, "not found", "not_found");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[magpie-gateway] admin request error: ${message}`);
    if (!res.headersSent) {
      sendJsonError(res, 500, "internal server error", "internal_error");
    }
  }
}

async function handleMintKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  keyStore: KeyStore,
  jobSockets: JobSocketManager,
): Promise<void> {
  let raw: unknown;
  try {
    const buf = await readBody(req);
    raw = JSON.parse(buf.toString("utf-8"));
  } catch {
    sendJsonError(res, 400, "invalid JSON body", "invalid_request_error");
    return;
  }

  const parsed = mintKeyBodySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    sendJsonError(res, 400, `invalid request body: ${detail}`, "invalid_request_error");
    return;
  }

  const { jobId, model, budgetUsd, ttlSeconds } = parsed.data;
  const { id, key } = keyStore.mint({ model, budgetUsd, ttlSeconds });

  // The key and its socket must be provisioned together: a key with no
  // reachable socket is useless to the reviewer, and a socket for a key we
  // failed to hand out would leak. If binding fails, revoke the just-minted
  // key before reporting the failure — never respond 201 with a key whose
  // socket doesn't exist.
  try {
    const { socketDir } = await jobSockets.bind({ id, jobId });
    sendJson(res, 201, { id, key, socketDir });
  } catch (err) {
    keyStore.revoke(id);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[magpie-gateway] failed to bind per-job proxy socket for key id=${id}: ${message}`);
    sendJsonError(res, 500, "failed to provision per-job proxy socket", "socket_bind_failed");
  }
}
