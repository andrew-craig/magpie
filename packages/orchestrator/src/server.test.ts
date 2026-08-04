import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
  buildHealthzTierSnapshot,
  createWebhookServer,
  HEALTHZ_PATH,
  WEBHOOK_PATH,
  type HealthzTierSnapshot,
  type OnIssueComment,
  type OnPullRequest,
  type WebhookServer,
} from "./server.js";
import type { TierSelectionResult } from "./tier-ladder.js";

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
    telemetry: { path: "/tmp/magpie-telemetry-test.jsonl" },
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

/** A minimal-but-valid `issue_comment` webhook payload body, on a PR. */
function issueCommentPayload(): string {
  return JSON.stringify({
    action: "created",
    issue: {
      number: 1,
      pull_request: { url: "https://api.github.com/repos/my-org/repo/pulls/1" },
    },
    comment: {
      id: 555,
      body: "@magpie review",
      user: { login: "octocat" },
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

/** A representative `/healthz` tier snapshot — a resolved, non-degraded crun floor. */
function testTierSnapshot(): HealthzTierSnapshot {
  return {
    resolvedTier: "crun",
    requestedTier: "crun",
    degraded: false,
    acknowledgedTier: null,
    kvmAvailable: false,
    crunRuntime: { present: true, binary: "docker", version: "Docker version 24.0.0" },
    microvmLauncher: { present: false, binary: "magpie-krun-launch" },
  };
}

let running: WebhookServer | undefined;

/** Start a server on an ephemeral port and return it plus its base URL. */
async function start(
  onPullRequest: OnPullRequest,
  tierSnapshot: HealthzTierSnapshot = testTierSnapshot(),
  onIssueComment?: OnIssueComment,
): Promise<{
  server: WebhookServer;
  baseUrl: string;
}> {
  const server = createWebhookServer(testConfig(), onPullRequest, tierSnapshot, onIssueComment);
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

  it("answers GET /healthz with 200 and the resolved isolation tier + probe details (M8-D2)", async () => {
    const snapshot = testTierSnapshot();
    const { baseUrl } = await start(vi.fn(), snapshot);
    const res = await fetch(`${baseUrl}${HEALTHZ_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { status: string; tier: HealthzTierSnapshot };
    expect(body.status).toBe("ok");
    expect(body.tier).toEqual(snapshot);
  });

  it("/healthz stays 200 even when the resolved tier is a DEGRADED, acknowledged fallback", async () => {
    // See server.ts's `createWebhookServer` doc comment: /healthz is a
    // liveness probe, not a health gate — a degraded-but-acknowledged tier
    // is still a running, job-processing service and must not flip the HTTP
    // status (that would restart-loop a perfectly running deployment under
    // an orchestrator supervisor for no benefit).
    const degradedSnapshot: HealthzTierSnapshot = {
      ...testTierSnapshot(),
      resolvedTier: "crun",
      requestedTier: "microvm",
      degraded: true,
      acknowledgedTier: "crun",
    };
    const { baseUrl } = await start(vi.fn(), degradedSnapshot);
    const res = await fetch(`${baseUrl}${HEALTHZ_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tier: HealthzTierSnapshot };
    expect(body.tier.degraded).toBe(true);
  });

  it("returns 404 for unknown routes", async () => {
    const { baseUrl } = await start(vi.fn());
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it("accepts a correctly-signed issue_comment delivery and fires the onIssueComment seam (M6-A)", async () => {
    const onIssueComment = vi.fn();
    const { baseUrl } = await start(vi.fn(), testTierSnapshot(), onIssueComment);
    const body = issueCommentPayload();

    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "00000000-0000-0000-0000-000000000001",
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      },
      body,
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(onIssueComment).toHaveBeenCalledTimes(1);

    const event = onIssueComment.mock.calls[0][0];
    expect(event.name).toBe("issue_comment");
    expect(event.payload.action).toBe("created");
    expect(event.payload.comment.body).toBe("@magpie review");
    expect(event.payload.repository.full_name).toBe("my-org/repo");
  });

  it("rejects a tampered/wrong-signature issue_comment delivery and does NOT fire the seam", async () => {
    const onIssueComment = vi.fn();
    const { baseUrl } = await start(vi.fn(), testTierSnapshot(), onIssueComment);
    const body = issueCommentPayload();

    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "00000000-0000-0000-0000-000000000002",
        "x-hub-signature-256": sign(body, "attacker-secret"),
      },
      body,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(onIssueComment).not.toHaveBeenCalled();
  });

  it("does not require an onIssueComment handler to be supplied (defaults to a no-op)", async () => {
    const onPullRequest = vi.fn();
    const { baseUrl } = await start(onPullRequest);
    const body = issueCommentPayload();

    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "00000000-0000-0000-0000-000000000003",
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      },
      body,
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});

describe("buildHealthzTierSnapshot", () => {
  /** Minimal-but-valid TierSelectionResult for exercising the projection in isolation. */
  function testTierSelectionResult(overrides: Partial<TierSelectionResult> = {}): TierSelectionResult {
    return {
      resolvedTier: "crun",
      requestedTier: "crun",
      degraded: false,
      acknowledgedTier: null,
      probe: {
        kvm: { available: true, reason: null },
        microvmLauncher: { present: true, binary: "magpie-krun-launch", version: "0.1.0" },
        microvmRootfsConfigured: false,
        crunRuntime: { present: true, binary: "podman", version: "podman version 4.9.3" },
      },
      availability: { microvm: false, crun: true },
      reasons: ["kvm: available", "resolution: \"crun\""],
      ...overrides,
    };
  }

  it("projects only the fields HealthzTierSnapshot declares — never the free-text `reasons` audit trail", () => {
    const result = testTierSelectionResult();
    const snapshot = buildHealthzTierSnapshot(result);
    expect(snapshot).toEqual({
      resolvedTier: "crun",
      requestedTier: "crun",
      degraded: false,
      acknowledgedTier: null,
      kvmAvailable: true,
      crunRuntime: { present: true, binary: "podman", version: "podman version 4.9.3" },
      microvmLauncher: { present: true, binary: "magpie-krun-launch", version: "0.1.0" },
    });
    expect(snapshot).not.toHaveProperty("reasons");
  });

  it("surfaces a degraded, acknowledged tier faithfully", () => {
    const result = testTierSelectionResult({
      resolvedTier: "crun",
      requestedTier: "microvm",
      degraded: true,
      acknowledgedTier: "crun",
      probe: {
        kvm: { available: false, reason: "no /dev/kvm" },
        microvmLauncher: { present: false, binary: "magpie-krun-launch", reason: "not found" },
        microvmRootfsConfigured: false,
        crunRuntime: { present: true, binary: "docker" },
      },
      availability: { microvm: false, crun: true },
    });
    const snapshot = buildHealthzTierSnapshot(result);
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.acknowledgedTier).toBe("crun");
    expect(snapshot.kvmAvailable).toBe(false);
  });
});
