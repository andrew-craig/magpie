// Diff-hunk parsing and finding-to-comment anchoring for Milestone 2.
//
// GitHub's `POST /repos/{owner}/{repo}/pulls/{number}/reviews` 422s any
// inline `comments[]` entry whose `line` isn't part of the PR's diff — the
// API can only anchor a comment to a line GitHub itself considers part of
// the (new-file/right-side or old-file/left-side) diff. Magpie only ever
// authors RIGHT-side comments (new-file line numbers, matching the
// CANONICAL FINDINGS CONTRACT's `line`/`end_line` fields — see findings.ts),
// so the only lines we can safely anchor to are:
//   - '+' (added) lines — present only on the right side, and
//   - ' ' (context) lines — present on both sides, including the right.
// '-' (deleted) lines never appear on the right side and are never
// commentable here.
//
// This module is pure: no I/O, no network, no process spawning. It takes a
// unified diff string (as already fetched by diff.ts from the GitHub API)
// and the validated findings (see findings.ts) and produces GitHub-ready
// inline comment locations, folding anything that can't be anchored into an
// `other` bucket for the publisher to append to the review summary instead
// of dropping it silently (see PLAN.md's "Diff-anchoring constraint").
//
// Ranged findings (`end_line` present) map to GitHub's start_line/line
// convention: GitHub's REST review-comment API anchors a *range* at its
// LAST line — the field named `line` is documented as "the line of the
// blob in the pull request diff that the comment applies to" and, for a
// multi-line comment, `start_line` is "the first line in the pull request
// diff that your multi-line comment applies to" while `line` remains the
// last line of the range (GitHub REST API docs, "Create a review comment
// for a pull request" / "Create a review for a pull request" — the
// start_line/line pair, plus start_side/side). So a finding's
// `{ line, end_line }` (start, end) becomes `{ start_line: line, line:
// end_line }` here. Both ends of the range must independently anchor to a
// commentable line, or GitHub 422s the whole review call; if only the end
// doesn't anchor we degrade to a single-line comment on `line` (the
// documented, validated end) rather than dropping the finding entirely —
// see anchorFindings' doc comment below for the exact degrade rules.

import { type Finding, type ReviewFindings, parseFindings } from "./findings.js";

export { parseFindings };
export type { Finding, ReviewFindings };

/** One GitHub-ready inline review comment location + body. */
export interface InlineComment {
  /** Repo-relative file path (matches the diff's `+++ b/<path>` new path). */
  path: string;
  /** For a single-line comment, the commented line. For a range, the LAST line (see module doc comment). */
  line: number;
  side: "RIGHT";
  /** Present only for a multi-line range: the FIRST line of the range. */
  start_line?: number;
  /** Present only alongside `start_line`. Always `"RIGHT"` — Magpie never comments on the left/old side. */
  start_side?: "RIGHT";
  /** The comment body (severity/category/message/suggestion folded into one string — see formatMessage). */
  message: string;
}

/** Result of anchoring a batch of findings against a diff. */
export interface AnchorResult {
  /** Findings that anchored to a commentable diff line — become `comments[]` entries. */
  inline: InlineComment[];
  /** Findings that could not be anchored at all — fold into the summary body's "Other observations" instead of dropping. */
  other: Finding[];
}

/** Per-file set of NEW-file (right-side) line numbers that GitHub will accept an inline comment on. */
export type CommentableLines = Map<string, Set<number>>;

// Matches a hunk header "@@ -a[,b] +c[,d] @@[ optional trailing context]".
// Only the new-file start (c) is needed: the new-file line counter starts
// there and advances on '+' and ' ' lines (see parseUnifiedDiff).
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff (as returned by the GitHub API, git-style) into, per
 * new-file path, the set of NEW-file (right-side) line numbers that are
 * commentable per GitHub's rules: '+' (added) and ' ' (context) lines
 * advance and are commentable; '-' (deleted) lines don't advance the
 * new-file counter and are never commentable on the right.
 *
 * Handles:
 *  - Multiple files and multiple hunks per file (`@@ -a,b +c,d @@` resets
 *    the new-file counter to `c` at the start of each hunk).
 *  - `+++ b/<path>` new-file headers (the `b/` prefix is stripped to get
 *    the repo-relative path used elsewhere in the pipeline); `+++ /dev/null`
 *    (file deleted entirely) contributes no commentable lines.
 *  - `\ No newline at end of file` marker lines — recognized and skipped;
 *    they don't represent a real line and must not advance the counter or
 *    be misread as diff content.
 *  - `diff --git`/`--- `/rename/mode-change header lines between hunks —
 *    anything outside an active hunk (before the first `@@` of a file, or
 *    between the last hunk and the next file's headers) is ignored rather
 *    than misparsed as hunk body content. In particular `--- a/<path>`
 *    lines are recognized explicitly so they're never mistaken for a
 *    deleted-line ('-'-prefixed) diff body line.
 */
export function parseUnifiedDiff(diff: string): CommentableLines {
  const result: CommentableLines = new Map();

  const lines = diff.split("\n");
  // `diff` from the GitHub API ends with a trailing newline, so split()
  // leaves one spurious empty trailing element that must not be read as a
  // (blank) context line for whatever hunk happened to be open. A
  // genuine blank context line inside a hunk is `" "` (one space), not
  // `""`, so trimming only trailing artifacts never drops real content. Loop
  // rather than a single pop() so any run of trailing blank lines is cleared.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let currentPath: string | null = null;
  let newLineNum: number | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // New file boundary. The real new-file path comes from the `+++`
      // line below; reset so any headers in between (mode changes, rename
      // from/to, index lines) are never misread as hunk body content.
      currentPath = null;
      newLineNum = null;
      continue;
    }

    if (line.startsWith("--- ")) {
      // Old-file header line. Must be recognized explicitly: it can start
      // with '-' (e.g. "--- a/foo.ts") and would otherwise be misread as a
      // deleted diff-body line if a previous hunk's newLineNum were still set.
      newLineNum = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const rawPath = line.slice("+++ ".length).trim();
      if (rawPath === "/dev/null") {
        // Whole file deleted — nothing commentable on the right side.
        currentPath = null;
      } else {
        currentPath = rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
        if (!result.has(currentPath)) {
          result.set(currentPath, new Set());
        }
      }
      newLineNum = null;
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      newLineNum = Number(hunkMatch[1]);
      continue;
    }

    if (newLineNum === null || currentPath === null) {
      // Outside any hunk body (e.g. "index abc123..def456 100644", "new
      // file mode", "rename from/to", or anything before the first hunk).
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a marker, not a real line; doesn't
      // advance the counter.
      continue;
    }

    if (line.startsWith("+")) {
      result.get(currentPath)!.add(newLineNum);
      newLineNum++;
    } else if (line.startsWith("-")) {
      // Deleted line: old-file only, never commentable on the right, and
      // the new-file counter does not advance for it.
      continue;
    } else {
      // Context line (leading ' ', or the degenerate "" for a blank
      // context line some diff generators emit) — present on both sides,
      // commentable on the right.
      result.get(currentPath)!.add(newLineNum);
      newLineNum++;
    }
  }

  return result;
}

/**
 * Render a `Finding`'s severity/category/message/suggestion into the single
 * `message` string an `InlineComment` carries as its GitHub comment body.
 * `InlineComment` (unlike `Finding`) has no separate severity/category/
 * suggestion fields — this is where they get folded in, once, so the
 * publisher can post `comment.message` verbatim as the review comment body.
 */
function formatMessage(finding: Finding): string {
  const severityLabel = { blocking: "Blocking", important: "Important", nit: "Nit" }[
    finding.severity
  ];
  const header = `**${severityLabel}** (${finding.category})`;
  const parts = [header, finding.message];
  if (finding.suggestion) {
    parts.push(`**Suggestion:**\n${finding.suggestion}`);
  }
  return parts.join("\n\n");
}

/**
 * Anchor each finding to a GitHub inline-comment location against the
 * parsed diff, or fold it into `other` when it can't be anchored at all.
 *
 * Per finding:
 *  - Unknown `path` (not touched by the diff) -> `other`.
 *  - `line` not a commentable NEW-file line for that path -> `other`.
 *  - Otherwise, no `end_line`: single-line inline comment on `line`.
 *  - `end_line` present:
 *     - `end_line < line`: an invalid range. Rather than dropping the
 *       finding, we degrade to a single-line comment on the (valid,
 *       already-checked) `line` — documented product decision, see task
 *       description ("pick single-line degrade and document it").
 *     - `end_line === line`: degenerate range of length 1; treated as a
 *       plain single-line comment (GitHub doesn't want start_line/line
 *       set to the same value for a "multi-line" comment).
 *     - `end_line > line` and `end_line` anchors to a commentable line
 *       too: ranged inline comment, GitHub's start_line/line convention
 *       (see module doc comment) — `start_line: line`, `line: end_line`.
 *     - `end_line > line` but `end_line` does NOT anchor: degrade to a
 *       single-line comment on `line` (the end of the validated range is
 *       unusable, but the start is still a good anchor) rather than
 *       dropping the finding.
 */
export function anchorFindings(diff: string, findings: ReviewFindings): AnchorResult {
  const commentable = parseUnifiedDiff(diff);
  const inline: InlineComment[] = [];
  const other: Finding[] = [];

  for (const finding of findings.findings) {
    const linesForPath = commentable.get(finding.path);
    if (!linesForPath || !linesForPath.has(finding.line)) {
      other.push(finding);
      continue;
    }

    const message = formatMessage(finding);
    const singleLine = (): InlineComment => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      message,
    });

    if (finding.end_line === undefined || finding.end_line === finding.line) {
      inline.push(singleLine());
      continue;
    }

    if (finding.end_line < finding.line) {
      // Invalid range — degrade rather than drop (see doc comment above).
      inline.push(singleLine());
      continue;
    }

    if (linesForPath.has(finding.end_line)) {
      inline.push({
        path: finding.path,
        line: finding.end_line,
        side: "RIGHT",
        start_line: finding.line,
        start_side: "RIGHT",
        message,
      });
    } else {
      // end_line doesn't anchor — degrade to single-line on the validated start.
      inline.push(singleLine());
    }
  }

  return { inline, other };
}
