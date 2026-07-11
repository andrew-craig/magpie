import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { extractBearerToken, isLoopbackRequest } from "./http-util.js";

function fakeReq(opts: { authorization?: string; remoteAddress?: string }): IncomingMessage {
  return {
    headers: opts.authorization !== undefined ? { authorization: opts.authorization } : {},
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as IncomingMessage;
}

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    expect(extractBearerToken(fakeReq({ authorization: "Bearer sk-magpie-abc123" }))).toBe("sk-magpie-abc123");
  });

  it("returns undefined when the header is missing", () => {
    expect(extractBearerToken(fakeReq({}))).toBeUndefined();
  });

  it("returns undefined for a non-Bearer scheme", () => {
    expect(extractBearerToken(fakeReq({ authorization: "Basic dXNlcjpwYXNz" }))).toBeUndefined();
  });
});

describe("isLoopbackRequest", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("treats %s as loopback", (addr) => {
    expect(isLoopbackRequest(fakeReq({ remoteAddress: addr }))).toBe(true);
  });

  it.each(["10.0.0.5", "172.31.99.7", "203.0.113.9", undefined])(
    "treats %s as NOT loopback — this is the guard that must hold for /admin/* to stay unreachable from magpie-net",
    (addr) => {
      expect(isLoopbackRequest(fakeReq({ remoteAddress: addr }))).toBe(false);
    },
  );
});
