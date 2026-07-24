// Typed configuration loader for the magpie orchestrator.
//
// Reads a TOML config file (see /config.example.toml at the repo root for the
// template and per-field documentation), validates it, applies defaults, and
// resolves the handful of secrets that deliberately live in the environment
// rather than the TOML file (webhook secret, gateway master key, and
// optionally the GitHub App private key). See PLAN.md "Repository layout" /
// "Defaults chosen" for the surrounding design.
//
// NOTE (M4-C): there is no LLM provider API key here. The real OpenRouter
// key now lives ONLY in packages/gateway's own process env
// (MAGPIE_GATEWAY_OPENROUTER_KEY) — this orchestrator mints a short-lived,
// budget-capped virtual key per job against the gateway's management plane
// (gateway.ts, authenticated with secrets.gatewayMasterKey below) instead of
// ever holding a long-lived provider credential itself.

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
        // The reviewer image the review container runs. As of M7-2
        // (DISTRIBUTION.md §3.1) this is PULLED from GHCR rather than built
        // locally: it's published multi-arch (amd64+arm64), cosign-signed with
        // SLSA provenance by .github/workflows/release-reviewer.yml on
        // `reviewer-v*` tags, and is the ONLY container in the product
        // (orchestrator + gateway are host services). Not just a convention:
        // task_4ed4 (M3-C)'s `docker run` invocation uses this value directly
        // as the image to run. The default is PINNED BY DIGEST (the `@sha256:`
        // below is the multi-arch image-index digest published by the
        // `reviewer-v0.2.0` tag) so a re-tagged upstream image can't silently
        // swap the untrusted-content runtime under you — the tag portion is
        // human-readable provenance only; the digest is what docker resolves.
        // `scripts/build-reviewer-image.sh` still builds a local
        // `magpie-reviewer:*` image for development (override this to use it).
        image: z
          .string()
          .min(1)
          .default(
            "ghcr.io/andrew-craig/magpie/reviewer:0.2.0@sha256:e6a6e118ce46392dffaf172afa35af2ff6c8ff375d37dd403e9d6ac77c1f3aed",
          ),
        memory: z.string().min(1).default("4g"),
        cpus: z.string().min(1).default("2"),
        pids_limit: z.number().int().positive().default(256),
        // M8-B2: the review-container runtime. Defaults to `podman` (rootless,
        // no root daemon, no `docker` group) — the M8 "crun floor" rootless
        // substrate (docs/design/cto-decision-brief.md §5). Any docker-
        // compatible CLI still works via this seam (set it to `docker` or a
        // full path). reviewer.ts keys the one rootless-only argv difference —
        // `--userns=keep-id` — off whether this binary's basename is `podman`
        // (see isPodmanBinary), so a `docker` value reproduces the exact
        // pre-M8-B2 argv. NOTE: running podman rootless as the `magpie` service
        // user needs subuid/subgid + linger provisioning; that installer/
        // systemd work is M8-D3 (task_67aa).
        docker_bin: z.string().min(1).default("podman"),
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
        // Container-facing PROXY (data) plane base URL — where the review
        // CONTAINER itself sends chat-completions requests (M4-C). This is a
        // SEPARATE address from `base_url` above on purpose: `base_url` is
        // the loopback-only mgmt plane this orchestrator process calls to
        // mint/revoke keys, while this one is what the review container
        // itself is pointed at. As of M7-1 (Design D — see DISTRIBUTION.md
        // §2) the reviewer runs `--network none` and has no bridge/host
        // route at all; this address is served by a tiny in-container
        // TCP->unix forwarder listening on the container's OWN loopback
        // (which `--network none` leaves intact) that relays to the per-job
        // unix socket bind-mounted at `/run/gw/gw.sock` (see reviewer.ts's
        // `gatewaySocketDir` mount). Default matches the gateway's own
        // default GATEWAY_PROXY_PORT=4000 on that in-container loopback,
        // with the `/v1` suffix `pi`'s OpenAI-compatible provider config
        // expects (see reviewer.ts's module doc comment on how this reaches
        // Pi — a `~/.pi/agent/models.json` provider-baseUrl override written
        // by docker/reviewer/entrypoint.sh, NOT an env var Pi itself reads).
        container_base_url: z.string().min(1).default("http://127.0.0.1:4000/v1"),
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
    telemetry: z
      .object({
        // Append-only JSONL sink for per-job cost/outcome telemetry (M5-D,
        // task_8a10 — see telemetry.ts). One line per job: repo/PR/head SHA,
        // outcome (success/diff-too-large/timeout-kill/budget-exhausted/...),
        // wall-clock duration, Pi's self-reported token usage, and the
        // gateway's own authoritative final spend when a gateway key was
        // involved. Same host-visible-tree rationale as workspace.work_dir
        // above: must be a path this process can create/append to. A dev box
        // without /var/lib/magpie (or without write access to it) doesn't
        // fail the job — recordJobTelemetry degrades to a log-line-only
        // fallback (see telemetry.ts) rather than throwing.
        path: z.string().min(1).default("/var/lib/magpie/telemetry.jsonl"),
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
    /** Path to the review-container runtime CLI. Defaults to `podman` (rootless; M8-B2); any docker-compatible CLI works. See config schema above. */
    dockerBin: string;
  };
  gateway: {
    /** Management (control) plane base URL for `packages/gateway` (see gateway.ts). Loopback-only by the gateway's own construction — see PLAN.md §5. */
    baseUrl: string;
    /**
     * Container-facing PROXY (data) plane base URL (M4-C) — passed into the
     * review container's env as `OPENAI_BASE_URL` (see reviewer.ts) and
     * translated by docker/reviewer/entrypoint.sh into a `~/.pi/agent/
     * models.json` `openrouter` provider `baseUrl` override, which is the
     * mechanism that actually redirects Pi's traffic (Pi 0.80.3 has no
     * generic env-var base-URL override — see reviewer.ts's module doc
     * comment). Deliberately a SEPARATE value from `baseUrl` above: that one
     * is this orchestrator's loopback-only mgmt-plane address; this one is
     * an address inside the review container's OWN network namespace (M7-1:
     * the container runs `--network none`, so this resolves to the
     * container's own loopback, served by the in-container forwarder that
     * relays to the mounted gateway unix socket — see DISTRIBUTION.md §2.2).
     */
    containerBaseUrl: string;
    /** Per-job USD spend cap passed to the gateway when minting a virtual key. The hard cost cap Pi itself lacks. */
    perJobBudgetUsd: number;
    /** Extra seconds added to `limits.jobTimeoutSeconds` for the minted key's TTL, so it outlives the job's own wall-clock budget. */
    ttlMarginSeconds: number;
  };
  telemetry: {
    /** Append-only JSONL path for per-job cost/outcome telemetry (M5-D — see telemetry.ts). */
    path: string;
  };
  /** Secrets resolved from the environment (never sourced from the TOML file). */
  secrets: {
    webhookSecret: string;
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

  // NOTE: there is deliberately no MAGPIE_LLM_API_KEY here (M4-C — CTO
  // decision). The real OpenRouter key now lives ONLY in the gateway
  // process's own env (MAGPIE_GATEWAY_OPENROUTER_KEY, see
  // packages/gateway/README.md); this orchestrator never holds it, so it
  // can't leak it into the reviewer/container path even by accident. The
  // review container instead authenticates to the gateway with a per-job
  // virtual key minted via MAGPIE_GATEWAY_MASTER_KEY below (see gateway.ts,
  // pipeline.ts, reviewer.ts).
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
    },
    gateway: {
      baseUrl: data.gateway.base_url,
      containerBaseUrl: data.gateway.container_base_url,
      perJobBudgetUsd: data.gateway.per_job_budget_usd,
      ttlMarginSeconds: data.gateway.ttl_margin_seconds,
    },
    telemetry: {
      path: data.telemetry.path,
    },
    secrets: {
      webhookSecret: webhookSecret!,
      githubPrivateKey: githubPrivateKey!,
      gatewayMasterKey: gatewayMasterKey!,
    },
  };
}
