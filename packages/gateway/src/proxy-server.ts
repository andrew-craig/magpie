// Proxy plane (data) for the magpie gateway: the OpenAI-compatible surface
// the review container's Pi process actually talks to (via `OPENAI_BASE_URL`
// pointed at the in-container TCP->unix forwarder, which relays to this
// server's per-job unix socket — see DISTRIBUTION.md §2.6 and
// job-sockets.ts's `JobSocketManager`, which binds one instance of the
// server built here per job; this module only builds the request-handling
// logic, not the per-job listen/bind lifecycle).
//
// Per request: authenticate the virtual key -> check its budget -> strip the
// client's Authorization and inject the REAL OpenRouter key -> forward to
// upstream -> stream the response back untouched -> record spend from
// whatever usage/cost the upstream response carried (see upstream.ts's
// `determineCost`, which never lets a parsing failure zero out the charge).
//
// SECURITY: `config.secrets.openrouterKey` is set on the outbound request's
// Authorization header ONLY — it is never read from, echoed into, or logged
// alongside anything derived from the incoming request. The incoming
// request's own Authorization header (the client's virtual key) is likewise
// never forwarded upstream or logged in full (see console.error below, which
// logs only the key's opaque `id`, never the raw token). A caller cannot
// observe the real key through any response this module produces: on every
// path (success, upstream error, network failure) the body this module
// writes back is either the untouched upstream body or a JSON error object
// this module constructs itself from constants — never anything containing
// `config.secrets.openrouterKey`.

import * as http from "node:http";
import type { GatewayConfig } from "./config.js";
import { extractBearerToken, readBody, sendJsonError } from "./http-util.js";
import type { KeyStore } from "./keystore.js";
import { determineCost } from "./upstream.js";

/** Injectable seam so tests point the gateway at a local stub server instead of real OpenRouter — mirrors reviewer.ts's `piBinary` override pattern (see that module's `RunReviewParams.piBinary` doc comment). Production callers leave this undefined. */
export type FetchLike = typeof fetch;

export interface ProxyServerDeps {
  fetchImpl?: FetchLike;
}

/**
 * A running (or ready-to-run) proxy server. Mirrors server.ts's
 * `WebhookServer` shape/lifecycle, except {@link listen} takes an explicit
 * bind target rather than reading one off `config` — Design D moved the
 * proxy plane to per-job unix sockets, so there is no longer a single
 * config-wide host/port to bind (see config.ts's `GatewayConfig` doc
 * comment). `job-sockets.ts`'s `JobSocketManager` is the production caller,
 * `listen()`ing each instance on that job's `gw.sock` path; tests may
 * instead `listen()` on an ephemeral TCP port for convenience (nothing in
 * the handler itself is transport-specific).
 */
export interface ProxyServer {
  readonly server: http.Server;
  /**
   * Bind and start accepting connections. Pass a filesystem path (unix
   * socket — production usage) or a TCP `{ port, host }` pair (defaults to
   * an OS-assigned loopback port — test usage only; production never binds
   * TCP for this plane).
   */
  listen(target?: string | { port: number; host?: string }): Promise<void>;
  close(): Promise<void>;
}

const HEALTHZ_PATH = "/healthz";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Joins `baseUrl` (with or without a trailing slash) + `/chat/completions`. */
function upstreamChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Build the proxy-plane request listener (routing only — no `listen`/bind).
 * Exported separately from {@link createProxyServer} so `job-sockets.ts`'s
 * `JobSocketManager` can mount the exact same handler on however many
 * per-job `http.Server`s it needs, rather than being forced through
 * `ProxyServer`'s single-server lifecycle.
 *
 * Routes:
 *  - `GET  /healthz`             — unauthenticated, always 200 "ok" (M4-E's gateway-reachable probe; the reviewer entrypoint health-probes this THROUGH the per-job socket before starting Pi).
 *  - `POST /v1/chat/completions` — OpenAI-compatible; requires `Authorization: Bearer <virtual key>`.
 *  - anything else               — 404.
 */
export function createProxyRequestListener(
  config: GatewayConfig,
  keyStore: KeyStore,
  deps: ProxyServerDeps = {},
): http.RequestListener {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return (req, res) => {
    if (req.method === "GET" && req.url === HEALTHZ_PATH) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url === CHAT_COMPLETIONS_PATH) {
      void handleChatCompletions(req, res, config, keyStore, fetchImpl);
      return;
    }

    sendJsonError(res, 404, "not found", "not_found");
  };
}

/**
 * Thin `http.Server` factory wrapping {@link createProxyRequestListener} —
 * kept for reuse by both `job-sockets.ts` (which calls `listen()` with a
 * unix socket path per job) and this package's own tests (which call
 * `listen()` with no argument / a `{ port }` for a plain TCP loopback
 * listener, since the handler logic itself doesn't care about transport).
 */
export function createProxyServer(config: GatewayConfig, keyStore: KeyStore, deps: ProxyServerDeps = {}): ProxyServer {
  const server = http.createServer(createProxyRequestListener(config, keyStore, deps));

  return {
    server,
    listen(target?: string | { port: number; host?: string }): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolve();
        };
        if (typeof target === "string") {
          server.listen(target, onListening);
        } else {
          server.listen(target?.port ?? 0, target?.host ?? "127.0.0.1", onListening);
        }
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig,
  keyStore: KeyStore,
  fetchImpl: FetchLike,
): Promise<void> {
  // If the client (the review container) goes away before we've finished
  // relaying the response, abort the upstream request too — otherwise the
  // gateway would keep pulling (and paying OpenRouter for) tokens nobody is
  // reading, quietly burning the key's budget. Bind to the RESPONSE stream's
  // `close`, not the request's: `req` 'close' fires as soon as the request
  // body is fully read (well before the response is done), which would abort
  // every call prematurely, whereas `res` 'close' fires on response
  // completion OR a premature client disconnect — aborting after the fetch
  // has already settled is a harmless no-op, so binding it is always safe.
  const abortController = new AbortController();
  res.on("close", () => abortController.abort());

  try {
    const token = extractBearerToken(req);
    if (!token) {
      sendJsonError(res, 401, "missing API key (Authorization: Bearer <key>)", "invalid_api_key");
      return;
    }

    const entry = keyStore.findByKey(token);
    if (!entry) {
      sendJsonError(res, 401, "invalid or expired API key", "invalid_api_key");
      return;
    }

    if (keyStore.isOverBudget(entry)) {
      sendJsonError(res, 402, "budget exhausted for this key", "budget_exceeded");
      return;
    }

    let raw: unknown;
    try {
      const buf = await readBody(req);
      raw = JSON.parse(buf.toString("utf-8"));
    } catch {
      sendJsonError(res, 400, "invalid JSON body", "invalid_request_error");
      return;
    }
    if (!isRecord(raw)) {
      sendJsonError(res, 400, "request body must be a JSON object", "invalid_request_error");
      return;
    }

    const outboundBody: Record<string, unknown> = { ...raw };
    const isStream = outboundBody.stream === true;

    // Always ask OpenRouter for usage/cost accounting, streaming or not —
    // this is what determineCost() (upstream.ts) relies on for the common
    // "usage.cost" path. See that module's doc comment.
    const existingUsage = isRecord(outboundBody.usage) ? outboundBody.usage : {};
    outboundBody.usage = { ...existingUsage, include: true };

    // Per-key model scope: if the key was minted with a `model`, it wins
    // over whatever the client asked for — this is what makes "scoped to
    // model X" on mint an actual enforcement rather than a hint. Falls back
    // to the gateway's configured default model if neither the key nor the
    // client specified one.
    if (entry.model) {
      outboundBody.model = entry.model;
    } else if (typeof outboundBody.model !== "string" && config.defaultModel) {
      outboundBody.model = config.defaultModel;
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetchImpl(upstreamChatCompletionsUrl(config.upstream.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The ONE place the real key is used — set on the OUTBOUND request
          // only, never derived from or echoed back into anything the client
          // sees. See module doc comment's SECURITY note.
          authorization: `Bearer ${config.secrets.openrouterKey}`,
        },
        body: JSON.stringify(outboundBody),
        // Cancel the upstream call if the client disconnects (see the
        // AbortController set up at the top of this function).
        signal: abortController.signal,
      });
    } catch (err) {
      // A client that disconnected before we even reached upstream aborted
      // this fetch — that's an expected client-side outcome, not a gateway
      // fault, so don't log it as an upstream failure or try to write a
      // response to a socket that's already gone.
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[magpie-gateway] upstream request failed for key id=${entry.id}: ${message}`);
      sendJsonError(res, 502, "upstream request failed", "upstream_error");
      return;
    }

    const contentType = upstreamRes.headers.get("content-type") ?? (isStream ? "text/event-stream" : "application/json");
    res.writeHead(upstreamRes.status, { "content-type": contentType });

    // Stream the upstream body straight back to the client, chunk by chunk,
    // rather than buffering it all before writing anything — required for
    // both a good streaming UX and per the M4-A task contract. We ALSO
    // accumulate the decoded text alongside forwarding it (not instead of),
    // purely so determineCost() has something to parse once the body ends;
    // this does not delay a single byte reaching the client.
    let accumulated = "";
    if (upstreamRes.body) {
      const decoder = new TextDecoder();
      for await (const chunk of upstreamRes.body as AsyncIterable<Uint8Array>) {
        res.write(Buffer.from(chunk));
        accumulated += decoder.decode(chunk, { stream: true });
      }
      accumulated += decoder.decode();
    }
    res.end();

    // Only charge for genuinely successful completions — an upstream error
    // (bad request, rate limit, etc.) produced no billable tokens, so
    // nothing is debited from the key's budget for it.
    if (upstreamRes.ok) {
      const { costUsd, source } = determineCost(accumulated, isStream);
      keyStore.recordSpend(entry.id, costUsd);
      if (source !== "usage.cost") {
        console.warn(
          `[magpie-gateway] cost accounting fell back to ${source} for key id=${entry.id} (charged $${costUsd.toFixed(4)}) — upstream response did not carry a parseable usage.cost`,
        );
      }
    }
  } catch (err) {
    // A client disconnect mid-stream aborts the upstream body iteration with
    // an AbortError (see the AbortController above). The client is already
    // gone, so there is nothing to report and no socket left to write to —
    // treat it as an expected end, not an internal error.
    if (err instanceof Error && err.name === "AbortError") return;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[magpie-gateway] proxy request error: ${message}`);
    if (!res.headersSent) {
      sendJsonError(res, 500, "internal server error", "internal_error");
    } else {
      res.end();
    }
  }
}
