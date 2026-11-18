// Sign-in with Atlassian (OAuth 2.0 3LO), sessions, encrypted token storage and token refresh.
//
// Identity: the Atlassian account is the user's identity. There are no passwords to store or leak.
// Tokens: access + refresh tokens are encrypted with AES-256-GCM using TOKEN_ENC_KEY (a Worker secret, kept
// outside the database) and never leave the Worker. The browser only ever holds an opaque session cookie.

import { HttpError, type JiraApi, type Json } from '../../src/core/jira.js';
import type { Budget } from './budget.js';
import { decryptJson, encryptJson, keyId, randomToken, safeEqual, sha256 } from './crypto.js';
import { SCOPES, SESSION_COOKIE, SESSION_IDLE_MS, SESSION_TTL_MS, STATE_COOKIE, type Env } from './env.js';
import { ApiError, clearCookie, clientIp, cookie, readCookie, redirect } from './http.js';

export interface Session {
  idHash: string;
  userId: string;
  accountId: string;
  name: string;
  email: string | null;
  picture: string | null;
}

interface Tokens {
  access: string;
  refresh: string;
}

export interface GrantRow {
  user_id: string;
  enc_tokens: string;
  key_id: string;
  access_expires_at: number;
  version: number;
  status: string;
}

const now = (): number => Date.now();

// ---------------------------------------------------------------- outgoing calls to Atlassian

async function atlassian(env: Env, budget: Budget, url: string, init: RequestInit & { bearer?: string } = {}): Promise<Response> {
  budget.take();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.bearer) headers.set('Authorization', `Bearer ${init.bearer}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  try {
    return await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new HttpError(502, `Could not reach Atlassian: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- sign-in

/** D1-backed limit for sign-in attempts per IP (in-memory limits are per isolate and easy to spread out). */
async function signInLimit(env: Env, req: Request): Promise<void> {
  const window = Math.floor(now() / 600_000);
  const bucket = `login:${await sha256(clientIp(req))}:${window}`;
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?1, 1, ?2) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count'
  ).bind(bucket, (window + 1) * 600_000).first<{ count: number }>();
  if ((row?.count ?? 0) > 30) throw new ApiError(429, 'Too many sign-in attempts. Try again in a few minutes.', 'rate_limited');
}

export async function startLogin(req: Request, env: Env): Promise<Response> {
  await signInLimit(env, req);
  const state = randomToken(24);
  const url = new URL('/authorize', env.ATLASSIAN_AUTH_BASE);
  url.search = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: env.ATLASSIAN_CLIENT_ID,
    scope: SCOPES.join(' '),
    redirect_uri: `${env.APP_ORIGIN}/auth/callback`,
    state,
    response_type: 'code',
    prompt: 'consent',
  }).toString();
  // The state is bound to this browser through an HttpOnly cookie; the callback must present both.
  return redirect(url.toString(), { 'Set-Cookie': cookie(STATE_COOKIE, state, 600) });
}

export async function finishLogin(req: Request, env: Env, budget: Budget): Promise<Response> {
  const url = new URL(req.url);
  const fail = (reason: string): Response =>
    redirect(`/?auth=${encodeURIComponent(reason)}`, { 'Set-Cookie': clearCookie(STATE_COOKIE) });

  const expected = readCookie(req, STATE_COOKIE);
  const state = url.searchParams.get('state') ?? '';
  if (!expected || !state || !safeEqual(expected, state)) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) return fail('code');

  // 1) code -> tokens
  const tr = await atlassian(env, budget, `${env.ATLASSIAN_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: env.ATLASSIAN_CLIENT_ID,
      client_secret: env.ATLASSIAN_CLIENT_SECRET,
      code,
      redirect_uri: `${env.APP_ORIGIN}/auth/callback`,
    }),
  });
  if (!tr.ok) return fail('exchange');
  const tok = (await tr.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!tok.access_token || !tok.refresh_token) return fail('offline'); // offline_access is required for monitoring
  const granted = new Set(String(tok.scope ?? '').split(/\s+/));
  if (!['read:jira-work', 'read:jira-user', 'read:me'].every((s) => granted.has(s))) return fail('scopes');

  // 2) who is this, and which Jira sites may we use?
  const [meR, resR] = await Promise.all([
    atlassian(env, budget, `${env.ATLASSIAN_API_BASE}/me`, { bearer: tok.access_token }),
    atlassian(env, budget, `${env.ATLASSIAN_API_BASE}/oauth/token/accessible-resources`, { bearer: tok.access_token }),
  ]);
  if (!meR.ok || !resR.ok) return fail('profile');
  const me = (await meR.json()) as { account_id: string; name?: string; nickname?: string; email?: string; picture?: string };
  const sites = ((await resR.json()) as { id: string; name: string; url: string; scopes?: string[] }[])
    .filter((s) => (s.scopes ?? []).includes('read:jira-work') && /^https:\/\//.test(s.url))
    .slice(0, 20);
  if (!me.account_id) return fail('profile');
  if (!sites.length) return fail('nosite');

  // 3) persist (one batch = one query)
  const t = now();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE atlassian_account_id = ?').bind(me.account_id).first<{ id: string }>();
  const userId = existing?.id ?? crypto.randomUUID();
  const kid = await keyId(env.TOKEN_ENC_KEY);
  const enc = await encryptJson(env.TOKEN_ENC_KEY, `grant:${userId}`, { access: tok.access_token, refresh: tok.refresh_token } satisfies Tokens);
  const sessionToken = randomToken(32);
  const idHash = await sha256(sessionToken);
  const ua = (req.headers.get('User-Agent') ?? '').slice(0, 160);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO users (id, atlassian_account_id, name, email, picture, created_at, last_seen_at, profile_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)
       ON CONFLICT(id) DO UPDATE SET name = ?3, email = ?4, picture = ?5, last_seen_at = ?6, profile_at = ?6`
    ).bind(userId, me.account_id, me.name || me.nickname || 'Jira user', me.email ?? null, me.picture ?? null, t),
    env.DB.prepare(
      `INSERT INTO oauth_grants (user_id, enc_tokens, key_id, access_expires_at, scopes, version, lease_until, status, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 'active', ?6)
       ON CONFLICT(user_id) DO UPDATE SET enc_tokens = ?2, key_id = ?3, access_expires_at = ?4, scopes = ?5, version = version + 1, lease_until = 0, status = 'active', updated_at = ?6`
    ).bind(userId, enc, kid, t + (tok.expires_in ?? 3600) * 1000, [...granted].join(' '), t),
    env.DB.prepare('DELETE FROM jira_sites WHERE user_id = ?').bind(userId),
    ...sites.map((s) => env.DB.prepare('INSERT INTO jira_sites (user_id, cloud_id, name, url) VALUES (?, ?, ?, ?)').bind(userId, s.id, s.name, s.url.replace(/\/+$/, ''))),
    env.DB.prepare(
      `INSERT INTO user_settings (user_id, active_cloud_id, slot, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET active_cloud_id = CASE WHEN active_cloud_id IN (SELECT cloud_id FROM jira_sites WHERE user_id = ?1) THEN active_cloud_id ELSE ?2 END, updated_at = ?4`
    ).bind(userId, (sites[0] as { id: string }).id, Math.floor(Math.random() * 60), t),
    env.DB.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)').bind(idHash, userId, t, t + SESSION_TTL_MS, t, ua),
  ];
  budget.take();
  await env.DB.batch(stmts);
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
  headers.append('Set-Cookie', cookie(SESSION_COOKIE, sessionToken, SESSION_TTL_MS / 1000));
  return redirect('/?view=foryou&connected=1', headers);
}

// ---------------------------------------------------------------- sessions

export async function getSession(req: Request, env: Env): Promise<Session | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const idHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.user_id, s.expires_at, s.last_used_at, u.atlassian_account_id, u.name, u.email, u.picture
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`
  ).bind(idHash).first<{ id_hash: string; user_id: string; expires_at: number; last_used_at: number; atlassian_account_id: string; name: string; email: string | null; picture: string | null }>();
  const t = now();
  if (!row || row.expires_at < t || row.last_used_at < t - SESSION_IDLE_MS) return null;
  // Sliding idle expiry, written at most once an hour to save D1 writes.
  if (t - row.last_used_at > 3600_000) await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE id_hash = ?').bind(t, idHash).run();
  return { idHash, userId: row.user_id, accountId: row.atlassian_account_id, name: row.name, email: row.email, picture: row.picture };
}

export async function requireSession(req: Request, env: Env): Promise<Session> {
  const s = await getSession(req, env);
  if (!s) throw new ApiError(401, 'Please sign in with Atlassian.', 'signin');
  return s;
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(token)).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie(SESSION_COOKIE), 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------- tokens

async function decryptGrant(env: Env, g: GrantRow): Promise<Tokens> {
  const aad = `grant:${g.user_id}`;
  try {
    return await decryptJson<Tokens>(env.TOKEN_ENC_KEY, aad, g.enc_tokens);
  } catch (e) {
    if (env.TOKEN_ENC_KEY_OLD) return decryptJson<Tokens>(env.TOKEN_ENC_KEY_OLD, aad, g.enc_tokens); // during key rotation
    throw e;
  }
}

export class ReauthRequired extends ApiError {
  constructor() {
    super(401, 'Jira access was revoked or expired. Reconnect with Atlassian.', 'reauth');
  }
}

const loadGrant = (env: Env, userId: string): Promise<GrantRow | null> =>
  env.DB.prepare('SELECT user_id, enc_tokens, key_id, access_expires_at, version, status FROM oauth_grants WHERE user_id = ?').bind(userId).first<GrantRow>();

/**
 * Returns a valid access token, refreshing it when it is about to expire.
 *
 * Atlassian rotates refresh tokens: every refresh returns a new refresh token and disables the old one
 * (with a 10-minute reuse leeway). To keep concurrent requests and cron runs from racing:
 *  1. take a 30-second lease with a conditional UPDATE (only one caller wins),
 *  2. the winner refreshes and writes the new pair only if `version` is still the one it read,
 *  3. everyone else waits briefly and re-reads the row.
 */
export async function accessToken(env: Env, userId: string, budget: Budget, known?: GrantRow | null): Promise<string> {
  let g = known ?? (budget.take(), await loadGrant(env, userId));
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!g || g.status !== 'active') throw new ReauthRequired();
    if (g.access_expires_at - now() > 120_000) return (await decryptGrant(env, g)).access;

    budget.take();
    const lease = await env.DB.prepare('UPDATE oauth_grants SET lease_until = ?1 WHERE user_id = ?2 AND version = ?3 AND lease_until < ?4 RETURNING version')
      .bind(now() + 30_000, userId, g.version, now()).first<{ version: number }>();
    if (!lease) {
      await new Promise((r) => setTimeout(r, 700 + attempt * 500)); // someone else is refreshing
      budget.take();
      g = await loadGrant(env, userId);
      continue;
    }

    const old = await decryptGrant(env, g);
    const r = await atlassian(env, budget, `${env.ATLASSIAN_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: env.ATLASSIAN_CLIENT_ID, client_secret: env.ATLASSIAN_CLIENT_SECRET, refresh_token: old.refresh }),
    });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      // invalid_grant: the user revoked access, the token expired after 90 days of inactivity, or reuse was detected.
      budget.take();
      await env.DB.prepare("UPDATE oauth_grants SET status = 'revoked', lease_until = 0, updated_at = ? WHERE user_id = ?").bind(now(), userId).run();
      throw new ReauthRequired();
    }
    if (!r.ok) {
      budget.take();
      await env.DB.prepare('UPDATE oauth_grants SET lease_until = 0 WHERE user_id = ? AND version = ?').bind(userId, g.version).run();
      throw new HttpError(502, `Atlassian token refresh failed (${r.status})`);
    }
    const tok = (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const next: Tokens = { access: tok.access_token, refresh: tok.refresh_token ?? old.refresh };
    const encd = await encryptJson(env.TOKEN_ENC_KEY, `grant:${userId}`, next);
    budget.take();
    const done = await env.DB.prepare(
      'UPDATE oauth_grants SET enc_tokens = ?1, key_id = ?2, access_expires_at = ?3, version = version + 1, lease_until = 0, updated_at = ?4 WHERE user_id = ?5 AND version = ?6'
    ).bind(encd, await keyId(env.TOKEN_ENC_KEY), now() + (tok.expires_in ?? 3600) * 1000, now(), userId, g.version).run();
    if (done.meta.changes === 1) return next.access;
    budget.take();
    g = await loadGrant(env, userId); // lost a race despite the lease (lease expired): use the winner's token
  }
  throw new HttpError(503, 'Could not obtain a Jira access token right now. Try again shortly.');
}

// ---------------------------------------------------------------- Jira through the OAuth gateway

export interface Site {
  cloudId: string;
  name: string;
  url: string;
}

/**
 * The shared core's JiraApi on top of https://api.atlassian.com/ex/jira/{cloudId}. Browse links use the
 * site URL from accessible-resources. A single retry handles an access token that expired mid-flight.
 */
export function cloudApi(env: Env, site: Site, userId: string, budget: Budget, initialToken: string): JiraApi {
  let token = initialToken;
  const base = `${env.ATLASSIAN_API_BASE}/ex/jira/${encodeURIComponent(site.cloudId)}`;
  return {
    siteUrl: site.url,
    cacheKey: `${userId}|${site.cloudId}`,
    async request(path, init) {
      for (let attempt = 0; ; attempt++) {
        const res = await atlassian(env, budget, base + path, {
          method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
          bearer: token,
        });
        if (res.status === 401 && attempt === 0) {
          await res.body?.cancel();
          // Force a refresh by pretending the token expired, then retry once.
          budget.take();
          await env.DB.prepare('UPDATE oauth_grants SET access_expires_at = 0 WHERE user_id = ?').bind(userId).run();
          token = await accessToken(env, userId, budget);
          continue;
        }
        if (res.status === 401) throw new ReauthRequired();
        if (res.status === 429) {
          const wait = Number(res.headers.get('retry-after'));
          await res.body?.cancel();
          throw new HttpError(429, 'Jira is rate limiting requests. Backing off.', Number.isFinite(wait) && wait > 0 ? wait : 60);
        }
        if (!res.ok) {
          let msg = `${res.status} ${res.statusText}`;
          try {
            const body = (await res.json()) as Json;
            const parts = [...(body.errorMessages || []), ...Object.values(body.errors || {})];
            if (parts.length) msg = parts.join('; ');
          } catch {
            /* non-JSON error body */
          }
          throw new HttpError(res.status === 403 ? 403 : res.status === 404 ? 404 : 502, msg);
        }
        return res.json();
      }
    },
  };
}

export async function activeSite(env: Env, userId: string): Promise<Site> {
  const row = await env.DB.prepare(
    `SELECT j.cloud_id, j.name, j.url FROM user_settings s JOIN jira_sites j ON j.user_id = s.user_id AND j.cloud_id = s.active_cloud_id WHERE s.user_id = ?`
  ).bind(userId).first<{ cloud_id: string; name: string; url: string }>();
  if (!row) throw new ApiError(409, 'No Jira site selected. Reconnect with Atlassian.', 'nosite');
  return { cloudId: row.cloud_id, name: row.name, url: row.url };
}
