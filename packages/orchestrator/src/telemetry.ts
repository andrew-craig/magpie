// Per-job cost/outcome telemetry (M5-D, task_8a10 — see PLAN.md §6).
//
// The reviewer already parses Pi's self-reported NDJSON usage (reviewer.ts's
// `ReviewUsage`) and the published PR comment carries a compact usage footer
// (publisher.ts's `formatUsageFooter`) — but neither of those is DURABLE or
// GREPPABLE across jobs: the footer only exists on GitHub, and Pi's own
// number is the model's self-report, not what was actually billed. This
// module is the durable, per-job record: exactly ONE structured line per
// job, containing enough to answer "what did this review cost, how long did
// it take, and how did it end" without a dashboard — `grep` is the query
// interface (see the module's `event: "job-telemetry"` tag below).
//
// COST OF RECORD: `costUsd` is the gateway's own tracked spend
// (`gateway.spentUsd`, threaded from gateway.ts's `revokeGatewayKey` — see
// its `GatewayKeyRevocation` doc comment) when a gateway key was involved in
// this job, because that is what was actually debited from OpenRouter's own
// `usage.cost` (packages/gateway/src/upstream.ts's `determineCost`) — not
// what the model self-reported. Pi's own usage (`usage`) is still recorded
// alongside it for cross-checking, but is never the authoritative number.
// Falls back to Pi's self-reported cost only when no gateway spend is
// available at all (e.g. the gateway revoke call itself failed — see
// gateway.ts's doc comment on why that resolves `undefined` rather than
// throwing), and to 0 when NEITHER source has anything to report (e.g. a job
// that failed before ever minting a key).
//
// TWO SINKS, BY DESIGN: every record is ALWAYS emitted as one structured log
// line via `logger.info` (this alone satisfies "greppable" — journald/systemd
// captures it with no extra setup) and is ALSO best-effort appended as one
// JSONL line to `path` (default `/var/lib/magpie/telemetry.jsonl`, see
// config.ts's `telemetry.path`). The JSONL append is allowed to fail (e.g. a
// dev box with no `/var/lib/magpie`, or a permissions problem) — that failure
// is itself logged (not thrown) and never masks or delays the job's own
// result, since the log line already recorded the same data durably enough
// for grep-based operations.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReviewUsage } from "./reviewer.js";

/**
 * Distinct terminal classes for a job, chosen so a "runaway cost" pattern
 * (repeated `timeout-kill`/`budget-exhausted`) is visible from the outcome
 * field alone, without parsing `reason` text:
 *  - `success`             — a real review ran and was published (findings or none).
 *  - `diff-too-large`      — skipped (summary-only) because the diff exceeded the size cap.
 *  - `already-reviewed`    — M5-C dedup: this head SHA was already reviewed; no-op.
 *  - `head-sha-mismatch`   — a force-push landed mid-job; skipped without publishing.
 *  - `timeout-kill`        — reviewer.ts's own wall-clock timeout killed the container.
 *  - `aborted`             — the queue's backstop signal (or an external abort) killed the job.
 *  - `budget-exhausted`    — the gateway's final spend reached/exceeded the key's budget.
 *  - `error`               — any other failure (thrown error, non-zero exit, invalid findings, ...).
 */
export type JobOutcome =
  | "success"
  | "diff-too-large"
  | "already-reviewed"
  | "head-sha-mismatch"
  | "timeout-kill"
  | "aborted"
  | "budget-exhausted"
  | "error";

/** The gateway's authoritative final-spend snapshot for this job's virtual key, when one was minted — see gateway.ts's `GatewayKeyRevocation`. */
export interface TelemetryGatewaySpend {
  keyId: string;
  spentUsd: number;
  budgetUsd: number;
}

/** One job's full structured telemetry record — see this module's doc comment for field rationale. */
export interface JobTelemetryRecord {
  event: "job-telemetry";
  timestamp: string;
  jobId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  outcome: JobOutcome;
  /** Wall-clock duration of the whole job (mint -> ... -> cleanup), in milliseconds. */
  durationMs: number;
  /** Authoritative cost figure — see module doc comment's "COST OF RECORD" section. */
  costUsd: number;
  /** Pi's own self-reported usage for this run, when any assistant turn was parsed (see reviewer.ts's `ReviewUsage`). Absent when no turn ever ran (e.g. a pre-review failure). */
  usage?: ReviewUsage;
  /** The gateway's final spend for this job's virtual key, when one was minted and the gateway's revoke response reported it (see gateway.ts). Absent when no gateway key was involved, or the gateway's spend couldn't be read. */
  gateway?: TelemetryGatewaySpend;
  /** Failure/skip detail. Present on every non-`success` outcome; absent on `success`. */
  reason?: string;
}

/** Minimal structured logger this module needs. Defaults to console JSON, mirroring pipeline.ts's own `consoleLogger`. */
export interface TelemetryLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

const consoleLogger: TelemetryLogger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

/** Default JSONL sink, matching config.ts's `telemetry.path` default — used only when a caller doesn't pass `path` explicitly (production always does, via `config.telemetry.path`). */
export const DEFAULT_TELEMETRY_PATH = "/var/lib/magpie/telemetry.jsonl";

/** Inputs to {@link recordJobTelemetry}. */
export interface RecordJobTelemetryParams {
  /** Every field except `event`/`timestamp`, which this function fills in. */
  record: Omit<JobTelemetryRecord, "event" | "timestamp">;
  /** JSONL append target. Defaults to {@link DEFAULT_TELEMETRY_PATH}; production callers pass `config.telemetry.path`. */
  path?: string;
  logger?: TelemetryLogger;
}

/**
 * Emit one job's telemetry record. ALWAYS logs it as one structured line
 * (`logger.info`) first — this never fails, so it's the floor guarantee this
 * module makes. THEN best-effort appends the same record as one JSONL line to
 * `path` (creating its parent directory first): a failure here (permissions,
 * missing mount, read-only filesystem — e.g. a dev box with no
 * `/var/lib/magpie`) is caught, logged via `logger.error`, and never thrown —
 * the log line already recorded the same data, so a durability-layer failure
 * must not affect the job it's reporting on (which has, by this point,
 * already fully settled).
 */
export async function recordJobTelemetry(params: RecordJobTelemetryParams): Promise<void> {
  const logger = params.logger ?? consoleLogger;
  const path = params.path ?? DEFAULT_TELEMETRY_PATH;
  const full: JobTelemetryRecord = {
    event: "job-telemetry",
    timestamp: new Date().toISOString(),
    ...params.record,
  };

  // Floor guarantee: a structured, greppable log line. Never throws.
  logger.info(full as unknown as Record<string, unknown>);

  // Best-effort durable JSONL append.
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(full)}\n`, "utf-8");
  } catch (err) {
    logger.error({
      event: "telemetry-write-failed",
      path,
      jobId: full.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
