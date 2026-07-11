import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminServer } from "./admin-server.js";
import { createAdminServer } from "./admin-server.js";
import type { GatewayConfig } from "./config.js";
import { createKeyStore, type KeyStore } from "./keystore.js";

const MASTER_KEY = "test-master-key";

function testConfig(): GatewayConfig {
  return {
    proxy: { host: "127.0.0.1", port: 0 },
    mgmt: { host: "127.0.0.1", port: 0 },
    upstream: { baseUrl: "https://example.invalid/v1" },
    defaultModel: undefined,
    secrets: { openrouterKey: "REAL_OPENROUTER_KEY_SENTINEL", masterKey: MASTER_KEY },
  };
}

let running: AdminServer | undefined;

async function start(keyStore: KeyStore = createKeyStore()): Promise<{ baseUrl: string; keyStore: KeyStore }> {
  const server = createAdminServer(testConfig(), keyStore);
  await server.listen();
  running = server;
  const { port } = server.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, keyStore };
}

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
});

describe("createAdminServer", () => {
  it("binds only to 127.0.0.1, never 0.0.0.0", async () => {
    const { keyStore } = await start();
    const address = running!.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    void keyStore;
  });

  it("rejects POST /admin/keys with no Authorization header", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetUsd: 1, ttlSeconds: 60 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects POST /admin/keys with the wrong master key", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
      body: JSON.stringify({ budgetUsd: 1, ttlSeconds: 60 }),
    });
    expect(res.status).toBe(401);
  });

  it("mints a key given the correct master key and a valid body", async () => {
    const { baseUrl, keyStore } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ budgetUsd: 2.5, ttlSeconds: 300, model: "anthropic/claude-sonnet-4.5" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; key: string };
    expect(body.key.startsWith("sk-magpie-")).toBe(true);
    expect(typeof body.id).toBe("string");

    const entry = keyStore.findByKey(body.key);
    expect(entry?.budgetUsd).toBe(2.5);
    expect(entry?.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("rejects a mint request with an invalid body (missing budgetUsd)", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ ttlSeconds: 60 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a mint request with a non-JSON body", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /admin/keys/:id revokes a real key, and the key stops working", async () => {
    const { baseUrl, keyStore } = await start();
    const { id, key } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });
    expect(keyStore.findByKey(key)).toBeDefined();

    const res = await fetch(`${baseUrl}/admin/keys/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(204);
    expect(keyStore.findByKey(key)).toBeUndefined();
  });

  it("DELETE /admin/keys/:id is idempotent for an unknown id (200/204, not an error)", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys/does-not-exist`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(204);
  });

  it("DELETE also requires the master key", async () => {
    const { baseUrl, keyStore } = await start();
    const { id } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });
    const res = await fetch(`${baseUrl}/admin/keys/${id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("404s on an unrecognized route", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/whatever`, {
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it("never echoes the real OpenRouter key or the master key back in any response body", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ budgetUsd: 1, ttlSeconds: 60 }),
    });
    const text = await res.text();
    expect(text).not.toContain("REAL_OPENROUTER_KEY_SENTINEL");
    expect(text).not.toContain(MASTER_KEY);
  });
});
