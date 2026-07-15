// Per-job unix-socket proxy-plane lifecycle for the magpie gateway (M7-1,
// DISTRIBUTION.md §2.6 "Design D"). Before this module existed, the proxy
// (data) plane was a single `http.Server` bound once at startup to a TCP
// host:port shared by every job. Design D replaces that with ONE unix
// socket PER JOB: the orchestrator bind-mounts a job's socket DIRECTORY
// (never the not-yet-existent socket file — see the "launch ordering" note
// in DISTRIBUTION.md §2.6) read-only into that job's `--network none`
// reviewer container, so the only way out of the container is through the
// socket the gateway itself created and owns.
//
// Lifecycle, driven by admin-server.ts:
//   mint  -> keyStore.mint()  -> JobSocketManager.bind({ id, jobId })
//   revoke -> keyStore.revoke() -> JobSocketManager.teardown(id)
//
// Each per-job server reuses the EXACT SAME request-handling logic as every
// other job (proxy-server.ts's `createProxyRequestListener` — auth, budget,
// key injection, upstream forwarding, spend recording); only the transport
// (a dedicated unix socket) and directory-level access control are new.
//
// Permissions (DISTRIBUTION.md §2.6, "directory traversal, not a shared
// group"):
//   - `<root>/`                    — owned by this process (systemd's
//                                    `RuntimeDirectory`, 0700 by systemd —
//                                    see config.ts's `socketDirRoot` doc
//                                    comment and index.ts, which deliberately
//                                    does NOT chmod this directory itself).
//   - `<root>/<sanitized-jobId>/`  — 0711 (search-only for everyone else: the
//                                    reviewer can traverse INTO the directory
//                                    to reach the socket, but cannot list it,
//                                    write into it, or unlink the socket).
//   - `.../gw.sock`                — 0666, explicit `chmod` AFTER `listen()`
//                                    (never relying on umask — a masked mode
//                                    would silently under- or over-grant).
//
// SECURITY: never log `config.secrets.*` or a minted virtual key — this
// module never receives either directly (they flow through `config`/
// `keyStore`, both opaque to this module beyond passing them on to
// proxy-server.ts), but log lines below are kept to job ids/paths only, same
// discipline as every other module in this package.

import { chmod, mkdir, rmdir, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { GatewayConfig } from "./config.js";
import type { KeyStore } from "./keystore.js";
import { createProxyServer, type ProxyServer, type ProxyServerDeps } from "./proxy-server.js";

/** Filename of the proxy-plane socket inside each job's directory — matches DISTRIBUTION.md §2.6 and the M7-0 spike (`spike/m7-0/gateway-on-socket.mjs`). */
const SOCKET_FILE_NAME = "gw.sock";

/** Mode for each per-job socket DIRECTORY — search-only for non-owners; see module doc comment. */
const JOB_DIR_MODE = 0o711;

/** Mode for the socket FILE itself — read/write for everyone; access control lives in the directory's mode, not here. See module doc comment. */
const SOCKET_FILE_MODE = 0o666;

/** Characters allowed in a sanitized job id / directory name — same spirit as `packages/orchestrator/src/reviewer.ts`'s `buildContainerName`/`DOCKER_NAME_UNSAFE_RE`, so a job id containing e.g. `/` or spaces can never be used to escape `config.socketDirRoot` or collide with an unrelated path. */
const JOB_ID_UNSAFE_RE = /[^a-zA-Z0-9_.-]/g;

/** Sanitizes a caller-supplied `jobId` into a safe, non-empty directory-name component. Unsafe characters become `-`; an empty (or all-unsafe) input falls back to `"job"`. `.` and `..` are allowed by {@link JOB_ID_UNSAFE_RE} (both are legal filename chars) but must never be used as a directory name here — either would make `path.join(root, name)` resolve to the root itself or its parent, letting a job escape `config.socketDirRoot` (in production `jobId` is always a `randomUUID()`, but this stays a real traversal boundary regardless). */
function sanitizeJobId(jobId: string): string {
  const sanitized = jobId.replace(JOB_ID_UNSAFE_RE, "-");
  if (sanitized === "." || sanitized === "..") {
    return "job";
  }
  return sanitized.length > 0 ? sanitized : "job";
}

/** Inputs to {@link JobSocketManager.bind}. */
export interface BindJobSocketParams {
  /** The keystore id ({@link KeyStore.mint}'s `id`) this socket is bound for — the map key `teardown` later addresses it by. */
  id: string;
  /** Caller-supplied job identifier (e.g. the orchestrator's job id). Sanitized before use as a path component — see {@link sanitizeJobId}. */
  jobId: string;
}

/** Result of a successful {@link JobSocketManager.bind} call. */
export interface BindJobSocketResult {
  /** The per-job directory the orchestrator should bind-mount (read-only) into the reviewer container — the socket itself always lives at `<socketDir>/gw.sock`. */
  socketDir: string;
}

interface JobSocketEntry {
  /** Sanitized job id (see {@link sanitizeJobId}) — used to detect a second `id` colliding on the same job directory. */
  sanitizedJobId: string;
  proxy: ProxyServer;
  socketDir: string;
  socketPath: string;
}

/**
 * Owns every currently-bound per-job proxy socket. One instance per gateway
 * process, constructed in index.ts alongside the `KeyStore` and threaded
 * into `createAdminServer` — see that module's mint/revoke handlers, which
 * are this class's only production callers.
 */
export class JobSocketManager {
  readonly #config: GatewayConfig;
  readonly #keyStore: KeyStore;
  readonly #root: string;
  readonly #deps: ProxyServerDeps;
  readonly #entries = new Map<string, JobSocketEntry>();

  constructor(config: GatewayConfig, keyStore: KeyStore, deps: ProxyServerDeps = {}) {
    this.#config = config;
    this.#keyStore = keyStore;
    this.#root = config.socketDirRoot;
    this.#deps = deps;
  }

  /**
   * Create `<root>/<sanitized-jobId>/`, bind a fresh proxy-plane
   * `http.Server` on `<that dir>/gw.sock`, and chmod the socket 0666. On any
   * failure, best-effort-cleans up whatever partial state this call created
   * (closed server, unlinked socket) and rethrows — callers (admin-server.ts)
   * must not hand out a virtual key whose socket failed to bind.
   *
   * Re-bind guards (see module doc comment's lifecycle note):
   *  - Same `id` bound again (e.g. a caller retries after a transient
   *    failure): the stale entry for that `id` is torn down first, then a
   *    fresh one is bound in its place.
   *  - A DIFFERENT `id` already bound to the same (sanitized) `jobId`: both
   *    would collide on the same `socketDir`/`socketPath`, silently
   *    orphaning the first one's still-running server out from under it. We
   *    tear the stale one down and replace it (rather than rejecting) so a
   *    caller doesn't need to know a prior id to recover — chosen the same
   *    way {@link KeyStore.revoke} is idempotent-by-contract rather than
   *    erroring on an unknown id.
   */
  async bind({ id, jobId }: BindJobSocketParams): Promise<BindJobSocketResult> {
    const sanitizedJobId = sanitizeJobId(jobId);

    const staleSameId = this.#entries.get(id);
    if (staleSameId) {
      this.#entries.delete(id);
      await this.#teardownEntry(staleSameId);
    }
    for (const [otherId, entry] of this.#entries) {
      if (entry.sanitizedJobId === sanitizedJobId) {
        this.#entries.delete(otherId);
        await this.#teardownEntry(entry);
      }
    }

    const socketDir = path.join(this.#root, sanitizedJobId);
    const socketPath = path.join(socketDir, SOCKET_FILE_NAME);

    await mkdir(socketDir, { recursive: true });
    // mkdir's `mode` option is subject to the process umask, same reasoning
    // as the socket's own chmod below — set it explicitly, not by hoping the
    // umask lines up.
    await chmod(socketDir, JOB_DIR_MODE);

    // A stale socket file from a previous (crashed/unclean-shutdown) bind at
    // this exact path would make the upcoming `listen()` fail EADDRINUSE.
    // Unlink unconditionally (a missing file just no-ops via `.catch`) rather
    // than gating on a synchronous `existsSync` stat — same effect without
    // blocking the event loop or a stat/unlink TOCTOU. Safe: `socketPath` is
    // always a path THIS process just computed under its own
    // `config.socketDirRoot`, never caller-supplied beyond the sanitized
    // `jobId` component baked into it.
    await unlink(socketPath).catch(() => {});

    const proxy = createProxyServer(this.#config, this.#keyStore, this.#deps);
    try {
      await proxy.listen(socketPath);
      await chmod(socketPath, SOCKET_FILE_MODE);
    } catch (err) {
      // Roll back everything this call created, including the (now empty) job
      // directory, so a failed bind doesn't leak a directory under the root.
      await proxy.close().catch(() => {});
      await unlink(socketPath).catch(() => {});
      await rmdir(socketDir).catch(() => {});
      throw err;
    }

    this.#entries.set(id, { sanitizedJobId, proxy, socketDir, socketPath });
    return { socketDir };
  }

  /**
   * Best-effort, idempotent teardown of the socket bound for `id`: closes
   * the per-job `http.Server`, unlinks the socket file, and removes the
   * (by then empty) job directory. Never throws — a no-op for an unknown
   * `id`, same idempotent-by-contract shape as {@link KeyStore.revoke}, since
   * admin-server.ts's revoke handler calls this unconditionally and must
   * never fail a cleanup over a double-revoke race or a half-torn-down prior
   * state.
   */
  async teardown(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    try {
      await this.#teardownEntry(entry);
    } catch {
      // Best-effort by contract — see doc comment above.
    }
  }

  /** Tears down every currently-bound socket — called once, from index.ts's graceful-shutdown path, alongside the admin server's own `close()`. */
  async closeAll(): Promise<void> {
    const ids = [...this.#entries.keys()];
    await Promise.all(ids.map((id) => this.teardown(id)));
  }

  async #teardownEntry(entry: JobSocketEntry): Promise<void> {
    await entry.proxy.close().catch(() => {});
    await unlink(entry.socketPath).catch(() => {});
    // `rmdir` (not `rm`/`rm -rf`) deliberately only removes an EMPTY
    // directory — the job directory should hold nothing but the socket we
    // just unlinked; if it somehow holds anything else, fail this one
    // (caught) step rather than recursively deleting unexpected content.
    await rmdir(entry.socketDir).catch(() => {});
  }
}

/** Factory, matching the rest of the codebase's `createX()` convention (see keystore.ts's `createKeyStore`). */
export function createJobSocketManager(config: GatewayConfig, keyStore: KeyStore, deps: ProxyServerDeps = {}): JobSocketManager {
  return new JobSocketManager(config, keyStore, deps);
}
