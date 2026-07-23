import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGitStripped,
  createOutputDir,
  GitNotStrippedError,
  prepareReviewMount,
} from "./container-mounts.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "magpie-container-mounts-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Builds a fake checked-out workspace dir: some source files plus a `.git/` with nested content. */
async function makeFakeWorkspace(): Promise<string> {
  const dir = join(root, "workspace");
  await mkdir(join(dir, ".git", "objects"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, ".git", "objects", "pack-fake"), "not a real pack\n");
  await writeFile(join(dir, "README.md"), "# hello\n");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
  return dir;
}

describe("prepareReviewMount", () => {
  it("removes .git entirely and returns the same directory", async () => {
    const dir = await makeFakeWorkspace();

    const mountDir = await prepareReviewMount(dir);

    expect(mountDir).toBe(dir);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("preserves the reviewable source files", async () => {
    const dir = await makeFakeWorkspace();

    await prepareReviewMount(dir);

    expect(await readFile(join(dir, "README.md"), "utf-8")).toBe("# hello\n");
    expect(await readFile(join(dir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
  });

  it("does not throw when .git is already absent (idempotent)", async () => {
    const dir = await makeFakeWorkspace();
    await prepareReviewMount(dir);

    await expect(prepareReviewMount(dir)).resolves.toBe(dir);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("does not throw on a directory that never had a .git", async () => {
    const dir = join(root, "no-git-workspace");
    await mkdir(dir);
    await writeFile(join(dir, "file.txt"), "content\n");

    await expect(prepareReviewMount(dir)).resolves.toBe(dir);
    expect(await readFile(join(dir, "file.txt"), "utf-8")).toBe("content\n");
  });

  it("rejects a relative workspace path and performs no filesystem removal", async () => {
    // Build a real workspace whose .git a bug in the guard could actually
    // delete (if the relative path happened to resolve, via process.cwd(),
    // back to this same directory) — a plain hard-coded string like
    // "relative/path" wouldn't prove anything was (or wasn't) removed.
    const dir = await makeFakeWorkspace();
    const relativeDir = relative(process.cwd(), dir);
    // Sanity-check the fixture: this only exercises the guard we care about
    // if the path handed to prepareReviewMount is actually relative.
    expect(relativeDir.startsWith("/")).toBe(false);

    await expect(prepareReviewMount(relativeDir)).rejects.toThrow(
      /prepareReviewMount requires an absolute workspace path/,
    );
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("rejects an empty workspace path", async () => {
    await expect(prepareReviewMount("")).rejects.toThrow(
      /prepareReviewMount requires an absolute workspace path/,
    );
  });

  // Mount-prep posture (task_bfaf): the argv golden pins the `:/work:ro`
  // FLAG, but not the fact that the prepared directory actually has NO `.git`
  // — pin that posture here so a strip that silently stops working can't slip
  // a live `.git` into the read-only /work mount.
  it("strips ALL of .git, including nested objects/HEAD, leaving no git state behind", async () => {
    const dir = await makeFakeWorkspace();

    await prepareReviewMount(dir);

    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(false);
    expect(existsSync(join(dir, ".git", "objects", "pack-fake"))).toBe(false);
  });
});

describe("assertGitStripped (task_bfaf fail-closed mount-prep preflight)", () => {
  it("resolves silently for a prepared (.git-stripped) mount", async () => {
    const dir = await makeFakeWorkspace();
    await prepareReviewMount(dir);

    await expect(assertGitStripped(dir)).resolves.toBeUndefined();
  });

  it("resolves for a directory that never had a .git", async () => {
    const dir = join(root, "clean");
    await mkdir(dir);
    await writeFile(join(dir, "file.txt"), "x\n");

    await expect(assertGitStripped(dir)).resolves.toBeUndefined();
  });

  it("FAILS CLOSED (throws GitNotStrippedError) when a .git dir is still present", async () => {
    // A workspace whose .git was NOT stripped (prepareReviewMount not run, or
    // a .git that re-materialised) must be refused before it can be mounted.
    const dir = await makeFakeWorkspace();

    await expect(assertGitStripped(dir)).rejects.toBeInstanceOf(GitNotStrippedError);
    await expect(assertGitStripped(dir)).rejects.toThrow(/still contains a \.git/);
  });

  it("also fails closed when .git is a file (e.g. a git worktree/submodule pointer)", async () => {
    const dir = join(root, "gitfile");
    await mkdir(dir);
    await writeFile(join(dir, ".git"), "gitdir: /elsewhere\n");

    await expect(assertGitStripped(dir)).rejects.toBeInstanceOf(GitNotStrippedError);
  });
});

describe("createOutputDir", () => {
  it("creates a directory that exists and is writable, with the expected findingsPath", async () => {
    const { outDir, findingsPath, cleanup } = await createOutputDir();
    try {
      expect(existsSync(outDir)).toBe(true);
      expect(findingsPath).toBe(join(outDir, "findings.json"));

      // Writable: actually write to findingsPath, like the container process would.
      await writeFile(findingsPath, JSON.stringify({ findings: [] }));
      expect(await readFile(findingsPath, "utf-8")).toContain("findings");
    } finally {
      await cleanup();
    }
  });

  it("creates a distinct directory per call", async () => {
    const a = await createOutputDir();
    const b = await createOutputDir();
    try {
      expect(a.outDir).not.toBe(b.outDir);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("cleanup() removes the directory", async () => {
    const { outDir, cleanup } = await createOutputDir();

    await cleanup();

    expect(existsSync(outDir)).toBe(false);
  });

  it("cleanup() is idempotent (safe to call more than once)", async () => {
    const { cleanup } = await createOutputDir();

    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("cleanup() does not throw even if called after the dir was written into", async () => {
    const { findingsPath, cleanup } = await createOutputDir();
    await writeFile(findingsPath, "{}");

    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("the created directory is owned/writable by the current process (no extra chmod needed)", async () => {
    const { outDir, cleanup } = await createOutputDir();
    try {
      const info = await stat(outDir);
      // Owner read/write/execute bits must be set; mkdtemp defaults to 0o700.
      expect(info.mode & 0o700).toBe(0o700);
    } finally {
      await cleanup();
    }
  });

  // Regression (M5): under systemd `PrivateTmp=true` the OS tmpdir is private
  // to the orchestrator process and invisible to the Docker daemon, so the
  // `/out` bind-mount source must be created under a host-visible base
  // (config.workspace.workDir). Callers pass that base explicitly.
  it("creates the per-job dir under an explicitly provided baseDir", async () => {
    const base = join(root, "state", "work");
    const { outDir, findingsPath, cleanup } = await createOutputDir(base);
    try {
      expect(relative(base, outDir).startsWith("..")).toBe(false);
      expect(join(outDir, "findings.json")).toBe(findingsPath);
      expect(existsSync(outDir)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("creates the baseDir if it does not exist yet (recursive)", async () => {
    // A base under the StateDirectory may not exist before the very first job.
    const base = join(root, "not", "created", "yet");
    expect(existsSync(base)).toBe(false);

    const { outDir, cleanup } = await createOutputDir(base);
    try {
      expect(existsSync(base)).toBe(true);
      expect(existsSync(outDir)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("rejects a relative baseDir before touching the filesystem", async () => {
    // A relative base would make the recursive mkdir resolve against
    // process.cwd(); fail loudly instead (mirrors prepareReviewMount).
    await expect(createOutputDir("relative/path")).rejects.toThrow(
      /createOutputDir requires an absolute baseDir path/,
    );
    expect(existsSync(join(process.cwd(), "relative"))).toBe(false);
  });
});
