import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOutputDir, prepareReviewMount } from "./container-mounts.js";

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
});
