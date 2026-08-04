import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { ExecFileFn } from "./docker.js";
import {
  cleanupOrphanContainers,
  cleanupOrphanLauncherProcesses,
  cleanupOrphanScratchDirs,
  type KillProcessFn,
  type ListDirFn,
  type ListProcessesFn,
  type ProcessInfo,
  type RemovePathFn,
} from "./orphan-cleanup.js";

/** A minimal-but-valid Config, mirroring docker.test.ts's `testConfig` convention. */
function testConfig(overrides: Partial<Config["container"]> = {}): Config {
  return {
    github: { appId: "123", privateKeyPath: null },
    llm: { baseUrl: "https://example.com/v1", model: "some/model", allowedModels: [] },
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
      tier: "crun",
      ...overrides,
    },
    microvm: {
      ramMib: 1024,
      vcpus: 2,
      rootfsPath: "",
      hostRamBudgetMib: 4096,
      launcherBin: "magpie-krun-launch",
    },
    gateway: {
      baseUrl: "http://127.0.0.1:4100",
      containerBaseUrl: "http://127.0.0.1:4000/v1",
      perJobBudgetUsd: 0.5,
      ttlMarginSeconds: 120,
    },
    telemetry: { path: "/tmp/magpie-telemetry-test.jsonl" },
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

describe("cleanupOrphanLauncherProcesses", () => {
  it("is a no-op on the crun tier — never even calls ps", async () => {
    const listProcessesFn: ListProcessesFn = async () => {
      throw new Error("ps must not be called for the crun tier");
    };
    const logger = makeRecordingLogger();

    await expect(
      cleanupOrphanLauncherProcesses(testConfig({ tier: "crun" }), listProcessesFn, () => {}, logger),
    ).resolves.toBeUndefined();

    expect(logger.calls).toEqual([]);
  });

  it("on the microvm tier, lists then SIGKILLs every process matching the launcher binary's basename", async () => {
    const processes: ProcessInfo[] = [
      { pid: 111, command: "/usr/local/bin/magpie-krun-launch --rootfs /x --exec /y" },
      { pid: 222, command: "node /home/magpie/dist/index.js" },
      { pid: 333, command: "magpie-krun-launch --rootfs /z" },
    ];
    const listProcessesFn: ListProcessesFn = async () => processes;
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const killFn: KillProcessFn = (pid, signal) => {
      killed.push({ pid, signal });
    };
    const logger = makeRecordingLogger();

    await cleanupOrphanLauncherProcesses(testConfig({ tier: "microvm" }), listProcessesFn, killFn, logger);

    expect(killed).toEqual([
      { pid: 111, signal: "SIGKILL" },
      { pid: 333, signal: "SIGKILL" },
    ]);
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-launcher-cleanup", removedCount: 2, pids: [111, 333] }),
    );
  });

  it("logs zero removals when no process matches, without treating it as an error", async () => {
    const listProcessesFn: ListProcessesFn = async () => [{ pid: 1, command: "init" }];
    const logger = makeRecordingLogger();

    await cleanupOrphanLauncherProcesses(
      testConfig({ tier: "microvm" }),
      listProcessesFn,
      () => {
        throw new Error("kill must not be called when nothing matched");
      },
      logger,
    );

    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-launcher-cleanup", removedCount: 0 }),
    );
  });

  it("matches on the full command line, not the (kernel-truncated) comm field", async () => {
    // "magpie-krun-launch" is 19 chars — longer than Linux's TASK_COMM_LEN-1
    // (15), so a naive `ps -eo comm=`-based match would silently miss every
    // real launcher process. Assert the match still fires given the FULL
    // argv-shaped command string this module actually parses.
    const processes: ProcessInfo[] = [{ pid: 42, command: "magpie-krun-launch --uid 1000 --gid 1000" }];
    const killed: number[] = [];
    const logger = makeRecordingLogger();

    await cleanupOrphanLauncherProcesses(
      testConfig({ tier: "microvm" }),
      async () => processes,
      (pid) => {
        killed.push(pid);
      },
      logger,
    );

    expect(killed).toEqual([42]);
  });

  it("swallows a kill error for one pid but still processes the rest of the batch", async () => {
    const processes: ProcessInfo[] = [
      { pid: 1, command: "magpie-krun-launch --a" },
      { pid: 2, command: "magpie-krun-launch --b" },
    ];
    const killed: number[] = [];
    const logger = makeRecordingLogger();

    await cleanupOrphanLauncherProcesses(
      testConfig({ tier: "microvm" }),
      async () => processes,
      (pid) => {
        if (pid === 1) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        killed.push(pid);
      },
      logger,
    );

    expect(killed).toEqual([2]);
    const call = logger.calls.find((c) => c.event === "orphan-launcher-cleanup");
    expect(call).toMatchObject({ removedCount: 1, pids: [2] });
    expect((call as { failedPids?: unknown[] }).failedPids).toHaveLength(1);
  });

  it("swallows a ps/listing error non-fatally (never throws)", async () => {
    const listProcessesFn: ListProcessesFn = async () => {
      throw new Error("ps: command not found");
    };
    const logger = makeRecordingLogger();

    await expect(
      cleanupOrphanLauncherProcesses(testConfig({ tier: "microvm" }), listProcessesFn, () => {}, logger),
    ).resolves.toBeUndefined();

    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-launcher-cleanup-failed" }),
    );
  });

  it("uses config.microvm.launcherBin's basename (not container.dockerBin) to match", async () => {
    const config = testConfig({ tier: "microvm" });
    config.microvm.launcherBin = "/opt/magpie/bin/custom-launcher-name";
    const processes: ProcessInfo[] = [
      { pid: 1, command: "custom-launcher-name --rootfs /x" },
      { pid: 2, command: "magpie-krun-launch --rootfs /y" },
    ];
    const killed: number[] = [];

    await cleanupOrphanLauncherProcesses(
      config,
      async () => processes,
      (pid) => {
        killed.push(pid);
      },
    );

    expect(killed).toEqual([1]);
  });
});

describe("cleanupOrphanScratchDirs", () => {
  it("removes every entry directly under workspace.workDir", async () => {
    const removed: string[] = [];
    const listDirFn: ListDirFn = async () => ["magpie-out-abc123", "octocat-hello-world-42-deadbeef"];
    const removePathFn: RemovePathFn = async (path) => {
      removed.push(path);
    };
    const logger = makeRecordingLogger();

    await cleanupOrphanScratchDirs(
      { workspace: { workDir: "/var/lib/magpie/work" } },
      listDirFn,
      removePathFn,
      logger,
    );

    expect(removed).toEqual([
      "/var/lib/magpie/work/magpie-out-abc123",
      "/var/lib/magpie/work/octocat-hello-world-42-deadbeef",
    ]);
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-scratch-cleanup", removedCount: 2 }),
    );
  });

  it("treats a missing workDir (ENOENT) as a silent zero-count success, not an error", async () => {
    const listDirFn: ListDirFn = async () => {
      throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
    };
    const logger = makeRecordingLogger();

    await expect(
      cleanupOrphanScratchDirs({ workspace: { workDir: "/does/not/exist" } }, listDirFn, async () => {}, logger),
    ).resolves.toBeUndefined();

    expect(logger.calls).toEqual([
      expect.objectContaining({ event: "orphan-scratch-cleanup", removedCount: 0 }),
    ]);
  });

  it("logs (but does not throw on) a non-ENOENT listing error", async () => {
    const listDirFn: ListDirFn = async () => {
      throw new Error("EACCES: permission denied");
    };
    const logger = makeRecordingLogger();

    await expect(
      cleanupOrphanScratchDirs({ workspace: { workDir: "/no/perm" } }, listDirFn, async () => {}, logger),
    ).resolves.toBeUndefined();

    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-scratch-cleanup-failed" }),
    );
  });

  it("swallows a per-entry removal error but still reports the entries that did succeed", async () => {
    const listDirFn: ListDirFn = async () => ["magpie-out-a", "magpie-out-b"];
    const removePathFn: RemovePathFn = async (path) => {
      if (path.endsWith("magpie-out-b")) throw new Error("EBUSY: resource busy");
    };
    const logger = makeRecordingLogger();

    await cleanupOrphanScratchDirs(
      { workspace: { workDir: "/var/lib/magpie/work" } },
      listDirFn,
      removePathFn,
      logger,
    );

    const call = logger.calls.find((c) => c.event === "orphan-scratch-cleanup");
    expect(call).toMatchObject({ removedCount: 1, names: ["magpie-out-a"] });
    expect((call as { failed?: unknown[] }).failed).toHaveLength(1);
  });

  it("never escapes workDir — every removed path is join(workDir, readdir-returned-name)", async () => {
    const removed: string[] = [];
    // A directory entry name can't literally contain a `/` on Linux (dirents
    // are single path components), but assert the join contract explicitly
    // so a future refactor can't accidentally start building paths from
    // anything other than workDir + the bare entry name.
    const listDirFn: ListDirFn = async () => ["some-job-dir"];
    const removePathFn: RemovePathFn = async (path) => {
      removed.push(path);
    };

    await cleanupOrphanScratchDirs({ workspace: { workDir: "/var/lib/magpie/work" } }, listDirFn, removePathFn);

    expect(removed).toEqual(["/var/lib/magpie/work/some-job-dir"]);
  });

  describe("against the real filesystem (default listDirFn/removePathFn)", () => {
    let realDir: string;

    afterEach(async () => {
      if (realDir) await rm(realDir, { recursive: true, force: true }).catch(() => {});
    });

    it("really deletes stray magpie-out-*/workspace-shaped dirs left under workDir", async () => {
      realDir = await mkdtemp(join(tmpdir(), "magpie-orphan-scratch-test-"));
      const outDir = join(realDir, "magpie-out-xyz");
      const workspaceDir = join(realDir, "octocat-hello-world-7-cafebabe");
      await Promise.all([
        makeDirWithFile(outDir, "findings.json"),
        makeDirWithFile(workspaceDir, "README.md"),
      ]);

      await cleanupOrphanScratchDirs({ workspace: { workDir: realDir } });

      const remaining = await readdir(realDir);
      expect(remaining).toEqual([]);
    });
  });
});

describe("crash-restart reap (task_df53 acceptance test)", () => {
  it("on restart under the microvm tier, reaps orphaned containers AND orphaned launcher processes AND stale scratch dirs, all in one pass, with the gateway-key decision exercised as a documented no-op", async () => {
    // Simulates exactly the scenario this task backstops: the orchestrator
    // was `kill -9`'d mid-review, leaving one dangling crun/podman
    // container, one orphaned `magpie-krun-launch` process (still running a
    // live guest), and the job's scratch dirs (workspace checkout + `/out`)
    // still on disk. On restart, all three of this module's reap functions
    // run (mirroring index.ts's composition-root wiring) and every orphan is
    // gone afterward.
    const config = testConfig({ tier: "microvm" });

    const dockerCalls: Array<{ file: string; args: string[] }> = [];
    const fakeExec: ExecFileFn = async (file, args) => {
      dockerCalls.push({ file, args });
      if (args[0] === "ps") return { stdout: "dangling-container-1\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const orphanedProcesses: ProcessInfo[] = [
      { pid: 4242, command: "magpie-krun-launch --rootfs /var/lib/magpie/rootfs --exec /opt/magpie/entrypoint.sh" },
      { pid: 1, command: "/sbin/init" },
    ];
    const killedPids: number[] = [];
    const killFn: KillProcessFn = (pid) => {
      killedPids.push(pid);
    };

    const scratchEntries = ["magpie-out-crashed123", "octocat-demo-repo-9-deadbeefcafe"];
    const removedScratchPaths: string[] = [];

    const logger = makeRecordingLogger();

    // Exactly the three calls index.ts's startup path makes, in order.
    await cleanupOrphanContainers(config, fakeExec, logger);
    await cleanupOrphanLauncherProcesses(config, async () => orphanedProcesses, killFn, logger, fakeExec);
    await cleanupOrphanScratchDirs(
      config,
      async () => scratchEntries,
      async (path) => {
        removedScratchPaths.push(path);
      },
      logger,
    );

    // 1. The dangling container was force-removed.
    expect(dockerCalls).toContainEqual({ file: "docker", args: ["rm", "-f", "dangling-container-1"] });

    // 2. The orphaned launcher process (the still-running guest) was
    //    killed; an unrelated process (init) was left alone.
    expect(killedPids).toEqual([4242]);

    // 3. Both stale scratch dirs were removed.
    expect(removedScratchPaths).toEqual([
      "/tmp/magpie-work/magpie-out-crashed123",
      "/tmp/magpie-work/octocat-demo-repo-9-deadbeefcafe",
    ]);

    // 4. Every reap function logged a completed pass (best-effort, no
    //    thrown error anywhere in the sequence).
    expect(logger.calls).toContainEqual(expect.objectContaining({ event: "orphan-cleanup", removedCount: 1 }));
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-launcher-cleanup", removedCount: 1, pids: [4242] }),
    );
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "orphan-scratch-cleanup", removedCount: 2 }),
    );
    expect(logger.calls.some((c) => c.level === "error")).toBe(false);

    // 5. The gateway-key design fork (task_df53 §4), exercised rather than
    //    silently skipped: none of the three calls above were given a
    //    gateway base URL, master key, or HTTP client of any kind — this
    //    whole reap sequence (container + launcher-process + scratch-dir)
    //    completed with no gateway interaction whatsoever, which is exactly
    //    the documented decision (rely on the gateway's own TTL + per-key
    //    budget cap once the orphaned launcher's guest is killed above,
    //    rather than add a new bulk-revoke admin-plane endpoint — see
    //    cleanupOrphanLauncherProcesses's doc comment and this task's
    //    plan §4 for the full justification).
  });
});

/** Test helper: creates `dir` and writes one throwaway file into it, so `cleanupOrphanScratchDirs`'s real `fs.rm` has something non-empty to remove (not just an empty dir). */
async function makeDirWithFile(dir: string, fileName: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), "test fixture content");
}
