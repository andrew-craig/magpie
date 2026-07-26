// relay-boundary.test.ts — the TCP-facing byte-relay CONTRACT shared by
// `docker/reviewer/forwarder.mjs` (TCP -> unix socket, docker/crun path) and
// `rust/vsock-client`'s `magpie-vsock-client` binary (TCP -> AF_VSOCK,
// micro-VM path). `docker/reviewer/entrypoint.sh` picks one of the two at
// container startup by testing `[ -c /dev/vsock ]` (see that script's "Relay
// to the gateway" section) — Pi always talks to `http://127.0.0.1:4000/v1`
// regardless of which relay is actually running underneath it. There is no
// custom wire format crossing this boundary: it's a raw byte pipe (Pi's HTTP
// traffic is already self-delimiting — see rust/vsock-client/src/main.rs's
// "Why not the vsock-framing crate" doc section), so the only thing worth
// pinning here is byte-stream RELAY BEHAVIOR, not a frame format.
//
// THIS FILE IS A BOUNDARY CONTRACT TEST (RUST-3 / task_9d2b). Per
// docs/design/rust-adoption.md's migration rule: a future swap PR may add
// Rust unit tests, but must NOT edit this file. If a swap changes the
// relay's observable TCP-facing behavior, that is a red flag to raise, not a
// reason to loosen this suite.
//
// IMPL SELECTION (`MAGPIE_RELAY_IMPL` env var, default `node`)
//   - `node` (default, always runs, no special hardware needed): drives the
//     real `docker/reviewer/forwarder.mjs` subprocess against a real
//     unix-socket destination stub this file owns. This is the suite CI runs
//     on every PR via `npm test` (see .github/workflows/ci.yml) with zero
//     extra setup.
//   - `rust`: drives the real compiled `magpie-vsock-client` binary (path
//     from `MAGPIE_VSOCK_CLIENT_BIN`, default
//     `rust/target/release/magpie-vsock-client` relative to the repo root —
//     i.e. whatever `.github/workflows/rust.yml`'s `build` job produces, or
//     a local `cargo build --release -p magpie-vsock-client`). Its
//     destination transport is AF_VSOCK, which no ordinary CI runner or dev
//     sandbox has (empirically confirmed here: no /dev/vsock, and loading
//     the vsock_loopback kernel module needs privileges this sandbox
//     doesn't grant) — so the byte-relay-BEHAVIOR assertions below SKIP for
//     this impl with an explicit, in-title reason (never a silent no-op)
//     rather than pretending to cover ground they can't reach. What DOES run
//     for real, unconditionally, against the actual compiled binary:
//       (a) the binary's fail-closed startup contract — it must never open
//           its TCP listener at all without a real /dev/vsock, which is
//           exactly the state of any environment running this suite;
//       (b) (documented, not executed here) the transport-agnostic core of
//           the SAME byte-relay contract (bidirectional copy, half-close
//           propagation, teardown-race tolerance) is independently proven,
//           in Rust, by rust/vsock-client/src/main.rs's own `relay()` unit
//           tests — `relay_copies_bytes_in_both_directions`,
//           `relay_propagates_half_close`, `relay_tolerates_peer_already_gone`
//           — which use the identical "stand in with a loopback TCP pair"
//           technique this file uses for the node impl below. Run them with
//           `cargo test -p magpie-vsock-client`.
//   See .github/workflows/rust.yml's `boundary-contract` job: it downloads
//   the artifact `build` produces and runs this file with
//   `MAGPIE_RELAY_IMPL=rust` — so a future swap PR must keep this green with
//   zero edits to this file.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FORWARDER_PATH = join(REPO_ROOT, "docker", "reviewer", "forwarder.mjs");
const DEFAULT_VSOCK_CLIENT_BIN = join(REPO_ROOT, "rust", "target", "release", "magpie-vsock-client");

/** Fixed by BOTH forwarder.mjs and vsock-client — see their own source (this
 * is Pi's `OPENAI_BASE_URL` target, an external contract neither relay may
 * change unilaterally). */
const TCP_HOST = "127.0.0.1";
const TCP_PORT = 4000;

const RELAY_IMPL = process.env.MAGPIE_RELAY_IMPL === "rust" ? "rust" : "node";
const VSOCK_CLIENT_BIN = process.env.MAGPIE_VSOCK_CLIENT_BIN || DEFAULT_VSOCK_CLIENT_BIN;

// --- shared test plumbing --------------------------------------------------

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // Best-effort teardown; a failed cleanup must never mask the test's
      // own assertion failure/success.
    }
  }
  cleanups = [];
});

/** Connects a plain TCP client to the relay's fixed listen address, rejecting
 * (e.g. ECONNREFUSED) if nothing is listening yet/at all. An optional
 * `timeoutMs` bounds the attempt so a connect that neither succeeds nor errors
 * (a hung SYN rather than a prompt refusal) fails fast with a clear message
 * instead of hanging until the caller's vitest timeout; omitted for the
 * happy-path node tests, which expect a prompt connect. */
function connectTcpClient(timeoutMs?: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            sock.destroy();
            reject(new Error(`timed out after ${timeoutMs}ms connecting to ${TCP_HOST}:${TCP_PORT}`));
          }, timeoutMs);
    const settle = () => {
      if (timer) clearTimeout(timer);
    };
    sock.once("connect", () => {
      settle();
      resolve(sock);
    });
    sock.once("error", (err) => {
      settle();
      reject(err);
    });
  });
}

/** Waits until `proc`'s stderr matches `pattern` (both relay binaries log a
 * "listening on ..." line — see forwarder.mjs's `log()` calls and
 * vsock-client's `main()`), or rejects after `timeoutMs`.
 *
 * Deliberately NOT a "probe-connect to the TCP port and see if it accepts"
 * check: both relays treat every accepted TCP connection as a real one to
 * relay onward (forwarder.mjs immediately dials the destination and calls
 * `tcpConn.pipe(unixConn)`), so a bare readiness probe would itself consume
 * one of the destination connections a test is waiting on — this bit the
 * first version of this file (a probe's `connect()+end()` silently ate the
 * `dest.nextConnection()` the real test client expected). Reading the
 * relay's own stderr avoids opening any extra connection at all. */
function waitForStderrMatch(proc: ChildProcess, pattern: RegExp, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stderr to match ${pattern} (got so far: ${JSON.stringify(buf)})`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (pattern.test(buf)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.stderr?.off("data", onData);
    };
    proc.stderr?.on("data", onData);
  });
}

/** Resolves once `sock` has received at least `n` bytes, with the first `n`
 * bytes read. Mirrors the Rust unit tests' `read_exact` usage. */
function readN(sock: net.Socket, n: number, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${n} bytes (got ${total})`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`stream ended before ${n} bytes were read (got ${total})`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("end", onEnd);
      sock.off("error", onError);
    };
    sock.on("data", onData);
    sock.once("end", onEnd);
    sock.once("error", onError);
  });
}

/** Resolves once `sock` observes EOF (a zero-byte read / "end" event) — the
 * relay's job of propagating a half-close from the other leg. */
function waitForEnd(sock: net.Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for EOF")), timeoutMs);
    sock.once("end", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Resolves once `sock` fully closes. */
function waitForClose(sock: net.Socket, timeoutMs = 3000): Promise<void> {
  if (sock.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for socket close")), timeoutMs);
    sock.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// --- node impl: docker/reviewer/forwarder.mjs (TCP -> unix socket) --------

/** A unix-socket "gateway" stand-in this file fully controls, so tests can
 * assert exactly what arrives on the destination side of the relay (not just
 * what bounces back to the TCP client). Queues incoming connections so
 * `nextConnection()` works whether it's called before or after the peer
 * actually connects. */
function createUnixDestination(): {
  path: string;
  ready: Promise<void>;
  nextConnection: () => Promise<net.Socket>;
} {
  const dir = mkdtempSync(join(tmpdir(), "magpie-relay-test-"));
  const path = join(dir, "gw.sock");
  const pendingConnections: net.Socket[] = [];
  const waiters: Array<(sock: net.Socket) => void> = [];

  const server = net.createServer((sock) => {
    const waiter = waiters.shift();
    if (waiter) waiter(sock);
    else pendingConnections.push(sock);
  });

  const ready = new Promise<void>((resolve) => server.listen(path, resolve));

  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        rmSync(dir, { recursive: true, force: true });
      }),
  );

  return {
    path,
    ready,
    nextConnection(): Promise<net.Socket> {
      const existing = pendingConnections.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Spawns the real `forwarder.mjs` subprocess pointed at `sockPath`, exactly
 * as `docker/reviewer/entrypoint.sh` does (`node /opt/magpie/forwarder.mjs
 * /run/gw/gw.sock`), and registers its teardown. */
function startForwarder(sockPath: string): ChildProcess {
  const proc = spawn(process.execPath, [FORWARDER_PATH, sockPath], { stdio: ["ignore", "pipe", "pipe"] });
  cleanups.push(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  });
  return proc;
}

describe.runIf(RELAY_IMPL === "node")("relay boundary contract — impl=node (docker/reviewer/forwarder.mjs)", () => {
  it(
    "relays bytes written by the TCP client to the destination, and the destination's reply back to the client",
    async () => {
      const dest = createUnixDestination();
      await dest.ready;
      const forwarderProc = startForwarder(dest.path);
      await waitForStderrMatch(forwarderProc, /listening on/);

      const client = await connectTcpClient();
      const destConn = dest.nextConnection();

      client.write("ping");
      const destSock = await destConn;
      expect((await readN(destSock, 4)).toString()).toBe("ping");

      destSock.write("pong");
      expect((await readN(client, 4)).toString()).toBe("pong");
    },
    10_000,
  );

  it(
    "propagates the TCP client's half-close as EOF on the destination side",
    async () => {
      const dest = createUnixDestination();
      await dest.ready;
      const forwarderProc = startForwarder(dest.path);
      await waitForStderrMatch(forwarderProc, /listening on/);

      const client = await connectTcpClient();
      const destConn = dest.nextConnection();
      client.end(); // FIN, no data — the relay must propagate this as EOF downstream.

      const destSock = await destConn;
      await waitForEnd(destSock);
    },
    10_000,
  );

  it(
    "propagates the destination's half-close as EOF on the TCP client side",
    async () => {
      const dest = createUnixDestination();
      await dest.ready;
      const forwarderProc = startForwarder(dest.path);
      await waitForStderrMatch(forwarderProc, /listening on/);

      const client = await connectTcpClient();
      const destConn = dest.nextConnection();
      const destSock = await destConn;
      destSock.end(); // FIN from the destination side.

      await waitForEnd(client);
    },
    10_000,
  );

  it(
    "tolerates a destination that closes immediately (teardown race) and keeps accepting later connections",
    async () => {
      const dest = createUnixDestination();
      await dest.ready;
      const forwarderProc = startForwarder(dest.path);
      await waitForStderrMatch(forwarderProc, /listening on/);

      // First connection: the destination slams the door shut with no data
      // at all — the relay must not hang or crash.
      const firstDestConn = dest.nextConnection();
      const client1 = await connectTcpClient();
      (await firstDestConn).destroy();
      await waitForClose(client1);

      // The relay process itself must still be alive and still accepting —
      // one bad connection must not take down the listener.
      expect(forwarderProc.exitCode).toBeNull();
      expect(forwarderProc.signalCode).toBeNull();

      const secondDestConn = dest.nextConnection();
      const client2 = await connectTcpClient();
      client2.write("still alive");
      const destSock2 = await secondDestConn;
      expect((await readN(destSock2, "still alive".length)).toString()).toBe("still alive");
    },
    10_000,
  );
});

// --- rust impl: rust/vsock-client (TCP -> AF_VSOCK) ------------------------

/** True iff `path` exists and is a character device — the same check
 * `rust/vsock-client/src/main.rs`'s `assert_char_device_present` and
 * `docker/reviewer/entrypoint.sh`'s `[ -c /dev/vsock ]` both perform. */
function isCharDevice(path: string): boolean {
  try {
    return statSync(path).isCharacterDevice();
  } catch {
    return false;
  }
}

const rustBinAvailable = existsSync(VSOCK_CLIENT_BIN);
const vsockTransportAvailable = isCharDevice("/dev/vsock");

const failClosedSkipReason = !rustBinAvailable
  ? `binary not found at ${VSOCK_CLIENT_BIN} -- build it first: cd rust && cargo build --release -p magpie-vsock-client`
  : vsockTransportAvailable
    ? "this environment actually has a real /dev/vsock; the fail-closed-without-vsock scenario this test asserts doesn't apply here"
    : null;

const byteRelaySkipReason = !rustBinAvailable
  ? `binary not found at ${VSOCK_CLIENT_BIN} -- build it first: cd rust && cargo build --release -p magpie-vsock-client`
  : "requires a real (or emulated) AF_VSOCK transport, unavailable in this environment (no /dev/vsock, no permission to load vsock_loopback) -- equivalent coverage lives in rust/vsock-client's own relay() unit tests, run via `cargo test -p magpie-vsock-client`";

describe.runIf(RELAY_IMPL === "rust")("relay boundary contract — impl=rust (magpie-vsock-client)", () => {
  it.skipIf(failClosedSkipReason !== null)(
    failClosedSkipReason
      ? `fails closed (never opens 127.0.0.1:${TCP_PORT}) when /dev/vsock is unavailable (SKIPPED: ${failClosedSkipReason})`
      : `fails closed (never opens 127.0.0.1:${TCP_PORT}) when /dev/vsock is unavailable`,
    async () => {
      const proc = spawn(VSOCK_CLIENT_BIN, [], { stdio: ["ignore", "pipe", "pipe"] });
      cleanups.push(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      });

      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Await 'close', NOT 'exit': 'exit' fires when the process terminates
      // but the stderr pipe may not be fully drained yet, so the final chunk
      // (carrying the "refusing to start ... /dev/vsock" message this test
      // asserts on) can still be in flight. 'close' fires only after all
      // stdio streams have closed, so `stderr` below is guaranteed complete —
      // this suite is the enforcement mechanism for the no-edit boundary
      // policy, so it must not flake and spuriously block swap PRs.
      const exitCode = await new Promise<number | null>((resolve) =>
        proc.once("close", (code) => resolve(code)),
      );

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/refusing to start/);
      expect(stderr).toMatch(/dev\/vsock/);

      // Fail-closed means fail-closed: unlike forwarder.mjs (which opens its
      // TCP listener unconditionally and only fails a given connection's
      // relay attempt), vsock-client must never accept a TCP connection it
      // has no way to relay in the first place. Explicit short timeout so a
      // hung connect (rather than the expected ECONNREFUSED) fails fast with
      // a clear message instead of burning the whole 10s test budget.
      await expect(connectTcpClient(1000)).rejects.toThrow();
    },
    10_000,
  );

  it.skip(
    `relays bytes bidirectionally over AF_VSOCK (SKIPPED: ${byteRelaySkipReason})`,
    () => {
      /* see skip reason above */
    },
  );

  it.skip(
    `propagates half-close as destination EOF over AF_VSOCK (SKIPPED: ${byteRelaySkipReason})`,
    () => {
      /* see skip reason above */
    },
  );

  it.skip(
    `tolerates a destination that closes/is already gone over AF_VSOCK (SKIPPED: ${byteRelaySkipReason})`,
    () => {
      /* see skip reason above */
    },
  );
});
