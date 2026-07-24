import { describe, expect, it } from "vitest";
import {
  assertMemoryControllerAvailable,
  MemoryControllerUnavailableError,
  type ReadFileFn,
} from "./cgroup-preflight.js";
import type { Config } from "./config.js";

const ROOT_CONTROLLERS_PATH = "/sys/fs/cgroup/cgroup.controllers";
const SELF_CGROUP_PATH = "/proc/self/cgroup";
const SELF_CONTROLLERS_PATH = "/sys/fs/cgroup/user.slice/user-1000.slice/cgroup.controllers";

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

/** Builds a fake ReadFileFn from a fixed map of path -> content (or a thrown ENOENT). */
function fakeReadFile(files: Record<string, string>): ReadFileFn {
  return async (path: string) => {
    if (path in files) return files[path];
    const err = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
}

/** Both the host root and this process's own cgroup fully delegate `memory` (the healthy case). */
const HEALTHY_FILES = {
  [ROOT_CONTROLLERS_PATH]: "cpuset cpu io memory pids\n",
  [SELF_CGROUP_PATH]: "0::/user.slice/user-1000.slice\n",
  [SELF_CONTROLLERS_PATH]: "cpuset cpu io memory pids\n",
};

/** Reproduces the bug report's exact Raspberry Pi symptom: no `memory` at the root at all. */
const DISABLED_AT_ROOT_FILES = {
  [ROOT_CONTROLLERS_PATH]: "cpuset cpu io pids\n",
  [SELF_CGROUP_PATH]: "0::/user.slice/user-1000.slice\n",
  [SELF_CONTROLLERS_PATH]: "cpuset cpu io pids\n",
};

/** Root has `memory`, but it isn't delegated down to this process's own cgroup. */
const NOT_DELEGATED_FILES = {
  [ROOT_CONTROLLERS_PATH]: "cpuset cpu io memory pids\n",
  [SELF_CGROUP_PATH]: "0::/user.slice/user-1000.slice\n",
  [SELF_CONTROLLERS_PATH]: "cpuset cpu io pids\n",
};

describe("assertMemoryControllerAvailable", () => {
  it("resolves silently when the memory controller is present and delegated", async () => {
    const readFileFn = fakeReadFile(HEALTHY_FILES);
    await expect(assertMemoryControllerAvailable(testConfig(), readFileFn, () => {})).resolves.toBeUndefined();
  });

  it("throws MemoryControllerUnavailableError when disabled at the host root and requireMemoryLimit is true (default)", async () => {
    const readFileFn = fakeReadFile(DISABLED_AT_ROOT_FILES);

    expect.assertions(3);
    try {
      await assertMemoryControllerAvailable(testConfig(), readFileFn, () => {});
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryControllerUnavailableError);
      expect((err as Error).message).toMatch(/memory.*controller.*not present/i);
      expect((err as Error).message).toMatch(/require_memory_limit = false/);
    }
  });

  it("throws MemoryControllerUnavailableError when present at the root but not delegated to this process", async () => {
    const readFileFn = fakeReadFile(NOT_DELEGATED_FILES);

    expect.assertions(2);
    try {
      await assertMemoryControllerAvailable(testConfig(), readFileFn, () => {});
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryControllerUnavailableError);
      expect((err as Error).message).toMatch(/not delegated/);
    }
  });

  it("throws MemoryControllerUnavailableError when the cgroup v2 files are unreadable (e.g. cgroup v1 host)", async () => {
    const readFileFn = fakeReadFile({});

    expect.assertions(2);
    try {
      await assertMemoryControllerAvailable(testConfig(), readFileFn, () => {});
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryControllerUnavailableError);
      expect((err as Error).message).toMatch(/could not read/);
    }
  });

  it("warns and resolves (does not throw) when unavailable but requireMemoryLimit is false — the escape hatch", async () => {
    const readFileFn = fakeReadFile(DISABLED_AT_ROOT_FILES);
    const warnings: string[] = [];

    await expect(
      assertMemoryControllerAvailable(
        testConfig({ requireMemoryLimit: false }),
        readFileFn,
        (m) => warnings.push(m),
      ),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/WARNING/);
    expect(warnings[0]).toMatch(/UNENFORCED/);
  });

  it("skips the delegation check (but still passes) when /proc/self/cgroup is unreadable, as long as the root has it", async () => {
    const readFileFn = fakeReadFile({
      [ROOT_CONTROLLERS_PATH]: "cpuset cpu io memory pids\n",
      // SELF_CGROUP_PATH deliberately omitted -> ENOENT.
    });

    await expect(assertMemoryControllerAvailable(testConfig(), readFileFn, () => {})).resolves.toBeUndefined();
  });

  it("includes config.container.memory in the error message so an operator sees exactly what would be unenforced", async () => {
    const readFileFn = fakeReadFile(DISABLED_AT_ROOT_FILES);

    expect.assertions(1);
    try {
      await assertMemoryControllerAvailable(testConfig({ memory: "2g" }), readFileFn, () => {});
    } catch (err) {
      expect((err as Error).message).toContain("2g");
    }
  });
});
