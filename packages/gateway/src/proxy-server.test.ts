import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { createKeyStore, type KeyStore } from "./keystore.js";
import { createProxyServer, type ProxyServer } from "./proxy-server.js";

const REAL_KEY = "REAL_OPENROUTER_KEY_SENTINEL";

/** A minimal stub "OpenRouter" upstream: records every request it receives and replies per a caller-supplied handler. */
interface StubUpstream {
  baseUrl: string;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: unknown }>;
  close(): Promise<void>;
}

async function startStubUpstream(
  handler: (body: unknown, res: http.ServerResponse) => void,
): Promise<StubUpstream> {
  const requests: StubUpstream["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
      requests.push({ headers: req.headers, body });
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function testConfig(upstreamBaseUrl: string, defaultModel?: string): GatewayConfig {
  return {
    proxy: { host: "127.0.0.1", port: 0 },
    mgmt: { host: "127.0.0.1", port: 0 },
    upstream: { baseUrl: upstreamBaseUrl },
    defaultModel,
    secrets: { openrouterKey: REAL_KEY, masterKey: "unused-in-proxy-tests" },
  };
}

let running: { proxy: ProxyServer; upstream: StubUpstream } | undefined;

async function start(
  handler: (body: unknown, res: http.ServerResponse) => void,
  opts: { keyStore?: KeyStore; defaultModel?: string } = {},
): Promise<{ baseUrl: string; keyStore: KeyStore; upstream: StubUpstream }> {
  const upstream = await startStubUpstream(handler);
  const keyStore = opts.keyStore ?? createKeyStore();
  const proxy = createProxyServer(testConfig(upstream.baseUrl, opts.defaultModel), keyStore);
  await proxy.listen();
  running = { proxy, upstream };
  const { port } = proxy.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, keyStore, upstream };
}

afterEach(async () => {
  if (running) {
    await running.proxy.close();
    await running.upstream.close();
    running = undefined;
  }
});

describe("createProxyServer", () => {
  it("GET /healthz is 200 and unauthenticated", async () => {
    const { baseUrl } = await start(() => {
      throw new Error("upstream should not be called for /healthz");
    });
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects a chat-completions request with no Authorization header", async () => {
    const { baseUrl } = await start(() => {
      throw new Error("upstream should not be called");
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_api_key");
  });

  it("rejects an unknown virtual key", async () => {
    const { baseUrl } = await start(() => {
      throw new Error("upstream should not be called");
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-magpie-nope" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request once the key's spend has reached its budget (402, no upstream call)", async () => {
    let upstreamCalled = false;
    const { baseUrl, keyStore } = await start(() => {
      upstreamCalled = true;
    });
    const { key, id } = keyStore.mint({ budgetUsd: 0.01, ttlSeconds: 60 });
    keyStore.recordSpend(id, 0.02); // already over budget

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("budget_exceeded");
    expect(upstreamCalled).toBe(false);
  });

  it("mint -> use (non-streaming): forwards to upstream with the REAL key injected, returns the completion, and debits spend from usage.cost", async () => {
    const { baseUrl, keyStore, upstream } = await start((_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-1",
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0021 },
        }),
      );
    });
    const { key, id } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "some/model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).choices[0].message.content).toBe("hello");

    // The client's virtual key must never reach upstream; the REAL key must.
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect((upstream.requests[0].body as { usage?: { include?: boolean } }).usage?.include).toBe(true);

    // The real key never leaks into the response the client sees.
    expect(text).not.toContain(REAL_KEY);

    expect(keyStore.findByKey(key)?.spentUsd).toBeCloseTo(0.0021, 8);
    void id;
  });

  it("mint -> use (streaming SSE): forwards immediately, passes the body through unchanged, and debits spend from the final usage chunk", async () => {
    const { baseUrl, keyStore, upstream } = await start((_body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, cost: 0.0055 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const { key } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "some/model", messages: [], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain(REAL_KEY);

    expect(upstream.requests[0].headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(keyStore.findByKey(key)?.spentUsd).toBeCloseTo(0.0055, 8);
  });

  it("scopes the request to the key's minted model, overriding whatever the client asked for", async () => {
    const { baseUrl, keyStore, upstream } = await start((_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [], usage: { cost: 0.001 } }));
    });
    const { key } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60, model: "scoped/model" });

    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "client-requested/model", messages: [] }),
    });

    expect((upstream.requests[0].body as { model?: string }).model).toBe("scoped/model");
  });

  it("does not charge the key when upstream returns an error status", async () => {
    const { baseUrl, keyStore } = await start((_body, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const { key } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(429);
    expect(keyStore.findByKey(key)?.spentUsd).toBe(0);
  });
});
