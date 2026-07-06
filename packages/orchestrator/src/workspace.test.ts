import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "./workspace.js";

// NOTE: everything here runs fully offline against a local bare-git fixture
// repo — no network, no real GitHub credentials. We use the `baseUrlOverride`
// test seam documented on `CreateWorkspaceParams` to point `createWorkspace`
// at a `file://` path instead of deriving a github.com URL via
// `buildCloneUrl`. The fake "token" below is never a real credential; it's
// only used to prove it doesn't end up anywhere in the resulting workspace.

const FAKE_TOKEN = "ghs_super-secret-installation-token-fixture-xyz";

let root: string;
let bareRepoPath: string;
let headSha: string;
let workDir: string;

/** Runs git with a throwaway identity so commits succeed with no global git config. */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf-8" },
  ).trim();
}

/** Recursively lists every file under `dir` (including inside `.git`). */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "magpie-workspace-test-"));
  bareRepoPath = join(root, "fixture-bare.git");
  workDir = join(root, "work");

  // Build the fixture: a bare "base repo" with one commit on a normal
  // branch, plus a refs/pull/1/head ref pointing at that same commit (this
  // is exactly what GitHub exposes for a PR, whether same-repo or fork).
  const seedDir = join(root, "seed");
  git(root, ["init", "--quiet", "--bare", bareRepoPath]);
  git(root, ["init", "--quiet", "--initial-branch=main", seedDir]);
  git(seedDir, ["remote", "add", "origin", bareRepoPath]);
  execFileSync("sh", ["-c", `echo hello > "${join(seedDir, "file.txt")}"`]);
  git(seedDir, ["add", "file.txt"]);
  git(seedDir, ["commit", "--quiet", "-m", "seed commit"]);
  headSha = git(seedDir, ["rev-parse", "HEAD"]);
  git(seedDir, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  git(seedDir, ["push", "--quiet", "origin", "HEAD:refs/pull/1/head"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createWorkspace", () => {
  it("checks out the PR head at the expected commit", async () => {
    const ws = await createWorkspace({
      owner: "acme",
      repo: "widgets",
      prNumber: 1,
      headSha,
      token: FAKE_TOKEN,
      workDir,
      baseUrlOverride: `file://${bareRepoPath}`,
    });

    try {
      const actualSha = git(ws.dir, ["rev-parse", "HEAD"]);
      expect(actualSha).toBe(headSha);
      expect(readFileSync(join(ws.dir, "file.txt"), "utf-8")).toBe("hello\n");
    } finally {
      await ws.cleanup();
    }
  });

  it("never leaves the token anywhere in the workspace tree", async () => {
    const ws = await createWorkspace({
      owner: "acme",
      repo: "widgets",
      prNumber: 1,
      headSha,
      token: FAKE_TOKEN,
      workDir,
      baseUrlOverride: `file://${bareRepoPath}`,
    });

    try {
      const files = listFilesRecursive(ws.dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const contents = readFileSync(file);
        expect(contents.includes(FAKE_TOKEN)).toBe(false);
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("leaves origin's remote URL credential-free", async () => {
    const ws = await createWorkspace({
      owner: "acme",
      repo: "widgets",
      prNumber: 1,
      headSha,
      token: FAKE_TOKEN,
      workDir,
      baseUrlOverride: `file://${bareRepoPath}`,
    });

    try {
      const originUrl = git(ws.dir, ["remote", "get-url", "origin"]);
      expect(originUrl).not.toContain(FAKE_TOKEN);
      expect(originUrl).not.toContain("@");
      expect(originUrl).toBe(`file://${bareRepoPath}`);
    } finally {
      await ws.cleanup();
    }
  });

  it("deletes FETCH_HEAD and reflogs (both of which git would otherwise use to record the fetch URL)", async () => {
    const ws = await createWorkspace({
      owner: "acme",
      repo: "widgets",
      prNumber: 1,
      headSha,
      token: FAKE_TOKEN,
      workDir,
      baseUrlOverride: `file://${bareRepoPath}`,
    });

    try {
      expect(existsSync(join(ws.dir, ".git", "FETCH_HEAD"))).toBe(false);
      expect(existsSync(join(ws.dir, ".git", "logs"))).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("cleanup() fully removes the workspace directory and is idempotent", async () => {
    const ws = await createWorkspace({
      owner: "acme",
      repo: "widgets",
      prNumber: 1,
      headSha,
      token: FAKE_TOKEN,
      workDir,
      baseUrlOverride: `file://${bareRepoPath}`,
    });

    expect(existsSync(ws.dir)).toBe(true);

    await ws.cleanup();
    expect(existsSync(ws.dir)).toBe(false);

    // Calling cleanup() again on an already-removed directory must not throw.
    await expect(ws.cleanup()).resolves.toBeUndefined();
  });

  it("throws and removes the partial workspace if the checked-out HEAD doesn't match the expected sha", async () => {
    const wrongSha = "0".repeat(40);

    await expect(
      createWorkspace({
        owner: "acme",
        repo: "widgets",
        prNumber: 1,
        headSha: wrongSha,
        token: FAKE_TOKEN,
        workDir,
        baseUrlOverride: `file://${bareRepoPath}`,
      }),
    ).rejects.toThrow(/expected PR head/);

    // The per-job dir is named using the (wrong, expected) sha; confirm no
    // orphaned workspace directory was left behind for this job.
    const expectedDir = join(workDir, `acme-widgets-1-${wrongSha}`);
    expect(existsSync(expectedDir)).toBe(false);
  });

  it("throws (and cleans up) when the requested PR ref doesn't exist on the base repo", async () => {
    await expect(
      createWorkspace({
        owner: "acme",
        repo: "widgets",
        prNumber: 999, // no refs/pull/999/head exists in the fixture
        headSha,
        token: FAKE_TOKEN,
        workDir,
        baseUrlOverride: `file://${bareRepoPath}`,
      }),
    ).rejects.toThrow();

    const expectedDir = join(workDir, `acme-widgets-999-${headSha}`);
    expect(existsSync(expectedDir)).toBe(false);
  });

  it("redacts the token from a thrown error's message even though git's own error text echoes the failing URL verbatim", async () => {
    // git prints the URL it failed to reach directly into its error output
    // (confirmed: "fatal: '<url>' does not appear to be a git repository").
    // Embed the real token in a URL that will fail fast (a nonexistent local
    // path, no network involved) to prove createWorkspace redacts it before
    // the error ever propagates to a caller that might log it.
    const bogusUrl = `file://${bareRepoPath}-does-not-exist-${FAKE_TOKEN}`;

    await expect(
      createWorkspace({
        owner: "acme",
        repo: "widgets",
        prNumber: 1,
        headSha,
        token: FAKE_TOKEN,
        workDir,
        baseUrlOverride: bogusUrl,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes(FAKE_TOKEN) && message.includes("REDACTED");
    });
  });
});
