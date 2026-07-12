import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { computeIncrementalDiff, computePrDiff, listPrChangedFiles } from "./diff.js";

// NOTE: everything here runs fully offline. We hand-roll a fake Octokit
// exposing only the surface computePrDiff actually calls
// (`rest.pulls.listFiles`, `rest.pulls.get`, `paginate`) rather than
// constructing a real `@octokit/rest` client — there is no network access and
// no real GitHub credentials in this test.

interface FakeFile {
  filename: string;
  additions: number;
  deletions: number;
}

/** Builds a fake Octokit whose `paginate` resolves to `files` regardless of args. */
function fakeOctokit(files: FakeFile[], diffText = "diff --git a/x b/x\n") {
  const listFiles = vi.fn();
  const get = vi.fn(async () => ({ data: diffText }));
  const paginate = vi.fn(async (fn: unknown, _args: unknown) => {
    expect(fn).toBe(listFiles);
    return files;
  });

  const octokit = {
    paginate,
    rest: {
      pulls: {
        listFiles,
        get,
      },
    },
  };

  return { octokit, listFiles, get, paginate };
}

describe("computePrDiff", () => {
  it("returns the diff, changed files, and line count for an under-cap PR", async () => {
    const files: FakeFile[] = [
      { filename: "src/a.ts", additions: 10, deletions: 2 },
      { filename: "src/b.ts", additions: 3, deletions: 1 },
    ];
    const diffText = "diff --git a/src/a.ts b/src/a.ts\n+hello\n";
    const { octokit, get, paginate } = fakeOctokit(files, diffText);

    const result = await computePrDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      maxDiffLines: 4000,
    });

    expect(result.diff).toBe(diffText);
    expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.changedLineCount).toBe(10 + 2 + 3 + 1);
    expect(result.tooLarge).toBe(false);

    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate.mock.calls[0][1]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
      per_page: 100,
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        pull_number: 42,
        mediaType: { format: "diff" },
      }),
    );
  });

  it("short-circuits without fetching the diff body when over the cap", async () => {
    const files: FakeFile[] = [
      { filename: "big.ts", additions: 3000, deletions: 3000 },
    ];
    const { octokit, get } = fakeOctokit(files);

    const result = await computePrDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      maxDiffLines: 4000,
    });

    expect(result.tooLarge).toBe(true);
    expect(result.diff).toBeNull();
    expect(result.changedFiles).toEqual(["big.ts"]);
    expect(result.changedLineCount).toBe(6000);

    expect(get).not.toHaveBeenCalled();
  });

  it("handles an empty PR (zero changed files)", async () => {
    const { octokit } = fakeOctokit([], "");

    const result = await computePrDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      prNumber: 99,
      maxDiffLines: 4000,
    });

    expect(result.changedFiles).toEqual([]);
    expect(result.changedLineCount).toBe(0);
    expect(result.tooLarge).toBe(false);
    expect(result.diff).toBeDefined();
    expect(result.diff).toBe("");
  });
});

/**
 * Builds a fake Octokit exposing `rest.repos.compareCommitsWithBasehead` — the
 * one surface `computeIncrementalDiff` touches. Metadata calls resolve to
 * `{ status, files }`; the `format: "diff"` call resolves to `diffText`. Pass
 * `compareError` to simulate a 404 (force-push that GC'd `before`) or any API
 * failure.
 */
function fakeCompareOctokit(opts: {
  status?: string;
  files?: FakeFile[];
  diffText?: string;
  compareError?: unknown;
  /** When true, the metadata call resolves to `{ data: null }` (defensive-guard test). */
  nullData?: boolean;
}) {
  const compareCommitsWithBasehead = vi.fn(
    async (args: { basehead: string; mediaType?: { format: string } }) => {
      if (opts.compareError !== undefined) {
        throw opts.compareError;
      }
      if (args?.mediaType?.format === "diff") {
        return { data: opts.diffText ?? "" };
      }
      if (opts.nullData) {
        return { data: null };
      }
      return { data: { status: opts.status, files: opts.files } };
    },
  );

  const octokit = {
    rest: { repos: { compareCommitsWithBasehead } },
  };

  return { octokit, compareCommitsWithBasehead };
}

describe("computeIncrementalDiff", () => {
  const AFTER = "a".repeat(40);
  const BEFORE = "b".repeat(40);

  it("returns the range diff for a clean fast-forward (status ahead)", async () => {
    const files: FakeFile[] = [{ filename: "src/new.ts", additions: 8, deletions: 2 }];
    const diffText = "diff --git a/src/new.ts b/src/new.ts\n+added\n";
    const { octokit, compareCommitsWithBasehead } = fakeCompareOctokit({
      status: "ahead",
      files,
      diffText,
    });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: BEFORE,
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.result.diff).toBe(diffText);
    expect(result.result.changedFiles).toEqual(["src/new.ts"]);
    expect(result.result.changedLineCount).toBe(10);
    expect(result.result.tooLarge).toBe(false);

    // Two calls: metadata, then the diff body — both against `before...after`.
    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(2);
    expect(compareCommitsWithBasehead.mock.calls[0][0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      basehead: `${BEFORE}...${AFTER}`,
    });
  });

  it("applies the size cap to the range and skips fetching the diff body when over", async () => {
    const files: FakeFile[] = [{ filename: "big.ts", additions: 3000, deletions: 3000 }];
    const { octokit, compareCommitsWithBasehead } = fakeCompareOctokit({
      status: "ahead",
      files,
    });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: BEFORE,
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.result.tooLarge).toBe(true);
    expect(result.result.diff).toBeNull();
    expect(result.result.changedLineCount).toBe(6000);
    // Only the metadata call — the diff body is never fetched when over-cap.
    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
  });

  it.each(["diverged", "behind", "identical", undefined])(
    "reports unavailable when the compare status is %s (not a fast-forward)",
    async (status) => {
      const { octokit } = fakeCompareOctokit({
        status: status as string | undefined,
        files: [{ filename: "x.ts", additions: 1, deletions: 0 }],
      });

      const result = await computeIncrementalDiff({
        octokit: octokit as unknown as Octokit,
        owner: "acme",
        repo: "widgets",
        base: BEFORE,
        head: AFTER,
        maxDiffLines: 4000,
      });

      expect(result.available).toBe(false);
      if (result.available) throw new Error("unreachable");
      expect(result.reason).toMatch(/not a fast-forward/);
    },
  );

  it("reports unavailable when the compare API errors (e.g. before unreachable after a force-push)", async () => {
    const { octokit } = fakeCompareOctokit({ compareError: new Error("Not Found") });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: BEFORE,
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toMatch(/failed: Not Found/);
  });

  it("reports unavailable for an ahead comparison with no changed files (empty/merge-only push)", async () => {
    const { octokit } = fakeCompareOctokit({ status: "ahead", files: [] });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: BEFORE,
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toMatch(/no changed files/);
  });

  it("reports unavailable (without an API call) for a zero/missing before sha", async () => {
    const { octokit, compareCommitsWithBasehead } = fakeCompareOctokit({ status: "ahead" });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: "0".repeat(40),
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toMatch(/zero before\/after sha/);
    expect(compareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("reports unavailable (without an API call) when before === after", async () => {
    const { octokit, compareCommitsWithBasehead } = fakeCompareOctokit({ status: "ahead" });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: AFTER,
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toMatch(/identical/);
    expect(compareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("falls back gracefully (no throw) when the compare body is null/undefined", async () => {
    const { octokit } = fakeCompareOctokit({ nullData: true });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: BEFORE,
      head: AFTER,
      maxDiffLines: 4000,
    });

    // A null body must NOT throw a TypeError on `.status`; it degrades to the
    // "not a fast-forward" fallback so the caller uses the full PR diff.
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toMatch(/not a fast-forward/);
  });

  it("reports unavailable when the compare file list may be truncated (>= 300 files)", async () => {
    // A fast-forward touching >= the compare endpoint's 300-file cap: the
    // single unpaginated response may be truncated, so the size cap can't be
    // trusted — fall back to the full (paginated-cap) PR diff. Line count here
    // stays UNDER maxDiffLines, proving the guard trips on file COUNT, not size.
    const files: FakeFile[] = Array.from({ length: 300 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const { octokit } = fakeCompareOctokit({ status: "ahead", files });

    const result = await computeIncrementalDiff({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      base: BEFORE,
      head: AFTER,
      maxDiffLines: 4000,
    });

    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toMatch(/may be truncated/);
  });
});

describe("listPrChangedFiles", () => {
  it("returns the paginated file list and total changed-line count", async () => {
    const files: FakeFile[] = [
      { filename: "src/a.ts", additions: 4, deletions: 1 },
      { filename: "src/b.ts", additions: 2, deletions: 3 },
    ];
    const { octokit, paginate } = fakeOctokit(files);

    const result = await listPrChangedFiles({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    });

    expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.changedLineCount).toBe(10);
    expect(paginate).toHaveBeenCalledTimes(1);
  });
});
