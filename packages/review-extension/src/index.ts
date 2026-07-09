/**
 * Magpie report_findings extension (M2-A).
 *
 * Pi (v0.80.3) has no JSON-schema structured-output mode, so Magpie uses the
 * "tool-call-as-structured-output" pattern documented in Pi's own
 * `examples/extensions/structured-output.ts`: a single custom tool the agent
 * calls exactly once, as its final action, in place of a free-text reply.
 * `terminate: true` on the tool result ends the turn without an extra
 * follow-up LLM call.
 *
 * This module is loaded into the Pi **host subprocess** that
 * `packages/orchestrator/src/reviewer.ts` spawns (no container, no gateway —
 * those are M3/M4). It has no access to any Magpie secret: the only channel
 * back to the orchestrator is the plain JSON file written to
 * `MAGPIE_FINDINGS_PATH`, a path the orchestrator itself chooses and owns.
 *
 * SECURITY NOTE: `params` here originates from the LLM's tool-call arguments,
 * which are themselves derived from the untrusted PR diff (see
 * reviewer-prompt.md's threat model — this is the indirect-prompt-injection
 * surface). This module never executes, evaluates, or shells out on any of
 * it; `path`/`message`/`suggestion` etc. are treated purely as data and
 * written verbatim to a JSON file for the orchestrator to parse and render
 * (e.g. as PR comment text) later.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

/** Default output path used only when the host forgot to set MAGPIE_FINDINGS_PATH. */
const FALLBACK_FINDINGS_PATH = "./magpie-findings.json";

// NOTE: these constraints (minLength/minimum, additionalProperties:false) are
// kept in lockstep with the orchestrator's zod schema in findings.ts, which is
// `.strict()` with `.min(1)`/`.positive()`. The two schemas validate the same
// contract on opposite sides of a process boundary (Pi tool-call args here, the
// findings JSON file there). If the extension's schema were looser, Pi could
// accept an LLM tool-call that the orchestrator later rejects — silently failing
// the whole review — so we enforce the same shape here and let Pi retry.
const findingSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Repo-relative file path of the finding, matching a path in the PR diff.",
    }),
    line: Type.Integer({
      minimum: 1,
      description: "1-based line number in the NEW file (right side of the diff) the finding applies to.",
    }),
    end_line: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "1-based end line (inclusive, right side of the diff) for multi-line findings. Must be >= line. Omit for single-line findings.",
      }),
    ),
    severity: Type.Union(
      [Type.Literal("blocking"), Type.Literal("important"), Type.Literal("nit")],
      {
        description:
          "How serious the finding is: 'blocking' (must fix before merge), 'important' (should fix), or 'nit' (minor/optional polish).",
      },
    ),
    category: Type.String({
      minLength: 1,
      description: "Short free-form tag for the kind of finding, e.g. 'correctness', 'security', 'clarity'.",
    }),
    message: Type.String({
      minLength: 1,
      description: "The finding text: what is wrong and why it matters.",
    }),
    suggestion: Type.Optional(
      Type.String({
        description: "Optional suggested fix or replacement code/text for this finding.",
      }),
    ),
  },
  { additionalProperties: false },
);

const reportFindingsParams = Type.Object(
  {
    findings: Type.Array(findingSchema, {
      description: "All review findings for this PR diff. May be empty if the diff has no issues.",
    }),
    summary: Type.String({
      description: "Overall review summary for the PR, as markdown.",
    }),
    verdict: Type.Union([Type.Literal("approve"), Type.Literal("comment")], {
      description:
        "Overall verdict. Magpie never blocks or approves on GitHub itself (a human always decides) — this is informational input to the posted review only.",
    }),
  },
  { additionalProperties: false },
);

export type Finding = Static<typeof findingSchema>;
export type ReportFindingsParams = Static<typeof reportFindingsParams>;

interface ReportFindingsDetails {
  findingsCount: number;
  path: string;
}

/** Resolves the host-owned findings output path, warning to stderr if unset. */
function resolveFindingsPath(): string {
  const configured = process.env.MAGPIE_FINDINGS_PATH;
  if (configured && configured.length > 0) {
    return configured;
  }
  process.stderr.write(
    "[magpie/review-extension] MAGPIE_FINDINGS_PATH is not set; falling back to " +
      `${FALLBACK_FINDINGS_PATH} in the current working directory.\n`,
  );
  return FALLBACK_FINDINGS_PATH;
}

export const reportFindingsTool = defineTool({
  name: "report_findings",
  label: "Report Findings",
  description:
    "Record the final, structured code-review findings for this PR. Call this exactly once, as your last action, instead of writing a free-text final response.",
  promptSnippet: "Record structured code-review findings as your final action",
  promptGuidelines: [
    "Call report_findings exactly once, as your final action, to record your complete set of findings and overall verdict.",
    "Do not emit another assistant response after calling report_findings — it ends the review.",
    "Every finding's line (and end_line, if present) must refer to the NEW file's line numbers (the right-hand side of the diff), not the old file.",
  ],
  parameters: reportFindingsParams,

  async execute(_toolCallId, params) {
    const findingsPath = resolveFindingsPath();
    await mkdir(dirname(findingsPath), { recursive: true });
    await writeFile(
      findingsPath,
      JSON.stringify({
        findings: params.findings,
        summary: params.summary,
        verdict: params.verdict,
      }),
      "utf-8",
    );

    return {
      content: [{ type: "text", text: `Recorded ${params.findings.length} findings` }],
      details: {
        findingsCount: params.findings.length,
        path: findingsPath,
      } satisfies ReportFindingsDetails,
      terminate: true,
    };
  },

  renderResult(result, _options, theme) {
    const details = result.details as ReportFindingsDetails | undefined;
    const text = details
      ? `Recorded ${details.findingsCount} finding(s) -> ${details.path}`
      : (result.content[0]?.type === "text" ? result.content[0].text : "");
    return new Text(theme.fg("text", text), 0, 0);
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(reportFindingsTool);
}
