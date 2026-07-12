// Per-job virtual-key lifecycle against the host-side LLM gateway (M4-B; see
// packages/gateway and PLAN.md §5).
//
// The gateway (a separate process, `packages/gateway`) holds the one real
// OpenRouter key and exposes a small, loopback-only management API — see
// packages/gateway/README.md's "Management plane" section and
// packages/gateway/src/admin-server.ts, which this module is written against
// exactly: `POST /admin/keys` mints a fresh, budget-capped, TTL-limited
// virtual key (`201 { id, key }`); `DELETE /admin/keys/:id` revokes one,
// idempotently (`204`, even for an unknown/already-revoked id). This module
// is the orchestrator-side half of that contract: mint one fresh virtual key
// per review job (mirrors github.ts's "mint fresh per job, no cross-job
// cache" principle) and revoke it during the pipeline's cleanup, on every
// exit path — success, failure, timeout, and abort alike (see pipeline.ts,
// which wires the calls below into its existing per-job try/finally).
//
// SECURITY:
//  - The master key (`config.secrets.gatewayMasterKey`, from
//    MAGPIE_GATEWAY_MASTER_KEY) authenticates every call this module makes.
//    It is a live credential for the gateway's control plane and must never
//    be logged or included in a thrown Error's message — this module only
//    ever puts it in the `Authorization` request header, never in a URL,
//    argv, or a log/error payload.
//  - The minted virtual key (`GatewayKey.key`) is likewise never logged here.
//    As of M4-C, pipeline.ts threads it into reviewer.ts's `runReview` as
//    `gatewayApiKey`, which sets it as the review container's
//    `-e OPENROUTER_API_KEY` — the orchestrator no longer loads a real
//    provider key at all (see config.ts: `secrets.llmApiKey` was removed),
//    so this virtual key is the ONLY OpenRouter-shaped credential the
//    reviewer path ever sees.
//  - `revokeGatewayKey` is BEST-EFFORT and NEVER THROWS (mirrors
//    orphan-cleanup.ts's `cleanupOrphanContainers` and reviewer.ts's
//    `output.cleanup()`): a revoke failure (network hiccup, gateway
//    unreachable) is logged and swallowed, never allowed to mask or replace
//    the job's actual result. The gateway's own revoke endpoint is also
//    idempotent, so a spurious double-revoke, or revoking a key that has
//    already expired on its own, is always safe.
//  - `mintGatewayKey` DOES throw on failure (mirrors github.ts's
//    `mintInstallationToken`): a job that can't get a virtual key can't be
//    reviewed safely (there would be nothing to pass to the container), so a
//    mint failure propagates like any other pre-workspace pipeline failure —
//    the job is recorded failed and no gateway key was ever allocated, so
//    there is nothing for cleanup to revoke.

import { z } from "zod";
import type { Config } from "./config.js";

/** Gateway management-plane credentials this module needs. Narrower than the full {@link Config} so tests/callers can pass just what they have (mirrors github.ts's `GithubAuthConfig`). */
export interface GatewayAuthConfig {
  gateway: { baseUrl: string };
  secrets: { gatewayMasterKey: string };
}

/** A minted virtual key. Exactly the gateway's `POST /admin/keys` response shape (see admin-server.ts). */
export interface GatewayKey {
  id: string;
  key: string;
}

/** Inputs to {@link mintGatewayKey}, mirroring the gateway's mint request body exactly (see admin-server.ts's `mintKeyBodySchema`). */
export interface MintGatewayKeyOptions {
  /** Scopes the minted key to one model; the gateway overrides any `model` the client's request specifies. Omit for an unscoped key. */
  model?: string;
  /** Hard USD spend cap enforced by the gateway; the NEXT request once spend reaches this is refused with 402, regardless of what the agent does next. */
  budgetUsd: number;
  /** Key lifetime in seconds, starting from mint time. */
  ttlSeconds: number;
}

/** Minimal structured logger this module needs (only the `error` level — mint failures propagate as thrown Errors instead of being logged here). */
export interface GatewayLogger {
  error(payload: Record<string, unknown>): void;
}

const consoleLogger: GatewayLogger = {
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

/** Validates the gateway's mint response shape before trusting it — the response crosses a process boundary (loopback HTTP), so it's parsed defensively like every other external-input trust boundary in this codebase (see findings.ts). */
const mintResponseSchema = z.object({ id: z.string().min(1), key: z.string().min(1) }).strict();

/**
 * Per-call timeout for the loopback HTTP calls to the gateway's management
 * plane. The gateway is a local process answering trivial in-memory
 * mint/revoke operations, so a call that takes longer than this is hung, not
 * slow — without a bound, an unresponsive gateway would block a queue worker
 * until the far coarser per-job wall-clock backstop (see queue.ts) fired.
 * Kept well under that backstop so a stuck mint surfaces as a fast, clean job
 * failure instead of a stall, and a stuck revoke is abandoned (best-effort;
 * never throws) rather than delaying cleanup.
 */
const GATEWAY_REQUEST_TIMEOUT_MS = 5000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strips any trailing slash so `${baseUrl}/admin/keys` never ends up with a doubled `//`. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Best-effort, non-secret detail extracted from a non-2xx gateway response, for a readable thrown-Error message. Never throws itself — a body read/parse failure just yields a generic placeholder rather than masking the original HTTP status. */
async function safeReadErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.trim().length > 0 ? text.slice(0, 500) : "(empty response body)";
  } catch {
    return "(failed to read response body)";
  }
}

/**
 * Mint a fresh virtual key on the gateway's management plane.
 *
 * `POST {gateway.baseUrl}/admin/keys` with `Authorization: Bearer
 * <masterKey>` and the given `{ model?, budgetUsd, ttlSeconds }` body. Throws
 * on any failure — unreachable gateway, non-201 response, or an
 * unparseable/wrong-shaped response body — rather than ever returning a
 * partial or placeholder key (see module doc comment: a job that can't mint a
 * key can't safely run a review). The thrown Error's message never contains
 * `masterKey` or a minted `key` value.
 */
export async function mintGatewayKey(
  gateway: GatewayAuthConfig,
  options: MintGatewayKeyOptions,
): Promise<GatewayKey> {
  const url = joinUrl(gateway.gateway.baseUrl, "/admin/keys");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gateway.secrets.gatewayMasterKey}`,
      },
      body: JSON.stringify({
        ...(options.model !== undefined ? { model: options.model } : {}),
        budgetUsd: options.budgetUsd,
        ttlSeconds: options.ttlSeconds,
      }),
      signal: AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`failed to reach LLM gateway management API (${url}): ${errorMessage(err)}`);
  }

  if (res.status !== 201) {
    const detail = await safeReadErrorDetail(res);
    throw new Error(`LLM gateway rejected virtual-key mint request (HTTP ${res.status}): ${detail}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`LLM gateway returned an unparseable virtual-key mint response: ${errorMessage(err)}`);
  }

  const parsed = mintResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`LLM gateway returned an unexpected virtual-key mint response shape: ${detail}`);
  }

  return parsed.data;
}

/**
 * Revoke a virtual key by id on the gateway's management plane.
 *
 * `DELETE {gateway.baseUrl}/admin/keys/:id` with `Authorization: Bearer
 * <masterKey>`. BEST-EFFORT and NEVER THROWS (see module doc comment): any
 * failure — unreachable gateway, unexpected status — is logged via `logger`
 * and swallowed. Safe to call more than once for the same id (the gateway's
 * revoke endpoint is itself idempotent) and safe to call for an id that never
 * existed or has already expired.
 */
export async function revokeGatewayKey(
  gateway: GatewayAuthConfig,
  id: string,
  logger: GatewayLogger = consoleLogger,
): Promise<void> {
  const url = joinUrl(gateway.gateway.baseUrl, `/admin/keys/${encodeURIComponent(id)}`);
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${gateway.secrets.gatewayMasterKey}` },
      signal: AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 204) {
      const detail = await safeReadErrorDetail(res);
      logger.error({ event: "gateway-key-revoke-failed", id, status: res.status, detail });
    }
  } catch (err) {
    logger.error({ event: "gateway-key-revoke-failed", id, error: errorMessage(err) });
  }
}

/**
 * Convenience adapter: mint a virtual key using settings pulled from the
 * loaded {@link Config} rather than passing them by hand (mirrors github.ts's
 * `mintInstallationTokenFromConfig`). Scopes the key to `config.llm.model`
 * (so a leaked key is worthless against any other, possibly pricier, model),
 * spends up to `config.gateway.perJobBudgetUsd`, and sets a TTL of
 * `config.limits.jobTimeoutSeconds + config.gateway.ttlMarginSeconds` — the
 * margin over the job's own wall-clock budget so the key comfortably outlives
 * the review (including reviewer.ts's SIGTERM->SIGKILL grace period and the
 * queue's own backstop timeout, see queue.ts's `QUEUE_TIMEOUT_GRACE_MS`) and
 * is always cleaned up by an explicit revoke on cleanup rather than expiring
 * mid-run.
 */
export function mintGatewayKeyFromConfig(
  config: Pick<Config, "gateway" | "llm" | "limits" | "secrets">,
): Promise<GatewayKey> {
  return mintGatewayKey(config, {
    model: config.llm.model,
    budgetUsd: config.gateway.perJobBudgetUsd,
    ttlSeconds: config.limits.jobTimeoutSeconds + config.gateway.ttlMarginSeconds,
  });
}

/** Convenience adapter for {@link revokeGatewayKey}, mirroring {@link mintGatewayKeyFromConfig}. */
export function revokeGatewayKeyFromConfig(
  config: Pick<Config, "gateway" | "secrets">,
  id: string,
  logger?: GatewayLogger,
): Promise<void> {
  return revokeGatewayKey(config, id, logger);
}
