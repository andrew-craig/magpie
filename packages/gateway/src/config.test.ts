import { describe, expect, it } from "vitest";
import { GatewayConfigError, loadGatewayConfig } from "./config.js";

const REQUIRED_ENV = {
  MAGPIE_GATEWAY_OPENROUTER_KEY: "sk-or-real-key",
  MAGPIE_GATEWAY_MASTER_KEY: "test-master-key",
};

describe("loadGatewayConfig", () => {
  it("returns a fully typed config with defaults applied given only the required secrets", () => {
    const config = loadGatewayConfig({ ...REQUIRED_ENV });

    expect(config.socketDirRoot).toBe("/run/magpie-gateway/jobs");
    expect(config.mgmt).toEqual({ host: "127.0.0.1", port: 4100 });
    expect(config.upstream.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.defaultModel).toBeUndefined();
    expect(config.secrets.openrouterKey).toBe("sk-or-real-key");
    expect(config.secrets.masterKey).toBe("test-master-key");
  });

  it("honours GATEWAY_* overrides", () => {
    const config = loadGatewayConfig({
      ...REQUIRED_ENV,
      GATEWAY_SOCKET_DIR: "/tmp/some-other-jobs-root",
      GATEWAY_MGMT_PORT: "5100",
      GATEWAY_UPSTREAM_BASE_URL: "https://example.invalid/v1",
      GATEWAY_DEFAULT_MODEL: "anthropic/claude-sonnet-4.5",
    });

    expect(config.socketDirRoot).toBe("/tmp/some-other-jobs-root");
    // mgmt.host is hardcoded to loopback regardless of any env — there is no
    // env var that can move it (see config.ts's doc comment on `mgmt.host`).
    expect(config.mgmt).toEqual({ host: "127.0.0.1", port: 5100 });
    expect(config.upstream.baseUrl).toBe("https://example.invalid/v1");
    expect(config.defaultModel).toBe("anthropic/claude-sonnet-4.5");
  });

  it("throws GatewayConfigError with both problems when required secrets are missing", () => {
    expect(() => loadGatewayConfig({})).toThrow(GatewayConfigError);
    try {
      loadGatewayConfig({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayConfigError);
      const problems = (err as GatewayConfigError).problems;
      expect(problems.some((p) => p.includes("MAGPIE_GATEWAY_OPENROUTER_KEY"))).toBe(true);
      expect(problems.some((p) => p.includes("MAGPIE_GATEWAY_MASTER_KEY"))).toBe(true);
    }
  });

  it("rejects an out-of-range mgmt port", () => {
    expect(() => loadGatewayConfig({ ...REQUIRED_ENV, GATEWAY_MGMT_PORT: "99999" })).toThrow(GatewayConfigError);
  });
});
