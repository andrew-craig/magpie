// Derives the per-job hybrid-vsock channel for the micro-VM reviewer tier
// (M8-C2, task_b3f7 — see that task file's "Implementation plan" section for
// the full investigation this module is the output of).
//
// KEY FINDING (task_b3f7): the "forwarder" the brief originally called for
// mostly dissolves once the direct-libkrun launcher (`rust/magpie-microvm-
// launcher`) is the topology in play. `krun_add_vsock_port2(ctx, port,
// uds_path, listen=false)` makes libkrun a CLIENT — on each guest `connect()`
// it dials OUT to `uds_path` itself (see that crate's `src/krun.rs`), and the
// gateway ALREADY listens at exactly such a path: `<socketDir>/gw.sock` (see
// gateway.ts's `GatewayKey.socketDir` doc comment and
// `packages/gateway/src/job-sockets.ts`'s `SOCKET_FILE_NAME` invariant). So
// the launcher's `--vsock-uds` can point straight at the gateway's per-job
// socket — no separate relay process, no host-global vhost-vsock listener.
//
// This module is the small, standalone piece of that wiring that's safe to
// build now, independent of the still-open spike/CTO decisions (direct
// wiring vs. a Rust `magpie-vsock-host-relay` fallback — see the task file):
// given a minted `GatewayKey`, derive the `{ udsPath, port }` pair the
// launcher's `--vsock-uds`/`--vsock-port` CLI flags need (see
// `rust/magpie-microvm-launcher/src/cli.rs`'s both-or-neither contract).
//
// PER-JOB ISOLATION INVARIANT: isolation is provided by `udsPath` — one path
// per job, torn down with the job's gateway key (mint/revoke, unchanged) —
// NEVER by a host-global listener and never by the vsock port, which is a
// single fixed, shared value across every job (see `MICROVM_VSOCK_PORT`
// below). A guest in job A's micro-VM has no way to reach job B's socket: it
// only ever dials the one `uds_path` its own launcher instance was started
// with.
//
// OUT OF SCOPE here (deliberately): actually wiring this into reviewer.ts/
// pipeline.ts or the launcher process is C3 (`task_39ff`), a future task.
// This module does not touch the filesystem, spawn anything, or change the
// mint/revoke flow in gateway.ts at all — it is a pure path/port derivation
// that both a direct-wiring C3 and a fallback Rust relay would consume
// identically.

import { isAbsolute, join } from "node:path";
import type { GatewayKey } from "./gateway.js";

/**
 * Fixed, well-known vsock port the guest dials (matches
 * `rust/vsock-client`'s `DEFAULT_VSOCK_PORT` and the launcher's own
 * smoke-test convention). A single shared port across every concurrent job
 * is correct and safe: per-job isolation is provided by the per-VM CID and
 * (on the host leg derived here) by each job's distinct `udsPath`, not by
 * the port number — see this module's doc comment.
 */
export const MICROVM_VSOCK_PORT = 1234;

/**
 * Filename the gateway always binds its per-job proxy-plane unix socket as,
 * inside the `socketDir` it hands back from mint (see gateway.ts's
 * `GatewayKey.socketDir` doc comment, and the authoritative source of this
 * invariant: `packages/gateway/src/job-sockets.ts`'s `SOCKET_FILE_NAME`
 * constant). Duplicated here as a constant, rather than importing across the
 * package boundary into `@magpie/gateway` internals, since the orchestrator
 * already treats `socketDir` as an opaque contract value from the gateway's
 * HTTP response (see gateway.ts) — this keeps that same arm's-length
 * relationship for the one extra path segment this module needs.
 */
export const GATEWAY_SOCKET_BASENAME = "gw.sock";

/**
 * The per-job hybrid-vsock channel a micro-VM reviewer launch needs: the
 * host-side unix socket the launcher's libkrun instance should dial
 * (`udsPath`), and the fixed guest-side port it should be reachable at
 * (`port`). Shape matches `rust/magpie-microvm-launcher/src/cli.rs`'s
 * `--vsock-uds`/`--vsock-port` pair.
 */
export interface MicrovmVsockChannel {
  /** Absolute host path to the gateway's per-job unix socket (`<socketDir>/gw.sock`). */
  udsPath: string;
  /** Fixed vsock port the guest dials — always {@link MICROVM_VSOCK_PORT}. */
  port: number;
}

/**
 * Derives the micro-VM tier's per-job vsock channel from a minted gateway
 * key's `socketDir` — a pure path computation, no filesystem access.
 *
 * Takes `Pick<GatewayKey, "socketDir">` rather than the full `GatewayKey` so
 * callers/tests don't need to fabricate an `id`/`key` (a real virtual key)
 * just to compute a path.
 *
 * `socketDir` MUST be a non-empty, absolute path — mirrors the fail-loud
 * absolute-path guards in `container-mounts.ts`'s `prepareReviewMount` and
 * `createOutputDir`, for the same reason: `socketDir` here always comes from
 * the gateway's mint response (see gateway.ts, where it's already an
 * absolute host path by construction), so a relative or empty value can only
 * mean a bug or a bad caller. Silently `join`-ing it would resolve against
 * `process.cwd()` and hand the launcher a `udsPath` that looks plausible but
 * silently misconnects (or, worse, connects to nothing / the wrong socket)
 * instead of failing at the point of the mistake.
 */
export function microvmVsockChannel(key: Pick<GatewayKey, "socketDir">): MicrovmVsockChannel {
  const { socketDir } = key;
  if (!isAbsolute(socketDir)) {
    throw new Error(
      `microvmVsockChannel requires an absolute socketDir, got: "${socketDir}"`,
    );
  }
  return {
    udsPath: join(socketDir, GATEWAY_SOCKET_BASENAME),
    port: MICROVM_VSOCK_PORT,
  };
}
