// Per-job workspace: check out a PR head onto the host filesystem, then
// strip every trace of the credential that was used to fetch it.
//
// This is host-side git plumbing, not container plumbing (that's a later
// milestone — see PLAN.md M3). But per the project's capability-separation
// principle, the checkout handed off to the reviewer must already be
// credential-free even in M1, so the invariant this module establishes
// ("the workspace holds no secret worth stealing") doesn't change later.
//
// SECURITY: the installation token is a real, live GitHub credential. This
// module never lets it touch the git command line or the on-disk repo at
// all. `origin` is added with a *tokenless* URL
// (`https://github.com/owner/repo.git`), so `.git/config` never contains a
// credential — not even transiently, so a crash/kill between fetch and
// teardown can't strand a token on disk. Auth for the fetch (and the
// on-demand blob fetch that the blobless checkout triggers) is supplied
// out-of-band: the token is passed to `git` via the `GIT_TOKEN` environment
// variable (readable only by this user, never exposed in `ps` /
// `/proc/<pid>/cmdline` the way a CLI argument would be) and read back by an
// ephemeral `-c credential.helper=...` shell snippet that echoes `$GIT_TOKEN`
// as the HTTP password. That snippet is passed per invocation via `-c` (never
// written to `.git/config`) and embeds only the literal string `$GIT_TOKEN`,
// not the token itself. We never write a `.git-credentials` file or a
// persistent credential helper. As defense in depth we still delete
// `.git/FETCH_HEAD` and `.git/logs` after checkout (see `stripCredentials`),
// though with a tokenless origin neither of those contains a credential
// either.
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

const execFile = promisify(execFileCb);

// Ephemeral git credential helper: reads the token from $GIT_TOKEN (set in
// the child process env by runGit/gitOutput) and hands it to git as the HTTP
// password. Passed per-invocation via `-c`, so it never lands in .git/config,
// and it embeds no secret itself — only the literal string `$GIT_TOKEN`.
const CREDENTIAL_HELPER_CONFIG =
  'credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f';

// The `-c` flags prepended to every git command that authenticates to origin.
// The first, empty-valued `credential.helper=` RESETS the accumulated helper
// list: git consults helpers in config order and stops at the first that
// returns a password, so without this reset the host's ambient system/global
// helper (e.g. `gh`'s or a keychain helper) would answer first with the wrong
// identity and silently defeat the per-job token. Clearing the list first
// makes our ephemeral helper the only one git will consult.
//
// @internal Exported only so workspace.test.ts can pin this precedence
// behavior against real `git`; not part of the module's public API.
export const CREDENTIAL_HELPER_ARGS = [
  "-c",
  "credential.helper=",
  "-c",
  CREDENTIAL_HELPER_CONFIG,
];

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
   * TEST SEAM: use this exact URL as the git remote instead of the derived
   * tokenless `https://github.com/<owner>/<repo>.git`. Production callers MUST
   * leave this undefined. Tests set it to a local `file://` path pointing at a
   * throwaway bare-repo fixture, so the whole
   * init/remote-add/fetch/checkout/strip flow can be exercised with real `git`
   * and zero network access (the `file://` transport needs no auth, so the
   * credential helper is simply never invoked). See workspace.test.ts.
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
 * Check out a PR head into a fresh per-job workspace directory. The
 * credential used to fetch it never touches the git command line or the
 * on-disk repo (see the module doc comment), so the resulting checkout is
 * credential-free by construction.
 *
 * Flow:
 *   1. Create `<workDir>/<owner>-<repo>-<prNumber>-<headSha>`.
 *   2. `git init` an empty repo there (no dependency on the base repo having
 *      a resolvable default branch — we only ever want one specific ref).
 *   3. Add `origin` pointing at the *tokenless* clone URL.
 *   4. `git -c credential.helper=... fetch --filter=blob:none origin
 *      refs/pull/{N}/head` — blobless (so large repos stay fast); auth comes
 *      from the ephemeral credential helper reading $GIT_TOKEN from the env.
 *   5. `git -c credential.helper=... checkout --detach FETCH_HEAD` — the same
 *      helper is needed here too, because the blobless clone fetches the
 *      missing blobs on demand during checkout.
 *   6. Delete FETCH_HEAD/logs (see `stripCredentials`) — defense in depth.
 *   7. Verify the checked-out HEAD equals `headSha`; throw if not.
 *
 * On any failure the partial workspace directory is removed before the error
 * propagates, so a caller that never receives a `Workspace` back never needs
 * to worry about an orphaned directory being left behind. The token is never
 * written to disk at any point (see the module doc comment), so even a crash
 * mid-flow cannot strand a credential.
 */
export async function createWorkspace(
  params: CreateWorkspaceParams,
): Promise<Workspace> {
  const { owner, repo, prNumber, headSha, token, workDir } = params;
  const dir = join(workDir, `${owner}-${repo}-${prNumber}-${headSha}`);
  const cloneUrl =
    params.baseUrlOverride ?? `https://github.com/${owner}/${repo}.git`;

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await mkdir(dir, { recursive: true });
    await runGit(["init", "--quiet"], dir, token);
    await runGit(["remote", "add", "origin", cloneUrl], dir, token);
    await runGit(
      [
        ...CREDENTIAL_HELPER_ARGS,
        "fetch",
        "--quiet",
        "--filter=blob:none",
        "origin",
        `refs/pull/${prNumber}/head`,
      ],
      dir,
      token,
    );
    await runGit(
      [...CREDENTIAL_HELPER_ARGS, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
      dir,
      token,
    );

    const actualSha = await gitOutput(["rev-parse", "HEAD"], dir, token);

    // Delete FETCH_HEAD/logs before ever deciding whether to throw below
    // (see stripCredentials — defense in depth; origin is already tokenless).
    await stripCredentials(dir);

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
 * Defense in depth after checkout: delete `.git/FETCH_HEAD` and `.git/logs`.
 *
 *   - `.git/FETCH_HEAD`: `git fetch <ref>` writes a human-readable line there
 *     of the form `<sha>\t\t'<ref>' of <url>`, embedding the origin URL used
 *     for the fetch. With a tokenless origin (see the module doc comment)
 *     that URL carries no credential, but the file isn't needed after
 *     `checkout` has consumed it, so we remove it anyway.
 *   - `.git/logs/` (all reflogs): reflog entries can reference a remote by
 *     URL depending on the operation. This repo is single-purpose and
 *     throwaway, so reflog history has no value here.
 *
 * The token is never written to `.git/config`, a `.git-credentials` file, or
 * a persistent credential helper in the first place (auth is supplied via
 * $GIT_TOKEN + an ephemeral `-c credential.helper`), so there is nothing of
 * that kind for this function to scrub.
 */
async function stripCredentials(dir: string): Promise<void> {
  await rm(join(dir, ".git", "FETCH_HEAD"), { force: true });
  await rm(join(dir, ".git", "logs"), { recursive: true, force: true });
}

/** Replaces every occurrence of `token` in `text` with a redacted placeholder. */
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("***REDACTED***") : text;
}

/**
 * Runs `git` with the given args/cwd via `execFile` (never a shell, so no
 * arg can be mangled/injected via string interpolation). The token is passed
 * to the child process only through the `GIT_TOKEN` environment variable —
 * never as a CLI argument — so it stays out of `ps` / `/proc/<pid>/cmdline`;
 * the credential helper (see `CREDENTIAL_HELPER_CONFIG`) reads it back for the
 * network operations that need it. On failure, the token is redacted from the
 * thrown error's `message`/`stdout`/`stderr` before it propagates — git prints
 * the failing remote URL verbatim into its own error output (e.g. "repository
 * '<url>' not found"), and that error is likely to end up in job logs, so it
 * must never carry the live token.
 */
async function runGit(args: string[], cwd: string, token: string): Promise<void> {
  try {
    await execFile("git", args, { cwd, env: { ...process.env, GIT_TOKEN: token } });
  } catch (err) {
    throw redactGitError(err, token);
  }
}

/** Like {@link runGit}, but returns trimmed stdout on success. */
async function gitOutput(args: string[], cwd: string, token: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      env: { ...process.env, GIT_TOKEN: token },
    });
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
