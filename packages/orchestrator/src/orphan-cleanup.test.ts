import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { ExecFileFn } from "./docker.js";
import { cleanupOrphanContainers } from "./orphan-cleanup.js";

/** A minimal-but-valid Config, mirroring docker.test.ts's `testConfig` convention. */
function testConfig(overrides: Partial<Config["container"]> = {}): Config {
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
      ...overrides,
    },
    gateway: {
      baseUrl: "http://127.0.0.1:4100",
      containerBaseUrl: "http://127.0.0.1:4000/v1",
      perJobBudgetUsd: 0.5,
      ttlMarginSeconds: 120,
    },
    secrets: {
      webhookSecret: "test-webhook-secret",
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      gatewayMasterKey: "test-gateway-master-key",
    },
  };
}

/** Captures logger calls without touching the console. */
function makeRecordingLogger(): {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    info(payload) {
      calls.push({ level: "info", ...payload });
    },
    error(payload) {
      calls.push({ level: "error", ...payload });
    },
  };
}

describe("cleanupOrphanContainers", () => {
  it("does nothing (beyond logging) when no magpie-* containers are running", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExec: ExecFileFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "\n", stderr: "" };
    };
    const logger = makeRecordingLogger();

    await cleanupOrphanContainers(testConfig(), fakeExec, logger);

    // Only the list call happened — no `rm` call when nothing was found.
    expect(calls).toEqual([
      { file: "docker", args: ["ps", "-aq", "--filter", "name=magpie-"] },
    ]);
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-cleanup", removedCount: 0 }),
    );
  });

  it("lists then force-removes every dangling magpie-* container it finds", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExec: ExecFileFn = async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "ps") {
        return { stdout: "abc123\ndef456\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const logger = makeRecordingLogger();

    await cleanupOrphanContainers(testConfig(), fakeExec, logger);

    expect(calls).toEqual([
      { file: "docker", args: ["ps", "-aq", "--filter", "name=magpie-"] },
      { file: "docker", args: ["rm", "-f", "abc123", "def456"] },
    ]);
    expect(logger.calls).toContainEqual(
      expect.objectContaining({
        event: "orphan-cleanup",
        removedCount: 2,
        ids: ["abc123", "def456"],
      }),
    );
  });

  it("uses config.container.dockerBin as the binary for both calls", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExec: ExecFileFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: args[0] === "ps" ? "onlyone\n" : "", stderr: "" };
    };

    await cleanupOrphanContainers(testConfig({ dockerBin: "/usr/local/bin/podman" }), fakeExec);

    expect(calls[0].file).toBe("/usr/local/bin/podman");
    expect(calls[1].file).toBe("/usr/local/bin/podman");
  });

  it("swallows a docker error non-fatally (never throws) and logs it", async () => {
    const fakeExec: ExecFileFn = async () => {
      throw new Error("Cannot connect to the Docker daemon");
    };
    const logger = makeRecordingLogger();

    await expect(cleanupOrphanContainers(testConfig(), fakeExec, logger)).resolves.toBeUndefined();

    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-cleanup-failed" }),
    );
    const failure = logger.calls.find((c) => c.event === "orphan-cleanup-failed");
    expect(failure?.error).toMatchObject({ message: "Cannot connect to the Docker daemon" });
  });

  it("swallows an error from the rm call too (list succeeded, remove failed)", async () => {
    const fakeExec: ExecFileFn = async (_file, args) => {
      if (args[0] === "ps") return { stdout: "abc123\n", stderr: "" };
      throw new Error("no such container: abc123");
    };
    const logger = makeRecordingLogger();

    await expect(cleanupOrphanContainers(testConfig(), fakeExec, logger)).resolves.toBeUndefined();

    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-cleanup-failed" }),
    );
  });
});
