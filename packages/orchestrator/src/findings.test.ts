import { describe, expect, it } from "vitest";
import { parseFindings } from "./findings.js";

const VALID_SAMPLE = {
  findings: [
    {
      path: "src/foo.ts",
      line: 10,
      severity: "blocking",
      category: "correctness",
      message: "This will throw on null input.",
      suggestion: "Add a null check.",
    },
    {
      path: "src/bar.ts",
      line: 20,
      end_line: 25,
      severity: "nit",
      category: "clarity",
      message: "Consider renaming this variable.",
    },
  ],
  summary: "Overall looks good, two small issues.",
  verdict: "comment",
};

describe("parseFindings", () => {
  it("accepts a valid sample matching the canonical contract", () => {
    const result = parseFindings(JSON.stringify(VALID_SAMPLE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings).toHaveLength(2);
      expect(result.value.verdict).toBe("comment");
      expect(result.value.findings[0]?.path).toBe("src/foo.ts");
      expect(result.value.findings[1]?.end_line).toBe(25);
    }
  });

  it("rejects malformed JSON", () => {
    const result = parseFindings("{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed JSON/i);
    }
  });

  it("rejects a bad severity enum value", () => {
    const bad = {
      ...VALID_SAMPLE,
      findings: [{ ...VALID_SAMPLE.findings[0], severity: "critical" }],
    };
    const result = parseFindings(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects a payload missing a required field", () => {
    const bad = {
      findings: [
        {
          path: "src/foo.ts",
          line: 10,
          severity: "blocking",
          category: "correctness",
          // message is missing
        },
      ],
      summary: "x",
      verdict: "comment",
    };
    const result = parseFindings(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it("rejects a payload with the wrong type for a field", () => {
    const bad = { ...VALID_SAMPLE, summary: 12345 };
    const result = parseFindings(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown top-level verdict value", () => {
    const bad = { ...VALID_SAMPLE, verdict: "reject" };
    const result = parseFindings(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });
});
