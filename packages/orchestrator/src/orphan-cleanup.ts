// Best-effort orphan-container/process/scratch-dir cleanup for the magpie
// orchestrator (M3-D containers; M8-C5 extends this to the micro-VM
// substrate — task_df53).
//
// Runtime-neutral: the container reap uses the same `config.container.dockerBin`
// seam the launcher uses, and the four verbs it needs — `version`,
// `ps -aq --filter name=magpie-`, `kill`, `rm -f` — are byte-identical under
// rootless podman (the M8-B2 default) and docker, so the docker→podman port
// needs NO change here (empirically confirmed against podman 4.3.1).
//
// Every review job's container is normally removed by `docker run --rm`
// (see reviewer.ts) the instant it exits, and the timeout/abort path
// additionally `docker kill`s it directly (also reviewer.ts). Neither of
// those paths runs at all if the orchestrator PROCESS ITSELF dies mid-job
// (e.g. `kill -9`, an OOM, a host crash/reboot) — in that case a
// `magpie-<jobid>` container can be left running with nothing left alive to
// kill or reap it. This module is the defence-in-depth backstop for exactly
// that scenario: on startup (see index.ts's composition root, called right
// after the docker preflight check so we know `docker` is usable at all),
// find every container whose name starts with `magpie-` and force-remove it.
//
// Deliberately NOT `docker ps -aq --filter name=magpie- | xargs -r docker rm
// -f` as a literal shell pipe: this module never spawns a shell, so there's
// no quoting/injection surface at all. Instead it's two plain `execFile`
// calls — list, then (if the list is non-empty) remove — composed in TS.
//
// M8-C5 ORPHAN-POPULATION AUDIT (task_df53) — what changed under the
// micro-VM tier and what didn't, verified against the actual code (the task
// brief that seeded this work was written under a stale "podman+krun OCI
// runtime" plan; the real substrate is the direct-libkrun launcher,
// rust/magpie-microvm-launcher, task_39ff):
//
//   - NO separate virtiofsd daemon exists. The launcher attaches `/work`/
//     `/out` via `krun_add_virtiofs3`, an in-process libkrun FFI call (see
//     rust/magpie-microvm-launcher/src/krun.rs) — there is no child process,
//     no `Command::new`, nothing to reap here. Chasing a "virtiofsd orphan"
//     would be chasing a process that never exists.
//   - The launcher creates NO per-job socket of its own. `--vsock-uds`
//     points straight at the GATEWAY's already-bound `<socketDir>/gw.sock`
//     (microvm-vsock.ts's `microvmVsockChannel`; `krun_add_vsock_port2(...,
//     listen=false)` makes libkrun a CLIENT that dials OUT). That socket's
//     bind/teardown lifecycle belongs to `packages/gateway`'s
//     `JobSocketManager` (a SEPARATE process/systemd unit), driven by
//     mint/revoke — not something this orchestrator-side module creates,
//     owns, or needs to unlink.
//   - The launcher process IS the micro-VM: `krun.rs`'s `boot()` returns
//     `Result<Infallible, BootError>` — `krun_start_enter` never returns
//     once the guest boots, and the launcher never forks/execs a child. One
//     `magpie-krun-launch` PID == one live guest, for its entire life.
//     Killing that PID is both necessary and sufficient to tear the VM down
//     (reviewer.ts's "Micro-VM tier" section documents the same fact for the
//     normal timeout/abort kill path). THIS is the real new orphan surface
//     the old container-only reap missed: if the orchestrator dies mid-job,
//     the launcher process (reparented to init) keeps the guest running
//     forever with nothing left to kill it.
//   - The other new surface is per-job SCRATCH DIRECTORIES, not sockets:
//     container-mounts.ts's `createOutputDir` makes `magpie-out-*` `mkdtemp`
//     dirs, and workspace.ts's `createWorkspace` makes
//     `<owner>-<repo>-<prNumber>-<headSha>` checkout dirs — both directly
//     under `config.workspace.workDir`, and (grepped) the ONLY two writers
//     into that directory anywhere in this package. Both tiers use them
//     (they predate the micro-VM tier entirely — virtiofs/bind-mount just
//     re-point the SAME host directories), so a crash can strand either
//     kind on disk in exactly the same way a crash strands a container.
//
// GATEWAY VIRTUAL KEYS — deliberately NOT reaped here. See
// `cleanupOrphanLauncherProcesses`'s doc comment for the full design-fork
// writeup (task_df53 §4): the short version is that the gateway is a
// separate long-running process whose in-memory key/socket state is
// unaffected by THIS process crashing, killing the orphaned launcher above
// already removes the only thing that could ever spend an orphaned key, and
// the gateway's own TTL + per-key budget cap (keystore.ts) already bound
// what an un-revoked key can do in the meantime. This mirrors the crun
// tier's existing, never-flagged-as-a-bug behavior: `cleanupOrphanContainers`
// has never called the gateway to revoke a reaped container's key either.
//
// Best-effort and NON-FATAL by design, for ALL THREE reap functions below:
// any error (daemon hiccup, permission issue, a container/process that
// disappears mid-reap, a directory removal race) is logged and swallowed,
// never thrown. This runs on the startup path where a thrown error would
// abort the whole process — orphan cleanup failing must never stop magpie
// from otherwise starting up and serving webhooks.

import { execFile as execFileCb } from "node:child_process";
import { readdir, rm as rmCb } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { ExecFileFn } from "./docker.js";

const execFileAsync = promisify(execFileCb);

/** Minimal structured logger this module needs. */
export interface OrphanCleanupLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

const consoleLogger: OrphanCleanupLogger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

/**
 * Force-removes every container whose name starts with `magpie-` (the
 * naming convention reviewer.ts's `buildContainerName` uses for every review
 * container — see reviewer.ts). Resolves whether it found zero, some, or hit
 * a docker error along the way; NEVER throws or rejects (see module doc
 * comment). `execFileFn`/`logger` default to the real, promisified
 * `child_process.execFile` and a JSON-on-console logger; orphan-cleanup.test.ts
 * injects fakes so this is exercised with no real docker daemon.
 */
export async function cleanupOrphanContainers(
  config: Pick<Config, "container">,
  execFileFn: ExecFileFn = execFileAsync,
  logger: OrphanCleanupLogger = consoleLogger,
): Promise<void> {
  const dockerBin = config.container.dockerBin;
  try {
    const { stdout } = await execFileFn(dockerBin, [
      "ps",
      "-aq",
      "--filter",
      "name=magpie-",
    ]);
    const ids = stdout
      .split(/\s+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (ids.length === 0) {
      logger.info({ event: "orphan-cleanup", removedCount: 0 });
      return;
    }

    await execFileFn(dockerBin, ["rm", "-f", ...ids]);
    logger.info({ event: "orphan-cleanup", removedCount: ids.length, ids });
  } catch (err) {
    // Best-effort: a docker hiccup here must never block startup/shutdown.
    logger.error({ event: "orphan-cleanup-failed", error: serializeError(err) });
  }
}

// --- Micro-VM tier: orphaned launcher process reap (M8-C5) -----------------

/** One row of `ps -eo pid=,args=` output. */
export interface ProcessInfo {
  pid: number;
  /** Full command line (argv joined with spaces) — NOT `ps`'s truncated `comm` column, which caps at 15 chars on Linux and would silently fail to match `magpie-krun-launch` (19 chars). */
  command: string;
}

/**
 * TEST SEAM: lists currently-running processes. Defaults to a plain
 * `execFile("ps", ["-eo", "pid=,args="])` call (no shell — no quoting/
 * injection surface, same discipline as {@link cleanupOrphanContainers}).
 * `pid=,args=` (trailing `=` suppresses the header line) rather than `comm=`
 * specifically because `comm` is kernel-truncated to `TASK_COMM_LEN - 1`
 * (15) characters — `args`/`cmd` carries the untruncated command line this
 * module needs to match a 19-character binary name reliably.
 */
export type ListProcessesFn = (execFileFn: ExecFileFn) => Promise<ProcessInfo[]>;

async function defaultListProcesses(execFileFn: ExecFileFn): Promise<ProcessInfo[]> {
  const { stdout } = await execFileFn("ps", ["-eo", "pid=,args="]);
  const rows: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const spaceIdx = trimmed.indexOf(" ");
    const pidStr = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const command = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
    const pid = Number.parseInt(pidStr, 10);
    if (Number.isNaN(pid)) continue;
    rows.push({ pid, command });
  }
  return rows;
}

/**
 * TEST SEAM: sends a signal to a pid. Defaults to the real `process.kill`
 * (no `kill` binary spawn needed — Node can signal an arbitrary pid
 * directly). An ESRCH (already-dead pid — a benign race between listing and
 * killing) is swallowed by the caller, not here.
 */
export type KillProcessFn = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Kills every orphaned `magpie-krun-launch` process left running by a
 * previous crash of this orchestrator (`kill -9`, OOM, host crash/reboot —
 * the exact same scenario {@link cleanupOrphanContainers} backstops for the
 * crun tier's containers). See this module's doc comment's "M8-C5
 * ORPHAN-POPULATION AUDIT" section for why this is the real new orphan
 * surface under the micro-VM tier: `krun_start_enter` never returns once a
 * guest boots, so the launcher process IS the VM for its whole life, and
 * killing that one process is both necessary and sufficient to tear the
 * guest down — there is no separate VMM/virtiofsd/vsock-relay process for
 * this micro-VM design to also reap.
 *
 * SAFE-TO-REAP-ALL: this runs at startup, before the queue accepts any job
 * (see index.ts's composition root), so there is by construction no
 * in-flight launcher process to avoid — every process matching the
 * configured launcher binary's name at this point in time is orphaned. Same
 * "reap everything named magpie-*" model {@link cleanupOrphanContainers}
 * already uses for containers.
 *
 * GATED on `config.container.tier === "microvm"`: a crun-only deployment
 * never spawns `magpie-krun-launch` at all, so this skips the `ps` call
 * entirely rather than running a no-op process scan on every boot (and
 * sidesteps a host that has never installed `ps` but never uses the
 * micro-VM tier either).
 *
 * GATEWAY VIRTUAL KEYS — deliberately NOT revoked here. Design fork
 * (task_df53 §4): the admin plane exposes mint and revoke-by-id but no
 * list-all/bulk-revoke endpoint, and after a `kill -9` this orchestrator has
 * no in-memory record of which job ids were live to revoke even if one
 * existed. Decision: do NOT add a new gateway management-plane endpoint for
 * this — the smaller, already-correct option, for three independent
 * reasons:
 *   1. The gateway is a SEPARATE process (its own systemd unit,
 *      `packages/gateway`) with its own in-memory `KeyStore`/
 *      `JobSocketManager`. This orchestrator crashing does not touch either
 *      — an orphaned job's key/socket are exactly as valid or invalid after
 *      the crash as they were the instant before it. There is nothing new
 *      to revoke as a *consequence* of the orchestrator dying.
 *   2. Once this function kills the orphaned launcher process, the guest —
 *      the ONLY thing that could ever present that job's virtual key over
 *      the vsock channel — no longer exists. A key with no VM left alive to
 *      spend it has no remaining attack surface; killing the launcher is
 *      the operative control, not gateway-side bookkeeping.
 *   3. Independent defense in depth already bounds an un-revoked key
 *      regardless: every minted key is TTL-capped (`KeyEntry.expiresAt`,
 *      lazily evicted on lookup/mint — see `packages/gateway/src/keystore.ts`)
 *      AND budget-capped (`isOverBudget`). This is not a new gap this task
 *      introduces — `cleanupOrphanContainers` has never revoked a reaped
 *      crun container's gateway key either, and that was never a flagged
 *      bug; this decision keeps both tiers' orphan reap consistent instead
 *      of adding new cross-process surface for a scenario that is already
 *      fully bounded.
 *
 * Best-effort and NEVER throws (see module doc comment): a `ps` failure
 * (missing binary, permission error) or a kill failing (already-dead pid,
 * permission) is logged and swallowed, never propagated.
 */
export async function cleanupOrphanLauncherProcesses(
  config: Pick<Config, "container" | "microvm">,
  listProcessesFn: ListProcessesFn = defaultListProcesses,
  killFn: KillProcessFn = (pid, signal) => process.kill(pid, signal),
  logger: OrphanCleanupLogger = consoleLogger,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  if (config.container.tier !== "microvm") {
    return;
  }
  const launcherName = basename(config.microvm.launcherBin);
  try {
    const processes = await listProcessesFn(execFileFn);
    const orphans = processes.filter((p) => {
      const argv0 = p.command.split(/\s+/, 1)[0] ?? "";
      return basename(argv0) === launcherName;
    });

    if (orphans.length === 0) {
      logger.info({ event: "orphan-launcher-cleanup", removedCount: 0 });
      return;
    }

    const killed: number[] = [];
    const failed: Array<{ pid: number; error: unknown }> = [];
    for (const { pid } of orphans) {
      try {
        killFn(pid, "SIGKILL");
        killed.push(pid);
      } catch (err) {
        // ESRCH (already exited between list and kill) or a permission
        // error — best-effort, keep going with the rest of the batch rather
        // than aborting the whole reap over one pid.
        failed.push({ pid, error: serializeError(err) });
      }
    }
    logger.info({
      event: "orphan-launcher-cleanup",
      removedCount: killed.length,
      pids: killed,
      ...(failed.length > 0 ? { failedPids: failed } : {}),
    });
  } catch (err) {
    logger.error({ event: "orphan-launcher-cleanup-failed", error: serializeError(err) });
  }
}

// --- Orphaned per-job scratch-directory reap (M8-C5) ------------------------

/** TEST SEAM: lists directory entry names directly under a path. Defaults to `fs.readdir`. */
export type ListDirFn = (dir: string) => Promise<string[]>;

/** TEST SEAM: recursively force-removes a path. Defaults to `fs.rm(path, { recursive: true, force: true })`. */
export type RemovePathFn = (path: string) => Promise<void>;

async function defaultListDir(dir: string): Promise<string[]> {
  return readdir(dir);
}

async function defaultRemovePath(path: string): Promise<void> {
  await rmCb(path, { recursive: true, force: true });
}

/**
 * Removes every entry found directly under `config.workspace.workDir` — the
 * per-job scratch directories a crash can strand on disk, tier-agnostically:
 * container-mounts.ts's `createOutputDir` (`magpie-out-*` `mkdtemp` dirs) and
 * workspace.ts's `createWorkspace` (`<owner>-<repo>-<prNumber>-<headSha>`
 * checkout dirs) are the ONLY two writers into this directory anywhere in
 * the orchestrator (see this module's doc comment's audit section) — both
 * predate the micro-VM tier and are unaffected by which tier is active
 * (virtiofs/bind-mount just re-point the same host directories).
 *
 * SAFE-TO-REAP-ALL: exactly like {@link cleanupOrphanLauncherProcesses}, this
 * runs at startup before the queue accepts any job, so there is no live job
 * whose scratch dir this could delete out from under it — every entry found
 * here at this point in time is orphaned. On a clean prior shutdown this
 * directory is already empty (every job's own `Workspace.cleanup()`/
 * `OutputDir.cleanup()` runs on every settle path), so this is a no-op in
 * the common case and only does real work after a crash — the same
 * "harmless when healthy, load-bearing after a crash" shape as
 * {@link cleanupOrphanContainers}.
 *
 * No traversal surface: every path removed is `join(workDir, name)` where
 * `name` comes only from `readdir`'s own return value, never from any
 * caller-supplied or attacker-influenced string.
 *
 * Best-effort and NEVER throws: a missing `workDir` (ENOENT — nothing has
 * ever run yet) resolves as a silent zero-count success; any other listing
 * or removal error is logged and swallowed.
 */
export async function cleanupOrphanScratchDirs(
  config: Pick<Config, "workspace">,
  listDirFn: ListDirFn = defaultListDir,
  removePathFn: RemovePathFn = defaultRemovePath,
  logger: OrphanCleanupLogger = consoleLogger,
): Promise<void> {
  const workDir = config.workspace.workDir;
  let entries: string[];
  try {
    entries = await listDirFn(workDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      logger.info({ event: "orphan-scratch-cleanup", removedCount: 0 });
      return;
    }
    logger.error({ event: "orphan-scratch-cleanup-failed", error: serializeError(err) });
    return;
  }

  const removed: string[] = [];
  const failed: Array<{ name: string; error: unknown }> = [];
  for (const name of entries) {
    const path = join(workDir, name);
    try {
      await removePathFn(path);
      removed.push(name);
    } catch (err) {
      failed.push({ name, error: serializeError(err) });
    }
  }
  logger.info({
    event: "orphan-scratch-cleanup",
    removedCount: removed.length,
    ...(removed.length > 0 ? { names: removed } : {}),
    ...(failed.length > 0 ? { failed } : {}),
  });
}
