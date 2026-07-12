// Small `node:http` helpers shared by the proxy and admin planes. Kept
// framework-free per the M4-A contract (matches orchestrator/src/server.ts's
// plain `node:http` convention — no Express/Fastify for a two-endpoint
// service).

import type { IncomingMessage, ServerResponse } from "node:http";

/** Reject a request body larger than this before it's ever fully buffered (defends against an unbounded-body DoS on either plane). */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB — generous for a chat-completion payload, tiny for a DoS.

/** Thrown by {@link readBody} when the body exceeds `maxBytes`. */
export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Buffers a request body into a single `Buffer`, capped at `maxBytes`. Used
 * by both planes' POST/DELETE handlers — none of magpie-gateway's request
 * bodies are large or need streaming parse (unlike the *response* bodies the
 * proxy plane streams straight through, see proxy-server.ts).
 */
export function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

/** Shape of every JSON error body this service returns — mirrors the OpenAI/OpenRouter `{ error: { message, type } }` convention so Pi's OpenAI-compatible client surfaces a sane message. */
export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
  };
}

/** Writes a JSON error response with the given status and `{ error: { message, type } }` body. */
export function sendJsonError(res: ServerResponse, status: number, message: string, type: string): void {
  const body: ApiErrorBody = { error: { message, type } };
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Writes a JSON success response with the given status. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Extracts a bearer token from an `Authorization: Bearer <token>` header.
 * Returns `undefined` if the header is missing or not in that exact form.
 */
export function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

/**
 * True if `req`'s socket remote address is loopback (`127.0.0.1`, `::1`, or
 * the IPv4-mapped `::ffff:127.0.0.1`). Used as defense-in-depth on the mgmt
 * plane (see admin-server.ts) IN ADDITION TO binding that listener to
 * `127.0.0.1` only — belt-and-suspenders so the "mgmt never reachable from
 * magpie-net" guarantee doesn't rest on the bind address alone.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
