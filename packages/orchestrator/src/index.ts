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

import { loadConfig, ConfigError } from "./config.js";
import { createPullRequestFilter } from "./filter.js";
import { createReviewPipeline } from "./pipeline.js";
import { JobQueue, jobQueueOptionsFromConfig } from "./queue.js";
import { createWebhookServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const queue = new JobQueue(jobQueueOptionsFromConfig(config));
  const { runJob, cleanupJob } = createReviewPipeline(config);
  const filter = createPullRequestFilter(config, (job) => {
    // `JobQueue.enqueue` resolves with a `JobOutcome` and never rejects (see
    // queue.ts), but `EnqueueJob` only wants `void | Promise<void>` — discard
    // the resolved outcome rather than propagate it.
    void queue.enqueue(job, runJob, cleanupJob);
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
    }),
  );

  // Graceful shutdown: stop accepting new webhook deliveries and release the
  // port on SIGINT/SIGTERM. Jobs already running in the queue are not
  // forcibly cancelled here (the queue's own per-job timeout is the
  // backstop) — this only closes the HTTP listener.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", event: "shutting-down", signal }));
    server
      .close()
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

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`[magpie] ${err.message}`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[magpie] fatal startup error: ${message}`);
  }
  process.exit(1);
});
