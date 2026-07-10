import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { assertDockerAvailable, DockerUnavailableError, type ExecFileFn } from "./docker.js";

/** A minimal-but-valid Config, mirroring reviewer.test.ts's `testConfig` convention. */
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
      cpus: "2",
      pidsLimit: 256,
      dockerBin: "docker",
      network: "bridge",
      ...overrides,
    },
    secrets: {
      webhookSecret: "test-webhook-secret",
      llmApiKey: "test-llm-api-key",
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
    },
  };
}

describe("assertDockerAvailable", () => {
  it("resolves without throwing when the injected exec succeeds", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExec: ExecFileFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "Docker version 24.0.0\n", stderr: "" };
    };

    await expect(assertDockerAvailable(testConfig(), fakeExec)).resolves.toBeUndefined();
    expect(calls).toEqual([{ file: "docker", args: ["version"] }]);
  });

  it("uses config.container.dockerBin as the binary to run", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExec: ExecFileFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };

    await assertDockerAvailable(testConfig({ dockerBin: "/usr/local/bin/podman" }), fakeExec);

    expect(calls).toEqual([{ file: "/usr/local/bin/podman", args: ["version"] }]);
  });

  it("throws a clear, actionable DockerUnavailableError when the binary is missing (ENOENT)", async () => {
    const fakeExec: ExecFileFn = async () => {
      const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };

    expect.assertions(3);
    try {
      await assertDockerAvailable(testConfig(), fakeExec);
    } catch (err) {
      expect(err).toBeInstanceOf(DockerUnavailableError);
      expect((err as Error).message).toMatch(/was not found on PATH/);
      expect((err as Error).message).toMatch(/docker_bin/);
    }
  });

  it("throws a clear, actionable DockerUnavailableError when the daemon is down (non-zero exit)", async () => {
    const fakeExec: ExecFileFn = async () => {
      const err = new Error(
        "Command failed: docker version\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ) as NodeJS.ErrnoException & { stderr?: string };
      err.code = undefined;
      err.stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.";
      throw err;
    };

    expect.assertions(3);
    try {
      await assertDockerAvailable(testConfig(), fakeExec);
    } catch (err) {
      expect(err).toBeInstanceOf(DockerUnavailableError);
      expect((err as Error).message).toMatch(/did not succeed/);
      expect((err as Error).message).toMatch(/daemon running/);
    }
  });

  it("names the docker binary that failed in the error message", async () => {
    const fakeExec: ExecFileFn = async () => {
      throw new Error("boom");
    };

    expect.assertions(1);
    try {
      await assertDockerAvailable(testConfig({ dockerBin: "/opt/bin/docker" }), fakeExec);
    } catch (err) {
      expect((err as Error).message).toContain("/opt/bin/docker");
    }
  });
});
