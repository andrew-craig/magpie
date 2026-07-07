import { describe, expect, it, vi } from "vitest";
import { computePrDiff } from "./diff.js";

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
      octokit: octokit as never,
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
      octokit: octokit as never,
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
      octokit: octokit as never,
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
