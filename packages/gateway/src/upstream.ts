// Cost extraction from OpenRouter chat-completion responses.
//
// Pure, side-effect-free parsing functions — deliberately separated from
// proxy-server.ts's network/streaming plumbing so the cost-accounting logic
// (the actual security-relevant part: this is what feeds the hard budget
// cap) can be unit tested against fixture strings without spinning up an
// HTTP server or a real/mocked fetch.
//
// OpenRouter usage/cost contract (per the M4-A task brief): requesting
// `usage: { include: true }` on the forwarded request makes OpenRouter
// include a `usage` object carrying `cost` (USD, already computed
// server-side) — on a non-streaming response that's the top-level
// `usage.cost` field; on a streaming (SSE) response it arrives as the FINAL
// `data:` chunk, whose `choices` array is typically empty and whose `usage`
// carries the totals for the whole request. We always set `usage.include`
// on forwarded requests (see proxy-server.ts) so this path is exercised for
// every request we make, not just ones the client happened to ask for usage
// on.
//
// SECURITY: `determineCost` is guaranteed to never return `undefined` — a
// response that doesn't parse as expected still yields a nonzero charge
// (falling through cost -> token-estimate -> flat-fallback) so a malformed
// or adversarial upstream body can never zero out spend and defeat the
// budget cap (see keystore.ts's `isOverBudget`). Document any inaccuracy
// this introduces rather than silently eating it.

/** Rough USD-per-1000-combined-tokens rate used ONLY when OpenRouter doesn't
 * return a `usage.cost` we can parse. This is a deliberately conservative,
 * hardcoded ESTIMATE — not tied to any real model's pricing — good enough to
 * keep a runaway/malformed-response loop from spending unboundedly, not
 * good enough to be a billing-accurate figure. Real `usage.cost` (the common
 * case) is always preferred when present. */
export const FALLBACK_COST_PER_1K_TOKENS_USD = 0.01;

/** Charged when a response yields neither a parseable `usage.cost` NOR
 * parseable token counts (e.g. a completely malformed/empty body) — the
 * last-resort floor that keeps the budget cap meaningful even against a
 * response we can't make any sense of at all. */
export const FALLBACK_FLAT_CHARGE_USD = 0.01;

export type CostSource = "usage.cost" | "token-estimate" | "flat-fallback";

export interface CostResult {
  costUsd: number;
  source: CostSource;
}

interface ParsedUsage {
  cost?: number;
  promptTokens?: number;
  completionTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extracts `{ cost, promptTokens, completionTokens }` from one parsed OpenRouter/OpenAI-shaped JSON object's `usage` field, if present and well-typed. */
function extractUsage(obj: unknown): ParsedUsage | undefined {
  if (!isRecord(obj) || !isRecord(obj.usage)) return undefined;
  const usage = obj.usage;
  const result: ParsedUsage = {};
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
    result.cost = usage.cost;
  }
  if (typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)) {
    result.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens)) {
    result.completionTokens = usage.completion_tokens;
  }
  return result;
}

/** Parses a non-streaming JSON completion body and returns its `usage`, if any. */
function parseUsageFromJsonBody(bodyText: string): ParsedUsage | undefined {
  try {
    return extractUsage(JSON.parse(bodyText));
  } catch {
    return undefined;
  }
}

/**
 * Parses an SSE completion body (`data: {...}\n\n` chunks, terminated by
 * `data: [DONE]`) and returns the LAST `usage` object seen across all
 * chunks — OpenRouter emits the totals-carrying chunk last, but scanning
 * every chunk (rather than assuming which one) is robust to reordering or a
 * provider that emits partial usage progressively.
 */
function parseUsageFromSseBody(bodyText: string): ParsedUsage | undefined {
  let last: ParsedUsage | undefined;
  for (const rawLine of bodyText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const usage = extractUsage(JSON.parse(payload));
      if (usage && (usage.cost !== undefined || usage.promptTokens !== undefined || usage.completionTokens !== undefined)) {
        last = usage;
      }
    } catch {
      // Ignore unparseable chunks (e.g. a stray comment/ping line) — SSE
      // legitimately has non-JSON lines.
    }
  }
  return last;
}

/**
 * Determines what to charge a key for one completed upstream request.
 * NEVER returns a "no charge" result (see module doc comment / SECURITY
 * note above) — falls through real cost -> token-estimate -> flat fallback.
 */
export function determineCost(bodyText: string, isStream: boolean): CostResult {
  const usage = isStream ? parseUsageFromSseBody(bodyText) : parseUsageFromJsonBody(bodyText);

  if (usage?.cost !== undefined) {
    return { costUsd: usage.cost, source: "usage.cost" };
  }

  if (usage?.promptTokens !== undefined || usage?.completionTokens !== undefined) {
    const totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    const costUsd = (totalTokens / 1000) * FALLBACK_COST_PER_1K_TOKENS_USD;
    return { costUsd, source: "token-estimate" };
  }

  return { costUsd: FALLBACK_FLAT_CHARGE_USD, source: "flat-fallback" };
}
