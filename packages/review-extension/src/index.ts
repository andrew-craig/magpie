/**
 * Magpie report_findings extension.
 *
 * Pi (v1.4.0, like every version back to v0.80.3) has no JSON-schema
 * structured-output mode, so Magpie uses the
 * "tool-call-as-structured-output" pattern documented in Pi's own
 * `examples/extensions/structured-output.ts`: a single custom tool the agent
 * calls exactly once, as its final action, in place of a free-text reply.
 * `terminate: true` on the tool result ends the turn without an extra
 * follow-up LLM call.
 *
 * This module is baked into the `magpie-reviewer` container image (see
 * docker/reviewer/) that `packages/orchestrator/src/reviewer.ts` launches.
 * It has no access to any Magpie secret: the only channel back to the
 * orchestrator is the plain JSON file written to
 * `MAGPIE_FINDINGS_PATH`, a path the orchestrator itself chooses and owns.
 *
 * SECURITY NOTE: `params` here originates from the LLM's tool-call arguments,
 * which are themselves derived from the untrusted PR diff (see
 * reviewer-prompt.md's threat model — this is the indirect-prompt-injection
 * surface). This module never executes, evaluates, or shells out on any of
 * it; `path`/`message`/`suggestion` etc. are treated purely as data and
 * written verbatim to a JSON file for the orchestrator to parse and render
 * (e.g. as PR comment text) later.
 *
 * `prepareArguments` (see below) runs before Pi's schema validation purely to
 * turn an out-of-enum `verdict`/`severity` into an error that names the
 * received value and every acceptable one. It never repairs a value: invalid
 * input is rejected so the model retries with a correct one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TUnsafe } from "typebox";

/** Default output path used only when the host forgot to set MAGPIE_FINDINGS_PATH. */
const FALLBACK_FINDINGS_PATH = "./magpie-findings.json";

/** Allowed `verdict` values; shared by the schema and the rejection message. */
export const VERDICTS = ["approve", "comment"] as const;
/** Allowed finding `severity` values; shared by the schema and the rejection message. */
export const SEVERITIES = ["blocking", "important", "nit"] as const;

/**
 * Flat `{type:"string", enum:[...]}` schema. `Type.Union([Type.Literal...])`
 * serialises to `anyOf`/`const`, which some providers handle poorly and which
 * produces the opaque "must match a schema in anyOf" validation error that
 * hid the acceptable values from the model. This mirrors `StringEnum` from
 * `@earendil-works/pi-ai`, re-implemented locally because pi-ai is not a
 * direct dependency of this package (the reviewer image pins an explicit
 * dependency set). `Static<>` stays the precise literal union.
 */
function stringEnum<const T extends readonly string[]>(
  values: T,
  description: string,
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

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
    severity: stringEnum(
      SEVERITIES,
      "How serious the finding is. Exactly one of: blocking (must fix before merge), important (should fix), nit (minor/optional polish). Pass the bare string with no extra quotes.",
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
    verdict: stringEnum(
      VERDICTS,
      'Overall verdict. Must be exactly one of: "approve", "comment" (pass the bare string, with no extra quotes). Magpie never blocks or approves on GitHub itself (a human always decides) — this is informational input to the posted review only.',
    ),
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

/** Cap on how much of a received value is echoed back, so a huge junk value cannot bloat the tool result. */
const MAX_ECHOED_VALUE_CHARS = 100;

function echoValue(value: unknown): string {
  // JSON.stringify makes stray quote characters visible (e.g. "\"approve\"").
  // It returns undefined for undefined/functions, and throws on BigInt; args
  // come from JSON.parse so neither is expected, but never throw a TypeError.
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_ECHOED_VALUE_CHARS ? `${text.slice(0, MAX_ECHOED_VALUE_CHARS)}...` : text;
}

function problemFor(path: string, value: unknown, allowed: readonly string[]): string | undefined {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return undefined;
  }
  const choices = allowed.map((v) => JSON.stringify(v)).join(", ");
  return `${path}: received ${echoValue(value)}, must be exactly one of ${choices} (pass the bare string, with no extra quotes).`;
}

/**
 * Pre-validation hook: if `verdict` or any `findings[i].severity` is present
 * but outside its enum, throw one error listing every such problem so the model
 * can fix them all in a single retry. Pi's own validator only says "must be
 * equal to constant", never the acceptable values. Anything else — including
 * valid args — is returned unchanged (same reference) for Pi's validator.
 *
 * A MISSING verdict/severity is deliberately NOT reported here: this hook runs
 * before Pi checks `toolCall.argumentsError`, so for malformed/truncated tool
 * call JSON (partial args) a "missing verdict" message from here would mask the
 * real cause. Missing fields fall through to Pi's validator, which reports
 * argumentsError first.
 *
 * Values are treated purely as data (see SECURITY NOTE) and never normalised.
 */
export function prepareReportFindingsArguments(args: unknown): ReportFindingsParams {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args as ReportFindingsParams;
  }
  const record = args as Record<string, unknown>;
  const problems: string[] = [];
  if ("verdict" in record && record.verdict !== undefined) {
    const p = problemFor("verdict", record.verdict, VERDICTS);
    if (p) problems.push(p);
  }
  if (Array.isArray(record.findings)) {
    record.findings.forEach((entry: unknown, i: number) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
      const severity = (entry as Record<string, unknown>).severity;
      if (severity === undefined) return;
      const p = problemFor(`findings[${i}].severity`, severity, SEVERITIES);
      if (p) problems.push(p);
    });
  }
  if (problems.length > 0) {
    throw new Error(`report_findings rejected: ${problems.join(" ")}`);
  }
  return args as ReportFindingsParams;
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
  prepareArguments: prepareReportFindingsArguments,

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
