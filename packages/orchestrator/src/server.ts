// Webhook receiver for the magpie orchestrator.
//
// This module owns the *edge* of the system: it accepts GitHub App webhook
// deliveries on localhost, verifies their authenticity, and re-emits the
// verified `pull_request` events onto a handler seam that later stages
// (filtering, queueing, reviewing) subscribe to. It deliberately does NOT
// filter, queue, or otherwise act on payloads — it is only the receiver.
//
// Security note (see PLAN.md threat model / CLAUDE.md capability separation):
// signature verification MUST happen before any payload parsing or handler
// dispatch. We delegate that to `@octokit/webhooks`, which reads the RAW
// request body and performs a constant-time comparison of the
// `X-Hub-Signature-256` header against HMAC-SHA256(body, webhookSecret).
// Deliveries with a missing/invalid signature are rejected with 400 by the
// middleware and never reach our `onPullRequest` seam. For this to hold, the
// raw body must reach the verifier untouched — hence we mount
// `createNodeMiddleware` directly on a `node:http` server and never place a
// JSON body parser in front of it.

import * as http from "node:http";
import {
  Webhooks,
  createNodeMiddleware,
  type EmitterWebhookEvent,
} from "@octokit/webhooks";
import type { Config } from "./config.js";

/** Path (relative to the server root) that GitHub webhook deliveries POST to. */
export const WEBHOOK_PATH = "/webhook";

/** Path of the liveness probe endpoint. */
export const HEALTHZ_PATH = "/healthz";

/**
 * A verified `pull_request` webhook delivery, exactly as surfaced by
 * `@octokit/webhooks`. Only deliveries whose signature verified against the
 * configured webhook secret are ever emitted with this type.
 */
export type PullRequestEvent = EmitterWebhookEvent<"pull_request">;

/**
 * Callback invoked once for every authenticated `pull_request` delivery.
 * This is the seam a later filtering/queueing task subscribes to. It is only
 * ever called with signature-verified payloads.
 */
export type OnPullRequest = (event: PullRequestEvent) => void;

/**
 * A running (or ready-to-run) webhook server. `listen()` and `close()` are
 * promisified wrappers over the underlying `node:http` server so callers can
 * `await` startup/shutdown — which also makes the server easy to drive from a
 * test on an ephemeral port (`server.address()` yields the bound port).
 */
export interface WebhookServer {
  /** The underlying HTTP server (exposed for tests and lifecycle control). */
  readonly server: http.Server;
  /** Begin listening on the configured host/port. Resolves once bound. */
  listen(): Promise<void>;
  /** Stop listening and release the port. Resolves once fully closed. */
  close(): Promise<void>;
}

/**
 * Build a webhook server that verifies GitHub App deliveries and forwards
 * authenticated `pull_request` events to `onPullRequest`.
 *
 * The returned object is not listening yet; call {@link WebhookServer.listen}.
 * Binding uses `config.server.host` / `config.server.port`; pass a port of `0`
 * to bind an ephemeral port (useful in tests — read the real port back off
 * `server.address()` after `listen()` resolves).
 *
 * Routes:
 *  - `POST {WEBHOOK_PATH}`  — GitHub webhook sink (signature-verified).
 *  - `GET  {HEALTHZ_PATH}`  — liveness probe, always `200`.
 *  - anything else          — `404`.
 *
 * @param config       Loaded orchestrator config; `secrets.webhookSecret`
 *                     keys signature verification and `server.{host,port}`
 *                     the bind address.
 * @param onPullRequest Seam invoked with every verified `pull_request` event.
 * @returns A {@link WebhookServer} handle.
 */
export function createWebhookServer(
  config: Config,
  onPullRequest: OnPullRequest,
): WebhookServer {
  const webhooks = new Webhooks({ secret: config.secrets.webhookSecret });

  // Re-emit verified pull_request deliveries onto the caller's seam. Because
  // @octokit/webhooks only dispatches to `.on(...)` handlers *after* the
  // signature has verified, anything reaching here is authenticated.
  webhooks.on("pull_request", (event) => {
    onPullRequest(event);
  });

  // Surface verification/handler failures. Bad signatures are turned into an
  // error here (and a 400 to the client) and never reach the seam above.
  webhooks.onError((error) => {
    console.error(
      `[magpie] webhook error (${error.name}): ${error.message}`,
    );
  });

  const middleware = createNodeMiddleware(webhooks, { path: WEBHOOK_PATH });

  const server = http.createServer((req, res) => {
    // Liveness probe: answered directly, never touches the verifier.
    if (req.method === "GET" && req.url === HEALTHZ_PATH) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    // Everything else is offered to the webhook middleware. When the request
    // path is not WEBHOOK_PATH the middleware invokes our `next` callback
    // (and does not touch the response), so we answer 404 there. Verified
    // POST /webhook deliveries are handled entirely by the middleware.
    middleware(req, res, () => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[magpie] unhandled webhook middleware error: ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal server error");
      }
    });
  });

  return {
    server,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(config.server.port, config.server.host, () => {
          server.removeListener("error", onError);
          const address = server.address();
          const port =
            address && typeof address === "object" ? address.port : config.server.port;
          console.log(
            `[magpie] webhook server listening on http://${config.server.host}:${port}${WEBHOOK_PATH}`,
          );
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
