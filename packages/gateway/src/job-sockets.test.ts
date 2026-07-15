import * as http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { createJobSocketManager, type JobSocketManager } from "./job-sockets.js";
import { createKeyStore, type KeyStore } from "./keystore.js";

const REAL_KEY = "REAL_OPENROUTER_KEY_SENTINEL";

function testConfig(socketDirRoot: string): GatewayConfig {
  return {
    socketDirRoot,
    mgmt: { host: "127.0.0.1", port: 0 },
    upstream: { baseUrl: "https://upstream-stub.invalid/v1" },
    defaultModel: undefined,
    secrets: { openrouterKey: REAL_KEY, masterKey: "unused-in-job-socket-tests" },
  };
}

/** Stub "OpenRouter" — never makes a real network call; mirrors the M7-0 spike's `stubFetch`. */
function stubFetch(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        id: "job-sockets-test-1",
        choices: [{ message: { role: "assistant", content: "stub reply" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0001 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

/** Issues a plain `node:http` request over a unix socket — deliberately NOT `fetch()`, since Node's global fetch has no first-class unix-socket support; `http.request`'s `socketPath` option does. */
function requestOverSocket(
  socketPath: string,
  options: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: options.path, method: options.method, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let tmpRoot: string | undefined;
let manager: JobSocketManager | undefined;

async function setup(): Promise<{ config: GatewayConfig; keyStore: KeyStore; jobSockets: JobSocketManager; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "magpie-gateway-job-sockets-test-"));
  tmpRoot = root;
  const config = testConfig(root);
  const keyStore = createKeyStore();
  const jobSockets = createJobSocketManager(config, keyStore, { fetchImpl: stubFetch });
  manager = jobSockets;
  return { config, keyStore, jobSockets, root };
}

afterEach(async () => {
  if (manager) {
    await manager.closeAll();
    manager = undefined;
  }
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("JobSocketManager", () => {
  it("bind() creates a 0711 job dir and a 0666 unix socket at <root>/<jobId>/gw.sock", async () => {
    const { jobSockets, root } = await setup();
    const { socketDir } = await jobSockets.bind({ id: "key-1", jobId: "job-abc" });
    expect(socketDir).toBe(path.join(root, "job-abc"));

    const dirStat = await stat(socketDir);
    expect(dirStat.isDirectory()).toBe(true);
    expect(dirStat.mode & 0o777).toBe(0o711);

    const socketPath = path.join(socketDir, "gw.sock");
    const socketStat = await stat(socketPath);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o666);
  });

  it("sanitizes an unsafe jobId into a single safe directory-name component directly under root (no path traversal)", async () => {
    const { jobSockets, root } = await setup();
    const { socketDir } = await jobSockets.bind({ id: "key-1", jobId: "../../etc/passwd weird job" });
    // The sanitized name may still contain literal dots/dashes (only `/` and
    // whitespace etc. are replaced) but it is always exactly one path
    // component directly under `root` -- slashes never survive sanitization,
    // so this can never resolve outside `config.socketDirRoot`.
    expect(path.dirname(socketDir)).toBe(root);
  });

  it("maps a jobId of `.` or `..` to a safe fallback dir strictly under root (never root itself or its parent)", async () => {
    // `.` and `..` survive the unsafe-char regex (both are legal filename
    // chars) but would make `path.join(root, name)` resolve to root itself
    // or its parent -- an escape. Both must collapse to the "job" fallback.
    const { jobSockets, root } = await setup();
    const dot = await jobSockets.bind({ id: "key-dot", jobId: "." });
    expect(dot.socketDir).toBe(path.join(root, "job"));
    const dotdot = await jobSockets.bind({ id: "key-dotdot", jobId: ".." });
    expect(dotdot.socketDir).toBe(path.join(root, "job"));
    expect(path.dirname(dotdot.socketDir)).toBe(root);
  });

  it("round-trips a GET /healthz over the bound unix socket", async () => {
    const { jobSockets } = await setup();
    const { socketDir } = await jobSockets.bind({ id: "key-1", jobId: "job-health" });
    const socketPath = path.join(socketDir, "gw.sock");

    const res = await requestOverSocket(socketPath, { method: "GET", path: "/healthz" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("round-trips a POST /v1/chat/completions over the bound unix socket against a stub upstream fetch", async () => {
    const { jobSockets, keyStore } = await setup();
    const { id, key } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });
    const { socketDir } = await jobSockets.bind({ id, jobId: "job-chat" });
    const socketPath = path.join(socketDir, "gw.sock");

    const res = await requestOverSocket(socketPath, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "some/model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { choices: Array<{ message: { content: string } }> };
    expect(parsed.choices[0].message.content).toBe("stub reply");
    expect(res.body).not.toContain(REAL_KEY);
    expect(keyStore.findByKey(key)?.spentUsd).toBeCloseTo(0.0001, 8);
  });

  it("teardown() unlinks the socket and removes the job dir, and is idempotent", async () => {
    const { jobSockets, root } = await setup();
    const { socketDir } = await jobSockets.bind({ id: "key-1", jobId: "job-teardown" });
    const socketPath = path.join(socketDir, "gw.sock");
    await expect(stat(socketPath)).resolves.toBeDefined();

    await jobSockets.teardown("key-1");
    await expect(stat(socketPath)).rejects.toThrow();
    await expect(stat(socketDir)).rejects.toThrow();
    // root itself is untouched
    await expect(stat(root)).resolves.toBeDefined();

    // idempotent: tearing down an already-torn-down (or never-bound) id is a silent no-op.
    await expect(jobSockets.teardown("key-1")).resolves.toBeUndefined();
    await expect(jobSockets.teardown("never-bound")).resolves.toBeUndefined();
  });

  it("a request over a torn-down socket fails (connection refused / ENOENT), proving revoke actually cuts off access", async () => {
    const { jobSockets, keyStore } = await setup();
    const { id, key } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 60 });
    const { socketDir } = await jobSockets.bind({ id, jobId: "job-cutoff" });
    const socketPath = path.join(socketDir, "gw.sock");

    await jobSockets.teardown(id);

    await expect(
      requestOverSocket(socketPath, {
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
    ).rejects.toThrow();
  });

  it("re-binding the same id tears down the previous server for that id first", async () => {
    const { jobSockets } = await setup();
    const first = await jobSockets.bind({ id: "key-1", jobId: "job-a" });
    const firstSocketPath = path.join(first.socketDir, "gw.sock");
    await expect(stat(firstSocketPath)).resolves.toBeDefined();

    const second = await jobSockets.bind({ id: "key-1", jobId: "job-b" });
    expect(second.socketDir).not.toBe(first.socketDir);

    // The first job's directory/socket must be gone -- rebinding the same id
    // tears down whatever it previously owned.
    await expect(stat(firstSocketPath)).rejects.toThrow();
    await expect(stat(path.join(second.socketDir, "gw.sock"))).resolves.toBeDefined();
  });

  it("a second id binding the SAME jobId tears down the first id's socket rather than orphaning it", async () => {
    const { jobSockets } = await setup();
    const first = await jobSockets.bind({ id: "key-1", jobId: "shared-job" });
    const firstSocketPath = path.join(first.socketDir, "gw.sock");
    await expect(stat(firstSocketPath)).resolves.toBeDefined();

    const second = await jobSockets.bind({ id: "key-2", jobId: "shared-job" });
    expect(second.socketDir).toBe(first.socketDir);

    // A fresh socket exists at the same path, owned by key-2 now.
    await expect(stat(path.join(second.socketDir, "gw.sock"))).resolves.toBeDefined();

    // key-1's teardown must be a no-op now (already superseded) -- it must
    // NOT tear down key-2's live socket out from under it.
    await jobSockets.teardown("key-1");
    await expect(stat(path.join(second.socketDir, "gw.sock"))).resolves.toBeDefined();
  });

  it("closeAll() tears down every bound socket", async () => {
    const { jobSockets, root } = await setup();
    const a = await jobSockets.bind({ id: "key-a", jobId: "job-a" });
    const b = await jobSockets.bind({ id: "key-b", jobId: "job-b" });

    await jobSockets.closeAll();

    await expect(stat(path.join(a.socketDir, "gw.sock"))).rejects.toThrow();
    await expect(stat(path.join(b.socketDir, "gw.sock"))).rejects.toThrow();
    await expect(stat(root)).resolves.toBeDefined();
  });
});
