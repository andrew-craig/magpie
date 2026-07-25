import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminServer } from "./admin-server.js";
import { createAdminServer } from "./admin-server.js";
import type { GatewayConfig } from "./config.js";
import { createJobSocketManager, type JobSocketManager } from "./job-sockets.js";
import { createKeyStore, type KeyStore } from "./keystore.js";

const MASTER_KEY = "test-master-key";

function testConfig(socketDirRoot: string): GatewayConfig {
  return {
    socketDirRoot,
    mgmt: { host: "127.0.0.1", port: 0 },
    upstream: { baseUrl: "https://example.invalid/v1" },
    defaultModel: undefined,
    secrets: { openrouterKey: "REAL_OPENROUTER_KEY_SENTINEL", masterKey: MASTER_KEY },
  };
}

let running: AdminServer | undefined;
let runningJobSockets: JobSocketManager | undefined;
let runningRoot: string | undefined;

async function start(keyStore: KeyStore = createKeyStore()): Promise<{ baseUrl: string; keyStore: KeyStore; jobSockets: JobSocketManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "magpie-gateway-admin-test-"));
  runningRoot = root;
  const config = testConfig(root);
  const jobSockets = createJobSocketManager(config, keyStore);
  runningJobSockets = jobSockets;
  const server = createAdminServer(config, keyStore, jobSockets);
  await server.listen();
  running = server;
  const { port } = server.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, keyStore, jobSockets };
}

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
  if (runningJobSockets) {
    await runningJobSockets.closeAll();
    runningJobSockets = undefined;
  }
  if (runningRoot) {
    await rm(runningRoot, { recursive: true, force: true });
    runningRoot = undefined;
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
      body: JSON.stringify({ jobId: "job-1", budgetUsd: 1, ttlSeconds: 60 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects POST /admin/keys with the wrong master key", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
      body: JSON.stringify({ jobId: "job-1", budgetUsd: 1, ttlSeconds: 60 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong master key that is the SAME length as the real one", async () => {
    // The constant-time comparison hashes both inputs to fixed-length digests
    // before comparing, so a same-length-but-wrong key must still be rejected
    // (guards against a comparison that only ever saw unequal-length inputs).
    const sameLenWrong = "x".repeat(MASTER_KEY.length);
    expect(sameLenWrong.length).toBe(MASTER_KEY.length);
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sameLenWrong}` },
      body: JSON.stringify({ jobId: "job-1", budgetUsd: 1, ttlSeconds: 60 }),
    });
    expect(res.status).toBe(401);
  });

  it("mints a key given the correct master key and a valid body, and binds its per-job socket", async () => {
    const { baseUrl, keyStore } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ jobId: "job-42", budgetUsd: 2.5, ttlSeconds: 300, model: "anthropic/claude-sonnet-4.5" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; key: string; socketDir: string };
    expect(body.key.startsWith("sk-magpie-")).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(body.socketDir).toBe(path.join(runningRoot!, "job-42"));

    const entry = keyStore.findByKey(body.key);
    expect(entry?.budgetUsd).toBe(2.5);
    expect(entry?.model).toBe("anthropic/claude-sonnet-4.5");

    const { stat } = await import("node:fs/promises");
    const socketStat = await stat(path.join(body.socketDir, "gw.sock"));
    expect(socketStat.isSocket()).toBe(true);
  });

  it("rejects a mint request with an invalid body (missing budgetUsd)", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ jobId: "job-1", ttlSeconds: 60 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a mint request with an invalid body (missing jobId)", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ budgetUsd: 1, ttlSeconds: 60 }),
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
    expect(res.status).toBe(200);
    expect(keyStore.findByKey(key)).toBeUndefined();
  });

  it("DELETE /admin/keys/:id responds with the key's final spend (M5-D)", async () => {
    const { baseUrl, keyStore } = await start();
    const { id } = keyStore.mint({ budgetUsd: 1.5, ttlSeconds: 60 });
    keyStore.recordSpend(id, 0.42);

    const res = await fetch(`${baseUrl}/admin/keys/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revoked: boolean; spentUsd: number; budgetUsd: number };
    expect(body).toEqual({ id, revoked: true, spentUsd: 0.42, budgetUsd: 1.5 });
  });

  it("DELETE /admin/keys/:id also tears down that job's per-job socket", async () => {
    const { baseUrl } = await start();
    const mintRes = await fetch(`${baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ jobId: "job-revoke-me", budgetUsd: 1, ttlSeconds: 60 }),
    });
    const { id, socketDir } = (await mintRes.json()) as { id: string; socketDir: string };

    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(socketDir, "gw.sock"))).resolves.toBeDefined();

    const res = await fetch(`${baseUrl}/admin/keys/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(200);

    await expect(stat(path.join(socketDir, "gw.sock"))).rejects.toThrow();
    await expect(stat(socketDir)).rejects.toThrow();
  });

  it("DELETE /admin/keys/:id is idempotent for an unknown id (200, not an error, no spend fields)", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/admin/keys/does-not-exist`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revoked: boolean; spentUsd?: number; budgetUsd?: number };
    expect(body).toEqual({ id: "does-not-exist", revoked: false });
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
      body: JSON.stringify({ jobId: "job-1", budgetUsd: 1, ttlSeconds: 60 }),
    });
    const text = await res.text();
    expect(text).not.toContain("REAL_OPENROUTER_KEY_SENTINEL");
    expect(text).not.toContain(MASTER_KEY);
  });
});
