// Flush-before-close acceptance test — the gateway must never drop a reply
// by closing promptly after a partial write.
//
// BACKGROUND: an earlier investigation found a timing race in libkrun's own
// `--vsock-uds` bridge — the exact transport the micro-VM tier carries live
// Pi<->gateway traffic over: when the HOST peer calls `shutdown(SHUT_WR)` in
// the SAME TICK as `sendall()`-ing its reply, the bridge can propagate the
// teardown to the guest before it finishes flushing the just-sent bytes, so
// the guest's blocking read sees a bare EOF instead of the reply. The bug is
// in the (external) bridge, so the micro-VM tier must not assume immunity —
// the mitigation this repo controls is that the GATEWAY (the host peer over
// that bridge) must never close/`destroy()` promptly after writing its final
// bytes; it must let the bytes flush first.
//
// The real gateway (packages/gateway/src/proxy-server.ts) replies exclusively
// via Node `http.ServerResponse.write()`/`end()` (never `res.destroy()`, never
// a synchronous `socket.shutdown()` in the last-write tick), which schedules
// the FIN through libuv AFTER the write buffer drains rather than racing it —
// structurally the SAFE shape (unlike the original investigation's Python
// stub, which `shutdown()`-ed synchronously after `sendall()`). This test
// VERIFIES that property empirically rather than trusting the code read:
//
//   - It binds the REAL proxy server on a UNIX SOCKET (the production
//     `job-sockets.ts` transport — the same kind of socket libkrun's
//     `--vsock-uds` bridge dials on the host side), not a TCP loopback port.
//   - It drives a client that reads the whole reply to EOF and asserts ZERO
//     byte loss on every gateway teardown path — a normal streamed success, a
//     LARGE multi-segment body (so flush-before-FIN is actually exercised
//     across kernel socket buffers, not a single tiny packet), an
//     error-before-headers (502), a budget rejection (402), and — the case
//     most likely to hide a prompt close-after-partial-write — an upstream
//     failure AFTER headers were already sent (the `headersSent` branch that
//     could, in a bad future refactor, `res.destroy()` and drop the bytes
//     already written).
//   - It also exercises the client-abort / `res.on("close")` -> upstream
//     `AbortController.abort()` teardown path.
//
// The libkrun vsock hop itself is validated on real hardware by a live
// micro-VM run under KVM — an automated test can't boot a VM. What THIS test
// locks down is the half that lives in this repo and could regress silently:
// the gateway's own write/close ordering.

import * as http from "node:http";
import { connect as netConnect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { createKeyStore, type KeyStore } from "./keystore.js";
import { createProxyServer, type ProxyServer, type ProxyServerDeps } from "./proxy-server.js";

const REAL_KEY = "REAL_OPENROUTER_KEY_SENTINEL";

function testConfig(): GatewayConfig {
  return {
    socketDirRoot: "/tmp/unused-in-flush-tests",
    mgmt: { host: "127.0.0.1", port: 0 },
    upstream: { baseUrl: "http://upstream.invalid/v1" },
    defaultModel: undefined,
    secrets: { openrouterKey: REAL_KEY, masterKey: "unused" },
  };
}

/**
 * Build a `fetchImpl` that returns `body` as a whatwg `Response` — the shape
 * proxy-server.ts consumes (`upstreamRes.ok`/`.status`/`.headers.get`/`.body`
 * async-iterated). `body` is a `ReadableStream<Uint8Array>` so we can control
 * exactly how (and how abruptly) the upstream "reply" arrives/ends.
 */
function fetchReturning(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  onCall?: (init: { signal?: AbortSignal }) => void,
): ProxyServerDeps["fetchImpl"] {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    onCall?.({ signal: init?.signal ?? undefined });
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as ProxyServerDeps["fetchImpl"];
}

/** A `ReadableStream` that enqueues each of `chunks` (optionally erroring after `errorAfter` of them, simulating an upstream that dies mid-stream). */
function streamOf(chunks: Buffer[], opts: { errorAfter?: number } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.errorAfter !== undefined && i >= opts.errorAfter) {
        controller.error(new Error("simulated upstream mid-stream failure"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[i]));
      i += 1;
    },
  });
}

let running: ProxyServer | undefined;
let socketDir: string | undefined;

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
  if (socketDir) {
    rmSync(socketDir, { recursive: true, force: true });
    socketDir = undefined;
  }
});

/** Bind the real proxy server on a fresh unix socket and return its path + the keystore. */
async function startOnUnixSocket(deps: ProxyServerDeps, keyStore: KeyStore = createKeyStore()): Promise<{ socketPath: string; keyStore: KeyStore }> {
  socketDir = mkdtempSync(join(tmpdir(), "magpie-gw-flush-"));
  const socketPath = join(socketDir, "gw.sock");
  const proxy = createProxyServer(testConfig(), keyStore, deps);
  await proxy.listen(socketPath);
  running = proxy;
  return { socketPath, keyStore };
}

/** A decoded HTTP response read over the unix socket via Node's own http client (handles chunked/content-length/close framing). */
interface DecodedResponse {
  status: number;
  body: Buffer;
}

/** POST a chat-completions request over the unix socket and read the WHOLE decoded body to EOF. */
function requestOverSocket(socketPath: string, key: string | undefined): Promise<DecodedResponse> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const req = http.request(
      { socketPath, path: "/v1/chat/completions", method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "m", messages: [] }));
  });
}

/**
 * The MOST FAITHFUL reproduction of the guest relay's failing consumer: a RAW
 * socket that writes one HTTP/1.0 request (which forces Node into
 * close-delimited framing — no chunked-transfer layer to unwrap, the body IS
 * every byte after the header block up to the connection close) and then does
 * the guest relay's exact move: read every byte until the server closes the
 * connection, a single EOF-terminated read of the whole reply. Returns the
 * raw response bytes (status line + headers + body). HTTP/1.0 (not 1.1 +
 * `Connection: close`) is required because Node STILL chunk-encodes a
 * no-Content-Length 1.1 response even when the connection will close; only a
 * 1.0 request makes it close-delimit, which is the framing the guest relay's
 * EOF-read consumer assumes.
 */
function rawRequestReadToEof(socketPath: string, key: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(socketPath);
    const chunks: Buffer[] = [];
    const body = JSON.stringify({ model: "m", messages: [] });
    sock.on("connect", () => {
      sock.write(
        `POST /v1/chat/completions HTTP/1.0\r\n` +
          `Host: gw\r\n` +
          `Authorization: Bearer ${key}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `\r\n` +
          body,
      );
    });
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", () => resolve(Buffer.concat(chunks)));
    sock.on("error", reject);
  });
}

/** Splits a raw HTTP response into its header block and body (everything after the first CRLFCRLF). */
function splitRawResponse(raw: Buffer): { head: string; body: Buffer } {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) return { head: raw.toString("utf-8"), body: Buffer.alloc(0) };
  return { head: raw.subarray(0, sep).toString("utf-8"), body: raw.subarray(sep + 4) };
}

function mintKey(keyStore: KeyStore): string {
  return keyStore.mint({ budgetUsd: 100, ttlSeconds: 3600 }).key;
}

describe("gateway reply flush safety (no truncation on close)", () => {
  it("delivers a normal streamed success body with zero byte loss", async () => {
    const payload = Buffer.from(JSON.stringify({ id: "x", choices: [{ message: { content: "hi" } }] }));
    const { socketPath, keyStore } = await startOnUnixSocket({
      fetchImpl: fetchReturning(200, streamOf([payload])),
    });
    const key = mintKey(keyStore);

    const res = await requestOverSocket(socketPath, key);
    expect(res.status).toBe(200);
    expect(res.body.equals(payload)).toBe(true);
  });

  it("delivers a LARGE multi-segment body with zero byte loss (flush-before-FIN across socket buffers)", async () => {
    // Many chunks totalling far more than a single socket buffer, so the
    // gateway's res.write()/res.end() genuinely has to flush across multiple
    // kernel segments before the FIN — the exact condition the flush-before-
    // close race needs to be able to manifest under. A same-tick close/destroy
    // after the last write would truncate this; res.end() must not.
    const chunk = Buffer.alloc(64 * 1024, 0x61); // 64 KiB of 'a'
    const chunks = Array.from({ length: 16 }, () => chunk); // 1 MiB total
    const total = 16 * 64 * 1024;
    const { socketPath, keyStore } = await startOnUnixSocket({
      fetchImpl: fetchReturning(200, streamOf(chunks)),
    });
    const key = mintKey(keyStore);

    const res = await requestOverSocket(socketPath, key);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(total);
    // Every byte is the sentinel — proves nothing was truncated OR corrupted.
    expect(res.body.every((b) => b === 0x61)).toBe(true);
  });

  it("delivers the LARGE body intact to a raw read-to-EOF client (the exact guest-relay consumer pattern)", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x62);
    const chunks = Array.from({ length: 16 }, () => chunk);
    const total = 16 * 64 * 1024;
    const { socketPath, keyStore } = await startOnUnixSocket({
      fetchImpl: fetchReturning(200, streamOf(chunks)),
    });
    const key = mintKey(keyStore);

    const raw = await rawRequestReadToEof(socketPath, key);
    const { head, body } = splitRawResponse(raw);
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    // Connection: close -> close-delimited framing (no chunked layer): the
    // body bytes after the header block are the entire reply, and a single
    // read-to-EOF (the guest relay's move) must see all of them.
    expect(body.length).toBe(total);
    expect(body.every((b) => b === 0x62)).toBe(true);
  });

  it("delivers a full error-BEFORE-headers body (502) with zero byte loss", async () => {
    // fetch itself rejects -> proxy-server.ts's pre-headers catch ->
    // sendJsonError -> res.end(<full json>). No partial write, but assert the
    // whole error object arrives (a prompt close here would truncate it too).
    const { socketPath, keyStore } = await startOnUnixSocket({
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as ProxyServerDeps["fetchImpl"],
    });
    const key = mintKey(keyStore);

    const res = await requestOverSocket(socketPath, key);
    expect(res.status).toBe(502);
    const parsed = JSON.parse(res.body.toString("utf-8")) as { error: { type: string } };
    expect(parsed.error.type).toBe("upstream_error");
  });

  it("delivers a full budget-rejection body (402) with zero byte loss", async () => {
    const keyStore = createKeyStore();
    const { key, id } = keyStore.mint({ budgetUsd: 1, ttlSeconds: 3600 });
    keyStore.recordSpend(id, 5); // push over budget
    const { socketPath } = await startOnUnixSocket(
      { fetchImpl: fetchReturning(200, streamOf([Buffer.from("unused")])) },
      keyStore,
    );

    const res = await requestOverSocket(socketPath, key);
    expect(res.status).toBe(402);
    const parsed = JSON.parse(res.body.toString("utf-8")) as { error: { type: string } };
    expect(parsed.error.type).toBe("budget_exceeded");
  });

  it("does not truncate the bytes already sent when the upstream fails AFTER headers (the res.destroy()-adjacent teardown)", async () => {
    // The case most likely to hide a prompt
    // close-after-partial-write: headers + several chunks already went out,
    // THEN the upstream body errors mid-stream. proxy-server.ts's outer catch
    // sees headersSent === true and calls res.end() (NOT res.destroy()), so
    // every byte written before the error must still reach the client — the
    // reply is a clean prefix, never a lost/RST'd stream.
    const prefixChunk = Buffer.alloc(32 * 1024, 0x63); // 32 KiB of 'c'
    const emittedBeforeError = 4;
    const chunks = Array.from({ length: emittedBeforeError }, () => prefixChunk);
    const { socketPath, keyStore } = await startOnUnixSocket({
      fetchImpl: fetchReturning(200, streamOf(chunks, { errorAfter: emittedBeforeError })),
    });
    const key = mintKey(keyStore);

    const raw = await rawRequestReadToEof(socketPath, key);
    const { head, body } = splitRawResponse(raw);
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    // All 4 already-written 32 KiB chunks arrive intact — none dropped by the
    // post-error teardown.
    expect(body.length).toBe(emittedBeforeError * 32 * 1024);
    expect(body.every((b) => b === 0x63)).toBe(true);
  });

  it("aborts the upstream request when the client disconnects mid-stream (res.on('close') teardown path)", async () => {
    // The other teardown direction: a client that goes away mid-reply must
    // trigger proxy-server.ts's `res.on("close", () => abortController.abort())`,
    // cancelling the upstream fetch so the gateway stops paying for tokens
    // nobody will read. Exercised here so the abort teardown path is covered
    // alongside the byte-loss paths above.
    let abortObserved = false;
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((r) => {
      resolveAborted = r;
    });
    // An upstream body that never ends on its own — only a client-abort can
    // stop it. Each `pull` yields to the event loop (a short delay) before
    // enqueuing so the gateway's forwarding loop can't starve the loop and
    // miss the client-disconnect / res 'close' event we're testing for.
    const neverEnding = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 10));
        controller.enqueue(new Uint8Array(Buffer.alloc(1024, 0x64)));
      },
    });
    const { socketPath, keyStore } = await startOnUnixSocket({
      fetchImpl: fetchReturning(200, neverEnding, ({ signal }) => {
        signal?.addEventListener("abort", () => {
          abortObserved = true;
          resolveAborted();
        });
      }),
    });
    const key = mintKey(keyStore);

    // Raw connect, send request, then destroy the socket mid-stream.
    await new Promise<void>((resolve, reject) => {
      const sock = netConnect(socketPath);
      const body = JSON.stringify({ model: "m", messages: [] });
      sock.on("connect", () => {
        sock.write(
          `POST /v1/chat/completions HTTP/1.1\r\nHost: gw\r\nAuthorization: Bearer ${key}\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      });
      let gotData = false;
      sock.on("data", () => {
        if (!gotData) {
          gotData = true;
          sock.destroy(); // client disconnects mid-stream
          resolve();
        }
      });
      sock.on("error", (err) => {
        // A local `destroy()` can surface as ECONNRESET on some platforms;
        // that's the disconnect we intended, not a failure.
        if (gotData) resolve();
        else reject(err);
      });
    });

    await aborted;
    expect(abortObserved).toBe(true);
  });
});
