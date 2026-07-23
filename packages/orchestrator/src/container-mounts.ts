// Host-side filesystem helpers for the M3 review container's two bind
// mounts (see PLAN.md §4's `docker run` invocation:
// `-v <workspace>:/work:ro` and `-v <output-dir>:/out`). Both helpers here
// are pure host-side fs operations with no docker/child-process dependency
// at all — the M3-C docker runner (task_4ed4) imports them and wires their
// results into the actual `docker run` args; this module doesn't know or
// care what container consumes its output.

import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Strips `.git` from a checked-out workspace so the directory is safe to
 * bind-mount **read-only** into the review container at `/work` (see
 * PLAN.md §4: "Repo mounted read-only, with `.git` stripped so no lazy blob
 * fetch or `git` invocation can try to reach `origin`").
 *
 * Approach chosen (option (c) from task_037b's spec): delete `.git` IN PLACE
 * under `workspaceDir` and return that same directory, rather than
 * `git archive`-ing HEAD into a fresh directory or copying the whole tree
 * minus `.git`. This is the simplest option, and it's valid here specifically
 * because:
 *   - The diff Pi reviews is sourced from the GitHub API (see diff.ts), never
 *     read back out of local git history — nothing downstream re-reads
 *     `.git` for any purpose.
 *   - workspace.ts's own credential scrubbing already deletes parts of
 *     `.git` in place after checkout (`FETCH_HEAD`, `logs/` — see
 *     `stripCredentials`), so this module is continuing an established
 *     pattern rather than introducing a new one.
 *   - `workspaceDir` is single-use for the remainder of this one job: the
 *     only things that touch it after this point are the read-only container
 *     mount and the final `Workspace.cleanup()` (`rm -rf` of the whole dir),
 *     so mutating it in place doesn't strand state any other stage needs.
 * A copy/archive approach would avoid mutating the original checkout, but
 * that only matters if something else still needed an intact `.git` after
 * this call, which nothing in this pipeline does — so it would just double
 * per-job disk I/O for no behavioral benefit.
 *
 * Idempotent: safe to call again on a directory that's already had `.git`
 * removed (or never had one) — `rm(..., { force: true })` does not throw on
 * a missing path.
 */
export async function prepareReviewMount(workspaceDir: string): Promise<string> {
  // Guard the recursive force-remove below: `workspaceDir` is always
  // produced by this codebase as an absolute path (join(config.workspace.
  // workDir, ...), and work_dir is itself asserted absolute at config load —
  // see config.ts), but since a bug or bad caller passing "" or a relative
  // path here would make `rm(..., { recursive: true, force: true })` resolve
  // against `process.cwd()` instead, fail loudly before it ever runs rather
  // than risk deleting the wrong directory tree.
  if (!isAbsolute(workspaceDir)) {
    throw new Error(
      `prepareReviewMount requires an absolute workspace path, got: "${workspaceDir}"`,
    );
  }
  await rm(join(workspaceDir, ".git"), { recursive: true, force: true });
  return workspaceDir;
}

/**
 * Thrown by {@link assertGitStripped} when a `.git` entry is still present in a
 * directory about to be bind-mounted read-only at `/work`.
 */
export class GitNotStrippedError extends Error {
  constructor(mountDir: string) {
    super(
      `review mount ${mountDir} still contains a .git directory — refusing to mount it into the ` +
        `review container (a live .git could trigger a lazy blob fetch or a git invocation that ` +
        `reaches origin; see prepareReviewMount and PLAN.md §4)`,
    );
    this.name = "GitNotStrippedError";
  }
}

/**
 * Fail-closed runtime assertion (task_bfaf) that `mountDir` has NO `.git` entry
 * — the mount-preparation counterpart to reviewer.ts's `findMissingHardenedFlags`
 * argv preflight, extending the pinned hardened posture beyond the `docker run`
 * argv (which the M8-B1 golden covers) to the `.git`-stripped read-only `/work`
 * mount (which it does not). {@link prepareReviewMount} strips `.git`; this
 * re-checks it immediately before launch so a strip that silently did not take
 * effect (a permission error swallowed upstream, a `.git` re-materialised by a
 * concurrent process, a future refactor that drops the strip) FAILS the job
 * closed instead of mounting a live `.git` into the reviewer. Throws
 * {@link GitNotStrippedError} if `.git` is present; resolves silently otherwise.
 */
export async function assertGitStripped(mountDir: string): Promise<void> {
  try {
    await access(join(mountDir, ".git"));
  } catch {
    // `.git` is absent (access rejected) — the required posture. This is the
    // success path.
    return;
  }
  // `access` resolved ⇒ `.git` still exists ⇒ posture violated.
  throw new GitNotStrippedError(mountDir);
}

/** Result of {@link createOutputDir}. */
export interface OutputDir {
  /** Absolute path to the per-job host temp dir, meant for `-v <outDir>:/out`. */
  outDir: string;
  /** `join(outDir, "findings.json")` — where the container is expected to write structured findings. */
  findingsPath: string;
  /**
   * Removes `outDir` and everything under it. Idempotent (safe to call more
   * than once, and safe if `outDir` was never written to) — callers should
   * invoke it exactly once as part of job teardown, but nothing bad happens
   * if it's invoked defensively from more than one place (mirrors
   * workspace.ts's `Workspace.cleanup()` contract).
   */
  cleanup: () => Promise<void>;
}

/**
 * Creates a fresh, per-job host directory meant to be bind-mounted at `/out`
 * in the review container (see PLAN.md §4: `-v <output-dir>:/out`). `mkdtemp`
 * is used (rather than a predictable name) so concurrent jobs never collide on
 * the same path and so the directory can't be pre-staged by anything else on
 * the host.
 *
 * `baseDir` is the parent under which that per-job dir is created. It MUST be
 * a path the Docker DAEMON can resolve in its own (host) mount namespace,
 * because `docker run -v <outDir>:/out` is resolved daemon-side, not by this
 * process. That rules out the OS tmpdir under systemd: `magpie.service` runs
 * with `PrivateTmp=true` (see systemd/magpie.service), which gives this
 * process a PRIVATE `/tmp` the daemon can't see — so an `/out` created there
 * would mount as an empty, root-owned dir the `--user`-dropped container can't
 * write `findings.json` into, silently failing every review with "pi did not
 * call report_findings". Callers in the systemd deployment therefore pass
 * `config.workspace.workDir` (`/var/lib/magpie/work`, the StateDirectory tree
 * that already backs the `/work` mount and IS host-visible). The default stays
 * the OS tmpdir for non-systemd/dev/test callers that share the daemon's
 * namespace. `mkdir(baseDir, { recursive: true })` first so a not-yet-created
 * base (e.g. before the first job) doesn't make `mkdtemp` fail.
 *
 * Per epic decision #4, the container process runs as the orchestrator's own
 * uid (no separate `reviewer` user mapping across the mount boundary in M3),
 * so no extra chmod/chown is needed beyond `mkdtemp`'s default `0o700` —
 * the directory is already owned by, and writable only by, this process's
 * user, which is exactly the container's runtime uid too.
 *
 * `baseDir` must be absolute: the `-v <outDir>:/out` mount is resolved
 * daemon-side (see above), and the `mkdir(..., { recursive: true })` below
 * would otherwise create a stray tree under `process.cwd()`. As with
 * {@link prepareReviewMount}, config-supplied paths (`config.workspace.workDir`)
 * are already asserted absolute at config load and the default `tmpdir()` is
 * absolute, so this only ever fires on a bad/relative caller — fail loudly
 * before touching the filesystem rather than write to the wrong place.
 */
export async function createOutputDir(baseDir: string = tmpdir()): Promise<OutputDir> {
  if (!isAbsolute(baseDir)) {
    throw new Error(
      `createOutputDir requires an absolute baseDir path, got: "${baseDir}"`,
    );
  }
  await mkdir(baseDir, { recursive: true });
  const outDir = await mkdtemp(join(baseDir, "magpie-out-"));
  const findingsPath = join(outDir, "findings.json");

  const cleanup = async (): Promise<void> => {
    await rm(outDir, { recursive: true, force: true });
  };

  return { outDir, findingsPath, cleanup };
}
