// Best-effort orphan-container cleanup for the magpie orchestrator (M3-D).
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
// Best-effort and NON-FATAL by design: any docker error here (daemon
// hiccup, permission issue, a container that disappears between the list and
// the remove call) is logged and swallowed, never thrown. This runs on the
// startup path where a thrown error would abort the whole process — orphan
// cleanup failing must never stop magpie from otherwise starting up and
// serving webhooks.

import { execFile as execFileCb } from "node:child_process";
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
