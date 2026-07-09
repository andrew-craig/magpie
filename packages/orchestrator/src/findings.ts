// Canonical orchestrator-side "findings" contract for Milestone 2.
//
// This is the trust boundary: `raw` below is the contents of the findings
// file written by the Pi `report_findings` tool — a file produced by an
// LLM-driven process reasoning over an untrusted PR diff. We treat its shape
// as fully untrusted: parse the JSON in a try/catch (never `eval`, never
// trust it's even valid JSON) and validate the parsed value against a zod
// schema before anything downstream (anchor.ts, the publisher, the reviewer
// wiring) is allowed to touch it as a typed `ReviewFindings`.
//
// The schema below must match the CANONICAL FINDINGS CONTRACT in
// epic_e6e6 EXACTLY — the Pi extension's Typebox schema (task_A, a sibling
// task on the extension side) mirrors this shape independently, since the
// two packages don't share types across the process boundary (the extension
// writes a file, the orchestrator reads it).
//
// Deliberately NOT validated here: `end_line >= line`. That's an anchoring
// concern, not a shape concern — anchorFindings() (see anchor.ts) decides
// what to do with an inverted range (degrade to a single-line comment), so
// rejecting it at parse time would make that handling unreachable. See
// anchor.ts's module doc comment for the full reasoning.

import { z } from "zod";

/** One structured finding as emitted by the Pi `report_findings` tool. */
const findingSchema = z
  .object({
    /** Repo-relative file path, matching the diff (e.g. `b/`-stripped `+++` path). */
    path: z.string().min(1),
    /** 1-based line number in the NEW file (right side of the diff). */
    line: z.number().int().positive(),
    /** Optional multi-line range end; intended to be >= `line` (see module doc comment — not enforced here). */
    end_line: z.number().int().positive().optional(),
    severity: z.enum(["blocking", "important", "nit"]),
    /** Free-form short tag, e.g. "correctness", "security", "clarity". */
    category: z.string().min(1),
    message: z.string().min(1),
    /** Optional suggested fix. */
    suggestion: z.string().optional(),
  })
  .strict();

/** Top-level `report_findings` payload. */
const reviewFindingsSchema = z
  .object({
    findings: z.array(findingSchema),
    /** Overall review summary (markdown). */
    summary: z.string(),
    /** Advisory only — Magpie always posts as COMMENT regardless (see PLAN.md). */
    verdict: z.enum(["approve", "comment"]),
  })
  .strict();

/** One structured finding, validated. */
export type Finding = z.infer<typeof findingSchema>;

/** The full validated `report_findings` payload. */
export type ReviewFindings = z.infer<typeof reviewFindingsSchema>;

export type ParseFindingsResult =
  | { ok: true; value: ReviewFindings }
  | { ok: false; error: string };

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parse and validate the raw contents of a findings file at the trust
 * boundary (see module doc comment).
 *
 * Two failure modes are collapsed into the same `{ ok: false, error }`
 * shape so callers don't need to distinguish "not JSON" from "JSON but
 * doesn't match the contract" — either way the findings file is unusable
 * and the caller's job is the same (log `error`, treat as a failed review):
 *
 *   1. `raw` isn't valid JSON at all (`JSON.parse` throws) — caught, never
 *      lets a parse exception escape to the caller.
 *   2. `raw` parses but doesn't match {@link reviewFindingsSchema} (missing
 *      required field, wrong type, bad enum value, unknown extra property,
 *      etc.) — every zod issue is joined into one readable message.
 */
export function parseFindings(raw: string): ParseFindingsResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `malformed JSON: ${reason}` };
  }

  const result = reviewFindingsSchema.safeParse(parsedJson);
  if (!result.success) {
    const problems = result.error.issues.map(formatZodIssue).join("; ");
    return { ok: false, error: `findings do not match the expected shape: ${problems}` };
  }

  return { ok: true, value: result.data };
}
