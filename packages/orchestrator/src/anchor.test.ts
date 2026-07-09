import { describe, expect, it } from "vitest";
import { anchorFindings, parseUnifiedDiff } from "./anchor.js";
import type { Finding, ReviewFindings } from "./findings.js";

// --- Fixture diffs -----------------------------------------------------
//
// src/foo.ts: two hunks.
//   hunk 1 "@@ -1,4 +1,4 @@": new-file lines 1,2,3,4 commentable
//     (1=context, 2=added, 3=context, 4=context-after-a-deletion;
//      the deleted line consumes no new-file line number at all).
//   hunk 2 "@@ -20,3 +21,4 @@": new-file lines 21,22,23,24 commentable.
// So new-file lines 5-20 are untouched by the diff (not commentable),
// and old-file line 4 ("removed line4") has no new-file counterpart.
const FOO_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line1
+added line2
 line3
-removed line4
 line5
@@ -20,3 +21,4 @@
 line20
+added line21
 line22
 line23
`;

// src/bar.ts: single hunk, new-file lines 5,6,7 commentable.
const BAR_DIFF = `diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -5,2 +5,3 @@
 line5
+added line6
 line7
`;

const MULTI_FILE_DIFF = FOO_DIFF + BAR_DIFF;

// A hunk followed by a "no newline at end of file" marker on both the
// removed and added side of a single-line change.
const NO_NEWLINE_DIFF = `diff --git a/src/baz.ts b/src/baz.ts
index 5555555..6666666 100644
--- a/src/baz.ts
+++ b/src/baz.ts
@@ -1,1 +1,1 @@
-old line
+new line
\\ No newline at end of file
`;

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: "src/foo.ts",
    line: 2,
    severity: "important",
    category: "correctness",
    message: "example finding",
    ...overrides,
  };
}

function reviewFindings(findings: Finding[]): ReviewFindings {
  return { findings, summary: "summary", verdict: "comment" };
}

describe("parseUnifiedDiff", () => {
  it("parses hunk headers across multiple hunks in one file", () => {
    const result = parseUnifiedDiff(FOO_DIFF);
    const fooLines = result.get("src/foo.ts");
    expect(fooLines).toBeDefined();
    expect([...fooLines!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 21, 22, 23, 24]);
  });

  it("parses hunk headers across multiple files", () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect([...result.keys()].sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
    const barLines = result.get("src/bar.ts");
    expect([...barLines!].sort((a, b) => a - b)).toEqual([5, 6, 7]);
  });

  it("strips the b/ prefix from the new-file path", () => {
    const result = parseUnifiedDiff(BAR_DIFF);
    expect(result.has("src/bar.ts")).toBe(true);
    expect(result.has("b/src/bar.ts")).toBe(false);
  });

  it("does not mark a deleted line as commentable", () => {
    const result = parseUnifiedDiff(FOO_DIFF);
    const fooLines = result.get("src/foo.ts")!;
    // Old-file line 4 ("removed line4") has no new-file counterpart; the
    // surrounding new-file lines are 3 and 4 only (see fixture doc comment).
    expect(fooLines.has(5)).toBe(false);
  });

  it("handles a '\\ No newline at end of file' marker without misreading it as content", () => {
    const result = parseUnifiedDiff(NO_NEWLINE_DIFF);
    const bazLines = result.get("src/baz.ts")!;
    expect([...bazLines]).toEqual([1]);
  });

  it("does not misread an old-file '--- a/<path>' header as a deleted diff-body line", () => {
    // Regression guard: if newLineNum weren't reset on "--- ", a "---"
    // header line beginning with '-' could be mistaken for hunk content.
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(result.get("src/foo.ts")!.size).toBe(8);
    expect(result.get("src/bar.ts")!.size).toBe(3);
  });
});

describe("anchorFindings", () => {
  it("anchors a finding on an added line inline", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 2 })]),
    );
    expect(other).toHaveLength(0);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ path: "src/foo.ts", line: 2, side: "RIGHT" });
    expect(inline[0]!.start_line).toBeUndefined();
  });

  it("anchors a finding on a context line inline", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 3 })]),
    );
    expect(other).toHaveLength(0);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ path: "src/foo.ts", line: 3, side: "RIGHT" });
  });

  it("folds a finding on a deleted/absent line into other", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 10 })]),
    );
    expect(inline).toHaveLength(0);
    expect(other).toHaveLength(1);
    expect(other[0]!.line).toBe(10);
  });

  it("folds a finding with an unknown path into other", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/does-not-exist.ts", line: 2 })]),
    );
    expect(inline).toHaveLength(0);
    expect(other).toHaveLength(1);
    expect(other[0]!.path).toBe("src/does-not-exist.ts");
  });

  it("maps a ranged finding to start_line + line (end_line as the anchor)", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 21, end_line: 23 })]),
    );
    expect(other).toHaveLength(0);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({
      path: "src/foo.ts",
      line: 23,
      side: "RIGHT",
      start_line: 21,
      start_side: "RIGHT",
    });
  });

  it("degrades to a single-line comment when end_line doesn't anchor", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 21, end_line: 30 })]),
    );
    expect(other).toHaveLength(0);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ path: "src/foo.ts", line: 21, side: "RIGHT" });
    expect(inline[0]!.start_line).toBeUndefined();
  });

  it("degrades to a single-line comment when end_line < line (invalid range)", () => {
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 22, end_line: 21 })]),
    );
    expect(other).toHaveLength(0);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ path: "src/foo.ts", line: 22, side: "RIGHT" });
    expect(inline[0]!.start_line).toBeUndefined();
  });

  it("treats end_line === line as a plain single-line comment", () => {
    const { inline } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 21, end_line: 21 })]),
    );
    expect(inline[0]).toMatchObject({ path: "src/foo.ts", line: 21, side: "RIGHT" });
    expect(inline[0]!.start_line).toBeUndefined();
  });

  it("folds an unanchorable finding to other even when it has a valid end_line", () => {
    // line itself doesn't anchor -> whole finding folds to other regardless
    // of whether end_line would have anchored on its own.
    const { inline, other } = anchorFindings(
      FOO_DIFF,
      reviewFindings([finding({ path: "src/foo.ts", line: 10, end_line: 21 })]),
    );
    expect(inline).toHaveLength(0);
    expect(other).toHaveLength(1);
  });

  it("includes severity/category/message/suggestion in the rendered message", () => {
    const { inline } = anchorFindings(
      FOO_DIFF,
      reviewFindings([
        finding({
          path: "src/foo.ts",
          line: 2,
          severity: "blocking",
          category: "security",
          message: "SQL injection risk.",
          suggestion: "Use a parameterized query.",
        }),
      ]),
    );
    expect(inline[0]!.message).toMatch(/Blocking/);
    expect(inline[0]!.message).toMatch(/security/);
    expect(inline[0]!.message).toMatch(/SQL injection risk\./);
    expect(inline[0]!.message).toMatch(/Use a parameterized query\./);
  });

  it("handles multiple files in one anchoring pass", () => {
    const { inline, other } = anchorFindings(
      MULTI_FILE_DIFF,
      reviewFindings([
        finding({ path: "src/foo.ts", line: 2 }),
        finding({ path: "src/bar.ts", line: 6 }),
      ]),
    );
    expect(other).toHaveLength(0);
    expect(inline).toHaveLength(2);
    expect(inline.map((c) => c.path).sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
  });
});
