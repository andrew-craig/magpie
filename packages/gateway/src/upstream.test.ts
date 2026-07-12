import { describe, expect, it } from "vitest";
import {
  determineCost,
  FALLBACK_COST_PER_1K_TOKENS_USD,
  FALLBACK_FLAT_CHARGE_USD,
} from "./upstream.js";

describe("determineCost", () => {
  it("prefers usage.cost from a non-streaming JSON body", () => {
    const body = JSON.stringify({
      id: "gen-1",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.0042 },
    });
    const result = determineCost(body, false);
    expect(result).toEqual({ costUsd: 0.0042, source: "usage.cost" });
  });

  it("prefers usage.cost from the final SSE chunk of a streaming body", () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cost: 0.0009 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = determineCost(body, true);
    expect(result).toEqual({ costUsd: 0.0009, source: "usage.cost" });
  });

  it("falls back to token-based estimation when usage has tokens but no cost", () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
    });
    const result = determineCost(body, false);
    expect(result.source).toBe("token-estimate");
    expect(result.costUsd).toBeCloseTo((1000 / 1000) * FALLBACK_COST_PER_1K_TOKENS_USD, 8);
  });

  it("falls back to the flat charge when nothing parseable is present at all", () => {
    expect(determineCost("not even json", false)).toEqual({
      costUsd: FALLBACK_FLAT_CHARGE_USD,
      source: "flat-fallback",
    });
    expect(determineCost("", true)).toEqual({
      costUsd: FALLBACK_FLAT_CHARGE_USD,
      source: "flat-fallback",
    });
  });

  it("falls back to the flat charge for a well-formed JSON body with no usage field", () => {
    const body = JSON.stringify({ id: "gen-1", choices: [] });
    expect(determineCost(body, false)).toEqual({
      costUsd: FALLBACK_FLAT_CHARGE_USD,
      source: "flat-fallback",
    });
  });

  it("never returns a zero/undefined charge, even for adversarial-looking input", () => {
    const adversarial = 'data: {"usage": null}\n\ndata: [DONE]\n';
    const result = determineCost(adversarial, true);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("charges the flat fallback (never $0) when usage reports present-but-zero token counts", () => {
    // A body whose usage fields are present but zero (a malformed/errored/
    // adversarial response) must not resolve to a $0 token-estimate — that
    // would let an attacker make unlimited free requests within the key's TTL,
    // defeating the budget cap. It must fall through to the flat charge.
    const body = JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(determineCost(body, false)).toEqual({
      costUsd: FALLBACK_FLAT_CHARGE_USD,
      source: "flat-fallback",
    });
  });

  it("charges the flat fallback when only one token field is present and it is zero", () => {
    const body = JSON.stringify({ usage: { completion_tokens: 0 } });
    expect(determineCost(body, false)).toEqual({
      costUsd: FALLBACK_FLAT_CHARGE_USD,
      source: "flat-fallback",
    });
  });
});
