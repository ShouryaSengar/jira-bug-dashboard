// JARVIS monitor: watches the bugs assigned to the authenticated user and turns Jira activity into
// discrete events. It runs inside the local server, so the API token never reaches the browser and
// detection keeps working while no browser tab is open.
//
// How a sync works
//  1. One paginated search lists every bug assigned to me (open ones, plus closed ones touched recently).
//  2. That list is diffed against the snapshot from the last sync.
//       - key not in the snapshot      -> newly assigned
//       - `updated` differs            -> fetch that issue's changelog + comments and turn the entries
//                                         newer than the last snapshot into events (status, priority, ...)
//       - key left the list            -> look it up: reassigned, unassigned, or simply aged out
//  3. Every changelog entry / comment has a stable id. Ids already seen are skipped, so an event can
//     never be announced twice, even across restarts.
//  The very first sync only records the baseline, so existing history is never announced.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type http from 'node:http';
import type { JarvisEvent, JarvisEventType, JarvisServerPrefs, JarvisState, JarvisStatus, MyBug } from '../shared/types.js';
import { CONFIG_DIR, loadConfig, type Config } from './config.js';
import { HttpError, iso, jira, resolveSeverityFieldIds, allFields } from './jira.js';
import { BASE_FIELDS, assignedJql, getMe, getPriorityRank, getStatusMap, recentChangelog, recentComments, searchAll } from './mine.js';
import { classifyAway, classifyChanges, classifyNew, eventLabel, type DetectCtx, type Draft } from '../core/detect.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const STATE_FILE = path.join(CONFIG_DIR, 'jarvis.json');
const MAX_EVENTS = 500;
const MAX_SEEN = 4000;
const MAX_EVENTS_PER_SYNC = 60;
const MAX_LOOKUPS_PER_SYNC = 25;

export const DEFAULT_SERVER_PREFS: JarvisServerPrefs = { enabled: true, paused: false, intervalSec: 60, osNotify: false, closedWindowDays: 90 };

interface Snap {
  updated: string;
  summary: string;
  project: string;
}
interface Persisted {
  version: 1;
  account: string | null;
  initialized: boolean;
  lastSyncAt: string | null;
  snapshot: Record<string, Snap>;
  seen: string[];
  events: JarvisEvent[];
  nextId: number;
  prefs: JarvisServerPrefs;
}

const blank = (prefs = DEFAULT_SERVER_PREFS): Persisted => ({
  version: 1, account: null, initialized: false, lastSyncAt: null, snapshot: {}, seen: [], events: [], nextId: 1, prefs: { ...prefs },
});

function loadState(): Persisted {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<Persisted>;
    if (raw.version !== 1) return blank();
    return { ...blank(), ...raw, prefs: { ...DEFAULT_SERVER_PREFS, ...raw.prefs } } as Persisted;
  } catch {
    return blank();
  }
}

export { eventLabel };

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx] as T);
      }
    })
  );
  return out;
}

/** Native OS notification for when no browser tab is connected. Arguments are passed as an array, never through a shell. */
function osNotify(title: string, body: string): void {
  const t = title.slice(0, 120), b = body.slice(0, 240);
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', '--', b, t], () => undefined);
  } else if (process.platform === 'linux') {
    execFile('notify-send', ['--app-name=Jira Bug Dashboard', '--', t, b], () => undefined);
  }
}
const OS_NOTIFY_SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

export class Monitor {
  private st: Persisted = loadState();
  private timer: NodeJS.Timeout | undefined;
  private syncing = false;
  private nextAt: number | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;
  private lastBroadcast = '';

  // ---------------------------------------------------------------- lifecycle
  start(): void {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 25_000);
    this.schedule(1500);
  }

  /** Credentials changed or were removed. */
  configChanged(): void {
    this.failures = 0;
    this.lastError = null;
    this.schedule(300);
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const p = this.st.prefs;
    if (!p.enabled || p.paused) {
      this.nextAt = null;
      this.pushStatus();
      return;
    }
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.pushStatus();
  }

  private async tick(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg) return this.schedule(10_000);
    let delay = this.st.prefs.intervalSec * 1000;
    try {
      await this.sync(cfg);
      this.failures = 0;
      this.lastError = null;
    } catch (e) {
      this.failures++;
      this.lastError = e instanceof Error ? e.message : String(e);
      const base = this.st.prefs.intervalSec * 1000;
      delay = Math.min(10 * 60_000, base * 2 ** Math.min(this.failures, 6));
      if (e instanceof HttpError) {
        if (e.status === 429) delay = Math.max(delay, (e.retryAfter ?? 60) * 1000);
        if (e.status === 401) delay = 10 * 60_000; // bad credentials: don't hammer Jira
      }
      console.warn(`JARVIS sync failed (attempt ${this.failures}): ${this.lastError}`);
    }
    this.schedule(delay);
  }

  // ---------------------------------------------------------------- public API for the HTTP layer
  syncNow(): void {
    if (!this.syncing && this.st.prefs.enabled) this.schedule(0);
  }

  /** Resolves when the sync started by `syncNow` has finished. Used by the tests. */
  async settled(): Promise<void> {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    while (this.syncing && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
  }

  get prefs(): JarvisServerPrefs {
    return { ...this.st.prefs };
  }

  setPrefs(patch: Partial<JarvisServerPrefs>): JarvisServerPrefs {
    const p = this.st.prefs;
    if (typeof patch.enabled === 'boolean') p.enabled = patch.enabled;
    if (typeof patch.paused === 'boolean') p.paused = patch.paused;
    if (typeof patch.osNotify === 'boolean') p.osNotify = patch.osNotify && OS_NOTIFY_SUPPORTED;
    const clamp = (v: unknown, lo: number, hi: number): number | undefined => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
    };
    p.intervalSec = clamp(patch.intervalSec, 30, 900) ?? p.intervalSec;
    p.closedWindowDays = clamp(patch.closedWindowDays, 7, 365) ?? p.closedWindowDays;
    this.persist();
    this.schedule(p.enabled && !p.paused ? 200 : 0);
    return { ...p };
  }

  eventsAfter(after: number, limit = 200): JarvisEvent[] {
    return this.st.events.filter((e) => e.id > after).slice(-limit);
  }
  recentEvents(limit = 200): JarvisEvent[] {
    return this.st.events.slice(-limit);
  }
  markRead(ids: number[] | 'all'): void {
    for (const e of this.st.events) if (ids === 'all' || ids.includes(e.id)) e.read = true;
    this.persist();
    this.pushStatus();
  }
  clearEvents(): void {
    this.st.events = [];
    this.persist();
    this.pushStatus();
  }

  lastActivityFor(key: string): MyBug['lastActivity'] {
    for (let i = this.st.events.length - 1; i >= 0; i--) {
      const e = this.st.events[i] as JarvisEvent;
      if (e.key === key && e.importance !== 'low') return { at: e.occurredAt, label: eventLabel(e) };
    }
    return null;
  }
  wasAssignedRecently(key: string): boolean {
    const cutoff = Date.now() - 7 * 864e5;
    return this.st.events.some((e) => e.key === key && e.type === 'assigned' && Date.parse(e.occurredAt) >= cutoff);
  }

  status(): JarvisStatus {
    const p = this.st.prefs;
    let state: JarvisState = 'online';
    if (!loadConfig()) state = 'unconfigured';
    else if (!p.enabled) state = 'off';
    else if (p.paused) state = 'paused';
    else if (this.syncing) state = 'syncing';
    else if (this.failures > 0) state = 'backoff';
    const last = this.st.events[this.st.events.length - 1];
    return {
      state,
      prefs: { ...p },
      lastSyncAt: this.st.lastSyncAt,
      nextSyncAt: this.nextAt ? new Date(this.nextAt).toISOString() : null,
      lastError: this.lastError,
      monitored: Object.keys(this.st.snapshot).length,
      unread: this.st.events.filter((e) => !e.read && !e.own).length,
      lastEventId: last?.id ?? 0,
      clients: this.clients.size,
      osNotifySupported: OS_NOTIFY_SUPPORTED,
    };
  }

  // ---------------------------------------------------------------- server-sent events
  addClient(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => {
      this.clients.delete(res);
      this.pushStatus();
    });
    const last = Number(req.headers['last-event-id']);
    if (Number.isFinite(last) && last > 0) for (const e of this.eventsAfter(last, 50)) this.sendEvent(res, e);
    res.write(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`);
    this.pushStatus();
  }
  private sendEvent(res: http.ServerResponse, e: JarvisEvent): void {
    res.write(`id: ${e.id}\nevent: jarvis\ndata: ${JSON.stringify(e)}\n\n`);
  }
  private pushStatus(): void {
    if (!this.clients.size) return;
    const data = JSON.stringify(this.status());
    if (data === this.lastBroadcast) return;
    this.lastBroadcast = data;
    for (const c of this.clients) c.write(`event: status\ndata: ${data}\n\n`);
  }

  // ---------------------------------------------------------------- persistence
  private persist(): void {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 });
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.warn('JARVIS could not save its state:', (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- the sync itself
  private async sync(cfg: Config): Promise<void> {
    this.syncing = true;
    this.pushStatus();
    try {
      await this.doSync(cfg);
    } finally {
      this.syncing = false;
    }
  }

  private async doSync(cfg: Config): Promise<void> {
    const me = await getMe(cfg);
    const account = `${cfg.jiraUrl}|${me.accountId}`;
    if (this.st.account !== account) {
      // A different Jira site or account: nothing from the old one applies.
      this.st = { ...blank(this.st.prefs), account };
    }
    const sev = await resolveSeverityFieldIds(cfg);
    const { issues } = await searchAll(cfg, assignedJql(cfg, this.st.prefs.closedWindowDays), [...BASE_FIELDS, ...sev]);
    const now = new Date().toISOString();

    const current = new Map<string, Json>(issues.map((i) => [String(i.key), i]));
    const next: Record<string, Snap> = {};
    for (const [key, i] of current) next[key] = { updated: iso(i.fields.updated), summary: String(i.fields.summary ?? ''), project: String(i.fields.project?.key ?? '') };

    if (!this.st.initialized) {
      // Baseline only: never announce what already existed.
      this.st.snapshot = next;
      this.st.initialized = true;
      this.st.lastSyncAt = now;
      this.persist();
      this.pushStatus();
      return;
    }

    const prevSnap = this.st.snapshot;
    const drafts: Draft[] = [];
    const seen = new Set(this.st.seen);
    const statusMap = await getStatusMap(cfg);
    const sevIds = new Set(sev);
    const severityNames = new Set((await allFields(cfg).catch(() => [] as Json[])).filter((f) => sevIds.has(f.id)).map((f) => String(f.name).toLowerCase()));
    const ctx: Ctx = {
      cfg,
      dc: { siteUrl: cfg.jiraUrl, meId: me.accountId, severityIds: sevIds, severityNames, seen, statusCat: (id) => statusMap.get(id)?.cat, priorityRank: await getPriorityRank(cfg) },
    };

    // 1) newly assigned
    const fresh = [...current.keys()].filter((k) => !prevSnap[k]);
    await mapLimit(fresh, 3, async (key) => {
      try {
        drafts.push(...(await this.onNew(ctx, current.get(key) as Json)));
      } catch (e) {
        if (isFatal(e)) throw e;
        delete next[key]; // retry on the next sync
      }
    });

    // 2) changed
    const changed = [...current.keys()].filter((k) => prevSnap[k] && (prevSnap[k] as Snap).updated !== (next[k] as Snap).updated);
    await mapLimit(changed, 3, async (key) => {
      try {
        drafts.push(...(await this.onChanged(ctx, current.get(key) as Json, prevSnap[key] as Snap)));
      } catch (e) {
        if (isFatal(e)) throw e;
        next[key] = prevSnap[key] as Snap; // keep the old snapshot so the same changes are found again
      }
    });

    // 3) gone from my list
    const missing = Object.keys(prevSnap).filter((k) => !current.has(k));
    const now2 = missing.slice(0, MAX_LOOKUPS_PER_SYNC);
    for (const k of missing.slice(MAX_LOOKUPS_PER_SYNC)) next[k] = prevSnap[k] as Snap;
    await mapLimit(now2, 3, async (key) => {
      try {
        const d = await this.onMissing(ctx, key, prevSnap[key] as Snap);
        if (d) drafts.push(d);
      } catch (e) {
        if (isFatal(e)) throw e;
        next[key] = prevSnap[key] as Snap;
      }
    });

    // Commit: everything above succeeded or was rolled back per issue.
    drafts.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const kept = drafts.slice(-MAX_EVENTS_PER_SYNC);
    const events: JarvisEvent[] = kept.map((d) => ({ ...d, id: this.st.nextId++, at: now, read: d.own }));
    this.st.events = [...this.st.events, ...events].slice(-MAX_EVENTS);
    this.st.seen = [...seen].slice(-MAX_SEEN);
    this.st.snapshot = next;
    this.st.lastSyncAt = now;
    this.persist();
    for (const e of events) for (const c of this.clients) this.sendEvent(c, e);
    this.pushStatus();
    if (events.length && !this.clients.size && this.st.prefs.osNotify) this.notifyOs(events);
  }

  private notifyOs(events: JarvisEvent[]): void {
    const list = events.filter((e) => !e.own && e.importance !== 'low');
    for (const e of list.slice(0, 3)) osNotify(`${e.key}: ${eventLabel(e)}`, e.summary);
    if (list.length > 3) osNotify('JARVIS', `${list.length - 3} more updates on your bugs`);
  }

  private async onNew(c: Ctx, i: Json): Promise<Draft[]> {
    const hist = await recentChangelog(c.cfg, i.key, 100).catch(() => [] as Json[]);
    return classifyNew(c.dc, i, hist, Date.parse(this.st.lastSyncAt ?? '') || 0);
  }

  private async onChanged(c: Ctx, i: Json, prev: Snap): Promise<Draft[]> {
    const [hist, comments] = await Promise.all([recentChangelog(c.cfg, i.key, 100), recentComments(c.cfg, i.key, 15)]);
    return classifyChanges(c.dc, i, hist, comments, Date.parse(prev.updated));
  }

  private async onMissing(c: Ctx, key: string, prev: Snap): Promise<Draft | null> {
    let i: Json;
    try {
      i = await jira(c.cfg, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,project,updated`);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return null; // deleted, moved or no longer visible
      throw e;
    }
    return classifyAway(c.dc, i, prev.summary);
  }
}

interface Ctx {
  cfg: Config;
  dc: DetectCtx;
}

/** Errors that should abort the whole sync (and trigger backoff) instead of skipping one issue. */
function isFatal(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 401 || e.status === 429);
}

export const monitor = new Monitor();
