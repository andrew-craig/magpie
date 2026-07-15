import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
  type GatewayAuthConfig,
  type GatewayKey,
  mintGatewayKey,
  mintGatewayKeyFromConfig,
  revokeGatewayKey,
} from "./gateway.js";

// NOTE: everything here runs fully offline against a throwaway `http.Server`
// standing in for the real M4-A gateway management plane (see
// packages/gateway/src/admin-server.ts). We assert HOW gateway.ts drives that
// API (auth header, method, path, body shape) and how it parses/handles the
// responses — the real gateway is proven end-to-end separately (see the
// task's live-verification evidence). This mirrors the fake-HTTP-endpoint
// pattern the gateway's own admin-server.test.ts uses, just from the caller
// side.

const MASTER_KEY = "test-master-key-should-never-leak";

/** One captured inbound request to the fake gateway. */
interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** How the fake gateway should respond to the next matching request. */
interface FakeResponse {
  status: number;
  /** JSON-serialized and sent as the body; omit for an empty body (e.g. a 204). */
  json?: unknown;
  /** Raw (non-JSON) body, for exercising the unparseable-response path. */
  raw?: string;
}

interface FakeGateway {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Sets the response the fake returns for every subsequent request. */
  setResponse(res: FakeResponse): void;
}

let running: http.Server | undefined;

async function startFakeGateway(initial: FakeResponse): Promise<FakeGateway> {
  const requests: CapturedRequest[] = [];
  let nextResponse: FakeResponse = initial;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      const { status, json, raw } = nextResponse;
      if (json !== undefined) {
        const text = JSON.stringify(json);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
      } else if (raw !== undefined) {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(raw);
      } else {
        res.writeHead(status);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setResponse(next: FakeResponse) {
      nextResponse = next;
    },
  };
}

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve, reject) => running!.close((err) => (err ? reject(err) : resolve())));
    running = undefined;
  }
});

function authConfig(baseUrl: string): GatewayAuthConfig {
  return { gateway: { baseUrl }, secrets: { gatewayMasterKey: MASTER_KEY } };
}

/** A recording logger, so best-effort revoke failures can be asserted on without hitting the console. */
function recordingLogger(): { errors: Record<string, unknown>[]; error(p: Record<string, unknown>): void } {
  const errors: Record<string, unknown>[] = [];
  return { errors, error: (p) => errors.push(p) };
}

describe("mintGatewayKey", () => {
  it("POSTs to /admin/keys with the master-key bearer auth and the right body shape", async () => {
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "abc123", key: "sk-magpie-deadbeef", socketDir: "/run/magpie-gateway/jobs/abc123" },
    });

    const result = await mintGatewayKey(authConfig(fake.baseUrl), {
      model: "anthropic/claude-sonnet-4.5",
      budgetUsd: 0.5,
      ttlSeconds: 720,
      jobId: "job-abc123",
    });

    expect(result).toEqual({
      id: "abc123",
      key: "sk-magpie-deadbeef",
      socketDir: "/run/magpie-gateway/jobs/abc123",
    });

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/admin/keys");
    expect(req.authorization).toBe(`Bearer ${MASTER_KEY}`);
    expect(req.contentType).toContain("application/json");
    expect(JSON.parse(req.body)).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      budgetUsd: 0.5,
      ttlSeconds: 720,
      jobId: "job-abc123",
    });
  });

  it("omits `model` from the body when no model scope is given", async () => {
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "id1", key: "sk-magpie-x", socketDir: "/run/magpie-gateway/jobs/id1" },
    });

    await mintGatewayKey(authConfig(fake.baseUrl), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" });

    expect(JSON.parse(fake.requests[0].body)).toEqual({ budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" });
    expect(JSON.parse(fake.requests[0].body)).not.toHaveProperty("model");
  });

  it("tolerates a base URL with a trailing slash (no doubled //admin/keys)", async () => {
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "id1", key: "sk-magpie-x", socketDir: "/run/magpie-gateway/jobs/id1" },
    });

    await mintGatewayKey(authConfig(`${fake.baseUrl}/`), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" });

    expect(fake.requests[0].url).toBe("/admin/keys");
  });

  it("throws on a non-201 status (e.g. 401 bad master key), surfacing the status", async () => {
    const fake = await startFakeGateway({ status: 401, json: { error: { message: "unauthorized", type: "unauthorized" } } });

    await expect(
      mintGatewayKey(authConfig(fake.baseUrl), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("throws on a 201 with an unexpected response shape (missing key)", async () => {
    const fake = await startFakeGateway({ status: 201, json: { id: "only-an-id" } });

    await expect(
      mintGatewayKey(authConfig(fake.baseUrl), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" }),
    ).rejects.toThrow(/unexpected virtual-key mint response shape/);
  });

  it("throws on a 201 with an unparseable (non-JSON) body", async () => {
    const fake = await startFakeGateway({ status: 201, raw: "<html>not json</html>" });

    await expect(
      mintGatewayKey(authConfig(fake.baseUrl), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" }),
    ).rejects.toThrow(/unparseable virtual-key mint response/);
  });

  it("throws (never hangs) when the gateway is unreachable", async () => {
    // Point at a port nothing is listening on (an ephemeral high port we
    // never bound). The fetch should fail fast and be wrapped as a reach error.
    const cfg = authConfig("http://127.0.0.1:1");
    await expect(mintGatewayKey(cfg, { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" })).rejects.toThrow(
      /failed to reach LLM gateway management API/,
    );
  });

  it("bounds the mint request with a 5s abort timeout so a hung gateway can't stall the queue worker", async () => {
    // Confirms the AbortSignal.timeout is wired onto the fetch (the real signal
    // still runs; we only assert the bound). Without it, a wedged gateway would
    // block a worker until the far coarser per-job wall-clock backstop fired.
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "id1", key: "sk-magpie-x", socketDir: "/run/magpie-gateway/jobs/id1" },
    });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await mintGatewayKey(authConfig(fake.baseUrl), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" });
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("never puts the master key in a thrown error message", async () => {
    const fake = await startFakeGateway({ status: 500, raw: "boom" });

    let caught: unknown;
    try {
      await mintGatewayKey(authConfig(fake.baseUrl), { budgetUsd: 1, ttlSeconds: 60, jobId: "job-1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(MASTER_KEY);
  });
});

describe("revokeGatewayKey", () => {
  it("DELETEs /admin/keys/:id with the master-key bearer auth", async () => {
    const fake = await startFakeGateway({ status: 204 });
    const logger = recordingLogger();

    await revokeGatewayKey(authConfig(fake.baseUrl), "abc123", logger);

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("/admin/keys/abc123");
    expect(req.authorization).toBe(`Bearer ${MASTER_KEY}`);
    expect(logger.errors).toHaveLength(0);
  });

  it("url-encodes a revoke id so a surprising id can't break the request path", async () => {
    const fake = await startFakeGateway({ status: 204 });

    await revokeGatewayKey(authConfig(fake.baseUrl), "a/b c", recordingLogger());

    expect(fake.requests[0].url).toBe("/admin/keys/a%2Fb%20c");
  });

  it("is best-effort: a non-204 response is logged, not thrown", async () => {
    const fake = await startFakeGateway({ status: 500, raw: "internal error" });
    const logger = recordingLogger();

    await expect(revokeGatewayKey(authConfig(fake.baseUrl), "abc123", logger)).resolves.toBeUndefined();
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({ event: "gateway-key-revoke-failed", id: "abc123", status: 500 });
  });

  it("is best-effort: an unreachable gateway is logged, not thrown", async () => {
    const logger = recordingLogger();

    await expect(revokeGatewayKey(authConfig("http://127.0.0.1:1"), "abc123", logger)).resolves.toBeUndefined();
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({ event: "gateway-key-revoke-failed", id: "abc123" });
  });

  it("bounds the revoke request with a 5s abort timeout so cleanup isn't delayed by a hung gateway", async () => {
    const fake = await startFakeGateway({ status: 204 });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await revokeGatewayKey(authConfig(fake.baseUrl), "abc123", recordingLogger());
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("never puts the master key in a logged revoke failure", async () => {
    const fake = await startFakeGateway({ status: 500, raw: "boom" });
    const logger = recordingLogger();

    await revokeGatewayKey(authConfig(fake.baseUrl), "abc123", logger);

    expect(JSON.stringify(logger.errors)).not.toContain(MASTER_KEY);
  });
});

describe("mintGatewayKeyFromConfig", () => {
  /** A Config slice carrying just the fields mintGatewayKeyFromConfig reads. */
  function testConfig(baseUrl: string): Config {
    return {
      github: { appId: "123", privateKeyPath: null },
      llm: { baseUrl: "https://example.com/v1", model: "some/model" },
      server: { host: "127.0.0.1", port: 0 },
      limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 },
      repoAllowlist: [],
      workspace: { workDir: "/tmp/magpie-work" },
      container: {
        image: "magpie-reviewer:0.1.0",
        memory: "4g",
        cpus: "2",
        pidsLimit: 256,
        dockerBin: "docker",
      },
      gateway: { baseUrl, containerBaseUrl: "http://127.0.0.1:4000/v1", perJobBudgetUsd: 0.75, ttlMarginSeconds: 90 },
      secrets: {
        webhookSecret: "test-webhook-secret",
        githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
        gatewayMasterKey: MASTER_KEY,
      },
    };
  }

  it("scopes to config.llm.model, budgets per config, sets TTL = jobTimeout + margin, and passes jobId through", async () => {
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "id1", key: "sk-magpie-x", socketDir: "/run/magpie-gateway/jobs/id1" },
    });

    await mintGatewayKeyFromConfig(testConfig(fake.baseUrl), "job-42");

    expect(JSON.parse(fake.requests[0].body)).toEqual({
      model: "some/model",
      budgetUsd: 0.75,
      // 600 (jobTimeoutSeconds) + 90 (ttlMarginSeconds).
      ttlSeconds: 690,
      jobId: "job-42",
    });
  });
});

describe("per-job lifecycle (mint -> ... -> revoke)", () => {
  it("mints a key, then revokes it by the returned id on success", async () => {
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "job-key-1", key: "sk-magpie-live", socketDir: "/run/magpie-gateway/jobs/job-key-1" },
    });

    const minted: GatewayKey = await mintGatewayKey(authConfig(fake.baseUrl), {
      budgetUsd: 0.5,
      ttlSeconds: 700,
      jobId: "job-key-1",
    });
    fake.setResponse({ status: 204 });
    await revokeGatewayKey(authConfig(fake.baseUrl), minted.id, recordingLogger());

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].method).toBe("POST");
    expect(fake.requests[1].method).toBe("DELETE");
    expect(fake.requests[1].url).toBe("/admin/keys/job-key-1");
  });

  it("revoke still runs (and swallows failure) even if the run it wrapped failed — the key id is always cleaned up", async () => {
    const fake = await startFakeGateway({
      status: 201,
      json: { id: "job-key-2", key: "sk-magpie-live", socketDir: "/run/magpie-gateway/jobs/job-key-2" },
    });
    const logger = recordingLogger();

    const minted = await mintGatewayKey(authConfig(fake.baseUrl), {
      budgetUsd: 0.5,
      ttlSeconds: 700,
      jobId: "job-key-2",
    });
    // Simulate the gateway being flaky at cleanup time (e.g. mid-restart):
    // the revoke must not throw regardless, so the job's own failure outcome
    // is never masked.
    fake.setResponse({ status: 503, raw: "unavailable" });
    await expect(revokeGatewayKey(authConfig(fake.baseUrl), minted.id, logger)).resolves.toBeUndefined();

    expect(fake.requests[1].url).toBe("/admin/keys/job-key-2");
    expect(logger.errors).toHaveLength(1);
  });
});

describe("default logger", () => {
  it("revoke with no injected logger falls back to console.error (still never throws)", async () => {
    const fake = await startFakeGateway({ status: 500, raw: "boom" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(revokeGatewayKey(authConfig(fake.baseUrl), "abc123")).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
      // The master key must not appear in whatever the default logger emitted.
      const serialized = JSON.stringify(errSpy.mock.calls);
      expect(serialized).not.toContain(MASTER_KEY);
    } finally {
      errSpy.mockRestore();
    }
  });
});
