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
//
// M8-D2 (task_92d7) note on `/healthz`'s tier field: the CTO's hard
// constraint is that the ACTIVE ISOLATION TIER is operator-facing
// information ONLY — a prospective attacker crafting a malicious PR must
// never be able to learn, pre-submission, whether the target runs the
// weaker crun floor (see docs/design/cto-decision-brief.md §8's reversal and
// publisher.ts's `FORBIDDEN_TIER_STRINGS` guard test, which asserts this
// data never reaches the published PR review). `/healthz` is a SEPARATE,
// deliberately different-audience surface from the PR review: it answers on
// whatever address `config.server.host` binds (loopback/private network per
// the deployment model — see DISTRIBUTION.md), is meant for the operator's
// own monitoring/`curl`, and is never shown to a PR author or embedded in
// GitHub in any form. Surfacing the tier there is exactly what task_92d7
// asks for ("operator logs and /healthz, never the PR").

import * as http from "node:http";
import {
  Webhooks,
  createNodeMiddleware,
  type EmitterWebhookEvent,
} from "@octokit/webhooks";
import type { Config } from "./config.js";
import type { Tier, TierSelectionResult } from "./tier-ladder.js";

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
 * A verified `issue_comment` webhook delivery, exactly as surfaced by
 * `@octokit/webhooks`. Only deliveries whose signature verified against the
 * configured webhook secret are ever emitted with this type. Fires for
 * comments on both issues and PRs — comment-command.ts (M6-A) is responsible
 * for filtering down to PR comments carrying the `@magpie review` command.
 */
export type IssueCommentEvent = EmitterWebhookEvent<"issue_comment">;

/**
 * Callback invoked once for every authenticated `issue_comment` delivery.
 * This is the seam comment-command.ts subscribes to (mirrors `OnPullRequest`
 * above). It is only ever called with signature-verified payloads.
 */
export type OnIssueComment = (event: IssueCommentEvent) => void;

/**
 * The `/healthz` projection of one runtime detail this module has no other
 * knowledge of: which isolation tier is actually launching review jobs (see
 * tier-ladder.ts's `resolveTier`/`TierSelectionResult`). This is a DELIBERATE,
 * NARROW, hand-picked subset of `TierSelectionResult` — not the whole object
 * — for two reasons: (1) `TierSelectionResult.reasons` is documented as a
 * free-text, LOG-ONLY audit trail (see that field's doc comment) and has no
 * business being echoed back over HTTP even to an operator, and (2) keeping
 * this shape explicit means a future field added to `TierSelectionResult`
 * doesn't silently start appearing on `/healthz` just because someone passed
 * the whole object through — it has to be deliberately added here. See
 * {@link buildHealthzTierSnapshot} for the one place this projection happens.
 */
export interface HealthzTierSnapshot {
  /** The tier actually launching jobs right now — see `TierSelectionResult.resolvedTier`. */
  resolvedTier: Tier;
  /** What `config.container.tier` asked for — lets an operator spot a degradation at a glance. */
  requestedTier: Tier;
  /** `true` iff running weaker than requested (always operator-acknowledged when true — see tier-ladder.ts). */
  degraded: boolean;
  /** The parsed `MAGPIE_ACK_TIER` value, or `null` if unset. */
  acknowledgedTier: Tier | null;
  /** Whether `KVM_CREATE_VM` succeeded on this host — the micro-VM tier's hard prerequisite. */
  kvmAvailable: boolean;
  /** Presence/version of the crun-floor's container runtime CLI (docker/podman). */
  crunRuntime: { present: boolean; binary: string; version?: string };
  /** Presence/version of the micro-VM tier's `magpie-krun-launch` launcher binary. */
  microvmLauncher: { present: boolean; binary: string; version?: string };
}

/**
 * Project a full {@link TierSelectionResult} (as produced by tier-ladder.ts's
 * `resolveTier` and threaded through from index.ts) down to the narrow
 * {@link HealthzTierSnapshot} shape `/healthz` actually serves. Pure and
 * exported so index.test.ts / server.test.ts can assert the projection
 * directly, independent of a real probe run.
 */
export function buildHealthzTierSnapshot(result: TierSelectionResult): HealthzTierSnapshot {
  return {
    resolvedTier: result.resolvedTier,
    requestedTier: result.requestedTier,
    degraded: result.degraded,
    acknowledgedTier: result.acknowledgedTier,
    kvmAvailable: result.probe.kvm.available,
    crunRuntime: {
      present: result.probe.crunRuntime.present,
      binary: result.probe.crunRuntime.binary,
      version: result.probe.crunRuntime.version,
    },
    microvmLauncher: {
      present: result.probe.microvmLauncher.present,
      binary: result.probe.microvmLauncher.binary,
      version: result.probe.microvmLauncher.version,
    },
  };
}

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
 *  - `GET  {HEALTHZ_PATH}`  — liveness probe, always `200`. Unauthenticated
 *    and unconditionally `200` DELIBERATELY (M8-D2 / task_92d7) — this is a
 *    liveness probe, not a health gate: a degraded isolation tier is still a
 *    running, job-processing service (see tier-ladder.ts — a degradation
 *    that shouldn't even start already fails closed at startup via
 *    `resolveTier` throwing; anything that reaches this handler at all is,
 *    by construction, in a state `resolveTier` already accepted), so
 *    reflecting `degraded` into the HTTP status would make an orchestrator
 *    supervisor (systemd, a container healthcheck, ...) restart-loop a
 *    perfectly-running-but-degraded deployment for no benefit.
 *  - anything else          — `404`.
 *
 * @param config       Loaded orchestrator config; `secrets.webhookSecret`
 *                     keys signature verification and `server.{host,port}`
 *                     the bind address.
 * @param onPullRequest Seam invoked with every verified `pull_request` event.
 * @param tierSnapshot The `/healthz` tier projection (see
 *                     {@link buildHealthzTierSnapshot}) — index.ts builds
 *                     this once from `resolveTier`'s result at startup and
 *                     passes it straight through; it never changes for the
 *                     lifetime of one process (the ladder is resolved once
 *                     at startup, not re-probed per request — see
 *                     tier-ladder.ts's module doc comment).
 * @param onIssueComment Seam invoked with every verified `issue_comment`
 *                     event (M6-A, comment-command.ts's `@magpie review`
 *                     trigger). Optional and defaults to a no-op so existing
 *                     callers/tests that only care about `pull_request` need
 *                     no change.
 * @returns A {@link WebhookServer} handle.
 */
export function createWebhookServer(
  config: Config,
  onPullRequest: OnPullRequest,
  tierSnapshot: HealthzTierSnapshot,
  onIssueComment: OnIssueComment = () => {},
): WebhookServer {
  const webhooks = new Webhooks({ secret: config.secrets.webhookSecret });

  // Re-emit verified pull_request deliveries onto the caller's seam. Because
  // @octokit/webhooks only dispatches to `.on(...)` handlers *after* the
  // signature has verified, anything reaching here is authenticated.
  webhooks.on("pull_request", (event) => {
    onPullRequest(event);
  });

  // Re-emit verified issue_comment deliveries onto the caller's seam (M6-A).
  // Fires for comments on both issues and PRs; comment-command.ts is
  // responsible for filtering down to PR comments carrying the command.
  webhooks.on("issue_comment", (event) => {
    onIssueComment(event);
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
    // Liveness probe: answered directly, never touches the verifier. Surfaces
    // the active isolation tier + probe evidence (M8-D2 / task_92d7) for
    // operator monitoring ONLY — see this module's doc comment and
    // HealthzTierSnapshot's doc comment for why this is deliberately a
    // narrow projection, and why `/healthz` is a categorically different,
    // operator-only audience from the published PR review (publisher.ts has
    // no access to this data at all — see its FORBIDDEN_TIER_STRINGS guard
    // test).
    if (req.method === "GET" && req.url === HEALTHZ_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tier: tierSnapshot }));
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
