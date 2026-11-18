// JARVIS monitoring engine for the Cloud edition. One shared Cron Trigger runs every minute and checks the
// users whose turn it is, so there is never one trigger per user.
//
// Free-plan constraints this is designed around (verify current values in cloud/README.md):
//  - 50 subrequests per invocation, D1 queries included   -> every call goes through a Budget; a user that
//    does not fit is deferred and finished next minute instead of failing half way
//  - 10 ms CPU per invocation                             -> incremental queries return few issues; no big payloads
//  - 100,000 D1 rows written per day                      -> idle checks write nothing (a heartbeat every 20 min)
//
// Per user and check:
//   incremental:  issuetype in (Bug) AND ((assignee = currentUser() AND updated >= -Nm)
//                                        OR assignee CHANGED FROM currentUser() AFTER -Nm)
//     -> new to me: read its changelog (who assigned it)         -> "assigned"
//     -> mine and changed: read changelog + comments             -> status / reopened / resolved / comment / ...
//     -> no longer mine: the result itself says who has it now  -> "reassigned" / "unassigned" (no extra call)
//   every 6 hours a full list re-syncs the snapshot (bugs that aged out, deletions, missed windows).
//   the first check only records a baseline, so existing history is never announced.

import type { JarvisEvent, JarvisEventType } from '../../src/shared/types.js';
import { BASE_FIELDS, HttpError, assignedJql, makePriorityRank, matchSeverityFields, recentChangelog, recentComments, searchAll, typesJql, type JiraApi, type Json } from '../../src/core/jira.js';
import { classifyAway, classifyChanges, classifyNew, statusIdsIn, type DetectCtx, type Draft } from '../../src/core/detect.js';
import { DEFAULT_JARVIS_PREFS, plan, type JarvisPrefs } from '../../src/client/jarvis-core.js';
import { ReauthRequired, accessToken, cloudApi, type GrantRow } from './auth.js';
import { Budget, BudgetExhausted } from './budget.js';
import { budgetSize, maxUsersPerRun, type Env } from './env.js';
import { sendPush, type PushTarget } from './push.js';

const MIN = 60_000;
const RECONCILE_MS = 6 * 3600_000;
const HEARTBEAT_MS = 20 * MIN;
const MAX_SEEN = 3000;
const MAX_EVENTS_PER_CHECK = 40;
const PUSH_GIVE_UP_MS = 6 * 3600_000;
const MAX_DEVICES = 5;

// ---------------------------------------------------------------- types

export interface NotifyPrefs {
  push?: boolean;
  types?: Partial<Record<JarvisEventType, boolean>>;
  frequency?: 'all' | 'important' | 'digest';
  quiet?: { on: boolean; from: string; to: string };
  tz?: string;
}

interface DueRow {
  user_id: string;
  account_id: string;
  active_cloud_id: string;
  site_name: string;
  site_url: string;
  issue_types: string;
  severity_fields: string;
  severity_ids: string;
  severity_names: string;
  closed_window_days: number;
  interval_min: number;
  notify_prefs: string;
  // grant
  enc_tokens: string;
  key_id: string;
  access_expires_at: number;
  version: number;
  status: string;
  // state (null before the first check)
  st_cloud_id: string | null;
  initialized: number | null;
  snapshot: string | null;
  seen: string | null;
  status_cats: string | null;
  priority_names: string | null;
  checked_at: number | null;
  reconciled_at: number | null;
  failures: number | null;
}

type Snap = Record<string, [updated: string, summary: string, project: string]>;

export interface CheckResult {
  userId: string;
  events: number;
  pushed: number;
  outcome: 'baseline' | 'ok' | 'deferred' | 'error' | 'reauth';
  error?: string;
}

export interface TickReport {
  at: string;
  due: number;
  checked: CheckResult[];
  deferred: number;
  retriedPush: number;
  subrequests: number;
  maintenance: boolean;
}

const DUE_SELECT = `
  SELECT s.user_id, u.atlassian_account_id AS account_id, s.active_cloud_id, j.name AS site_name, j.url AS site_url,
         s.issue_types, s.severity_fields, s.severity_ids, s.severity_names, s.closed_window_days, s.interval_min, s.notify_prefs,
         g.enc_tokens, g.key_id, g.access_expires_at, g.version, g.status,
         st.cloud_id AS st_cloud_id, st.initialized, st.snapshot, st.seen, st.status_cats, st.priority_names,
         st.checked_at, st.reconciled_at, st.failures
  FROM user_settings s
  JOIN users u ON u.id = s.user_id
  JOIN oauth_grants g ON g.user_id = s.user_id AND g.status = 'active'
  JOIN jira_sites j ON j.user_id = s.user_id AND j.cloud_id = s.active_cloud_id
  LEFT JOIN monitor_state st ON st.user_id = s.user_id`;

/** Stored severity ids; ["none"] marks "looked up, nothing found" so the lookup is not repeated every check. */
export const cleanIds = (raw: string | null | undefined): string[] => parse<string[]>(raw, []).filter((x) => x !== 'none');

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- events <-> rows

export interface EventRow {
  id: number; type: string; at: number; occurred_at: string; issue_key: string; summary: string; project: string; url: string;
  actor: string | null; from_v: string | null; to_v: string | null; detail: string | null; escalated: number; importance: string; own: number; read: number;
}
export const toEvent = (r: EventRow): JarvisEvent => ({
  id: r.id, type: r.type as JarvisEventType, at: new Date(r.at).toISOString(), occurredAt: r.occurred_at, key: r.issue_key, summary: r.summary,
  project: r.project, url: r.url, actor: r.actor, from: r.from_v, to: r.to_v, detail: r.detail, escalated: !!r.escalated,
  importance: r.importance as JarvisEvent['importance'], own: !!r.own, read: !!r.read,
});

// ---------------------------------------------------------------- notification rules (server side, for push)

function localMinutes(tz: string | undefined, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0), m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}
export function quietNow(p: NotifyPrefs, at = new Date()): boolean {
  const q = p.quiet;
  if (!q?.on) return false;
  const mins = (s: string): number => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const now = localMinutes(p.tz, at), a = mins(q.from), b = mins(q.to);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

function jarvisPrefsFor(p: NotifyPrefs): JarvisPrefs {
  return {
    ...DEFAULT_JARVIS_PREFS,
    voice: false,
    desktop: true,
    types: { ...DEFAULT_JARVIS_PREFS.types, ...(p.types ?? {}) },
    frequency: p.frequency === 'important' ? 'important' : 'all', // digest grouping happens in the browser
    quiet: { on: false, from: '22:00', to: '08:00' }, // quiet hours are checked in the user's time zone above
  };
}

/** Events worth a push, already grouped ("3 new comments") and capped at three notifications plus a summary. */
export function pushPlan(events: JarvisEvent[], p: NotifyPrefs, at = new Date()): { title: string; body: string; key: string; ids: number[]; importance: string }[] {
  if (!p.push || quietNow(p, at)) return [];
  return plan(events, jarvisPrefsFor(p), at)
    .filter((a) => a.notify)
    .map((a) => {
      const last = a.events[a.events.length - 1] as JarvisEvent;
      return { title: a.title, body: a.body, key: last.key, ids: a.events.map((e) => e.id), importance: a.importance };
    });
}

// ---------------------------------------------------------------- the tick

export async function runTick(env: Env, at = Date.now()): Promise<TickReport> {
  const budget = new Budget(budgetSize(env));
  const minute = Math.floor(at / MIN);
  const report: TickReport = { at: new Date(at).toISOString(), due: 0, checked: [], deferred: 0, retriedPush: 0, subrequests: 0, maintenance: false };

  // Due: deferred users first, then everyone whose slot matches this minute. One query.
  budget.take();
  const { results } = await env.DB.prepare(
    `${DUE_SELECT}
     WHERE s.monitor_enabled = 1 AND s.monitor_paused = 0 AND COALESCE(st.backoff_until, 0) <= ?2
       AND (COALESCE(st.deferred, 0) = 1 OR ((?1 - s.slot) % s.interval_min) = 0)
     ORDER BY COALESCE(st.deferred, 0) DESC, ((s.slot * 7919 + ?1) % 1009)
     LIMIT 60`
  ).bind(minute, at).all<DueRow>();
  report.due = results.length;

  const left: string[] = [];
  for (const row of results) {
    // A quiet check costs ~2 calls; leave room for one with changes plus a push or two. The user cap keeps the
    // run inside the 10 ms CPU limit, which subrequest counting alone would not.
    if (!budget.has(6) || report.checked.length >= maxUsersPerRun(env)) {
      left.push(row.user_id);
      continue;
    }
    report.checked.push(await checkUser(env, row, budget, at));
  }
  if (left.length && budget.has(1)) {
    budget.take();
    await env.DB.batch(left.map((id) =>
      env.DB.prepare(`INSERT INTO monitor_state (user_id, cloud_id, deferred) SELECT user_id, active_cloud_id, 1 FROM user_settings WHERE user_id = ?
                      ON CONFLICT(user_id) DO UPDATE SET deferred = 1`).bind(id)
    ));
  }
  report.deferred = left.length + report.checked.filter((c) => c.outcome === 'deferred').length;

  // Retry pushes that failed earlier, if there is budget left.
  if (budget.has(5)) report.retriedPush = await retryPendingPushes(env, budget, at);

  // Hourly housekeeping.
  if (minute % 60 === 13 && budget.has(1)) {
    budget.take();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1 OR last_used_at < ?2').bind(at, at - 7 * 864e5),
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(at),
      env.DB.prepare('DELETE FROM events WHERE at < ?').bind(at - 30 * 864e5),
      env.DB.prepare('UPDATE events SET pushed = 2 WHERE pushed = 0 AND at < ?').bind(at - PUSH_GIVE_UP_MS),
    ]);
    report.maintenance = true;
  }
  report.subrequests = budget.used;
  return report;
}

/** "Check now" from the dashboard: the same check, for one signed-in user, inside their request. */
export async function checkOne(env: Env, userId: string, budget: Budget): Promise<CheckResult> {
  budget.take();
  const row = await env.DB.prepare(`${DUE_SELECT} WHERE s.user_id = ?`).bind(userId).first<DueRow>();
  if (!row) return { userId, events: 0, pushed: 0, outcome: 'reauth', error: 'Not connected' };
  return checkUser(env, row, budget, Date.now());
}

// ---------------------------------------------------------------- one user

async function checkUser(env: Env, row: DueRow, budget: Budget, at: number): Promise<CheckResult> {
  const res: CheckResult = { userId: row.user_id, events: 0, pushed: 0, outcome: 'ok' };
  const sameSite = row.st_cloud_id === row.active_cloud_id;
  const st = {
    initialized: sameSite && !!row.initialized,
    snapshot: sameSite ? parse<Snap>(row.snapshot, {}) : {},
    seen: new Set(sameSite ? parse<string[]>(row.seen, []) : []),
    statusCats: sameSite ? parse<Record<string, string>>(row.status_cats, {}) : {},
    priorityNames: sameSite ? parse<string[] | null>(row.priority_names, null) : null,
    checkedAt: sameSite ? row.checked_at ?? 0 : 0,
    reconciledAt: sameSite ? row.reconciled_at ?? 0 : 0,
  };
  let changed = !sameSite;
  let finished = true;
  const drafts: Draft[] = [];

  try {
    const grant: GrantRow = { user_id: row.user_id, enc_tokens: row.enc_tokens, key_id: row.key_id, access_expires_at: row.access_expires_at, version: row.version, status: row.status };
    const token = await accessToken(env, row.user_id, budget, grant);
    const api = cloudApi(env, { cloudId: row.active_cloud_id, name: row.site_name, url: row.site_url }, row.user_id, budget, token);

    let sevIds = cleanIds(row.severity_ids);
    let sevNames = parse<string[]>(row.severity_names, []);
    if (row.severity_ids === '[]') ({ ids: sevIds, names: sevNames } = await ensureSeverity(env, api, row.user_id, row.severity_fields, row.severity_ids, budget));
    const fields = ['summary', 'status', 'updated', 'project', 'assignee', 'priority', ...sevIds];
    const ctx: DetectCtx = {
      siteUrl: row.site_url,
      meId: row.account_id,
      severityIds: new Set(sevIds),
      severityNames: new Set(sevNames),
      seen: st.seen,
      statusCat: (id) => st.statusCats[id],
      priorityRank: makePriorityRank(st.priorityNames),
    };

    const needFull = !st.initialized || at - st.reconciledAt > RECONCILE_MS || at - st.checkedAt > 7 * 864e5;
    if (needFull) {
      if (!st.priorityNames) {
        st.priorityNames = ((await api.request('/rest/api/3/priority')) as Json[]).map((p) => String(p.name));
        ctx.priorityRank = makePriorityRank(st.priorityNames);
      }
      const { issues } = await searchAll(api, assignedJql(row.issue_types, row.closed_window_days), fields, 500);
      const full: Snap = {};
      for (const i of issues) full[i.key] = [String(i.fields.updated), String(i.fields.summary ?? ''), String(i.fields.project?.key ?? '')];
      if (st.initialized) {
        // Anything mine that the incremental checks missed (for example during an outage) is still announced.
        for (const i of issues) {
          if (st.snapshot[i.key]) continue;
          if (!budget.has(3)) { finished = false; delete full[i.key]; continue; }
          const hist = await recentChangelog(api, i.key, 100).catch(() => [] as Json[]);
          drafts.push(...classifyNew(ctx, i, hist, st.checkedAt));
        }
      }
      st.snapshot = full;
      st.reconciledAt = at;
      if (!st.initialized) {
        st.initialized = true;
        res.outcome = 'baseline';
      }
      changed = true;
    } else {
      const windowMin = Math.min(7 * 1440, Math.max(10, Math.ceil((at - st.checkedAt) / MIN) + 3));
      const jql = `issuetype in (${typesJql(row.issue_types)}) AND ((assignee = currentUser() AND updated >= -${windowMin}m) OR assignee CHANGED FROM currentUser() AFTER -${windowMin}m) ORDER BY updated ASC`;
      const { issues } = await searchAll(api, jql, fields, 200);
      for (const i of issues) {
        const key = String(i.key);
        const snap = st.snapshot[key];
        const updated = String(i.fields.updated);
        const mine = i.fields.assignee?.accountId === row.account_id;
        if (snap && snap[0] === updated && mine) continue; // already handled in an earlier, overlapping window
        if (!mine) {
          if (!snap) continue; // was never in my list
          const d = classifyAway(ctx, i, snap[1]);
          if (d) drafts.push(d);
          delete st.snapshot[key];
          changed = true;
          continue;
        }
        if (!budget.has(snap ? 4 : 3)) {
          finished = false; // picked up again next minute: checked_at is not advanced
          break;
        }
        if (!snap) {
          const hist = await recentChangelog(api, key, 100).catch(() => [] as Json[]);
          drafts.push(...classifyNew(ctx, i, hist, st.checkedAt));
        } else {
          const [hist, comments] = await Promise.all([recentChangelog(api, key, 100), recentComments(api, key, 15)]);
          await learnStatuses(api, hist, st.statusCats, budget);
          drafts.push(...classifyChanges(ctx, i, hist, comments, Date.parse(snap[0])));
        }
        st.snapshot[key] = [updated, String(i.fields.summary ?? ''), String(i.fields.project?.key ?? '')];
        changed = true;
      }
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      finished = false;
    } else {
      return recordFailure(env, row, budget, at, e, res);
    }
  }

  // ---- commit (one batch): events + checkpoint
  const kept = drafts.slice(-MAX_EVENTS_PER_CHECK);
  const prefs = parse<NotifyPrefs>(row.notify_prefs, {});
  const pushable = new Set(prefs.push ? kept.filter((d) => !d.own && (prefs.types?.[d.type] ?? DEFAULT_JARVIS_PREFS.types[d.type])).map((d) => d) : []);
  const newChecked = finished ? at : st.checkedAt;
  const heartbeat = finished && at - st.checkedAt > HEARTBEAT_MS;
  if (!changed && !kept.length && !heartbeat && finished) return res; // idle: no write at all

  const stmts: D1PreparedStatement[] = kept.map((d) =>
    env.DB.prepare(
      `INSERT INTO events (user_id, type, at, occurred_at, issue_key, summary, project, url, actor, from_v, to_v, detail, escalated, importance, own, read, pushed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(row.user_id, d.type, at, d.occurredAt, d.key, d.summary.slice(0, 300), d.project, d.url, d.actor, d.from, d.to, d.detail, d.escalated ? 1 : 0, d.importance, d.own ? 1 : 0, d.own ? 1 : 0, pushable.has(d) ? 0 : 1)
  );
  stmts.push(
    env.DB.prepare(
      `INSERT INTO monitor_state (user_id, cloud_id, initialized, snapshot, seen, status_cats, priority_names, checked_at, reconciled_at, deferred, failures, backoff_until, last_error)
       VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, NULL)
       ON CONFLICT(user_id) DO UPDATE SET cloud_id = ?2, initialized = 1, snapshot = ?3, seen = ?4, status_cats = ?5, priority_names = ?6,
         checked_at = ?7, reconciled_at = ?8, deferred = ?9, failures = 0, backoff_until = 0, last_error = NULL`
    ).bind(row.user_id, row.active_cloud_id, JSON.stringify(st.snapshot), JSON.stringify([...st.seen].slice(-MAX_SEEN)), JSON.stringify(st.statusCats),
      st.priorityNames ? JSON.stringify(st.priorityNames) : null, newChecked, st.reconciledAt, finished ? 0 : 1)
  );
  budget.used = Math.min(budget.size, budget.used + 1); // the commit must happen even at the edge of the budget
  const out = await env.DB.batch(stmts);
  res.events = kept.length;
  if (!finished) res.outcome = res.outcome === 'baseline' ? 'baseline' : 'deferred';

  // ---- push
  const ids = out.slice(0, kept.length).map((r) => (r.results[0] as { id: number }).id);
  const stored: JarvisEvent[] = kept.map((d, n) => ({ ...d, id: ids[n] as number, at: new Date(at).toISOString(), read: d.own }));
  const toPush = stored.filter((_, n) => pushable.has(kept[n] as Draft));
  if (toPush.length) res.pushed = await deliver(env, row.user_id, toPush, prefs, budget, at);
  return res;
}

/** Status categories are needed to tell "reopened" from "moved". Unknown ids are looked up once and cached. */
async function learnStatuses(api: JiraApi, hist: Json[], cats: Record<string, string>, budget: Budget): Promise<void> {
  for (const id of statusIdsIn(hist)) {
    if (cats[id] || !budget.has(3)) continue;
    try {
      const s = await api.request(`/rest/api/3/status/${encodeURIComponent(id)}`);
      cats[id] = String(s.statusCategory?.key ?? '');
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      cats[id] = ''; // deleted status: fall back to names
    }
  }
}

async function recordFailure(env: Env, row: DueRow, budget: Budget, at: number, e: unknown, res: CheckResult): Promise<CheckResult> {
  const reauth = e instanceof ReauthRequired;
  const failures = (row.failures ?? 0) + 1;
  let wait = Math.min(60, row.interval_min * 2 ** Math.min(failures, 5)) * MIN;
  if (e instanceof HttpError && e.status === 429) wait = Math.max(wait, (e.retryAfter ?? 60) * 1000);
  const msg = reauth ? 'Jira access was revoked. Reconnect with Atlassian.' : (e as Error).message?.slice(0, 300) ?? 'error';
  console.warn(`monitor: user check failed (${failures}x): ${msg}`); // no tokens or Jira content in logs
  {
    budget.used = Math.min(budget.size, budget.used + 1); // always record the failure, even at the edge of the budget
    await env.DB.prepare(
      `INSERT INTO monitor_state (user_id, cloud_id, failures, backoff_until, last_error) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET failures = ?3, backoff_until = ?4, last_error = ?5, deferred = 0`
    ).bind(row.user_id, row.active_cloud_id, failures, reauth ? 0 : at + wait, msg).run();
  }
  return { ...res, outcome: reauth ? 'reauth' : 'error', error: msg };
}

// ---------------------------------------------------------------- push delivery

async function deliver(env: Env, userId: string, events: JarvisEvent[], prefs: NotifyPrefs, budget: Budget, at: number): Promise<number> {
  const items = pushPlan(events, prefs, new Date(at));
  const allIds = events.map((e) => e.id);
  if (!items.length) {
    if (budget.has(1)) { budget.take(); await markPushed(env, userId, allIds, 1); }
    return 0;
  }
  if (!budget.has(2)) return 0; // stays pending; retried next minute
  budget.take();
  const { results: subs } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, MAX_DEVICES).all<PushTarget & { id: string }>();
  if (!subs.length) {
    budget.take();
    await markPushed(env, userId, allIds, 1);
    return 0;
  }
  const payload = {
    v: 1,
    items: items.map((i) => ({ title: i.title, body: i.body, key: i.key, ids: i.ids, importance: i.importance })),
    events: events.slice(-8).map((e) => ({ ...e, summary: e.summary.slice(0, 140), detail: e.detail?.slice(0, 140) ?? null })),
  };
  let delivered = 0, retry = false;
  const gone: string[] = [], ok: string[] = [];
  for (const s of subs) {
    if (!budget.has(2)) { retry = true; break; }
    budget.take();
    const r = await sendPush(env, s, payload, items.some((i) => i.importance === 'high') ? 'high' : 'normal');
    if (r === 'ok') { delivered++; ok.push(s.id); }
    else if (r === 'gone') gone.push(s.id);
    else retry = true;
  }
  budget.used = Math.min(budget.size, budget.used + 1);
  await env.DB.batch([
    ...(delivered || !retry ? [env.DB.prepare(`UPDATE events SET pushed = 1 WHERE user_id = ? AND id IN (${allIds.map(() => '?').join(',')})`).bind(userId, ...allIds)] : []),
    ...gone.map((id) => env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').bind(id, userId)),
    ...ok.map((id) => env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ? AND user_id = ?').bind(at, id, userId)),
  ]);
  return delivered;
}

async function markPushed(env: Env, userId: string, ids: number[], v: 1 | 2): Promise<void> {
  if (!ids.length) return;
  await env.DB.prepare(`UPDATE events SET pushed = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(v, userId, ...ids).run();
}

/** Events stored with pushed = 0 whose delivery failed (push service down, budget ran out). */
async function retryPendingPushes(env: Env, budget: Budget, at: number): Promise<number> {
  budget.take();
  const { results } = await env.DB.prepare(
    `SELECT e.*, s.notify_prefs FROM events e JOIN user_settings s ON s.user_id = e.user_id
     WHERE e.pushed = 0 AND e.at < ?1 ORDER BY e.id LIMIT 12`
  ).bind(at - 30_000).all<EventRow & { user_id: string; notify_prefs: string }>();
  const byUser = new Map<string, (EventRow & { notify_prefs: string })[]>();
  for (const r of results) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  let n = 0;
  for (const [userId, rows] of byUser) {
    if (!budget.has(4)) break;
    n += await deliver(env, userId, rows.map(toEvent), parse<NotifyPrefs>(rows[0]?.notify_prefs, {}), budget, at);
  }
  return n;
}

/** Severity field ids for a user's site, resolved once with the small field-search API and cached. */
export async function ensureSeverity(env: Env, api: JiraApi, userId: string, wantedCsv: string, cachedIds: string, budget: Budget): Promise<{ ids: string[]; names: string[] }> {
  if (parse<string[]>(cachedIds, []).length) return { ids: cleanIds(cachedIds), names: [] };
  const wanted = wantedCsv.split(',').map((s) => s.trim()).filter(Boolean);
  const found: { id: string; name: string }[] = [];
  for (const w of wanted.slice(0, 4)) {
    if (/^customfield_\d+$/.test(w)) { found.push({ id: w, name: w }); continue; }
    const r = await api.request(`/rest/api/3/field/search?type=custom&maxResults=50&query=${encodeURIComponent(w)}`).catch(() => ({ values: [] }));
    for (const f of (r.values ?? []) as Json[]) found.push({ id: String(f.id), name: String(f.name) });
  }
  const ids = matchSeverityFields(wantedCsv, found);
  const names = [...new Set(found.filter((f) => ids.includes(f.id)).map((f) => f.name.toLowerCase()))];
  budget.take();
  await env.DB.prepare('UPDATE user_settings SET severity_ids = ?, severity_names = ? WHERE user_id = ?').bind(JSON.stringify(ids.length ? ids : ['none']), JSON.stringify(names), userId).run();
  return { ids, names };
}

export { BASE_FIELDS };
