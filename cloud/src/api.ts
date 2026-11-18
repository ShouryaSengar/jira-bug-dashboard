// HTTP API. The paths and response shapes match the Local edition's server (/api/config, /api/bugs,
// /api/mine, /api/issue, /api/jarvis/*) so the same frontend runs on both. Cloud-only routes: /auth/*,
// /api/push/*, /api/jarvis/notify, /api/account/delete.
//
// Isolation rule: every query is scoped by the session's user id. No endpoint accepts a user id, and
// ids supplied by the client (event ids, device ids) are always combined with `user_id = <session user>`.

import type { JarvisEvent, JarvisEventType, JarvisServerPrefs, JarvisStatus, PublicConfig } from '../../src/shared/types.js';
import { getBugs, getIssueDetail, getMyBugs } from '../../src/core/jira.js';
import { eventLabel } from '../../src/core/detect.js';
import { EVENT_TYPES } from '../../src/client/jarvis-core.js';
import { accessToken, activeSite, cloudApi, finishLogin, logout, requireSession, getSession, startLogin, type Session } from './auth.js';
import { Budget, unlimited } from './budget.js';
import { minInterval, type Env } from './env.js';
import { ApiError, KEY_RE, assertSameOrigin, json, rateLimit, readJson } from './http.js';
import { checkOne, cleanIds, ensureSeverity, runTick, toEvent, type EventRow, type NotifyPrefs } from './monitor.js';
import { endpointAllowed, sendPush } from './push.js';

const DONE_STATES = new Set(['off', 'paused']);

interface SettingsRow {
  active_cloud_id: string | null;
  severity_fields: string;
  issue_types: string;
  severity_ids: string;
  monitor_enabled: number;
  monitor_paused: number;
  interval_min: number;
  closed_window_days: number;
  slot: number;
  notify_prefs: string;
}

const settingsOf = async (env: Env, userId: string): Promise<SettingsRow> => {
  const s = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first<SettingsRow>();
  if (!s) throw new ApiError(409, 'Account setup is incomplete. Sign in again.', 'reauth');
  return s;
};

/** Jira client for the signed-in user's active site. */
async function jiraFor(env: Env, s: Session, budget: Budget) {
  const [site, settings] = await Promise.all([activeSite(env, s.userId), settingsOf(env, s.userId)]);
  const token = await accessToken(env, s.userId, budget);
  const api = cloudApi(env, site, s.userId, budget, token);
  const sev = settings.severity_ids === '[]'
    ? (await ensureSeverity(env, api, s.userId, settings.severity_fields, settings.severity_ids, budget)).ids
    : cleanIds(settings.severity_ids);
  return { api, site, settings, severityIds: sev };
}

// ---------------------------------------------------------------- JARVIS status

function nextSlot(minuteNow: number, slot: number, interval: number): number {
  for (let m = minuteNow + 1; m <= minuteNow + interval; m++) if ((m - slot) % interval === 0) return m;
  return minuteNow + interval;
}

async function jarvisStatus(env: Env, s: Session): Promise<JarvisStatus> {
  const row = await env.DB.prepare(
    `SELECT us.monitor_enabled, us.monitor_paused, us.interval_min, us.closed_window_days, us.slot, g.status AS grant_status,
            st.checked_at, st.snapshot, st.failures, st.last_error, st.backoff_until,
            (SELECT COUNT(*) FROM events e WHERE e.user_id = us.user_id AND e.read = 0 AND e.own = 0) AS unread,
            (SELECT MAX(id) FROM events e WHERE e.user_id = us.user_id) AS last_id
     FROM user_settings us LEFT JOIN oauth_grants g ON g.user_id = us.user_id LEFT JOIN monitor_state st ON st.user_id = us.user_id
     WHERE us.user_id = ?`
  ).bind(s.userId).first<{ monitor_enabled: number; monitor_paused: number; interval_min: number; closed_window_days: number; slot: number; grant_status: string | null;
    checked_at: number | null; snapshot: string | null; failures: number | null; last_error: string | null; backoff_until: number | null; unread: number; last_id: number | null }>();
  if (!row) throw new ApiError(409, 'Account setup is incomplete. Sign in again.', 'reauth');
  const prefs: JarvisServerPrefs = { enabled: !!row.monitor_enabled, paused: !!row.monitor_paused, intervalSec: row.interval_min * 60, osNotify: false, closedWindowDays: row.closed_window_days };
  let state: JarvisStatus['state'] = 'online';
  if (row.grant_status !== 'active') state = 'unconfigured';
  else if (!prefs.enabled) state = 'off';
  else if (prefs.paused) state = 'paused';
  else if ((row.failures ?? 0) > 0) state = 'backoff';
  const minute = Math.floor(Date.now() / 60_000);
  let monitored = 0;
  try {
    monitored = Object.keys(JSON.parse(row.snapshot || '{}')).length;
  } catch {
    /* ignore */
  }
  return {
    state,
    prefs,
    lastSyncAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
    nextSyncAt: DONE_STATES.has(state) || state === 'unconfigured' ? null : new Date(Math.max(nextSlot(minute, row.slot, row.interval_min) * 60_000, row.backoff_until ?? 0)).toISOString(),
    lastError: row.last_error,
    monitored,
    unread: row.unread,
    lastEventId: row.last_id ?? 0,
    clients: 0,
    osNotifySupported: false,
  };
}

// ---------------------------------------------------------------- config

async function publicConfig(env: Env, s: Session | null): Promise<PublicConfig> {
  const base: PublicConfig = { edition: 'cloud', configured: false, signedIn: false, vapidPublicKey: env.VAPID_PUBLIC_KEY, minIntervalMin: minInterval(env) };
  if (!s) return base;
  const [grant, sites, settings] = await Promise.all([
    env.DB.prepare('SELECT status FROM oauth_grants WHERE user_id = ?').bind(s.userId).first<{ status: string }>(),
    env.DB.prepare('SELECT cloud_id, name, url FROM jira_sites WHERE user_id = ? ORDER BY name').bind(s.userId).all<{ cloud_id: string; name: string; url: string }>(),
    env.DB.prepare('SELECT active_cloud_id, severity_fields, issue_types FROM user_settings WHERE user_id = ?').bind(s.userId).first<{ active_cloud_id: string | null; severity_fields: string; issue_types: string }>(),
  ]);
  const site = sites.results.find((x) => x.cloud_id === settings?.active_cloud_id) ?? null;
  const active = grant?.status === 'active' && !!site;
  return {
    ...base,
    signedIn: true,
    configured: active,
    needsReauth: grant?.status !== 'active',
    source: 'cloud',
    jiraUrl: site?.url,
    email: s.email ?? undefined,
    displayName: s.name,
    user: { name: s.name, email: s.email, picture: s.picture },
    site: site ? { cloudId: site.cloud_id, name: site.name, url: site.url } : null,
    sites: sites.results.map((x) => ({ cloudId: x.cloud_id, name: x.name, url: x.url })),
    severityFields: settings?.severity_fields,
    issueTypes: settings?.issue_types,
    configFile: null,
  };
}

const clean = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

async function updateSettings(env: Env, s: Session, body: { severityFields?: string; issueTypes?: string; activeCloudId?: string }): Promise<void> {
  const cur = await settingsOf(env, s.userId);
  const sev = body.severityFields !== undefined ? clean(body.severityFields, 300) || 'Defect Severity, Severity' : cur.severity_fields;
  const types = body.issueTypes !== undefined ? clean(body.issueTypes, 300) || 'Bug' : cur.issue_types;
  let site = cur.active_cloud_id;
  if (body.activeCloudId !== undefined) {
    const ok = await env.DB.prepare('SELECT 1 FROM jira_sites WHERE user_id = ? AND cloud_id = ?').bind(s.userId, clean(body.activeCloudId, 100)).first();
    if (!ok) throw new ApiError(400, 'Unknown Jira site');
    site = clean(body.activeCloudId, 100);
  }
  const resetSev = sev !== cur.severity_fields || site !== cur.active_cloud_id;
  await env.DB.prepare('UPDATE user_settings SET severity_fields = ?, issue_types = ?, active_cloud_id = ?, severity_ids = CASE WHEN ? THEN \'[]\' ELSE severity_ids END, updated_at = ? WHERE user_id = ?')
    .bind(sev, types, site, resetSev ? 1 : 0, Date.now(), s.userId).run();
}

// ---------------------------------------------------------------- validation helpers

function validNotifyPrefs(b: Record<string, unknown>, prev: NotifyPrefs): NotifyPrefs {
  const out: NotifyPrefs = { ...prev };
  if (typeof b['push'] === 'boolean') out.push = b['push'];
  if (b['types'] && typeof b['types'] === 'object') {
    const t: Partial<Record<JarvisEventType, boolean>> = {};
    for (const k of EVENT_TYPES) if (typeof (b['types'] as Record<string, unknown>)[k] === 'boolean') t[k] = (b['types'] as Record<string, boolean>)[k];
    out.types = t;
  }
  if (b['frequency'] === 'all' || b['frequency'] === 'important' || b['frequency'] === 'digest') out.frequency = b['frequency'];
  const q = b['quiet'] as { on?: unknown; from?: unknown; to?: unknown } | undefined;
  const hhmm = (v: unknown, d: string): string => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  if (q && typeof q === 'object') out.quiet = { on: q.on === true, from: hhmm(q.from, '22:00'), to: hhmm(q.to, '08:00') };
  if (typeof b['tz'] === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/.test(b['tz']) && b['tz'].length < 64) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: b['tz'] });
      out.tz = b['tz'];
    } catch {
      /* unknown zone: keep the previous one */
    }
  }
  return out;
}

const b64urlRe = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------- router

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;

  // ---- sign-in (top-level navigations, no CSRF header possible; protected by the OAuth state cookie)
  if (route === 'GET /auth/login') return startLogin(req, env);
  if (route === 'GET /auth/callback') return finishLogin(req, env, unlimited());

  assertSameOrigin(req, env);
  if (route === 'POST /auth/logout') return logout(req, env);
  if (route === 'GET /api/config') return json(await publicConfig(env, await getSession(req, env)));

  const s = await requireSession(req, env);
  rateLimit(`u:${s.userId}`, 240, 60_000);
  const budget = new Budget(45);

  switch (route) {
    // ---- connection & settings
    case 'POST /api/config': {
      await updateSettings(env, s, await readJson(req));
      return json(await publicConfig(env, s));
    }
    case 'DELETE /api/config': {
      // Disconnect Jira: forget tokens, sites, monitoring and devices; sign out everywhere. History stays until the account is deleted.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_grants WHERE user_id = ?').bind(s.userId),
        env.DB.prepare('DELETE FROM jira_sites WHERE user_id = ?').bind(s.userId),
        env.DB.prepare('DELETE FROM monitor_state WHERE user_id = ?').bind(s.userId),
        env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(s.userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(s.userId),
      ]);
      return json({ ...(await publicConfig(env, null)) }, 200, { 'Set-Cookie': '__Host-jbd_sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    }
    case 'POST /api/account/delete': {
      const body = await readJson<{ confirm?: string }>(req);
      if (body.confirm !== 'DELETE') throw new ApiError(400, 'Send {"confirm":"DELETE"} to delete your account.');
      // Children first (foreign keys also cascade), then the user.
      await env.DB.batch(['oauth_grants', 'jira_sites', 'monitor_state', 'push_subscriptions', 'events', 'user_settings', 'sessions'].map((t) =>
        env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(s.userId)).concat([env.DB.prepare('DELETE FROM users WHERE id = ?').bind(s.userId)]));
      return json({ deleted: true }, 200, { 'Set-Cookie': '__Host-jbd_sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
    }

    // ---- Jira data (same shapes as the Local edition)
    case 'GET /api/bugs': {
      const key = (url.searchParams.get('key') || '').trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new ApiError(400, `"${key.slice(0, 40)}" is not a valid Jira key (e.g. ABC-123)`);
      const j = await jiraFor(env, s, budget);
      return json(await getBugs(j.api, key, { severityIds: j.severityIds, issueTypes: j.settings.issue_types }));
    }
    case 'GET /api/mine': {
      const j = await jiraFor(env, s, budget);
      const { results } = await env.DB.prepare(
        "SELECT issue_key, type, occurred_at, actor, from_v, to_v, escalated, detail FROM events WHERE user_id = ? AND importance != 'low' ORDER BY id DESC LIMIT 300"
      ).bind(s.userId).all<{ issue_key: string; type: JarvisEventType; occurred_at: string; actor: string | null; from_v: string | null; to_v: string | null; escalated: number; detail: string | null }>();
      const last = new Map<string, (typeof results)[number]>();
      for (const r of results) if (!last.has(r.issue_key)) last.set(r.issue_key, r);
      const weekAgo = Date.now() - 7 * 864e5;
      const assigned = new Set(results.filter((r) => r.type === 'assigned' && Date.parse(r.occurred_at) >= weekAgo).map((r) => r.issue_key));
      return json(await getMyBugs(j.api, {
        me: { name: s.name, email: s.email },
        severityIds: j.severityIds,
        issueTypes: j.settings.issue_types,
        closedWindowDays: j.settings.closed_window_days,
        lastActivity: (k) => {
          const r = last.get(k);
          return r ? { at: r.occurred_at, label: eventLabel({ type: r.type, actor: r.actor, from: r.from_v, to: r.to_v, escalated: !!r.escalated, detail: r.detail }) } : null;
        },
        assignedEvents: (k) => assigned.has(k),
        maxIssues: 300, // keeps one request inside the free plan's CPU and subrequest limits
      }));
    }
    case 'GET /api/issue': {
      const key = (url.searchParams.get('key') || '').trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new ApiError(400, 'Not a valid Jira key');
      const j = await jiraFor(env, s, budget);
      return json(await getIssueDetail(j.api, key, j.severityIds));
    }

    // ---- JARVIS
    case 'GET /api/jarvis/status':
      return json(await jarvisStatus(env, s));
    case 'GET /api/jarvis/events': {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') || 0)) || 0);
      const { results } = await env.DB.prepare('SELECT * FROM (SELECT * FROM events WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT 200) ORDER BY id')
        .bind(s.userId, after).all<EventRow>();
      return json({ events: results.map(toEvent) });
    }
    case 'POST /api/jarvis/prefs': {
      const b = await readJson<Partial<JarvisServerPrefs>>(req);
      const cur = await settingsOf(env, s.userId);
      const minI = minInterval(env);
      const interval = b.intervalSec !== undefined ? Math.min(60, Math.max(minI, Math.round(Number(b.intervalSec) / 60) || minI)) : cur.interval_min;
      const closed = b.closedWindowDays !== undefined ? Math.min(365, Math.max(7, Math.round(Number(b.closedWindowDays)) || 90)) : cur.closed_window_days;
      await env.DB.prepare('UPDATE user_settings SET monitor_enabled = ?, monitor_paused = ?, interval_min = ?, closed_window_days = ?, updated_at = ? WHERE user_id = ?')
        .bind(typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : cur.monitor_enabled, typeof b.paused === 'boolean' ? (b.paused ? 1 : 0) : cur.monitor_paused, interval, closed, Date.now(), s.userId).run();
      const status = await jarvisStatus(env, s);
      return json({ prefs: status.prefs, status });
    }
    case 'POST /api/jarvis/read': {
      const b = await readJson<{ ids?: unknown[]; all?: boolean }>(req);
      if (b.all) await env.DB.prepare('UPDATE events SET read = 1 WHERE user_id = ? AND read = 0').bind(s.userId).run();
      else {
        const ids = (Array.isArray(b.ids) ? b.ids : []).filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, 90);
        if (ids.length) await env.DB.prepare(`UPDATE events SET read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(s.userId, ...ids).run();
      }
      return json(await jarvisStatus(env, s));
    }
    case 'POST /api/jarvis/clear':
      await env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(s.userId).run();
      return json(await jarvisStatus(env, s));
    case 'POST /api/jarvis/sync': {
      rateLimit(`sync:${s.userId}`, 4, 60_000);
      const before = (await jarvisStatus(env, s)).lastEventId;
      const result = await checkOne(env, s.userId, new Budget(40));
      const { results } = await env.DB.prepare('SELECT * FROM events WHERE user_id = ? AND id > ? ORDER BY id LIMIT 100').bind(s.userId, before).all<EventRow>();
      return json({ result: { outcome: result.outcome, error: result.error }, events: results.map(toEvent), status: await jarvisStatus(env, s) });
    }
    case 'POST /api/jarvis/notify': {
      const cur = await settingsOf(env, s.userId);
      let prev: NotifyPrefs = {};
      try {
        prev = JSON.parse(cur.notify_prefs) as NotifyPrefs;
      } catch {
        /* reset */
      }
      const next = validNotifyPrefs(await readJson(req), prev);
      await env.DB.prepare('UPDATE user_settings SET notify_prefs = ?, updated_at = ? WHERE user_id = ?').bind(JSON.stringify(next), Date.now(), s.userId).run();
      return json({ notify: next });
    }

    // ---- Web Push
    case 'POST /api/push/subscribe': {
      const b = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>(req);
      const endpoint = String(b.endpoint ?? '');
      const p256dh = String(b.keys?.p256dh ?? ''), auth = String(b.keys?.auth ?? '');
      if (!endpointAllowed(env, endpoint)) throw new ApiError(400, 'This push service is not supported.');
      if (!b64urlRe.test(p256dh) || p256dh.length > 120 || !b64urlRe.test(auth) || auth.length > 40) throw new ApiError(400, 'Invalid subscription keys');
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND endpoint != ?').bind(s.userId, endpoint).first<{ n: number }>();
      if ((count?.n ?? 0) >= 5) throw new ApiError(409, 'Five devices already receive notifications. Remove one first.');
      const settings = await settingsOf(env, s.userId);
      let np: NotifyPrefs = {};
      try {
        np = JSON.parse(settings.notify_prefs) as NotifyPrefs;
      } catch {
        /* reset */
      }
      await env.DB.batch([
        // An endpoint identifies one browser. If another account subscribed it before (shared computer), it moves to this account.
        env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint),
        env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at, failures) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
          .bind(crypto.randomUUID(), s.userId, endpoint, p256dh, auth, clean(b.label, 80) || null, Date.now()),
        env.DB.prepare('UPDATE user_settings SET notify_prefs = ? WHERE user_id = ?').bind(JSON.stringify({ ...np, push: true }), s.userId),
      ]);
      return json({ ok: true });
    }
    case 'POST /api/push/unsubscribe': {
      const b = await readJson<{ endpoint?: string; id?: string }>(req);
      if (b.id) await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND id = ?').bind(s.userId, clean(b.id, 64)).run();
      else await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(s.userId, String(b.endpoint ?? '')).run();
      return json({ ok: true });
    }
    case 'GET /api/push/devices': {
      const { results } = await env.DB.prepare('SELECT id, label, created_at, last_ok_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC').bind(s.userId).all();
      return json({ devices: results });
    }
    case 'POST /api/push/test': {
      rateLimit(`pushtest:${s.userId}`, 3, 60_000);
      const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? LIMIT 5').bind(s.userId).all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
      const test = { v: 1, items: [{ title: 'JARVIS test: background notifications work', body: 'You will be notified here even when the dashboard is closed.', key: '', ids: [], importance: 'normal' }], events: [] as JarvisEvent[] };
      const outcomes = [];
      for (const r of results) {
        const o = await sendPush(env, r, test, 'normal');
        outcomes.push(o);
        if (o === 'gone') await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').bind(r.id, s.userId).run();
      }
      return json({ devices: results.length, outcomes });
    }

    // ---- local development only: run one cron tick and see what it did
    case 'POST /api/__dev/tick':
      if (env.ALLOW_INSECURE_PUSH !== '1') break;
      return json(await runTick(env));
    default:
  }
  throw new ApiError(404, 'Not found');
}
