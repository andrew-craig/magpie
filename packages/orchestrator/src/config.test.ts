import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveDefaultConfigPath } from "./config.js";

const REQUIRED_ENV = {
  MAGPIE_WEBHOOK_SECRET: "test-webhook-secret",
  MAGPIE_LLM_API_KEY: "test-llm-api-key",
  MAGPIE_GATEWAY_MASTER_KEY: "test-gateway-master-key",
} as const;

let workDir: string;
let savedEnv: NodeJS.ProcessEnv;
let savedCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "magpie-config-test-"));
  savedEnv = { ...process.env };
  savedCwd = process.cwd();
});

afterEach(() => {
  process.chdir(savedCwd);
  rmSync(workDir, { recursive: true, force: true });
  // Restore process.env exactly: clear everything added/changed, then
  // restore original keys, so tests never leak env state into each other.
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

function writeConfig(contents: string): string {
  const configPath = join(workDir, "config.toml");
  writeFileSync(configPath, contents, "utf-8");
  return configPath;
}

function writePemFile(): string {
  const pemPath = join(workDir, "github-app.pem");
  writeFileSync(pemPath, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n", "utf-8");
  return pemPath;
}

// NOTE: repo_allowlist is a top-level key, so in TOML it must appear before
// the first [section] header.
const MINIMAL_TOML = (privateKeyPath: string) => `
repo_allowlist = ["my-org/my-repo"]

[github]
app_id = "123456"
private_key_path = "${privateKeyPath}"

[llm]
model = "anthropic/claude-sonnet-4.5"
`;

describe("loadConfig", () => {
  it("returns a fully typed object with defaults applied for a valid minimal config", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(MINIMAL_TOML(pemPath));
    Object.assign(process.env, REQUIRED_ENV);

    const config = loadConfig(configPath);

    expect(config.github.appId).toBe("123456");
    expect(config.github.privateKeyPath).toBe(pemPath);
    expect(config.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.llm.model).toBe("anthropic/claude-sonnet-4.5");
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(8787);
    expect(config.limits.jobTimeoutSeconds).toBe(600);
    expect(config.limits.concurrency).toBe(2);
    expect(config.limits.maxDiffLines).toBe(4000);
    expect(config.repoAllowlist).toEqual(["my-org/my-repo"]);
    expect(config.workspace.workDir).toBe("/var/lib/magpie/work");
    expect(config.container.image).toBe("magpie-reviewer:0.1.0");
    expect(config.container.memory).toBe("4g");
    expect(config.container.cpus).toBe("2");
    expect(config.container.pidsLimit).toBe(256);
    expect(config.container.dockerBin).toBe("docker");
    expect(config.container.network).toBe("bridge");
    expect(config.gateway.baseUrl).toBe("http://127.0.0.1:4100");
    expect(config.gateway.perJobBudgetUsd).toBe(0.5);
    expect(config.gateway.ttlMarginSeconds).toBe(120);
    expect(config.secrets.webhookSecret).toBe("test-webhook-secret");
    expect(config.secrets.llmApiKey).toBe("test-llm-api-key");
    expect(config.secrets.githubPrivateKey).toContain("BEGIN PRIVATE KEY");
    expect(config.secrets.gatewayMasterKey).toBe("test-gateway-master-key");
  });

  it("allows overriding defaults via TOML", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(`
repo_allowlist = []

[github]
app_id = 999
private_key_path = "${pemPath}"

[llm]
base_url = "https://example.com/v1"
model = "some/model"

[server]
host = "0.0.0.0"
port = 9000

[limits]
job_timeout_seconds = 30
concurrency = 5
max_diff_lines = 100

[workspace]
work_dir = "/srv/magpie-work"

[container]
image = "magpie-reviewer:9.9.9"
memory = "8g"
cpus = "4"
pids_limit = 512
docker_bin = "/usr/local/bin/podman"
network = "magpie-net"

[gateway]
base_url = "http://10.0.0.1:9100"
per_job_budget_usd = 1.25
ttl_margin_seconds = 300
`);
    Object.assign(process.env, REQUIRED_ENV);

    const config = loadConfig(configPath);

    expect(config.github.appId).toBe("999");
    expect(config.llm.baseUrl).toBe("https://example.com/v1");
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.port).toBe(9000);
    expect(config.limits.jobTimeoutSeconds).toBe(30);
    expect(config.limits.concurrency).toBe(5);
    expect(config.limits.maxDiffLines).toBe(100);
    expect(config.repoAllowlist).toEqual([]);
    expect(config.workspace.workDir).toBe("/srv/magpie-work");
    expect(config.container.image).toBe("magpie-reviewer:9.9.9");
    expect(config.container.memory).toBe("8g");
    expect(config.container.cpus).toBe("4");
    expect(config.container.pidsLimit).toBe(512);
    expect(config.container.dockerBin).toBe("/usr/local/bin/podman");
    expect(config.container.network).toBe("magpie-net");
    expect(config.gateway.baseUrl).toBe("http://10.0.0.1:9100");
    expect(config.gateway.perJobBudgetUsd).toBe(1.25);
    expect(config.gateway.ttlMarginSeconds).toBe(300);
  });

  it("reports a malformed [container] field by name", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(
      MINIMAL_TOML(pemPath) +
        `\n[container]\npids_limit = "not-a-number"\n`,
    );
    Object.assign(process.env, REQUIRED_ENV);

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/container\.pids_limit/);
    }
  });

  it("rejects a relative workspace.work_dir with a clear error", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(
      MINIMAL_TOML(pemPath) + `\n[workspace]\nwork_dir = "./.magpie-work"\n`,
    );
    Object.assign(process.env, REQUIRED_ENV);

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/workspace\.work_dir must be an absolute path/);
    }
  });

  it("reports a missing required field by name", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(`
repo_allowlist = []

[github]
private_key_path = "${pemPath}"

[llm]
model = "anthropic/claude-sonnet-4.5"
`);
    Object.assign(process.env, REQUIRED_ENV);

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/github\.app_id/);
    }
  });

  it("reports a missing env secret by name", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(MINIMAL_TOML(pemPath));
    process.env.MAGPIE_WEBHOOK_SECRET = "test-webhook-secret";
    // MAGPIE_LLM_API_KEY intentionally left unset.

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/MAGPIE_LLM_API_KEY/);
    }
  });

  it("reports a missing MAGPIE_GATEWAY_MASTER_KEY by name", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(MINIMAL_TOML(pemPath));
    process.env.MAGPIE_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.MAGPIE_LLM_API_KEY = "test-llm-api-key";
    // MAGPIE_GATEWAY_MASTER_KEY intentionally left unset.

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/MAGPIE_GATEWAY_MASTER_KEY/);
    }
  });

  it("aggregates multiple problems into a single error", () => {
    // Missing app_id, missing private key resolution, malformed repo_allowlist entry,
    // and no env secrets set at all.
    const configPath = writeConfig(`
repo_allowlist = ["not-a-valid-entry"]

[github]

[llm]
model = "anthropic/claude-sonnet-4.5"
`);

    expect.assertions(6);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toMatch(/github\.app_id/);
      expect(message).toMatch(/MAGPIE_WEBHOOK_SECRET/);
      expect(message).toMatch(/MAGPIE_LLM_API_KEY/);
      expect(message).toMatch(/private_key_path/);
      expect(message).toMatch(/repo_allowlist/);
    }
  });

  it("rejects a malformed repo_allowlist entry", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(`
repo_allowlist = ["this-has-no-slash"]

[github]
app_id = "123456"
private_key_path = "${pemPath}"

[llm]
model = "anthropic/claude-sonnet-4.5"
`);
    Object.assign(process.env, REQUIRED_ENV);

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/repo_allowlist\.0/);
    }
  });

  it("uses MAGPIE_GITHUB_PRIVATE_KEY over private_key_path when both are present", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(MINIMAL_TOML(pemPath));
    Object.assign(process.env, REQUIRED_ENV);
    process.env.MAGPIE_GITHUB_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nenv-key\n-----END PRIVATE KEY-----\n";

    const config = loadConfig(configPath);

    expect(config.secrets.githubPrivateKey).toContain("env-key");
  });

  it("succeeds without private_key_path when MAGPIE_GITHUB_PRIVATE_KEY is set", () => {
    const configPath = writeConfig(`
repo_allowlist = []

[github]
app_id = "123456"

[llm]
model = "anthropic/claude-sonnet-4.5"
`);
    Object.assign(process.env, REQUIRED_ENV);
    process.env.MAGPIE_GITHUB_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nenv-key\n-----END PRIVATE KEY-----\n";

    const config = loadConfig(configPath);

    expect(config.github.privateKeyPath).toBeNull();
    expect(config.secrets.githubPrivateKey).toContain("env-key");
  });

  it("fails when neither private_key_path nor MAGPIE_GITHUB_PRIVATE_KEY is set", () => {
    const configPath = writeConfig(`
repo_allowlist = []

[github]
app_id = "123456"

[llm]
model = "anthropic/claude-sonnet-4.5"
`);
    Object.assign(process.env, REQUIRED_ENV);

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/private_key_path/);
    }
  });

  it("fails with a clear error when private_key_path points at a nonexistent file", () => {
    const configPath = writeConfig(MINIMAL_TOML(join(workDir, "does-not-exist.pem")));
    Object.assign(process.env, REQUIRED_ENV);

    expect.assertions(2);
    try {
      loadConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/private_key_path/);
    }
  });

  it("resolves the config path from MAGPIE_CONFIG when no explicit path is given", () => {
    const pemPath = writePemFile();
    const configPath = writeConfig(MINIMAL_TOML(pemPath));
    Object.assign(process.env, REQUIRED_ENV);
    process.env.MAGPIE_CONFIG = configPath;

    const config = loadConfig();

    expect(config.github.appId).toBe("123456");
  });

  it("resolves a relative private_key_path against the config file's directory, not process.cwd()", () => {
    // The PEM lives next to config.toml in workDir, but the private_key_path
    // in the TOML is written as a bare relative filename. If it were (still)
    // resolved against process.cwd(), chdir-ing away from workDir before
    // calling loadConfig would break resolution.
    writePemFile();
    const configPath = writeConfig(MINIMAL_TOML("github-app.pem"));
    Object.assign(process.env, REQUIRED_ENV);

    const unrelatedDir = mkdtempSync(join(tmpdir(), "magpie-config-cwd-"));
    try {
      process.chdir(unrelatedDir);

      const config = loadConfig(configPath);

      expect(config.secrets.githubPrivateKey).toContain("BEGIN PRIVATE KEY");
    } finally {
      rmSync(unrelatedDir, { recursive: true, force: true });
    }
  });
});

describe("resolveDefaultConfigPath", () => {
  // These exercise the walk-up logic directly against a hermetic fixture
  // tree (rather than the real repo layout) so the test doesn't depend on
  // where this package happens to sit on disk.

  it("finds an existing config.toml in an ancestor directory, however deeply nested the start dir is", () => {
    const rootConfigPath = writeConfig("# fixture root config\n");
    const nestedStartDir = join(workDir, "packages", "orchestrator", "src");
    mkdirSync(nestedStartDir, { recursive: true });

    expect(resolveDefaultConfigPath(nestedStartDir)).toBe(rootConfigPath);
  });

  it("falls back to the workspace root (marked by .git) when no ancestor has a config.toml", () => {
    mkdirSync(join(workDir, ".git"));
    const nestedStartDir = join(workDir, "packages", "orchestrator", "src");
    mkdirSync(nestedStartDir, { recursive: true });

    expect(resolveDefaultConfigPath(nestedStartDir)).toBe(
      join(workDir, "config.toml"),
    );
  });

  it("falls back to the workspace root (marked by a workspaces package.json) when there is no .git either", () => {
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
      "utf-8",
    );
    const nestedStartDir = join(workDir, "packages", "orchestrator", "src");
    mkdirSync(nestedStartDir, { recursive: true });

    expect(resolveDefaultConfigPath(nestedStartDir)).toBe(
      join(workDir, "config.toml"),
    );
  });

  it("resolves the same file regardless of process.cwd() (cwd-independence)", () => {
    const rootConfigPath = writeConfig("# fixture root config\n");
    const nestedStartDir = join(workDir, "packages", "orchestrator", "src");
    mkdirSync(nestedStartDir, { recursive: true });

    const cwdA = mkdtempSync(join(tmpdir(), "magpie-config-cwdA-"));
    const cwdB = mkdtempSync(join(tmpdir(), "magpie-config-cwdB-"));
    try {
      process.chdir(cwdA);
      const resolvedFromA = resolveDefaultConfigPath(nestedStartDir);

      process.chdir(cwdB);
      const resolvedFromB = resolveDefaultConfigPath(nestedStartDir);

      expect(resolvedFromA).toBe(rootConfigPath);
      expect(resolvedFromB).toBe(rootConfigPath);
      expect(resolvedFromA).toBe(resolvedFromB);
    } finally {
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });
});
