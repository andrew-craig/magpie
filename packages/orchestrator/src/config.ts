// Typed configuration loader for the magpie orchestrator.
//
// Reads a TOML config file (see /config.example.toml at the repo root for the
// template and per-field documentation), validates it, applies defaults, and
// resolves the handful of secrets that deliberately live in the environment
// rather than the TOML file (webhook secret, LLM API key, and optionally the
// GitHub App private key). See PLAN.md "Repository layout" / "Defaults
// chosen" for the surrounding design.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
        work_dir: z.string().min(1).default("/var/lib/magpie/work"),
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
  /** Secrets resolved from the environment (never sourced from the TOML file). */
  secrets: {
    webhookSecret: string;
    llmApiKey: string;
    /** PEM contents of the GitHub App private key. */
    githubPrivateKey: string;
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

function resolveConfigPath(explicit?: string): string {
  const candidate = explicit ?? process.env.MAGPIE_CONFIG ?? "config.toml";
  return resolvePath(process.cwd(), candidate);
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Load and validate the magpie configuration.
 *
 * Path resolution order: `configPath` argument -> `MAGPIE_CONFIG` env var ->
 * `./config.toml` (relative to `process.cwd()`).
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
    try {
      githubPrivateKey = readFileSync(resolvePath(process.cwd(), rawPrivateKeyPath), "utf-8");
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
    secrets: {
      webhookSecret: webhookSecret!,
      llmApiKey: llmApiKey!,
      githubPrivateKey: githubPrivateKey!,
    },
  };
}
