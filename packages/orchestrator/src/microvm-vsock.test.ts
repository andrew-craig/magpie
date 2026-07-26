import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_SOCKET_BASENAME,
  MICROVM_VSOCK_PORT,
  microvmVsockChannel,
} from "./microvm-vsock.js";

describe("microvmVsockChannel", () => {
  it("derives udsPath as <socketDir>/gw.sock for an absolute socketDir", () => {
    const socketDir = "/run/magpie/gateway/job-abc123";

    const channel = microvmVsockChannel({ socketDir });

    expect(channel.udsPath).toBe(join(socketDir, "gw.sock"));
    expect(channel.udsPath).toBe(join(socketDir, GATEWAY_SOCKET_BASENAME));
  });

  it("uses the fixed MICROVM_VSOCK_PORT (1234)", () => {
    const channel = microvmVsockChannel({ socketDir: "/run/magpie/gateway/job-abc123" });

    expect(MICROVM_VSOCK_PORT).toBe(1234);
    expect(channel.port).toBe(MICROVM_VSOCK_PORT);
  });

  it("rejects an empty socketDir", () => {
    expect(() => microvmVsockChannel({ socketDir: "" })).toThrow();
  });

  it("rejects a relative socketDir", () => {
    expect(() => microvmVsockChannel({ socketDir: "relative/job-dir" })).toThrow();
  });

  it("gives two distinct jobs distinct udsPaths but the SAME port (per-job isolation is by uds_path, not port)", () => {
    // Two concurrent jobs mint two distinct gateway keys, each with its own
    // socketDir (as job-sockets.ts guarantees — one directory per sanitized
    // jobId). The derived channels must never collide on udsPath: that's what
    // actually prevents job A's guest from reaching job B's gateway socket.
    // Sharing the same fixed port is fine and expected — isolation never
    // depended on the port being unique, only on the host-side socket path.
    const channelA = microvmVsockChannel({ socketDir: "/run/magpie/gateway/job-aaaa" });
    const channelB = microvmVsockChannel({ socketDir: "/run/magpie/gateway/job-bbbb" });

    expect(channelA.udsPath).not.toBe(channelB.udsPath);
    expect(channelA.port).toBe(channelB.port);
    expect(channelA.port).toBe(MICROVM_VSOCK_PORT);
  });
});
