// Typed configuration loader for the magpie orchestrator.
//
// Reads a TOML config file (see /config.example.toml at the repo root for the
// template and per-field documentation), validates it, applies defaults, and
// resolves the handful of secrets that deliberately live in the environment
// rather than the TOML file (webhook secret, LLM API key, gateway master key,
// and optionally the GitHub App private key). See PLAN.md "Repository
// layout" / "Defaults chosen" for the surrounding design.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";

/** Matches "owner/repo" — no slashes, whitespace, or empty segments. */
const OWNER_REPO_RE = /^[^\s/]+\/[^\s/]+$/;

const rawConfigSchema = z
  .object({
    github: z
      .object({
        app_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
        private_key_path: z.string().min(1).optional(),
      })
      .strict(),
    llm: z
      .object({
        base_url: z.string().min(1).default("https://openrouter.ai/api/v1"),
        model: z.string().min(1),
      })
      .strict(),
    server: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(8787),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        job_timeout_seconds: z.number().int().positive().default(600),
        concurrency: z.number().int().positive().default(2),
        max_diff_lines: z.number().int().positive().default(4000),
      })
      .strict()
      .prefault({}),
    repo_allowlist: z.array(
      z.string().regex(OWNER_REPO_RE, 'must look like "owner/repo"'),
    ),
    workspace: z
      .object({
        // Must be absolute: container-mounts.ts's prepareReviewMount() does a
        // recursive force-remove of `<work_dir>/.../.git`, and a relative
        // work_dir would let that resolve against process.cwd() instead of
        // the intended workspace tree (see prepareReviewMount's own runtime
        // guard for the same invariant, belt-and-suspenders here).
        work_dir: z
          .string()
          .min(1)
          .default("/var/lib/magpie/work")
          .refine(isAbsolute, { message: "workspace.work_dir must be an absolute path" }),
      })
      .strict()
      .prefault({}),
    container: z
      .object({
        // MUST match the tag the M3-A image build produces (see PLAN.md M3
        // and docker/). Not just a convention: task_4ed4 (M3-C)'s `docker
        // run` invocation uses this value directly as the image to run.
        image: z.string().min(1).default("magpie-reviewer:0.1.0"),
        memory: z.string().min(1).default("4g"),
        cpus: z.string().min(1).default("2"),
        pids_limit: z.number().int().positive().default(256),
        docker_bin: z.string().min(1).default("docker"),
        network: z.string().min(1).default("bridge"),
      })
      .strict()
      .prefault({}),
    gateway: z
      .object({
        // Management (control) plane base URL for the credential-injecting
        // LLM gateway (M4-A, packages/gateway; PLAN.md §5). This orchestrator
        // process only ever talks to the mgmt plane (mint/revoke virtual
        // keys, see gateway.ts) — never the proxy/data plane, which the
        // review container reaches directly (M4-C wiring, not this field).
        // Default matches packages/gateway's own default
        // GATEWAY_MGMT_PORT=4100 on loopback.
        base_url: z.string().min(1).default("http://127.0.0.1:4100"),
        // Per-job USD spend cap passed as `budgetUsd` when minting a virtual
        // key (see gateway.ts's mintGatewayKeyFromConfig). This is the HARD
        // cost cap Pi itself lacks (no --max-turns/budget flag): the
        // gateway's NEXT request on a key that has crossed this stops with a
        // 402, no matter what the agent does. 0.50 is a sane single-review
        // default for typical diff sizes against Claude/GPT-class models via
        // OpenRouter; tune per provider/model pricing.
        per_job_budget_usd: z.number().positive().default(0.5),
        // Extra seconds added on top of limits.job_timeout_seconds for the
        // minted key's TTL (see gateway.ts), so the key comfortably outlives
        // the job's own wall-clock budget (including reviewer.ts's
        // SIGTERM->SIGKILL grace period and the queue's backstop timeout —
        // see queue.ts's QUEUE_TIMEOUT_GRACE_MS) and is always cleaned up by
        // an explicit revoke on cleanup rather than expiring mid-run.
        ttl_margin_seconds: z.number().int().nonnegative().default(120),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** Shape of the config once parsed, defaulted, and validated. */
export interface Config {
  github: {
    appId: string;
    /** Path to the PEM file as written in TOML, or null if only the env var was used. */
    privateKeyPath: string | null;
  };
  llm: {
    baseUrl: string;
    model: string;
  };
  server: {
    host: string;
    port: number;
  };
  limits: {
    jobTimeoutSeconds: number;
    concurrency: number;
    maxDiffLines: number;
  };
  repoAllowlist: string[];
  workspace: {
    workDir: string;
  };
  container: {
    /** Docker image tag the review container runs. See PLAN.md M3/M3-C. */
    image: string;
    /** `docker run --memory` limit, e.g. "4g". */
    memory: string;
    /** `docker run --cpus` limit, e.g. "2". */
    cpus: string;
    /** `docker run --pids-limit`. */
    pidsLimit: number;
    /** Path to the docker (or docker-compatible, e.g. podman) CLI binary. */
    dockerBin: string;
    /** `docker run --network`. "bridge" until M4 introduces `magpie-net`. */
    network: string;
  };
  gateway: {
    /** Management (control) plane base URL for `packages/gateway` (see gateway.ts). Loopback-only by the gateway's own construction — see PLAN.md §5. */
    baseUrl: string;
    /** Per-job USD spend cap passed to the gateway when minting a virtual key. The hard cost cap Pi itself lacks. */
    perJobBudgetUsd: number;
    /** Extra seconds added to `limits.jobTimeoutSeconds` for the minted key's TTL, so it outlives the job's own wall-clock budget. */
    ttlMarginSeconds: number;
  };
  /** Secrets resolved from the environment (never sourced from the TOML file). */
  secrets: {
    webhookSecret: string;
    llmApiKey: string;
    /** PEM contents of the GitHub App private key. */
    githubPrivateKey: string;
    /**
     * Bearer token authenticating this orchestrator to the gateway's
     * management plane (env: MAGPIE_GATEWAY_MASTER_KEY). Must be provisioned
     * with the SAME value as the gateway process's own
     * MAGPIE_GATEWAY_MASTER_KEY (see packages/gateway/README.md) — it is one
     * shared secret known to both processes, distinct from the gateway's
     * MAGPIE_GATEWAY_OPENROUTER_KEY (the real provider key), which this
     * orchestrator never has or needs.
     */
    gatewayMasterKey: string;
  };
}

/**
 * Thrown when config loading fails. `.message` aggregates every problem
 * found (missing/invalid fields, missing env secrets, unreadable key files)
 * as one multi-line, actionable report rather than failing on the first
 * issue found.
 */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[], configPath: string) {
    const body = problems.map((p) => `  - ${p}`).join("\n");
    super(`Invalid magpie configuration (${configPath}):\n${body}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

// Directory containing this source file at runtime (packages/orchestrator/src
// when run via tsx, packages/orchestrator/dist when run from the build).
// Computed once from import.meta.url so the DEFAULT config location never
// depends on process.cwd() — npm workspace scripts run with cwd set to the
// orchestrator package dir, but the documented config.toml location is the
// repo root, so cwd is the wrong thing to resolve against (see .env loading,
// which has the same problem and was already fixed in the package.json
// scripts via --env-file-if-exists=../../.env).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from `startDir` looking for a directory containing `filename`.
 * Returns the full path to that file, or `undefined` if no ancestor (up to
 * and including the filesystem root) contains it.
 */
function findUp(startDir: string, filename: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Walk up from `startDir` looking for the workspace/repo root, marked by a
 * `.git` entry or a `package.json` with a `workspaces` field. Falls back to
 * `startDir` itself if no marker is found on the way to the filesystem root
 * (shouldn't happen for a normal checkout, but keeps this total).
 */
function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces) return dir;
      } catch {
        // Malformed package.json on the way up — ignore and keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/**
 * Default `config.toml` location when neither an explicit path nor
 * `MAGPIE_CONFIG` is given. Independent of `process.cwd()`: walks up from
 * `startDir` (this module's own directory in production) to the nearest
 * ancestor that already contains `config.toml`, falling back to
 * `<repo-root>/config.toml` (repo root = nearest ancestor with a `.git` dir
 * or a `package.json` declaring `workspaces`) so that a missing-file error
 * still points at the conventional location. Exported as a pure,
 * dependency-injectable function so tests can exercise the walk-up logic
 * against a hermetic fixture instead of the real repo layout.
 */
export function resolveDefaultConfigPath(startDir: string): string {
  return (
    findUp(startDir, "config.toml") ??
    join(findWorkspaceRoot(startDir), "config.toml")
  );
}

function resolveConfigPath(explicit?: string): string {
  const candidate = explicit ?? process.env.MAGPIE_CONFIG;
  if (candidate) return resolvePath(process.cwd(), candidate);
  return resolveDefaultConfigPath(MODULE_DIR);
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Load and validate the magpie configuration.
 *
 * Path resolution order: `configPath` argument (resolved against
 * `process.cwd()` if relative) -> `MAGPIE_CONFIG` env var (same) ->
 * cwd-independent default (see {@link resolveDefaultConfigPath}), so the
 * default location resolves the same way whether the process is launched
 * from the repo root or from `packages/orchestrator/` (as the npm workspace
 * `dev`/`start` scripts do).
 *
 * Throws {@link ConfigError} with every problem found aggregated into one
 * message if the file is missing/malformed, required fields are missing or
 * the wrong type, required env secrets are unset, or the GitHub App private
 * key cannot be resolved (neither `MAGPIE_GITHUB_PRIVATE_KEY` nor a readable
 * `github.private_key_path` file).
 */
export function loadConfig(configPath?: string): Config {
  const resolvedPath = resolveConfigPath(configPath);
  const problems: string[] = [];

  let rawText: string;
  try {
    rawText = readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      [`could not read config file: ${reason}`],
      resolvedPath,
    );
  }

  let raw: unknown;
  try {
    raw = parseToml(rawText);
  } catch (err) {
    const reason = err instanceof TomlError ? err.message : String(err);
    throw new ConfigError([`failed to parse TOML: ${reason}`], resolvedPath);
  }

  const parsed = rawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(formatZodIssue(issue));
    }
  }

  // --- Env-var-backed secrets -------------------------------------------
  const webhookSecret = process.env.MAGPIE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    problems.push(
      "MAGPIE_WEBHOOK_SECRET env var is required (GitHub App webhook secret)",
    );
  }

  const llmApiKey = process.env.MAGPIE_LLM_API_KEY;
  if (!llmApiKey) {
    problems.push(
      "MAGPIE_LLM_API_KEY env var is required (LLM provider API key)",
    );
  }

  const gatewayMasterKey = process.env.MAGPIE_GATEWAY_MASTER_KEY;
  if (!gatewayMasterKey) {
    problems.push(
      "MAGPIE_GATEWAY_MASTER_KEY env var is required (must match the LLM gateway's own MAGPIE_GATEWAY_MASTER_KEY — see packages/gateway/README.md)",
    );
  }

  // The private key can come from the raw TOML even if other parts of the
  // document failed validation, so resolve it independently of `parsed`.
  const rawGithub =
    raw !== null && typeof raw === "object" && "github" in raw
      ? (raw as Record<string, unknown>).github
      : undefined;
  const rawPrivateKeyPath =
    rawGithub !== null && typeof rawGithub === "object" && "private_key_path" in rawGithub
      ? (rawGithub as Record<string, unknown>).private_key_path
      : undefined;

  const envPrivateKey = process.env.MAGPIE_GITHUB_PRIVATE_KEY;
  let githubPrivateKey: string | undefined;
  if (envPrivateKey) {
    githubPrivateKey = envPrivateKey;
  } else if (typeof rawPrivateKeyPath === "string" && rawPrivateKeyPath.length > 0) {
    // A relative private_key_path is what the user wrote *in the TOML file*,
    // so resolve it relative to that file's directory rather than
    // process.cwd() — otherwise the meaning of the same config.toml would
    // change depending on where the orchestrator happens to be launched
    // from, which is exactly the cwd-dependence this task removes for the
    // config file itself. Absolute paths are unaffected either way.
    try {
      githubPrivateKey = readFileSync(resolvePath(dirname(resolvedPath), rawPrivateKeyPath), "utf-8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      problems.push(
        `github.private_key_path: cannot read file "${rawPrivateKeyPath}" (${reason})`,
      );
    }
  } else {
    problems.push(
      "github.private_key_path is required (or set the MAGPIE_GITHUB_PRIVATE_KEY env var)",
    );
  }

  // If schema validation failed, `problems` is non-empty, so this single
  // throw covers both TOML-shape problems and missing secrets at once.
  if (!parsed.success || problems.length > 0) {
    throw new ConfigError(problems, resolvedPath);
  }

  const data = parsed.data;

  return {
    github: {
      appId: data.github.app_id,
      privateKeyPath: data.github.private_key_path ?? null,
    },
    llm: {
      baseUrl: data.llm.base_url,
      model: data.llm.model,
    },
    server: {
      host: data.server.host,
      port: data.server.port,
    },
    limits: {
      jobTimeoutSeconds: data.limits.job_timeout_seconds,
      concurrency: data.limits.concurrency,
      maxDiffLines: data.limits.max_diff_lines,
    },
    repoAllowlist: data.repo_allowlist,
    workspace: {
      workDir: data.workspace.work_dir,
    },
    container: {
      image: data.container.image,
      memory: data.container.memory,
      cpus: data.container.cpus,
      pidsLimit: data.container.pids_limit,
      dockerBin: data.container.docker_bin,
      network: data.container.network,
    },
    gateway: {
      baseUrl: data.gateway.base_url,
      perJobBudgetUsd: data.gateway.per_job_budget_usd,
      ttlMarginSeconds: data.gateway.ttl_margin_seconds,
    },
    secrets: {
      webhookSecret: webhookSecret!,
      llmApiKey: llmApiKey!,
      githubPrivateKey: githubPrivateKey!,
      gatewayMasterKey: gatewayMasterKey!,
    },
  };
}
