import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: everything here runs fully offline. We have no real GitHub App
// credentials, so `@octokit/auth-app` is mocked to assert *how* it's driven
// (the right appId/privateKey/installationId reach the right calls) rather
// than exercising the real GitHub API. LIVE verification — e.g. minting a
// real installation token and listing the installation's repos with an
// actual GitHub App — is deferred to the later integration task, per the
// project's "provision creds as we go" decision.

const FAKE_TOKEN = "ghs_super-secret-installation-token-123";
const FAKE_EXPIRES_AT = "2026-07-06T13:00:00Z";

const installationAuthMock = vi.fn(async (options: unknown) => ({
  type: "token" as const,
  tokenType: "installation" as const,
  token: FAKE_TOKEN,
  expiresAt: FAKE_EXPIRES_AT,
  createdAt: "2026-07-06T12:00:00Z",
  permissions: {},
  repositorySelection: "all" as const,
  installationId: (options as { installationId: number }).installationId,
}));

const createAppAuthMock = vi.fn(() => installationAuthMock);

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: (...args: unknown[]) => createAppAuthMock(...args),
}));

const { mintInstallationToken, getAppBotLogin } = await import("./github.js");

const CREDS = {
  appId: "123456",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  installationId: 987654,
};

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createAppAuthMock.mockClear();
  installationAuthMock.mockClear();
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleInfoSpy.mockRestore();
});

/** Asserts the token never appeared in any console call across all spies. */
function assertTokenNeverLogged() {
  for (const spy of [consoleLogSpy, consoleErrorSpy, consoleWarnSpy, consoleInfoSpy]) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(FAKE_TOKEN);
      }
    }
  }
}

describe("mintInstallationToken", () => {
  it("drives createAppAuth with the given appId/privateKey", async () => {
    await mintInstallationToken(CREDS);

    expect(createAppAuthMock).toHaveBeenCalledTimes(1);
    expect(createAppAuthMock).toHaveBeenCalledWith({
      appId: CREDS.appId,
      privateKey: CREDS.privateKey,
    });
  });

  it("requests installation-token auth with the given installationId", async () => {
    await mintInstallationToken(CREDS);

    expect(installationAuthMock).toHaveBeenCalledTimes(1);
    expect(installationAuthMock).toHaveBeenCalledWith({
      type: "installation",
      installationId: CREDS.installationId,
    });
  });

  it("surfaces the returned token and expiry", async () => {
    const result = await mintInstallationToken(CREDS);

    expect(result.token).toBe(FAKE_TOKEN);
    expect(result.expiresAt).toBe(FAKE_EXPIRES_AT);
  });

  it("never emits the token to console", async () => {
    const result = await mintInstallationToken(CREDS);

    // Sanity check the token is in fact the secret value we're guarding.
    expect(result.token).toBe(FAKE_TOKEN);
    assertTokenNeverLogged();
  });
});

describe("getAppBotLogin", () => {
  // getAppBotLogin memoizes its result at MODULE scope (see github.ts's
  // `cachedBotLogin` doc comment) — resolved at most once per process. That
  // means this single test both proves the resolved value AND proves the
  // memoization, by calling it twice and asserting the fake `GET /app` only
  // fired once; a second `it()` block in this file calling getAppBotLogin
  // again would just observe the same cached promise from this test rather
  // than exercising anything new, so the two assertions are deliberately
  // combined here instead of split across tests.
  it("resolves `<slug>[bot]` from a fake app-JWT-authenticated octokit's GET /app, and memoizes across repeated calls", async () => {
    const getAuthenticated = vi.fn(async () => ({ data: { slug: "my-magpie-app" } }));
    const makeAppOctokit = vi.fn(() => ({
      rest: { apps: { getAuthenticated } },
    }));

    const first = await getAppBotLogin(
      { appId: CREDS.appId, privateKey: CREDS.privateKey },
      { makeAppOctokit: makeAppOctokit as never },
    );
    const second = await getAppBotLogin(
      { appId: CREDS.appId, privateKey: CREDS.privateKey },
      { makeAppOctokit: makeAppOctokit as never },
    );

    expect(first).toBe("my-magpie-app[bot]");
    expect(second).toBe("my-magpie-app[bot]");
    // Memoized: the underlying octokit factory and the GET /app call each
    // only ever fired once, even though getAppBotLogin was called twice.
    expect(makeAppOctokit).toHaveBeenCalledTimes(1);
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });
});
