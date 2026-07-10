// Host-side filesystem helpers for the M3 review container's two bind
// mounts (see PLAN.md §4's `docker run` invocation:
// `-v <workspace>:/work:ro` and `-v <output-dir>:/out`). Both helpers here
// are pure host-side fs operations with no docker/child-process dependency
// at all — the M3-C docker runner (task_4ed4) imports them and wires their
// results into the actual `docker run` args; this module doesn't know or
// care what container consumes its output.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  await rm(join(workspaceDir, ".git"), { recursive: true, force: true });
  return workspaceDir;
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
 * Creates a fresh, per-job host temp directory (under the OS tmpdir) meant
 * to be bind-mounted at `/out` in the review container (see PLAN.md §4:
 * `-v <output-dir>:/out`). `mkdtemp` is used (rather than a predictable
 * name) so concurrent jobs never collide on the same path and so the
 * directory can't be pre-staged by anything else on the host.
 *
 * Per epic decision #4, the container process runs as the orchestrator's own
 * uid (no separate `reviewer` user mapping across the mount boundary in M3),
 * so no extra chmod/chown is needed beyond `mkdtemp`'s default `0o700` —
 * the directory is already owned by, and writable only by, this process's
 * user, which is exactly the container's runtime uid too.
 */
export async function createOutputDir(): Promise<OutputDir> {
  const outDir = await mkdtemp(join(tmpdir(), "magpie-out-"));
  const findingsPath = join(outDir, "findings.json");

  const cleanup = async (): Promise<void> => {
    await rm(outDir, { recursive: true, force: true });
  };

  return { outDir, findingsPath, cleanup };
}
