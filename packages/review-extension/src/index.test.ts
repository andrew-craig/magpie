import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportFindingsTool, type ReportFindingsParams } from "./index.js";

const SAMPLE_PARAMS: ReportFindingsParams = {
  findings: [
    {
      path: "src/foo.ts",
      line: 42,
      end_line: 44,
      severity: "important",
      category: "correctness",
      message: "This off-by-one will drop the last element.",
      suggestion: "Use `<=` instead of `<`.",
    },
    {
      path: "src/bar.ts",
      line: 7,
      severity: "nit",
      category: "clarity",
      message: "Consider a more descriptive name.",
    },
  ],
  summary: "Two issues found; nothing blocking.",
  verdict: "comment",
};

let workDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "magpie-review-extension-test-"));
  savedEnv = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  rmSync(workDir, { recursive: true, force: true });
});

describe("report_findings execute()", () => {
  it("writes a valid JSON file to MAGPIE_FINDINGS_PATH that round-trips the findings", async () => {
    const findingsPath = join(workDir, "nested", "findings.json");
    process.env.MAGPIE_FINDINGS_PATH = findingsPath;

    await reportFindingsTool.execute("tool-call-1", SAMPLE_PARAMS, undefined, undefined, {} as never);

    const written = JSON.parse(readFileSync(findingsPath, "utf-8"));
    expect(written).toEqual({
      findings: SAMPLE_PARAMS.findings,
      summary: SAMPLE_PARAMS.summary,
      verdict: SAMPLE_PARAMS.verdict,
    });
  });

  it("creates the parent directory if it does not exist", async () => {
    const findingsPath = join(workDir, "does", "not", "exist", "yet", "findings.json");
    process.env.MAGPIE_FINDINGS_PATH = findingsPath;

    await reportFindingsTool.execute("tool-call-2", SAMPLE_PARAMS, undefined, undefined, {} as never);

    expect(JSON.parse(readFileSync(findingsPath, "utf-8")).verdict).toBe("comment");
  });

  it("returns terminate: true", async () => {
    const findingsPath = join(workDir, "findings.json");
    process.env.MAGPIE_FINDINGS_PATH = findingsPath;

    const result = await reportFindingsTool.execute(
      "tool-call-3",
      SAMPLE_PARAMS,
      undefined,
      undefined,
      {} as never,
    );

    expect(result.terminate).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Recorded ${SAMPLE_PARAMS.findings.length} findings`,
    });
  });

  it("falls back to ./magpie-findings.json and warns to stderr when MAGPIE_FINDINGS_PATH is unset", async () => {
    delete process.env.MAGPIE_FINDINGS_PATH;
    const savedCwd = process.cwd();
    process.chdir(workDir);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let warned = "";
    process.stderr.write = ((chunk: string) => {
      warned += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await reportFindingsTool.execute(
        "tool-call-4",
        SAMPLE_PARAMS,
        undefined,
        undefined,
        {} as never,
      );
      expect(warned).toMatch(/MAGPIE_FINDINGS_PATH is not set/);
      const details = result.details as { path: string };
      expect(details.path).toBe("./magpie-findings.json");
      expect(JSON.parse(readFileSync(join(workDir, "magpie-findings.json"), "utf-8")).verdict).toBe(
        "comment",
      );
    } finally {
      process.stderr.write = stderrWrite;
      process.chdir(savedCwd);
    }
  });
});

describe("report_findings parameter schema", () => {
  it("accepts a well-formed findings payload", () => {
    expect(Value.Check(reportFindingsTool.parameters, SAMPLE_PARAMS)).toBe(true);
  });

  it("rejects a bad severity value", () => {
    const bad = {
      ...SAMPLE_PARAMS,
      findings: [{ ...SAMPLE_PARAMS.findings[0], severity: "critical" }],
    };
    expect(Value.Check(reportFindingsTool.parameters, bad)).toBe(false);
  });

  it("rejects a finding missing a required field (message)", () => {
    const { message, ...findingWithoutMessage } = SAMPLE_PARAMS.findings[0]!;
    const bad = {
      ...SAMPLE_PARAMS,
      findings: [findingWithoutMessage],
    };
    expect(Value.Check(reportFindingsTool.parameters, bad)).toBe(false);
  });

  it("rejects a payload missing the top-level verdict field", () => {
    const { verdict, ...withoutVerdict } = SAMPLE_PARAMS;
    expect(Value.Check(reportFindingsTool.parameters, withoutVerdict)).toBe(false);
  });

  // The following lock in schema-consistency with the orchestrator's `.strict()`
  // zod (findings.ts): an empty string or an extra property must be rejected
  // HERE, so Pi retries, rather than passing and being rejected downstream.
  it("rejects an empty-string required field (minLength)", () => {
    const bad = {
      ...SAMPLE_PARAMS,
      findings: [{ ...SAMPLE_PARAMS.findings[0], message: "" }],
    };
    expect(Value.Check(reportFindingsTool.parameters, bad)).toBe(false);
  });

  it("rejects a line number below 1 (minimum)", () => {
    const bad = {
      ...SAMPLE_PARAMS,
      findings: [{ ...SAMPLE_PARAMS.findings[0], line: 0 }],
    };
    expect(Value.Check(reportFindingsTool.parameters, bad)).toBe(false);
  });

  it("rejects an unknown extra property (additionalProperties: false)", () => {
    const badFinding = {
      ...SAMPLE_PARAMS,
      findings: [{ ...SAMPLE_PARAMS.findings[0], bogus: "nope" }],
    };
    expect(Value.Check(reportFindingsTool.parameters, badFinding)).toBe(false);

    const badTopLevel = { ...SAMPLE_PARAMS, bogus: "nope" };
    expect(Value.Check(reportFindingsTool.parameters, badTopLevel)).toBe(false);
  });
});
