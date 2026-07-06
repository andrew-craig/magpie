// Per-job workspace: check out a PR head onto the host filesystem, then
// strip every trace of the credential that was used to fetch it.
//
// This is host-side git plumbing, not container plumbing (that's a later
// milestone — see PLAN.md M3). But per the project's capability-separation
// principle, the checkout handed off to the reviewer must already be
// credential-free even in M1, so the invariant this module establishes
// ("the workspace holds no secret worth stealing") doesn't change later.
//
// SECURITY: the installation token (see github.ts {@link buildCloneUrl}) is
// a real, live GitHub credential. This module treats it the same way
// github.ts does: never logged, never intentionally written to disk. Because
// `git` itself will transiently record the clone URL (which embeds the
// token) in a few places as a side effect of cloning/fetching — notably
// `.git/config` (`remote.origin.url`) and `.git/FETCH_HEAD` (a
// human-readable "fetched X from <url>" line) — we don't rely on avoiding
// that; we let it happen and then positively scrub every location afterward,
// every time, on every code path (see `stripCredentials` below). We never
// configure a credential helper or write a `.git-credentials` file, so the
// token is never durably persisted, only transiently written and then wiped
// before `createWorkspace` returns.
//
// CRITICAL correctness detail: we always fetch `refs/pull/{N}/head` from the
// *base* repo (the repo the PR targets), never a fork remote. GitHub exposes
// every PR's head commit as `refs/pull/{N}/head` on the base repo, so this
// one code path handles same-repo and fork PRs identically — there is
// deliberately no fork-remote handling anywhere in this file.

import { execFile as execFileCb } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCloneUrl } from "./github.js";

const execFile = promisify(execFileCb);

/** Parameters for {@link createWorkspace}. */
export interface CreateWorkspaceParams {
  owner: string;
  repo: string;
  prNumber: number;
  /** Expected PR head commit SHA; checked after checkout (see below). */
  headSha: string;
  /**
   * Installation token used as the HTTP password for the base-repo clone
   * URL. NEVER logged; see the module doc comment for how its transient
   * on-disk traces are scrubbed.
   */
  token: string;
  /** Base directory under which per-job workspace dirs are created. */
  workDir: string;
  /**
   * TEST SEAM: use this exact URL as the git remote instead of deriving one
   * from {@link buildCloneUrl}. Production callers MUST leave this
   * undefined so the real `https://x-access-token:<token>@github.com/...`
   * URL is used. Tests set it to a local `file://` path pointing at a
   * throwaway bare-repo fixture, so the whole
   * init/remote-add/fetch/checkout/strip flow can be exercised with real
   * `git` and zero network access. See workspace.test.ts.
   */
  baseUrlOverride?: string;
}

/** A checked-out, credential-free per-job workspace. */
export interface Workspace {
  /** Absolute path to the checkout. */
  dir: string;
  /**
   * Removes the entire workspace directory. Idempotent (safe to call more
   * than once) and safe to call after success, failure, or a job timeout —
   * callers should always invoke it exactly once as part of job teardown,
   * but nothing bad happens if it's invoked defensively from more than one
   * place.
   */
  cleanup: () => Promise<void>;
}

/**
 * Check out a PR head into a fresh per-job workspace directory, then strip
 * all credentials from the resulting checkout.
 *
 * Flow:
 *   1. Create `<workDir>/<owner>-<repo>-<prNumber>-<headSha>`.
 *   2. `git init` an empty repo there (no dependency on the base repo having
 *      a resolvable default branch — we only ever want one specific ref).
 *   3. Add `origin` pointing at the (tokenized, in production) clone URL.
 *   4. `git fetch --filter=blob:none origin refs/pull/{N}/head` — blobless,
 *      so large repos stay fast; missing blobs are fetched on demand by the
 *      checkout step below, while origin is still reachable/authenticated.
 *   5. `git checkout --detach FETCH_HEAD`.
 *   6. Strip credentials (see `stripCredentials`) — unconditionally, even if
 *      the next step is about to fail.
 *   7. Verify the checked-out HEAD equals `headSha`; throw if not.
 *
 * On any failure the partial workspace directory is removed before the
 * error propagates, so a caller that never receives a `Workspace` back never
 * needs to worry about an orphaned (and possibly still-credentialed, until
 * step 6 makes it not so) directory being left behind.
 */
export async function createWorkspace(
  params: CreateWorkspaceParams,
): Promise<Workspace> {
  const { owner, repo, prNumber, headSha, token, workDir } = params;
  const dir = join(workDir, `${owner}-${repo}-${prNumber}-${headSha}`);
  const cloneUrl = params.baseUrlOverride ?? buildCloneUrl(owner, repo, token);

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await mkdir(dir, { recursive: true });
    await runGit(["init", "--quiet"], dir, token);
    await runGit(["remote", "add", "origin", cloneUrl], dir, token);
    await runGit(
      ["fetch", "--quiet", "--filter=blob:none", "origin", `refs/pull/${prNumber}/head`],
      dir,
      token,
    );
    await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir, token);

    const actualSha = await gitOutput(["rev-parse", "HEAD"], dir, token);

    // Strip credentials before ever deciding whether to throw below, so a
    // sha mismatch never leaves a still-credentialed workspace on disk even
    // momentarily (cleanup() removes the directory entirely right after,
    // but belt-and-suspenders here costs nothing).
    await stripCredentials(dir, cloneUrl, token);

    if (actualSha !== headSha) {
      throw new Error(
        `workspace checkout for ${owner}/${repo}#${prNumber} landed on ` +
          `${actualSha}, expected PR head ${headSha}`,
      );
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { dir, cleanup };
}

/**
 * Remove every trace of the tokenized clone URL from the workspace:
 *
 *   - `git remote set-url origin <tokenless>` overwrites `remote.origin.url`
 *     in `.git/config` in place (the only location a credential-embedded
 *     git URL is ever stored for a named remote).
 *   - `.git/FETCH_HEAD` is deleted outright: `git fetch <ref>` writes a
 *     human-readable line there of the form `<sha>\t\t'<ref>' of <url>`,
 *     which embeds the exact URL used for the fetch (tokenized, in
 *     production). It isn't needed after `checkout` has already consumed it.
 *   - `.git/logs/` (all reflogs) is deleted outright, defensively: reflog
 *     entries can end up referencing a remote by URL rather than by name
 *     depending on the operation. This repo is single-purpose and
 *     throwaway, so reflog history has no value here.
 *
 * We never configure a credential helper or write `.git-credentials`, so
 * those aren't things this function needs to clean up — they're simply
 * never created in the first place.
 */
async function stripCredentials(
  dir: string,
  cloneUrl: string,
  token: string,
): Promise<void> {
  const tokenless = stripUrlCredentials(cloneUrl);
  await runGit(["remote", "set-url", "origin", tokenless], dir, token);
  await rm(join(dir, ".git", "FETCH_HEAD"), { force: true });
  await rm(join(dir, ".git", "logs"), { recursive: true, force: true });
}

/** Returns `url` with any embedded userinfo (e.g. `x-access-token:tok@`) removed. */
function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Not a parseable URL (shouldn't happen for our inputs) — return as-is
    // rather than throwing; there's nothing more we can safely do here.
    return url;
  }
}

/** Replaces every occurrence of `token` in `text` with a redacted placeholder. */
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("***REDACTED***") : text;
}

/**
 * Runs `git` with the given args/cwd via `execFile` (never a shell, so
 * there's no risk of the tokenized URL leaking into shell history or being
 * mangled/injected via string interpolation). On failure, the token is
 * redacted from the thrown error's `message`/`stdout`/`stderr` before it
 * propagates — git prints the failing remote URL verbatim into its own
 * error output (e.g. "repository '<url>' not found"), and that error is
 * likely to end up in job logs, so it must never carry the live token.
 */
async function runGit(args: string[], cwd: string, token: string): Promise<void> {
  try {
    await execFile("git", args, { cwd });
  } catch (err) {
    throw redactGitError(err, token);
  }
}

/** Like {@link runGit}, but returns trimmed stdout on success. */
async function gitOutput(args: string[], cwd: string, token: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, { cwd });
    return stdout.trim();
  } catch (err) {
    throw redactGitError(err, token);
  }
}

/** Redacts `token` from every string field of a caught git error, in place. */
function redactGitError(err: unknown, token: string): unknown {
  if (err instanceof Error) {
    err.message = redact(err.message, token);
    const withStreams = err as Error & { stdout?: unknown; stderr?: unknown };
    if (typeof withStreams.stdout === "string") {
      withStreams.stdout = redact(withStreams.stdout, token);
    }
    if (typeof withStreams.stderr === "string") {
      withStreams.stderr = redact(withStreams.stderr, token);
    }
  }
  return err;
}
