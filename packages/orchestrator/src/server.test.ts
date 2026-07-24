import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
  createWebhookServer,
  HEALTHZ_PATH,
  WEBHOOK_PATH,
  type OnPullRequest,
  type WebhookServer,
} from "./server.js";

const WEBHOOK_SECRET = "test-webhook-secret";

/**
 * Build a Config that only populates the fields the server actually reads
 * (`server.host`, `server.port`, `secrets.webhookSecret`). Port 0 asks the OS
 * for an ephemeral port so tests never collide with a real listener.
 */
function testConfig(): Config {
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
      requireMemoryLimit: true,
      cpus: "2",
      pidsLimit: 256,
      dockerBin: "docker",
    },
    gateway: {
      baseUrl: "http://127.0.0.1:4100",
      containerBaseUrl: "http://127.0.0.1:4000/v1",
      perJobBudgetUsd: 0.5,
      ttlMarginSeconds: 120,
    },
    secrets: {
      webhookSecret: WEBHOOK_SECRET,
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      gatewayMasterKey: "test-gateway-master-key",
    },
  };
}

/** A minimal-but-valid `pull_request` webhook payload body. */
function pullRequestPayload(): string {
  return JSON.stringify({
    action: "opened",
    number: 1,
    pull_request: {
      id: 1,
      number: 1,
      title: "Test PR",
      state: "open",
    },
    repository: {
      id: 100,
      name: "repo",
      full_name: "my-org/repo",
    },
    sender: { id: 5, login: "octocat" },
  });
}

/** GitHub's `X-Hub-Signature-256` header value for a body + secret. */
function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

let running: WebhookServer | undefined;

/** Start a server on an ephemeral port and return it plus its base URL. */
async function start(onPullRequest: OnPullRequest): Promise<{
  server: WebhookServer;
  baseUrl: string;
}> {
  const server = createWebhookServer(testConfig(), onPullRequest);
  await server.listen();
  running = server;
  const { port } = server.server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
  vi.restoreAllMocks();
});

describe("createWebhookServer", () => {
  it("accepts a correctly-signed pull_request delivery and fires the seam", async () => {
    const onPullRequest = vi.fn();
    const { baseUrl } = await start(onPullRequest);
    const body = pullRequestPayload();

    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "00000000-0000-0000-0000-000000000000",
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      },
      body,
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(onPullRequest).toHaveBeenCalledTimes(1);

    const event = onPullRequest.mock.calls[0][0];
    expect(event.name).toBe("pull_request");
    expect(event.payload.action).toBe("opened");
    expect(event.payload.pull_request.number).toBe(1);
    expect(event.payload.repository.full_name).toBe("my-org/repo");
  });

  it("rejects a tampered/wrong-signature delivery and does NOT fire the seam", async () => {
    const onPullRequest = vi.fn();
    const { baseUrl } = await start(onPullRequest);
    const body = pullRequestPayload();

    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "00000000-0000-0000-0000-000000000000",
        // Signature computed with the WRONG secret -> must be rejected.
        "x-hub-signature-256": sign(body, "attacker-secret"),
      },
      body,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(onPullRequest).not.toHaveBeenCalled();
  });

  it("rejects a delivery whose body was tampered after signing", async () => {
    const onPullRequest = vi.fn();
    const { baseUrl } = await start(onPullRequest);
    const originalBody = pullRequestPayload();
    const signature = sign(originalBody, WEBHOOK_SECRET);
    // Body altered after the (valid-for-original) signature was computed.
    const tamperedBody = originalBody.replace('"opened"', '"closed"');

    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "00000000-0000-0000-0000-000000000000",
        "x-hub-signature-256": signature,
      },
      body: tamperedBody,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(onPullRequest).not.toHaveBeenCalled();
  });

  it("answers GET /healthz with 200", async () => {
    const { baseUrl } = await start(vi.fn());
    const res = await fetch(`${baseUrl}${HEALTHZ_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown routes", async () => {
    const { baseUrl } = await start(vi.fn());
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
