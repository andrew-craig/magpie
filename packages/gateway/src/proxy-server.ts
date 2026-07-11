// Proxy plane (data) for the magpie gateway: the OpenAI-compatible surface
// the review container's Pi process actually talks to (via `OPENAI_BASE_URL`
// pointed at this server — see docker/reviewer/entrypoint.sh's contract
// notes and M4-B/M4-D, which wire that up; this module only builds the
// gateway side).
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

/** A running (or ready-to-run) proxy server. Mirrors server.ts's `WebhookServer` shape/lifecycle. */
export interface ProxyServer {
  readonly server: http.Server;
  listen(): Promise<void>;
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
 * Build the proxy-plane HTTP server.
 *
 * Routes:
 *  - `GET  /healthz`             — unauthenticated, always 200 "ok" (M4-E's gateway-reachable probe).
 *  - `POST /v1/chat/completions` — OpenAI-compatible; requires `Authorization: Bearer <virtual key>`.
 *  - anything else               — 404.
 *
 * The returned server is not listening yet; call {@link ProxyServer.listen}.
 * Binding uses `config.proxy.host`/`config.proxy.port` (never "0.0.0.0" —
 * enforced by config.ts's loader).
 */
export function createProxyServer(config: GatewayConfig, keyStore: KeyStore, deps: ProxyServerDeps = {}): ProxyServer {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const server = http.createServer((req, res) => {
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
  });

  return {
    server,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(config.proxy.port, config.proxy.host, () => {
          server.removeListener("error", onError);
          const address = server.address();
          const port = address && typeof address === "object" ? address.port : config.proxy.port;
          console.log(`[magpie-gateway] proxy (data) plane listening on http://${config.proxy.host}:${port}`);
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

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig,
  keyStore: KeyStore,
  fetchImpl: FetchLike,
): Promise<void> {
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
      });
    } catch (err) {
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[magpie-gateway] proxy request error: ${message}`);
    if (!res.headersSent) {
      sendJsonError(res, 500, "internal server error", "internal_error");
    } else {
      res.end();
    }
  }
}
