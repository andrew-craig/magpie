// On-demand review trigger: `@magpie review` PR comment command (M6-A).
//
// This module is the `issue_comment` counterpart to filter.ts's `pull_request`
// filter: server.ts forwards every signature-verified `issue_comment`
// delivery here, unfiltered, and this module decides whether it becomes a
// fresh review job. Unlike filter.ts it is NOT pure/sync — authorizing the
// command requires a live GitHub API call (a comment's author has no
// verifiable "collaborator" claim in the webhook payload itself), so this
// module mints its own installation token and Octokit client per delivery,
// the same pattern pipeline.ts uses per job (see github.ts).
//
// Gating order: action === "created" -> comment is on a PR (not a plain
// issue) -> body matches the command -> repo allowlist -> authorization.
// Every step short-circuits to "drop, log only" on failure; only a fully
// authorized, matching, allowlisted command reaches `enqueue`.
//
// SECURITY (mirrors rereview.ts's module doc comment SECURITY section): the
// comment BODY is attacker-controlled — any PR participant, including a
// malicious PR author, can post a comment containing the literal string
// "@magpie review". Authorization therefore never keys off body content; it
// keys ONLY off `payload.comment.user.login`, a field GitHub itself asserts
// (the webhook payload is signature-verified end-to-end before it ever
// reaches this handler — see server.ts), cross-checked LIVE against
// `repos.getCollaboratorPermissionLevel` rather than trusted from the
// payload alone (a webhook payload has no "is this user still a
// collaborator right now" claim, and permissions can change between when a
// comment was posted and when this delivery is processed). Only `"write"`
// or `"admin"` permission triggers a review; anything else — including a
// GitHub API error resolving permission — is treated as unauthorized and
// produces no reply, no reaction, log only. This is the same reasoning
// rereview.ts applies to `user.type === "Bot"` identity checks: GitHub-
// asserted metadata is trustworthy, request/comment body content is not.
//
// Never throws: this is wired directly into the webhook emitter's dispatch
// path (see server.ts), and a throw there would be an unhandled exception on
// the event loop. Every branch degrades to "drop the event" plus a log line;
// the whole async body is additionally wrapped in a try/catch as a backstop.

import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";
import type { EnqueueJob } from "./filter.js";
import type { GithubAuthConfig } from "./github.js";
import { mintInstallationTokenFromConfig } from "./github.js";
import type { JobDescriptor } from "./queue.js";
import type { IssueCommentEvent, OnIssueComment } from "./server.js";

/** Matches "@magpie review" anywhere in a comment body, tolerant of surrounding text/whitespace. */
const COMMAND_RE = /@magpie\s+review\b/i;

/** GitHub collaborator permission levels this module treats as authorized to trigger a review. */
const AUTHORIZED_PERMISSIONS: ReadonlySet<string> = new Set(["write", "admin"]);

/** Minimal structured logger this module needs. Defaults to console JSON. */
export interface CommentCommandLogger {
  debug(payload: Record<string, unknown>): void;
  info(payload: Record<string, unknown>): void;
  warn(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

const consoleLogger: CommentCommandLogger = {
  debug(payload) {
    console.debug(JSON.stringify({ level: "debug", ...payload }));
  },
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  warn(payload) {
    console.warn(JSON.stringify({ level: "warn", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

/** The slice of `Config` this module needs: the repo allowlist plus GitHub App auth creds. */
export type CommentCommandConfig = Pick<Config, "repoAllowlist"> & GithubAuthConfig;

/**
 * Collaborators this module needs that touch the network or mint a secret.
 * Every field defaults to the real production implementation; tests override
 * them with offline fakes — mirrors pipeline.ts's `PipelineDeps` pattern.
 */
export interface CommentCommandDeps {
  /** Defaults to {@link mintInstallationTokenFromConfig}. */
  mintToken?: (config: CommentCommandConfig, installationId: number) => Promise<{ token: string }>;
  /** Defaults to `(token) => new Octokit({ auth: token })`. */
  makeOctokit?: (token: string) => Octokit;
}

/**
 * Loose shape we actually read off an `issue_comment` webhook payload — see
 * filter.ts's `LenientPullRequestPayload` for why this module reads through a
 * deliberately-optional local view rather than fighting `@octokit/webhooks`'
 * generated union types, and validates every field it needs at runtime.
 */
interface LenientIssueCommentPayload {
  action?: string;
  comment?: {
    id?: number;
    body?: string;
    user?: { login?: string };
  };
  issue?: {
    number?: number;
    /** Present (non-null) only when the commented-on issue is actually a PR. */
    pull_request?: unknown;
  };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
  };
  installation?: { id?: number };
}

/**
 * Build the `OnIssueComment` handler that recognizes `@magpie review`
 * commands from authorized collaborators and hands a forced-full-review job
 * to `enqueue`. See the module doc comment for the full gating order and the
 * SECURITY rationale for how authorization is decided.
 *
 * @param config  `repoAllowlist` plus the GitHub App credentials needed to
 *                mint a per-delivery installation token (see github.ts).
 * @param enqueue Seam invoked once per accepted job (see filter.ts's
 *                {@link EnqueueJob} — reused here rather than redefined).
 * @param deps    Test seams for the token mint + Octokit construction (see
 *                {@link CommentCommandDeps}); production callers (index.ts)
 *                leave these undefined.
 * @param logger  Defaults to a JSON-on-console logger.
 */
export function createIssueCommentHandler(
  config: CommentCommandConfig,
  enqueue: EnqueueJob,
  deps: CommentCommandDeps = {},
  logger: CommentCommandLogger = consoleLogger,
): OnIssueComment {
  const allowlist = new Set(config.repoAllowlist);
  const mintToken = deps.mintToken ?? mintInstallationTokenFromConfig;
  const makeOctokit = deps.makeOctokit ?? ((token: string) => new Octokit({ auth: token }));

  // Returns a Promise<void>, which TypeScript's void-return compatibility
  // rule allows to satisfy `OnIssueComment`'s `(event) => void` signature —
  // `server.ts`'s production caller discards it (fire-and-forget, matching
  // filter.ts's sync handler shape at the call site), while tests can await
  // it directly to observe the full async flow (mint token -> authorize ->
  // enqueue) instead of racing a detached promise.
  return async function handle(event: IssueCommentEvent): Promise<void> {
    try {
      const payload = event?.payload as LenientIssueCommentPayload | undefined;
      const action = payload?.action;

      if (action !== "created") {
        return;
      }

      const issue = payload?.issue;
      if (!issue || issue.pull_request === undefined || issue.pull_request === null) {
        logger.debug({ event: "comment-command-drop-not-a-pr" });
        return;
      }

      const body = payload?.comment?.body;
      if (typeof body !== "string" || !COMMAND_RE.test(body)) {
        return;
      }

      const repository = payload?.repository;
      const fullName = repository?.full_name;
      if (typeof fullName !== "string" || !allowlist.has(fullName)) {
        logger.debug({
          event: "comment-command-drop-not-allowlisted",
          fullName: fullName ?? null,
        });
        return;
      }

      const owner = repository?.owner?.login;
      const repo = repository?.name;
      const prNumber = issue.number;
      const commentId = payload?.comment?.id;
      const commenterLogin = payload?.comment?.user?.login;
      const installationId = payload?.installation?.id;

      if (
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        typeof prNumber !== "number" ||
        typeof commentId !== "number" ||
        typeof commenterLogin !== "string" ||
        typeof installationId !== "number"
      ) {
        logger.warn({
          event: "comment-command-drop-malformed-payload",
          fullName,
        });
        return;
      }

      const { token } = await mintToken(config, installationId);
      const octokit = makeOctokit(token);

      // AUTHORIZATION — see module doc comment's SECURITY section: keyed on
      // the GitHub-asserted commenter login, verified LIVE against the
      // collaborator-permission API, never on comment body content. Any
      // outcome other than "write"/"admin" — including an API error — is
      // silently unauthorized: no reply, no reaction, log only.
      let permission: string | undefined;
      try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username: commenterLogin,
        });
        permission = data.permission;
      } catch (err) {
        logger.info({
          event: "comment-command-unauthorized",
          owner,
          repo,
          prNumber,
          commenterLogin,
          reason: "permission-lookup-failed",
          error: serializeError(err),
        });
        return;
      }

      if (!AUTHORIZED_PERMISSIONS.has(permission)) {
        logger.info({
          event: "comment-command-unauthorized",
          owner,
          repo,
          prNumber,
          commenterLogin,
          permission,
        });
        return;
      }

      // The issue_comment payload's `issue.pull_request` sub-object is
      // minimal (no head SHA) — fetch the PR directly for its CURRENT head.
      // Deliberately does NOT check `draft` here (unlike filter.ts): a
      // human's explicit review request should be honored regardless of
      // draft status.
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      const headSha = pr.head?.sha;
      if (typeof headSha !== "string") {
        logger.warn({
          event: "comment-command-drop-no-head-sha",
          owner,
          repo,
          prNumber,
        });
        return;
      }

      // Best-effort ack. A reaction failure must not block the review job
      // itself — the review is the important side effect, the reaction is
      // just an acknowledgement that the command was seen.
      try {
        await octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content: "eyes",
        });
      } catch (err) {
        logger.warn({
          event: "comment-command-reaction-failed",
          owner,
          repo,
          prNumber,
          commentId,
          error: serializeError(err),
        });
      }

      const job: JobDescriptor = {
        id: randomUUID(),
        owner,
        repo,
        prNumber,
        headSha,
        baseFullName: fullName,
        installationId,
        forceFullReview: true,
      };

      logger.info({
        event: "comment-command-triggered",
        owner,
        repo,
        prNumber,
        commenterLogin,
        headSha,
      });

      await enqueue(job);
    } catch (err) {
      logger.warn({
        event: "comment-command-handler-error",
        error: serializeError(err),
      });
    }
  }
}
