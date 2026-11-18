import { ApiError } from './http.js';
// Bindings, variables and secrets. Secrets are set with `wrangler secret put` (production) or `.dev.vars`
// (local development, git-ignored) and never appear in source code or wrangler.jsonc.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // ---- variables (wrangler.jsonc)
  /** Public origin of this deployment, e.g. https://jbd.example.workers.dev. Used for redirects and Origin checks. */
  APP_ORIGIN: string;
  ATLASSIAN_CLIENT_ID: string;
  /** https://auth.atlassian.com in production; a local mock in tests. */
  ATLASSIAN_AUTH_BASE: string;
  /** https://api.atlassian.com in production; a local mock in tests. */
  ATLASSIAN_API_BASE: string;
  VAPID_PUBLIC_KEY: string;
  /** mailto: or https: contact for push services. A secret in production (keeps the address out of the repo). */
  VAPID_SUBJECT: string;
  /** Comma-separated host suffixes push subscriptions may point at (SSRF protection). */
  PUSH_ENDPOINT_HOSTS: string;
  /** Subrequests one cron run may use. Workers Free allows 50 per invocation; keep a margin. */
  MONITOR_SUBREQUEST_BUDGET?: string;
  /**
   * Users checked per cron run. Workers Free allows 10 ms CPU per invocation; an idle check costs ~0.4 ms
   * (measured, see scripts/test-unit.mjs), so 12 leaves room for a user with changes and a push. Raise on Workers Paid.
   */
  MONITOR_MAX_USERS_PER_RUN?: string;
  /** Smallest allowed monitoring interval in minutes. 5 in production. */
  MIN_INTERVAL_MIN?: string;
  /** "1" only in local tests: lets push endpoints use plain http. */
  ALLOW_INSECURE_PUSH?: string;

  /** Optional: the Atlassian accountId that owns the OAuth app. Its token is preferred for personal data reporting. */
  ATLASSIAN_APP_OWNER_ACCOUNT_ID?: string;

  // ---- secrets
  ATLASSIAN_CLIENT_SECRET: string;
  /** base64 of 32 random bytes. `npm run vapid` prints one. */
  TOKEN_ENC_KEY: string;
  /** Optional previous key, base64, for rotating TOKEN_ENC_KEY without logging everyone out. */
  TOKEN_ENC_KEY_OLD?: string;
  /** VAPID private key, base64url "d" of a P-256 key. */
  VAPID_PRIVATE_KEY: string;
}

export const SCOPES = ['read:jira-work', 'read:jira-user', 'read:me', 'offline_access'];

export const SESSION_TTL_MS = 30 * 864e5; // absolute
export const SESSION_IDLE_MS = 7 * 864e5; // idle
export const SESSION_COOKIE = '__Host-jbd_sid';
export const STATE_COOKIE = '__Host-jbd_oauth';

export const minInterval = (env: Env): number => Math.max(1, Number(env.MIN_INTERVAL_MIN ?? 5) || 5);
export const maxUsersPerRun = (env: Env): number => Math.min(200, Math.max(1, Number(env.MONITOR_MAX_USERS_PER_RUN ?? 12) || 12));
export const budgetSize = (env: Env): number => Math.min(48, Math.max(10, Number(env.MONITOR_SUBREQUEST_BUDGET ?? 45) || 45));

/** Fails fast with a clear message when a deployment is missing configuration. */
export function assertConfigured(env: Env): void {
  const missing = (['APP_ORIGIN', 'ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'TOKEN_ENC_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const)
    .filter((k) => !env[k] || /REPLACE/.test(String(env[k])));
  // Only setting names are reported, never values.
  if (missing.length) throw new ApiError(503, `Cloud edition is not configured: missing ${missing.join(', ')}. See cloud/README.md.`, 'not_configured');
}
