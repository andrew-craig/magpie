#!/usr/bin/env node
// M7-0 spike: run the REAL compiled gateway proxy-plane server
// (packages/gateway/dist/proxy-server.js), but bind it to a UNIX DOMAIN
// SOCKET instead of a TCP host:port, and stub the upstream OpenRouter call
// (via the `fetchImpl` seam `createProxyServer` already exposes for tests)
// so this spike spends zero real tokens and needs no real API key.
//
// Usage: node gateway-on-socket.mjs <socketPath>
//
// Prints, to stdout, lines run-spike.sh greps for:
//   VKEY=sk-magpie-...
//   SOCKET=<socketPath>
//   GATEWAY_READY
//
// Everything else (request logging, upstream-stub logging) goes to stdout
// too, prefixed `[gateway-on-socket]`, so run-spike.sh's captured log proves
// traffic actually transited the socket.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayDist = path.resolve(here, "../../packages/gateway/dist");

const { loadGatewayConfig } = await import(path.join(gatewayDist, "config.js"));
const { createKeyStore } = await import(path.join(gatewayDist, "keystore.js"));
const { createProxyServer } = await import(path.join(gatewayDist, "proxy-server.js"));

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("usage: node gateway-on-socket.mjs <socketPath>");
  process.exit(2);
}

// Dummy secrets: this process's config.secrets.openrouterKey is only ever
// used as the Authorization header VALUE on the outbound fetch — and the
// stub fetchImpl below never makes a real network call, so its value is
// inert. GATEWAY_UPSTREAM_BASE_URL is likewise never actually dialed for the
// same reason; kept as an obviously-fake host so a bug that bypassed the stub
// would fail loudly (DNS error) rather than silently reaching the real API.
const config = loadGatewayConfig({
  MAGPIE_GATEWAY_OPENROUTER_KEY: "sk-or-v1-SPIKE-NOT-A-REAL-KEY",
  MAGPIE_GATEWAY_MASTER_KEY: "spike-master-key-unused",
  GATEWAY_PROXY_HOST: "127.0.0.1", // unused once we call server.listen(socketPath) ourselves
  GATEWAY_PROXY_PORT: "4000", // unused, ditto
  GATEWAY_UPSTREAM_BASE_URL: "https://upstream-stub.invalid/api/v1",
});

const keyStore = createKeyStore();
const { id: keyId, key: vkey } = keyStore.mint({
  budgetUsd: 0.5,
  ttlSeconds: 600,
});
console.log(`[gateway-on-socket] minted virtual key id=${keyId} (prefix check: ${vkey.startsWith("sk-magpie-")})`);

let requestCount = 0;

/**
 * Stub upstream `fetch` — stands in for the real OpenRouter call per the
 * spike brief ("gateway->OpenRouter leg is UNCHANGED from M4 and already
 * proven in production, so STUB the upstream"). Returns a valid
 * OpenAI/OpenRouter-shaped chat-completion, non-streaming or a minimal SSE
 * stream depending on what the inbound request asked for, WITH a
 * `usage.cost` field so proxy-server.ts's determineCost() takes the real
 * `usage.cost` path (not a fallback).
 */
async function stubFetch(url, init) {
  let parsedBody = {};
  try {
    parsedBody = init?.body ? JSON.parse(init.body.toString()) : {};
  } catch {
    // fall through with {} -- proxy-server.ts already validated the inbound
    // body is JSON before it ever reaches here, so this shouldn't happen.
  }
  const wantsStream = parsedBody.stream === true;
  console.log(
    `[gateway-on-socket] [stub-upstream] would-be POST ${url} model=${parsedBody.model ?? "(unset)"} stream=${wantsStream}`,
  );

  if (wantsStream) {
    const chunks = [
      `data: ${JSON.stringify({
        id: "spike-stub-1",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: parsedBody.model ?? "spike-stub-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "Spike stub reply: no findings." }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "spike-stub-1",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: parsedBody.model ?? "spike-stub-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50, cost: 0.0002 },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    return new Response(chunks.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  const json = {
    id: "spike-stub-1",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: parsedBody.model ?? "spike-stub-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Spike stub reply: no findings (M7-0 transport spike, stubbed upstream)." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50, cost: 0.0002 },
  };
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const proxy = createProxyServer(config, keyStore, { fetchImpl: stubFetch });

// Log every inbound request (method + url), independent of the response
// createProxyServer's own handler produces -- proves traffic actually
// transited the unix socket, which is the whole point of this spike.
// Adding a second 'request' listener alongside http.createServer's own
// (registered internally by createProxyServer) is safe: node invokes every
// listener, and this one never touches `res`.
proxy.server.on("request", (req) => {
  requestCount += 1;
  console.log(`[gateway-on-socket] [socket-request #${requestCount}] ${req.method} ${req.url} from (unix socket, no remote addr)`);
});

// Bind to the UNIX SOCKET ourselves -- deliberately NOT calling
// `proxy.listen()` (that binds `config.proxy.host:port`, i.e. TCP). Per
// DISTRIBUTION.md §2.6, a stale socket file from a previous run must be
// removed before bind (EADDRINUSE otherwise); the job dir itself is expected
// to already exist (created by run-spike.sh) so this never creates a
// root-owned directory.
if (fs.existsSync(socketPath)) {
  fs.unlinkSync(socketPath);
}

proxy.server.listen(socketPath, () => {
  // Per DISTRIBUTION.md §2.6: explicit chmod after bind, not umask-dependent
  // -- connect() needs write on the socket inode, and the reviewer shares
  // neither owner nor group with the gateway in the real design (here,
  // spike-simplified: same host user runs both sides, but we chmod anyway to
  // mirror production and prove the step works).
  fs.chmodSync(socketPath, 0o666);
  console.log(`SOCKET=${socketPath}`);
  console.log(`VKEY=${vkey}`);
  console.log("GATEWAY_READY");
});

proxy.server.on("error", (err) => {
  console.error(`[gateway-on-socket] server error: ${err.message}`);
  process.exit(1);
});

function shutdown() {
  console.log("[gateway-on-socket] shutting down");
  proxy.server.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // already gone
    }
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
