// Atlassian Personal Data Reporting API (required for apps that store personal data).
// https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/
//
// What this app stores per Atlassian accountId:
//   - signed-in users: name, e-mail, avatar URL                    (users.profile_at = when fetched)
//   - other people in the notification history: display name       (events.actor_id, events.at)
//
// Every cycle (default 7 days, or the Cycle-Period header) each stored accountId is reported with the
// oldest time its data was fetched. Atlassian answers per account:
//   closed  -> erase everything about that person
//   updated -> our copy is stale: refresh it (signed-in users, when possible) or erase it
// Runs inside the shared cron, a few requests at a time, resumable (progress lives in pdr_reports).

import type { Budget } from './budget.js';
import type { Env } from './env.js';
import { accessToken } from './auth.js';

const DEFAULT_CYCLE_MS = 7 * 864e5;
const BATCH = 90; // API maximum per request
const MAX_REQUESTS_PER_RUN = 3;
const ACCOUNT_ID = /^[A-Za-z0-9:-]{1,128}$/;

export interface PdrReport {
  reported: number;
  closed: number;
  updated: number;
  requests: number;
  skipped?: string;
}

async function meta(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
}
const setMeta = (env: Env, key: string, value: string): D1PreparedStatement =>
  env.DB.prepare('INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(key, value);

/** The grant used to call the API: Atlassian recommends the app owner's token; any active grant works. */
async function reporterToken(env: Env, budget: Budget): Promise<string | null> {
  budget.take();
  const row = await env.DB.prepare(
    `SELECT g.user_id FROM oauth_grants g JOIN users u ON u.id = g.user_id
     WHERE g.status = 'active' ORDER BY (u.atlassian_account_id = ?) DESC, u.last_seen_at DESC LIMIT 1`
  ).bind(env.ATLASSIAN_APP_OWNER_ACCOUNT_ID ?? '').first<{ user_id: string }>();
  return row ? accessToken(env, row.user_id, budget) : null;
}

export async function runPersonalDataReporting(env: Env, budget: Budget, at = Date.now()): Promise<PdrReport> {
  const rep: PdrReport = { reported: 0, closed: 0, updated: 0, requests: 0 };
  budget.take();
  const [cycleRaw, backoffRaw] = await Promise.all([meta(env, 'pdr_cycle_ms'), meta(env, 'pdr_backoff_until')]);
  if (Number(backoffRaw ?? 0) > at) return { ...rep, skipped: 'backoff' };
  const cycle = Number(cycleRaw) || DEFAULT_CYCLE_MS;

  // Accounts that are due: every stored accountId whose last report is older than one cycle.
  budget.take();
  const { results } = await env.DB.prepare(
    `SELECT a.account_id, a.fetched_at FROM (
       SELECT account_id, MIN(t) AS fetched_at FROM (
         SELECT atlassian_account_id AS account_id, profile_at AS t FROM users
         UNION ALL
         SELECT actor_id AS account_id, at AS t FROM events WHERE actor_id IS NOT NULL
       ) GROUP BY account_id
     ) a LEFT JOIN pdr_reports p ON p.account_id = a.account_id
     WHERE a.account_id != 'unknown' AND COALESCE(p.reported_at, 0) <= ?1
     ORDER BY COALESCE(p.reported_at, 0) LIMIT ?2`
  ).bind(at - cycle, BATCH * MAX_REQUESTS_PER_RUN).all<{ account_id: string; fetched_at: number }>();
  const due = results.filter((r) => ACCOUNT_ID.test(r.account_id));
  if (!due.length) return { ...rep, skipped: 'nothing due' };

  const token = await reporterToken(env, budget);
  if (!token) return { ...rep, skipped: 'no active grant to report with' };

  for (let i = 0; i < due.length && rep.requests < MAX_REQUESTS_PER_RUN; i += BATCH) {
    if (!budget.has(3)) break;
    const batch = due.slice(i, i + BATCH);
    budget.take();
    rep.requests++;
    const res = await fetch(`${env.ATLASSIAN_API_BASE}/app/report-accounts/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accounts: batch.map((b) => ({ accountId: b.account_id, updatedAt: new Date(b.fetched_at || at).toISOString() })) }),
      signal: AbortSignal.timeout(20_000),
    });
    const cyc = Number(res.headers.get('Cycle-Period'));
    const stmts: D1PreparedStatement[] = [];
    // The header's unit is not documented; accept it only as a plausible number of seconds (1 hour .. 60 days).
    if (cyc >= 3600 && cyc <= 60 * 86400) stmts.push(setMeta(env, 'pdr_cycle_ms', String(cyc * 1000)));
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After')) || 3600;
      await res.body?.cancel();
      budget.take();
      await env.DB.batch([...stmts, setMeta(env, 'pdr_backoff_until', String(at + wait * 1000))]);
      return { ...rep, skipped: 'rate limited' };
    }
    if (res.status !== 200 && res.status !== 204) {
      const msg = (await res.text().catch(() => '')).slice(0, 200);
      console.warn(`personal data reporting failed: ${res.status} ${msg}`);
      budget.take();
      await env.DB.batch([...stmts, setMeta(env, 'pdr_backoff_until', String(at + 3600_000))]);
      return { ...rep, skipped: `HTTP ${res.status}` };
    }
    const actions = res.status === 200 ? (((await res.json()) as { accounts?: { accountId: string; status: string }[] }).accounts ?? []) : [];
    const closed = new Set(actions.filter((a) => a.status === 'closed').map((a) => a.accountId));
    const updated = new Set(actions.filter((a) => a.status === 'updated').map((a) => a.accountId));
    for (const b of batch) {
      if (closed.has(b.account_id)) stmts.push(...eraseAccount(env, b.account_id));
      else if (updated.has(b.account_id)) stmts.push(...staleAccount(env, b.account_id));
      // Closed accounts are erased and never reported again; everything else is recorded as reported.
      if (!closed.has(b.account_id)) {
        stmts.push(env.DB.prepare('INSERT INTO pdr_reports (account_id, reported_at) VALUES (?1, ?2) ON CONFLICT(account_id) DO UPDATE SET reported_at = ?2').bind(b.account_id, at));
      }
    }
    budget.take();
    await env.DB.batch(stmts);
    rep.reported += batch.length;
    rep.closed += closed.size;
    rep.updated += updated.size;
  }
  return rep;
}

/** Account closed: delete a signed-in user entirely (cascade), and remove the person from everyone's history. */
function eraseAccount(env: Env, accountId: string): D1PreparedStatement[] {
  const userId = '(SELECT id FROM users WHERE atlassian_account_id = ?1)';
  return [
    ...['oauth_grants', 'jira_sites', 'monitor_state', 'push_subscriptions', 'events', 'user_settings', 'sessions'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ${userId}`).bind(accountId)),
    env.DB.prepare('DELETE FROM users WHERE atlassian_account_id = ?').bind(accountId),
    env.DB.prepare("UPDATE events SET actor = 'Former user', actor_id = NULL WHERE actor_id = ?").bind(accountId),
    env.DB.prepare('DELETE FROM pdr_reports WHERE account_id = ?').bind(accountId),
  ];
}

/**
 * Our copy is out of date. Names in the history are dropped (they are shown as "Someone"); a signed-in
 * user's profile fields are cleared and fetched again at their next sign-in.
 */
function staleAccount(env: Env, accountId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare('UPDATE events SET actor = NULL, actor_id = NULL WHERE actor_id = ?').bind(accountId),
    env.DB.prepare("UPDATE users SET name = 'Jira user', email = NULL, picture = NULL, profile_at = ?2 WHERE atlassian_account_id = ?1").bind(accountId, Date.now()),
  ];
}
