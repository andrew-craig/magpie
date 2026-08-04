import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";
import {
  applyRepoConfig,
  fetchRepoConfig,
  GUIDANCE_MAX_CHARS,
  IGNORE_PATH_MAX_CHARS,
  IGNORE_PATHS_MAX_ENTRIES,
  MAX_REPO_CONFIG_BYTES,
  REPO_CONFIG_PATH,
  type RepoConfig,
} from "./repo-config.js";

// NOTE: everything here runs fully offline — a hand-rolled fake Octokit
// exposing only `rest.repos.getContent`, mirroring diff.test.ts's fake-
// Octokit pattern. No network, no real GitHub credentials.

function silentLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function fakeOctokitWithContent(content: string, opts: { size?: number; type?: string } = {}) {
  const getContent = vi.fn(async () => ({
    data: {
      type: opts.type ?? "file",
      size: opts.size ?? Buffer.byteLength(content, "utf-8"),
      content: Buffer.from(content, "utf-8").toString("base64"),
    },
  }));
  const octokit = { rest: { repos: { getContent } } };
  return { octokit: octokit as unknown as Octokit, getContent };
}

function fakeOctokitThrowing(err: unknown) {
  const getContent = vi.fn(async () => {
    throw err;
  });
  const octokit = { rest: { repos: { getContent } } };
  return { octokit: octokit as unknown as Octokit, getContent };
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    github: { appId: "123", privateKeyPath: null },
    llm: { baseUrl: "https://example.com/v1", model: "server/model", allowedModels: [] },
    server: { host: "127.0.0.1", port: 0 },
    limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 },
    repoAllowlist: ["acme/widgets"],
    workspace: { workDir: "/tmp/magpie-work" },
    container: {
      image: "magpie-reviewer:0.1.0",
      memory: "4g",
      requireMemoryLimit: true,
      cpus: "2",
      pidsLimit: 256,
      dockerBin: "docker",
      tier: "crun",
      tierProbeBin: "magpie-tier-probe",
    },
    microvm: { ramMib: 1024, vcpus: 2, rootfsPath: "", hostRamBudgetMib: 4096, launcherBin: "magpie-krun-launch" },
    gateway: {
      baseUrl: "http://127.0.0.1:4100",
      containerBaseUrl: "http://127.0.0.1:4000/v1",
      perJobBudgetUsd: 0.5,
      ttlMarginSeconds: 120,
    },
    telemetry: { path: "/tmp/magpie-telemetry-test.jsonl" },
    secrets: {
      webhookSecret: "test-webhook-secret",
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      gatewayMasterKey: "test-gateway-master-key",
    },
    ...overrides,
  };
}

describe("fetchRepoConfig", () => {
  it("fetches from the given ref and path", async () => {
    const { octokit, getContent } = fakeOctokitWithContent('[review]\nguidance = "be nice"\n');
    await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger: silentLogger() });
    expect(getContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      path: REPO_CONFIG_PATH,
      ref: "main",
    });
  });

  it("returns a valid parsed config", async () => {
    const { octokit } = fakeOctokitWithContent(
      ['[llm]', 'model = "openrouter/x"', '', '[limits]', "max_diff_lines = 100", "", "[review]", 'guidance = "focus on security"', 'ignore_paths = ["vendor/**", "*.min.js"]'].join("\n"),
    );
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger: silentLogger() });
    expect(result).toEqual<RepoConfig>({
      llm: { model: "openrouter/x" },
      limits: { maxDiffLines: 100 },
      review: { guidance: "focus on security", ignorePaths: ["vendor/**", "*.min.js"] },
    });
  });

  it("returns null (not an error) on a 404 — no .magpie.toml is the common case", async () => {
    const { octokit, getContent } = fakeOctokitThrowing({ status: 404, message: "Not Found" });
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(getContent).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("falls back on a non-404 API error, with a warning logged", async () => {
    const { octokit } = fakeOctokitThrowing(new Error("network blip"));
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it("falls back when the content API reports a directory, not a file", async () => {
    const getContent = vi.fn(async () => ({ data: [{ type: "file", name: ".magpie.toml" }] }));
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit;
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it("falls back on an oversized file (reported size over the cap)", async () => {
    const { octokit } = fakeOctokitWithContent('[review]\nguidance = "x"\n', { size: MAX_REPO_CONFIG_BYTES + 1 });
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-oversized" }));
  });

  it("falls back on an oversized decoded body even if the reported size lied", async () => {
    const big = "x".repeat(MAX_REPO_CONFIG_BYTES + 100);
    const content = `[review]\nguidance = "${big}"\n`;
    const { octokit } = fakeOctokitWithContent(content, { size: 10 });
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-oversized" }));
  });

  it("falls back on malformed TOML", async () => {
    const { octokit } = fakeOctokitWithContent("this is not [ valid toml");
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-invalid-toml" }));
  });

  it("falls back on an unknown top-level section (strict schema)", async () => {
    const { octokit } = fakeOctokitWithContent('[container]\nimage = "evil/image:latest"\n');
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-schema-invalid" }));
  });

  it("falls back on an unknown key inside a known section (strict schema)", async () => {
    const { octokit } = fakeOctokitWithContent('[llm]\nmodel = "x/y"\nbase_url = "https://evil.example/v1"\n');
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-schema-invalid" }));
  });

  it("falls back on non-UTF8 content", async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: "file",
        size: 4,
        // Invalid UTF-8 byte sequence, base64-encoded directly (bypassing
        // fakeOctokitWithContent's UTF-8 round trip on purpose).
        content: Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64"),
      },
    }));
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit;
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-not-utf8" }));
  });

  it("accepts a file whose guidance legitimately contains a literal U+FFFD replacement character", async () => {
    // Distinct from actual invalid UTF-8 (the test above): this is VALID
    // UTF-8 that happens to encode the replacement character itself as real
    // content, e.g. a repo documenting its own encoding-handling
    // conventions. A naive `text.includes("�")` check would wrongly
    // reject this; the strict TextDecoder only rejects genuinely malformed
    // byte sequences.
    const content = '[review]\nguidance = "mojibake often shows up as � in logs"\n';
    const { octokit } = fakeOctokitWithContent(content);
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toEqual<RepoConfig>({
      llm: undefined,
      limits: undefined,
      review: { guidance: "mojibake often shows up as � in logs", ignorePaths: undefined },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("falls back when review.ignore_paths has more than IGNORE_PATHS_MAX_ENTRIES entries", async () => {
    const tooMany = Array.from({ length: IGNORE_PATHS_MAX_ENTRIES + 1 }, (_, i) => `dir${i}/**`);
    const toml = `[review]\nignore_paths = [${tooMany.map((p) => JSON.stringify(p)).join(", ")}]\n`;
    const { octokit } = fakeOctokitWithContent(toml);
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-schema-invalid" }));
  });

  it("accepts review.ignore_paths at exactly IGNORE_PATHS_MAX_ENTRIES entries", async () => {
    const exactlyMax = Array.from({ length: IGNORE_PATHS_MAX_ENTRIES }, (_, i) => `dir${i}/**`);
    const toml = `[review]\nignore_paths = [${exactlyMax.map((p) => JSON.stringify(p)).join(", ")}]\n`;
    const { octokit } = fakeOctokitWithContent(toml);
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger: silentLogger() });
    expect(result?.review?.ignorePaths).toHaveLength(IGNORE_PATHS_MAX_ENTRIES);
  });

  it("falls back when a single review.ignore_paths entry exceeds IGNORE_PATH_MAX_CHARS", async () => {
    const tooLong = "d".repeat(IGNORE_PATH_MAX_CHARS + 1);
    const toml = `[review]\nignore_paths = [${JSON.stringify(tooLong)}]\n`;
    const { octokit } = fakeOctokitWithContent(toml);
    const logger = silentLogger();
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "repo-config-schema-invalid" }));
  });

  it("accepts a review.ignore_paths entry at exactly IGNORE_PATH_MAX_CHARS", async () => {
    const exactlyMax = "d".repeat(IGNORE_PATH_MAX_CHARS);
    const toml = `[review]\nignore_paths = [${JSON.stringify(exactlyMax)}]\n`;
    const { octokit } = fakeOctokitWithContent(toml);
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger: silentLogger() });
    expect(result?.review?.ignorePaths).toEqual([exactlyMax]);
  });

  it("an empty file parses to an empty (all-undefined-section) RepoConfig", async () => {
    const { octokit } = fakeOctokitWithContent("");
    const result = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger: silentLogger() });
    expect(result).toEqual<RepoConfig>({ llm: undefined, limits: undefined, review: undefined });
  });
});

describe("applyRepoConfig", () => {
  it("with repoConfig null, returns the server config unchanged in every field and no sidecars", () => {
    const server = testConfig();
    const result = applyRepoConfig(server, null, silentLogger());
    expect(result.config).toEqual(server);
    expect(result.guidance).toBe("");
    expect(result.ignorePaths).toEqual([]);
    expect(result.accepted).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("applies llm.model when it is in the server's allowed_models", () => {
    const server = testConfig({ llm: { baseUrl: "https://x", model: "server/model", allowedModels: ["repo/model", "other/model"] } });
    const result = applyRepoConfig(server, { llm: { model: "repo/model" } }, silentLogger());
    expect(result.config.llm.model).toBe("repo/model");
    expect(result.accepted).toEqual(["llm.model=repo/model"]);
  });

  it("refuses llm.model when allowed_models is empty", () => {
    const server = testConfig({ llm: { baseUrl: "https://x", model: "server/model", allowedModels: [] } });
    const result = applyRepoConfig(server, { llm: { model: "anything/goes" } }, silentLogger());
    expect(result.config.llm.model).toBe("server/model");
    expect(result.refused).toEqual([expect.stringContaining("llm.model=anything/goes")]);
  });

  it("refuses llm.model when it is not a member of a non-empty allowed_models", () => {
    const server = testConfig({ llm: { baseUrl: "https://x", model: "server/model", allowedModels: ["only/this-one"] } });
    const result = applyRepoConfig(server, { llm: { model: "not/allowed" } }, silentLogger());
    expect(result.config.llm.model).toBe("server/model");
    expect(result.refused).toEqual([expect.stringContaining("llm.model=not/allowed")]);
  });

  it("the server's own configured model need not be in allowed_models to keep working", () => {
    const server = testConfig({ llm: { baseUrl: "https://x", model: "server/model", allowedModels: [] } });
    const result = applyRepoConfig(server, null, silentLogger());
    expect(result.config.llm.model).toBe("server/model");
  });

  it("clamps limits.max_diff_lines to the server cap when the repo asks for more", () => {
    const server = testConfig({ limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 } });
    const result = applyRepoConfig(server, { limits: { maxDiffLines: 999999 } }, silentLogger());
    expect(result.config.limits.maxDiffLines).toBe(4000);
    expect(result.accepted[0]).toContain("clamped to server cap 4000");
  });

  it("applies limits.max_diff_lines when the repo asks for LESS than the server cap", () => {
    const server = testConfig({ limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 } });
    const result = applyRepoConfig(server, { limits: { maxDiffLines: 500 } }, silentLogger());
    expect(result.config.limits.maxDiffLines).toBe(500);
  });

  it("never raises limits.max_diff_lines above the server value", () => {
    const server = testConfig({ limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 100 } });
    const result = applyRepoConfig(server, { limits: { maxDiffLines: 100000 } }, silentLogger());
    expect(result.config.limits.maxDiffLines).toBeLessThanOrEqual(100);
  });

  it("applies review.guidance verbatim under the cap", () => {
    const server = testConfig();
    const result = applyRepoConfig(server, { review: { guidance: "please focus on null checks" } }, silentLogger());
    expect(result.guidance).toBe("please focus on null checks");
  });

  it("truncates review.guidance at GUIDANCE_MAX_CHARS", () => {
    const server = testConfig();
    const long = "x".repeat(GUIDANCE_MAX_CHARS + 500);
    const result = applyRepoConfig(server, { review: { guidance: long } }, silentLogger());
    expect(result.guidance.length).toBe(GUIDANCE_MAX_CHARS);
  });

  it("ignores empty/whitespace-only guidance", () => {
    const server = testConfig();
    const result = applyRepoConfig(server, { review: { guidance: "   " } }, silentLogger());
    expect(result.guidance).toBe("");
    expect(result.accepted).toEqual([]);
  });

  it("applies review.ignore_paths", () => {
    const server = testConfig();
    const result = applyRepoConfig(server, { review: { ignorePaths: ["vendor/**", "*.min.js"] } }, silentLogger());
    expect(result.ignorePaths).toEqual(["vendor/**", "*.min.js"]);
  });

  it("SECURITY: a hostile RepoConfig can only ever carry the four typed fields — every non-overridable Config field is byte-identical to server config", () => {
    const server = testConfig({
      llm: { baseUrl: "https://real-gateway.internal/v1", model: "server/model", allowedModels: ["repo/model"] },
      repoAllowlist: ["acme/widgets", "acme/other"],
      container: {
        image: "ghcr.io/real/reviewer:1.0@sha256:abc",
        memory: "4g",
        requireMemoryLimit: true,
        cpus: "2",
        pidsLimit: 256,
        dockerBin: "podman",
        tier: "crun",
        tierProbeBin: "magpie-tier-probe",
      },
      gateway: {
        baseUrl: "http://127.0.0.1:4100",
        containerBaseUrl: "http://127.0.0.1:4000/v1",
        perJobBudgetUsd: 0.5,
        ttlMarginSeconds: 120,
      },
    });
    // The MOST a RepoConfig object can carry is these typed fields — there is
    // no way to express "container.image" or "gateway.baseUrl" etc in this
    // type at all (that's enforced separately by the strict zod schema in
    // fetchRepoConfig; this test asserts the OTHER half: even if such a
    // value somehow arrived here as a RepoConfig, applyRepoConfig ignores
    // anything it doesn't explicitly read).
    const hostile: RepoConfig = {
      llm: { model: "repo/model" },
      limits: { maxDiffLines: 1 },
      review: { guidance: "hi", ignorePaths: ["**"] },
    };
    const result = applyRepoConfig(server, hostile, silentLogger());

    // Every field EXCEPT llm.model and limits.maxDiffLines must be identical
    // to the server config.
    expect(result.config.github).toEqual(server.github);
    expect(result.config.llm.baseUrl).toBe(server.llm.baseUrl);
    expect(result.config.llm.allowedModels).toEqual(server.llm.allowedModels);
    expect(result.config.server).toEqual(server.server);
    expect(result.config.limits.jobTimeoutSeconds).toBe(server.limits.jobTimeoutSeconds);
    expect(result.config.limits.concurrency).toBe(server.limits.concurrency);
    expect(result.config.repoAllowlist).toEqual(server.repoAllowlist);
    expect(result.config.workspace).toEqual(server.workspace);
    expect(result.config.container).toEqual(server.container);
    expect(result.config.microvm).toEqual(server.microvm);
    expect(result.config.gateway).toEqual(server.gateway);
    expect(result.config.telemetry).toEqual(server.telemetry);
    expect(result.config.secrets).toEqual(server.secrets);

    // The two genuinely-overridable fields DID change (proving this isn't a
    // vacuous "nothing ever applies" test).
    expect(result.config.llm.model).toBe("repo/model");
    expect(result.config.limits.maxDiffLines).toBe(1);
  });

  it("SECURITY: a fully-populated but schema-rejected hostile .magpie.toml (fetchRepoConfig -> null) yields an effective config identical to server config end-to-end", async () => {
    const server = testConfig();
    const hostileToml = [
      "[container]",
      'image = "evil/image:latest"',
      'tier = "crun"',
      "",
      "[gateway]",
      'base_url = "http://attacker.example/mgmt"',
      "per_job_budget_usd = 999999",
      "",
      "[repo_allowlist]",
      'value = "anything/anything"',
      "",
      "[limits]",
      "max_diff_lines = 999999999",
      "concurrency = 999",
      "job_timeout_seconds = 999999",
    ].join("\n");
    const { octokit } = fakeOctokitWithContent(hostileToml);
    const logger = silentLogger();
    const fetched = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger });
    expect(fetched).toBeNull();

    const result = applyRepoConfig(server, fetched, logger);
    expect(result.config).toEqual(server);
  });

  it("the same .magpie.toml content on the PR head has no effect: fetchRepoConfig is pinned to whatever ref the caller passes, and pipeline.ts always passes the default branch, never the head ref", async () => {
    // This test documents the CONTRACT fetchRepoConfig relies on: it reads
    // exactly the `ref` it's given and nothing else. The full base-branch
    // pinning guarantee (pipeline.ts never passing the PR head ref) is
    // exercised end-to-end in pipeline.test.ts, which controls both refs and
    // asserts getContent was called with the DEFAULT branch, not the head
    // SHA. Here we just pin down that two different `ref`s hit two different
    // requests (i.e. fetchRepoConfig has no ref-independent caching/fallback
    // that could blur that distinction).
    const headContent = '[review]\nguidance = "from the PR head, should never be read"\n';
    const defaultBranchContent = '[review]\nguidance = "from the default branch"\n';
    const getContent = vi.fn(async (args: { ref: string }) => ({
      data: {
        type: "file",
        size: 0,
        content: Buffer.from(args.ref === "main" ? defaultBranchContent : headContent, "utf-8").toString("base64"),
      },
    }));
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit;

    const fromDefault = await fetchRepoConfig({ octokit, owner: "acme", repo: "widgets", ref: "main", logger: silentLogger() });
    expect(fromDefault?.review?.guidance).toBe("from the default branch");

    const fromHead = await fetchRepoConfig({
      octokit,
      owner: "acme",
      repo: "widgets",
      ref: "abcféad-pr-head-sha",
      logger: silentLogger(),
    });
    expect(fromHead?.review?.guidance).toBe("from the PR head, should never be read");
    // Both calls happened with their OWN distinct ref, proving fetchRepoConfig
    // itself has no hidden default-branch-only behaviour baked in — the
    // caller (pipeline.ts) is the sole enforcer of "always the default
    // branch", verified separately in pipeline.test.ts.
    expect(getContent).toHaveBeenNthCalledWith(1, expect.objectContaining({ ref: "main" }));
    expect(getContent).toHaveBeenNthCalledWith(2, expect.objectContaining({ ref: "abcféad-pr-head-sha" }));
  });
});
