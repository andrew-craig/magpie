// Entrypoint for the magpie orchestrator.
//
// Wires the modules built across the earlier milestone tasks into one running
// service: load config -> build the job queue -> build the review pipeline
// (auth -> clone -> diff -> review -> publish, see pipeline.ts) -> filter
// webhook deliveries down to review jobs (filter.ts) -> accept webhook
// deliveries (server.ts). See PLAN.md for the full design.
//
// This module intentionally contains no pipeline logic of its own — every
// stage it wires already validates/tests its own behavior in isolation
// (config.test.ts, queue.test.ts, filter.test.ts, pipeline.test.ts, ...);
// this file's only job is composition, startup, and graceful shutdown.

import { pathToFileURL } from "node:url";
import { assertMemoryControllerAvailable, MemoryControllerUnavailableError } from "./cgroup-preflight.js";
import { loadConfig, ConfigError } from "./config.js";
import { assertDockerAvailable, DockerUnavailableError } from "./docker.js";
import { createPullRequestFilter } from "./filter.js";
import { cleanupOrphanContainers } from "./orphan-cleanup.js";
import { createReviewPipeline } from "./pipeline.js";
import type { JobOutcome } from "./queue.js";
import { JobQueue, jobQueueOptionsFromConfig } from "./queue.js";
import { createWebhookServer } from "./server.js";
import type { ShutdownLogger } from "./shutdown.js";
import { drainQueue } from "./shutdown.js";

/** Minimal logger this module needs: a single pre-serialized JSON line. */
export interface JobOutcomeLogger {
  error(line: string): void;
}

/** Structured JSON-on-console logger, shared by the drain step below. */
const consoleLogger: ShutdownLogger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

/**
 * Logs the terminal outcome of a job once it settles, if that outcome is
 * `"failed"` or `"timed-out"` (successes and dedup-skips are not logged
 * here). Extracted from the queue-enqueue callback below so its output shape
 * (`event: "job-failed"`, id, outcome, error) is independently testable —
 * see index.test.ts's assertion that this never leaks the installation
 * token even for a realistic post-mint pipeline failure. This function only
 * ever serializes whatever error a pipeline stage produced; the invariant
 * that no such error ever contains the token is enforced by pipeline.ts
 * (see its module doc comment) and covered by pipeline.test.ts's
 * failure-path tests.
 */
export function logJobOutcome(outcome: JobOutcome, logger: JobOutcomeLogger = console): void {
  if (outcome.outcome !== "failed" && outcome.outcome !== "timed-out") {
    return;
  }
  const error =
    outcome.error instanceof Error
      ? {
          name: outcome.error.name,
          message: outcome.error.message,
          stack: outcome.error.stack,
        }
      : outcome.error;
  logger.error(
    JSON.stringify({
      level: "error",
      event: "job-failed",
      id: outcome.id,
      outcome: outcome.outcome,
      durationMs: outcome.durationMs,
      error,
    }),
  );
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Fail fast if docker isn't usable: M3 containerizes every review job (see
  // PLAN.md Milestone 3, docker.ts), so a broken/missing docker install
  // would otherwise only surface once the first webhook triggers a job,
  // failing every subsequent job the same way. Refusing to start at all is
  // strictly better for a self-hosted, unattended service.
  await assertDockerAvailable(config);

  // Fail fast (bug_df2d) if the review container's `--memory` limit would be
  // silently unenforced: some hosts (notably Raspberry Pi firmware defaults)
  // boot with the kernel's cgroup v2 `memory` controller disabled, which
  // makes Docker accept `--memory` and discard it with only a stderr warning
  // — a hardening flag that quietly becomes a no-op is exactly the class of
  // gap M7 "Design D"'s asserted-confinement posture exists to catch. Fails
  // closed by default (`container.requireMemoryLimit`, see config.ts); an
  // operator who understands the risk can set that to `false` to start
  // anyway. See cgroup-preflight.ts's module doc comment for the full
  // rationale and docker/reviewer/entrypoint.sh for the per-job,
  // in-container backstop over this startup-time check.
  await assertMemoryControllerAvailable(config);

  // Defence-in-depth (M3-D, see orphan-cleanup.ts): remove any `magpie-*`
  // review containers left running by a previous crash of this process
  // (normal exits, including the graceful-shutdown path below, never leave
  // one behind — see reviewer.ts's `--rm` + kill-on-timeout/abort handling).
  // Best-effort and non-fatal: never blocks startup on a docker error.
  await cleanupOrphanContainers(config);

  const queue = new JobQueue(jobQueueOptionsFromConfig(config));
  const { runJob, cleanupJob } = createReviewPipeline(config);
  const filter = createPullRequestFilter(config, (job) => {
    // `JobQueue.enqueue` resolves with a `JobOutcome` and never rejects (see
    // queue.ts). We don't block the webhook handler on it, but we DO observe
    // the settled outcome so a failed/timed-out job surfaces *why* — the queue
    // logs only the terminal status, and the error it carries would otherwise
    // be silently dropped here (the composition root is the only place that
    // sees the `JobOutcome`). The reason is never a secret: pipeline stages
    // that touch the token redact it from their own errors (see workspace.ts).
    void queue.enqueue(job, runJob, cleanupJob).then((outcome) => {
      logJobOutcome(outcome);
    });
  });
  const server = createWebhookServer(config, filter);

  await server.listen();
  console.log(
    JSON.stringify({
      level: "info",
      event: "magpie-started",
      host: config.server.host,
      port: config.server.port,
      concurrency: config.limits.concurrency,
      repoAllowlist: config.repoAllowlist,
      // Surface which container runtime is active at startup. As of M8-B2 the
      // default flipped `docker`→`podman` (rootless crun floor), so an operator
      // upgrading with a config.toml that omits `docker_bin` silently switches
      // runtimes; logging it here makes that visible in the boot line rather
      // than only surfacing on the first failed review.
      containerRuntime: config.container.dockerBin,
    }),
  );

  // Graceful shutdown, on SIGINT/SIGTERM:
  //   1. Stop accepting new webhook deliveries (`server.close()`).
  //   2. Drain already-queued/running jobs to completion, so each job's own
  //      `finally` cleanup runs (see pipeline.ts) instead of being killed
  //      mid-`await` — a bare `process.exit(0)` right after `server.close()`
  //      would forcibly terminate an in-flight job and leak its checkout dir
  //      under `workDir`. Draining is bounded by a grace timeout (see
  //      shutdown.ts's `drainQueue`) so shutdown can never hang forever; we
  //      reuse the queue's own per-job timeout (`jobQueueOptionsFromConfig`'s
  //      `jobTimeoutMs`, i.e. `jobTimeoutSeconds` PLUS the queue's backstop
  //      grace — see queue.ts) as that bound, so drain never cuts a job off
  //      before the queue's own timeout/backstop would have — a job already
  //      past that would have been timed out by the queue anyway.
  //   3. `process.exit(0)`.
  const graceMs = jobQueueOptionsFromConfig(config).jobTimeoutMs;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", event: "shutting-down", signal }));
    server
      .close()
      .then(() => drainQueue(queue, graceMs, consoleLogger))
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({ level: "error", event: "shutdown-failed", message }),
        );
        process.exit(1);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Only auto-run `main()` when this module is the actual process entrypoint
// (`node dist/index.js` / `tsx src/index.ts`), not when it's imported for its
// exports (e.g. index.test.ts importing `logJobOutcome`) — otherwise loading
// this file in a test would call `loadConfig()`/`process.exit()` for real.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    if (
      err instanceof ConfigError ||
      err instanceof DockerUnavailableError ||
      err instanceof MemoryControllerUnavailableError
    ) {
      console.error(`[magpie] ${err.message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[magpie] fatal startup error: ${message}`);
    }
    process.exit(1);
  });
}
