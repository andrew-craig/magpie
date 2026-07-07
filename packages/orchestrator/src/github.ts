// GitHub App authentication and installation-token minting.
//
// Magpie authenticates to GitHub as a *GitHub App*, not as a user or a
// long-lived PAT. The auth flow is:
//
//   App JWT (signed with the App's private key, proves "I am app N")
//     -> POST /app/installations/{id}/access_tokens
//     -> a short-lived (1 hour) installation access token
//
// The installation token is what the host orchestrator actually uses to do
// privileged work per job: cloning the PR branch and, later, publishing the
// review. It is minted **fresh for every job** — there is deliberately no
// cross-job cache here beyond the token's own natural GitHub-imposed TTL.
// Minting fresh means a compromised or leaked token has the smallest
// possible blast radius and lifetime.
//
// SECURITY: per the project's core threat model (see PLAN.md /
// AGENTS.md — capability separation, indirect prompt injection), this token
// is a real secret. It is never given to the reviewer container, and it must
// never be written to disk or logged anywhere on the host either. Treat the
// token itself as write-once, memory-only, host-side-git-use only.
//
// We use `@octokit/auth-app` for the JWT + installation-token exchange and
// `@octokit/rest` for a ready-to-use authenticated client (needed later for
// posting the review). Both are network calls to the real GitHub API — this
// module does not cache or retry beyond what those libraries do internally.

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/** Credentials + target installation needed to mint a GitHub App token. */
export interface InstallationAuthParams {
  /** The GitHub App's numeric ID (as a string; GitHub accepts either). */
  appId: string;
  /** PEM contents of the GitHub App's private key. */
  privateKey: string;
  /** The installation ID of the App on the target repo/org. */
  installationId: number;
}

/** A minted installation access token and its expiry. */
export interface InstallationToken {
  /** The installation access token. NEVER log or persist this value. */
  token: string;
  /** ISO-8601 UTC timestamp of when the token expires (~1 hour out). */
  expiresAt: string;
}

/**
 * Mint a fresh, short-lived (1 hour) GitHub App installation access token.
 *
 * Drives the standard GitHub App auth flow via `@octokit/auth-app`: signs an
 * App JWT from `appId`/`privateKey`, then exchanges it for an installation
 * token scoped to `installationId`. Call this once per job — do not cache
 * the result across jobs; each job should mint its own token.
 *
 * SECURITY: the returned `token` must never be logged or written to disk.
 * It is a live credential for the GitHub App's installation permissions.
 */
export async function mintInstallationToken(
  params: InstallationAuthParams,
): Promise<InstallationToken> {
  const auth = createAppAuth({
    appId: params.appId,
    privateKey: params.privateKey,
  });

  const installationAuth = await auth({
    type: "installation",
    installationId: params.installationId,
  });

  return {
    token: installationAuth.token,
    expiresAt: installationAuth.expiresAt,
  };
}

/**
 * Build an Octokit client authenticated as the GitHub App installation.
 *
 * Useful for privileged host-side GitHub API calls (e.g. later, publishing
 * the review). Internally this also mints a fresh installation token via the
 * same `@octokit/auth-app` flow as {@link mintInstallationToken}; Octokit
 * manages the token's lifetime for the calls made through this client.
 */
export function createInstallationOctokit(
  params: InstallationAuthParams,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: params.appId,
      privateKey: params.privateKey,
      installationId: params.installationId,
    },
  });
}

/** The slice of {@link Config} that GitHub App auth needs. */
export interface GithubAuthConfig {
  github: { appId: string };
  secrets: { githubPrivateKey: string };
}

/**
 * Convenience adapter: mint a fresh installation token using credentials
 * pulled from the loaded {@link Config} rather than passing them by hand.
 * The core functions above still take injected credentials directly so they
 * stay unit-testable without a config file.
 */
export async function mintInstallationTokenFromConfig(
  config: GithubAuthConfig,
  installationId: number,
): Promise<InstallationToken> {
  return mintInstallationToken({
    appId: config.github.appId,
    privateKey: config.secrets.githubPrivateKey,
    installationId,
  });
}
