// Docker preflight check for the magpie orchestrator.
//
// Milestone 3 containerizes each review job as an ephemeral `docker run`
// (see PLAN.md §4; the runner itself is task_4ed4/M3-C, not this module).
// Rather than discover a missing/broken docker installation only when the
// first review job tries to use it — failing every job thereafter with the
// same root cause — this module runs one `<docker_bin> version` invocation
// once at startup and fails fast with a clear, actionable error (mirroring
// config.ts's fail-fast `ConfigError` style) if docker isn't installed or
// its daemon isn't reachable. See index.ts's composition root for where this
// is wired in: the process refuses to start at all if it can't containerize,
// rather than accepting webhooks it can never successfully review.
//
// This module does NOT build or run the `docker run` invocation itself, and
// does not know anything about `docker run` flags/mounts — that's M3-C
// (reviewer.ts). It only answers "is docker usable right now?".

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFileCb);

/**
 * Minimal shape this module needs from `child_process.execFile` (promisified
 * form). TEST SEAM: {@link assertDockerAvailable}'s second parameter accepts
 * an implementation of this type; production callers must leave it undefined
 * so the real, promisified `execFile` runs. docker.test.ts injects fakes for
 * the success/missing-binary(ENOENT)/daemon-down(non-zero exit) cases, so
 * this whole module is unit-testable without a real docker installation.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Thrown when the docker preflight check fails. Mirrors config.ts's
 * `ConfigError`: a single, clear, actionable message rather than a raw
 * `child_process` error (which — for the ENOENT case especially — is not
 * self-explanatory to an operator).
 */
export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

/**
 * Verifies that `config.container.dockerBin` is installed and its daemon is
 * reachable, by running `<docker_bin> version` once. Resolves silently on
 * success; throws {@link DockerUnavailableError} with a clear, actionable
 * message otherwise (binary missing, or found but the daemon refuses the
 * connection — e.g. not running, or the caller isn't in the `docker` group).
 *
 * `execFileFn` defaults to the real, promisified `child_process.execFile`
 * (see {@link ExecFileFn}'s doc comment) — this is the only test seam this
 * module needs, since it never touches the filesystem or any Magpie secret.
 */
export async function assertDockerAvailable(
  config: Config,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  const dockerBin = config.container.dockerBin;
  try {
    await execFileFn(dockerBin, ["version"]);
  } catch (err) {
    throw new DockerUnavailableError(formatError(dockerBin, err));
  }
}

/** Builds the actionable error message for {@link DockerUnavailableError}. */
function formatError(dockerBin: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return (
      `container-runtime preflight failed: "${dockerBin}" was not found on PATH. Magpie ` +
      `containerizes every review job (see PLAN.md Milestone 3) and refuses to ` +
      `start without a working container runtime CLI. The default runtime is rootless ` +
      `podman (M8-B2); install podman (or docker), or set [container] docker_bin in ` +
      `config.toml to the runtime's full path.`
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return (
    `container-runtime preflight failed: "${dockerBin} version" did not succeed (${reason}). ` +
    `For rootless podman (the M8-B2 default) check the service user's subuid/subgid + linger ` +
    `provisioning; for docker check the daemon is running and this user can reach it. Magpie ` +
    `refuses to start without a working container runtime (see PLAN.md Milestone 3).`
  );
}
