// Typed configuration loader for the magpie gateway.
//
// The gateway is a standalone service with its OWN process/env, deliberately
// separate from the orchestrator's `config.toml` + `MAGPIE_*` secrets (see
// packages/orchestrator/src/config.ts and CLAUDE.md's capability-separation
// principle: after M4, the real OpenRouter key lives ONLY in this process's
// environment, never the orchestrator's or the review container's). Per the
// M4-A task contract, non-secret settings are plain `GATEWAY_*` env vars
// (no TOML file for this small a surface) and the two secrets are
// `MAGPIE_GATEWAY_*`-namespaced so they're unambiguously gateway-owned even
// though they share the `MAGPIE_` prefix convention with the orchestrator's
// secrets.
//
// SECURITY: `secrets.openrouterKey` and `secrets.masterKey` must never be
// logged. This module itself never logs them; callers (index.ts,
// proxy-server.ts, admin-server.ts) must keep the same discipline — see each
// module's own doc comment.

import { z } from "zod";

/** Loopback-only guard: the mgmt plane bind host is hardcoded, not configurable — see {@link GatewayConfig.mgmt}. */
const LOOPBACK_HOST = "127.0.0.1";

/** Default root for per-job proxy-plane socket directories — see {@link GatewayConfig.socketDirRoot} and job-sockets.ts. */
const DEFAULT_SOCKET_DIR_ROOT = "/run/magpie-gateway/jobs";

const envSchema = z.object({
  MAGPIE_GATEWAY_OPENROUTER_KEY: z.string().min(1, "required (real OpenRouter API key)"),
  MAGPIE_GATEWAY_MASTER_KEY: z.string().min(1, "required (management-plane bearer auth)"),
  GATEWAY_SOCKET_DIR: z.string().min(1).default(DEFAULT_SOCKET_DIR_ROOT),
  GATEWAY_MGMT_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  GATEWAY_UPSTREAM_BASE_URL: z.string().min(1).default("https://openrouter.ai/api/v1"),
  GATEWAY_DEFAULT_MODEL: z.string().min(1).optional(),
});

/** Shape of the config once parsed, defaulted, and validated. */
export interface GatewayConfig {
  /**
   * Root directory under which each job gets its own `<sanitized-jobId>/`
   * subdirectory (mode 0711) holding that job's proxy-plane unix socket
   * (`gw.sock`, chmod 0666 after bind) — see job-sockets.ts's
   * `JobSocketManager`. Design D (DISTRIBUTION.md §2.6) replaced the old
   * single TCP proxy listener with one unix socket per job; there is no
   * longer a proxy host/port to configure. This directory is NOT chmod'd by
   * this process at startup — see index.ts's doc comment on why the parent
   * `RuntimeDirectory` is systemd's to own.
   */
  socketDirRoot: string;
  mgmt: {
    /** Bind address for the control plane (`/admin/*`). Hardcoded to loopback — not configurable, so the "mgmt never reachable from magpie-net" guarantee can't be misconfigured away. */
    host: string;
    port: number;
  };
  upstream: {
    /** OpenAI-compatible upstream base URL. Requests are forwarded to `${baseUrl}/chat/completions`. */
    baseUrl: string;
  };
  /** Optional model every minted key is scoped to when the caller doesn't ask for one. Not enforced by itself — see proxy-server.ts's per-key `model` scoping. */
  defaultModel?: string;
  /** Secrets resolved from the environment. Never sourced from a file, never logged. */
  secrets: {
    /** The real OpenRouter API key. The ONLY place it lives after M4 (PLAN.md §5). */
    openrouterKey: string;
    /** Bearer token guarding the `/admin/*` management plane. */
    masterKey: string;
  };
}

/**
 * Thrown when config loading fails. `.message` aggregates every problem found
 * into one multi-line, actionable report — mirrors
 * packages/orchestrator/src/config.ts's `ConfigError`.
 */
export class GatewayConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    const body = problems.map((p) => `  - ${p}`).join("\n");
    super(`Invalid magpie-gateway configuration:\n${body}`);
    this.name = "GatewayConfigError";
    this.problems = problems;
  }
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Load and validate the gateway configuration from `env` (defaults to
 * `process.env`). Throws {@link GatewayConfigError} with every problem found
 * if required secrets are missing or a numeric field is out of range.
 *
 * `env` is injectable so tests never have to mutate the real
 * `process.env` (mirrors config.test.ts's approach in the orchestrator
 * package, but as a pure function instead of env mutation + restore).
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new GatewayConfigError(parsed.error.issues.map(formatZodIssue));
  }
  const data = parsed.data;

  return {
    socketDirRoot: data.GATEWAY_SOCKET_DIR,
    mgmt: {
      host: LOOPBACK_HOST,
      port: data.GATEWAY_MGMT_PORT,
    },
    upstream: {
      baseUrl: data.GATEWAY_UPSTREAM_BASE_URL,
    },
    defaultModel: data.GATEWAY_DEFAULT_MODEL,
    secrets: {
      openrouterKey: data.MAGPIE_GATEWAY_OPENROUTER_KEY,
      masterKey: data.MAGPIE_GATEWAY_MASTER_KEY,
    },
  };
}
