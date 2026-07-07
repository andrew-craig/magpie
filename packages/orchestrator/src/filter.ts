// Event filtering + repo allowlist gating.
//
// This module is the seam between the webhook receiver (server.ts) and the
// job queue (queue.ts). `server.ts` deliberately does no filtering — it
// forwards every signature-verified `pull_request` delivery. This module
// decides which of those deliveries actually become review jobs:
//
//   - only `opened` / `ready_for_review` / `reopened` / `synchronize` PR
//     actions are ever reviewed (comments, labels, closes, etc. are ignored);
//   - draft PRs are ignored (nothing to review yet);
//   - the PR's *base* repository must be on `config.repoAllowlist` — this is
//     the last line of defense against a public GitHub App instance being
//     pointed at a repo the operator never opted in to running the reviewer
//     agent against.
//
// A `PullRequestFilter` is intentionally NOT wired to the concrete
// `JobQueue` class. It takes an injected `enqueue` callback instead, so this
// module (the actual filtering *policy*) can be unit tested with a plain
// `vi.fn()` rather than a real queue. `index.ts` (wiring, not present yet at
// the time of writing) is expected to do
// `createPullRequestFilter(config, (job) => queue.enqueue(job, runJob))`.
//
// Defensiveness: `onPullRequest` (the returned handler) is wired directly
// into the webhook server's dispatch path (see server.ts). A throw here
// would be an unhandled exception inside the `Webhooks` emitter and could
// crash or wedge the whole process on a single odd payload. Every branch
// below is therefore written to degrade to "drop the event" plus a log line
// rather than to throw, and the whole body is additionally wrapped in a
// try/catch as a backstop.

import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { JobDescriptor } from "./queue.js";
import type { OnPullRequest, PullRequestEvent } from "./server.js";

/** PR actions this module turns into review jobs. Everything else is dropped. */
const ACCEPTED_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

/**
 * Callback invoked with each job the filter decides to accept. Deliberately
 * decoupled from the concrete `JobQueue` class (see module doc comment) —
 * callers typically pass `(job) => queue.enqueue(job, runJob)`. May return
 * void or a Promise; if it returns a rejecting Promise the rejection is
 * caught and logged here rather than propagated (see {@link createPullRequestFilter}).
 */
export type EnqueueJob = (job: JobDescriptor) => void | Promise<void>;

/** Minimal structured logger this module needs. Defaults to console JSON. */
export interface FilterLogger {
  debug(payload: Record<string, unknown>): void;
  warn(payload: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

const consoleLogger: FilterLogger = {
  debug(payload) {
    console.debug(JSON.stringify({ level: "debug", ...payload }));
  },
  warn(payload) {
    console.warn(JSON.stringify({ level: "warn", ...payload }));
  },
};

/**
 * Loose shape we actually read off a `pull_request` webhook payload.
 *
 * `PullRequestEvent["payload"]` is, per `@octokit/webhooks`, a discriminated
 * union of ~20 `pull-request-*` payload variants (one per action), each with
 * its own generated type. Rather than fight that union with per-branch
 * narrowing (and still be at the mercy of a malformed/partial real-world
 * delivery, which this module must survive per the module doc comment), we
 * read through this deliberately-optional local view and validate the
 * fields we need at runtime before building a job. `before`/`after` only
 * ever exist on the `synchronize` variant; `installation` is optional on
 * every variant (GitHub's schema marks it so).
 */
interface LenientPullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    draft?: boolean;
    head?: { sha?: string };
  };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
  };
  installation?: { id?: number };
  before?: string;
  after?: string;
}

/**
 * Build the `OnPullRequest` handler that filters webhook deliveries down to
 * review jobs and hands accepted ones to `enqueue`.
 *
 * Gating order: action allowlist -> not-draft -> repo allowlist (checked
 * against the PR's *base* repository, i.e. `payload.repository.full_name` —
 * the repo the PR targets, not a fork it may come from). Repo-allowlist
 * drops are logged at debug level (expected/routine — e.g. the App
 * installed on repos beyond the ones the operator configured); anything
 * that looks like a malformed payload is logged at warn level and dropped.
 *
 * Never throws: this is wired directly into the webhook emitter's dispatch
 * path (see server.ts), and a throw there would be an unhandled exception on
 * the event loop. Every failure mode — missing fields, an unexpected
 * payload shape, `enqueue` rejecting — is caught and logged instead.
 *
 * @param config  Only `repoAllowlist` is read; accepts a `Config` or any
 *                slice that has it, so tests don't need a full fake Config.
 * @param enqueue Seam invoked once per accepted job (see {@link EnqueueJob}).
 * @param logger  Defaults to a JSON-on-console logger.
 */
export function createPullRequestFilter(
  config: Pick<Config, "repoAllowlist">,
  enqueue: EnqueueJob,
  logger: FilterLogger = consoleLogger,
): OnPullRequest {
  const allowlist = new Set(config.repoAllowlist);

  return (event: PullRequestEvent): void => {
    try {
      const payload = event?.payload as LenientPullRequestPayload | undefined;
      const action = payload?.action;

      if (typeof action !== "string" || !ACCEPTED_ACTIONS.has(action)) {
        return;
      }

      const pr = payload?.pull_request;
      if (!pr || pr.draft === true) {
        return;
      }

      const repository = payload?.repository;
      const fullName = repository?.full_name;

      if (typeof fullName !== "string" || !allowlist.has(fullName)) {
        logger.debug({
          event: "pr-filter-drop-not-allowlisted",
          fullName: fullName ?? null,
          action,
        });
        return;
      }

      const owner = repository?.owner?.login;
      const repo = repository?.name;
      const prNumber = pr.number;
      const headSha = pr.head?.sha;

      if (
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        typeof prNumber !== "number" ||
        typeof headSha !== "string"
      ) {
        logger.warn({
          event: "pr-filter-drop-malformed-payload",
          fullName,
          action,
        });
        return;
      }

      const job: JobDescriptor = {
        id: randomUUID(),
        owner,
        repo,
        prNumber,
        headSha,
        baseFullName: fullName,
        installationId: payload?.installation?.id,
      };

      if (action === "synchronize") {
        job.before = payload?.before;
        job.after = payload?.after;
      }

      // Call synchronously (not deferred via a microtask) so a caller that
      // passes a plain, non-Promise-returning `enqueue` sees it invoked
      // before this function returns. Only the *rejection* of an
      // async `enqueue` is handled asynchronously, below.
      const result = enqueue(job);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          logger.warn({
            event: "pr-filter-enqueue-error",
            id: job.id,
            error: serializeError(err),
          });
        });
      }
    } catch (err) {
      logger.warn({
        event: "pr-filter-handler-error",
        error: serializeError(err),
      });
    }
  };
}
