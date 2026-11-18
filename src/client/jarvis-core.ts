// JARVIS announcement logic with no browser dependencies, so it can be unit-tested in Node.
// Messages come from hand-written templates (no AI, no network). Each event type has several
// variations; the same one is never used twice in a row.

import type { JarvisEvent, JarvisEventType } from '../shared/types.js';

export type Frequency = 'all' | 'important' | 'digest';
export type Address = 'sir' | "ma'am" | 'boss' | '';

export interface JarvisPrefs {
  voice: boolean;
  desktop: boolean;
  address: Address;
  /** Voice name chosen by the user. Empty means "pick the best English voice". */
  voiceName: string;
  rate: number;
  volume: number;
  /** Which event types are announced at all. Everything is still recorded in the history. */
  types: Record<JarvisEventType, boolean>;
  frequency: Frequency;
  quiet: { on: boolean; from: string; to: string };
}

export const EVENT_LABEL: Record<JarvisEventType, string> = {
  assigned: 'New assignment',
  reassigned_away: 'Reassigned to someone else',
  unassigned: 'Unassigned',
  status: 'Status change',
  reopened: 'Reopened',
  resolved: 'Resolved',
  closed: 'Closed',
  comment: 'New comment',
  priority: 'Priority change',
  severity: 'Severity change',
  updated: 'Other edits (quiet by default)',
};
export const EVENT_TYPES = Object.keys(EVENT_LABEL) as JarvisEventType[];

export const DEFAULT_JARVIS_PREFS: JarvisPrefs = {
  voice: true,
  desktop: false, // turned on by the user, because the browser needs an explicit permission prompt
  address: 'sir',
  voiceName: '',
  rate: 1,
  volume: 0.85,
  types: { assigned: true, reassigned_away: true, unassigned: true, status: true, reopened: true, resolved: true, closed: true, comment: true, priority: true, severity: true, updated: false },
  frequency: 'all',
  quiet: { on: false, from: '22:00', to: '08:00' },
};

// ------------------------------------------------------------------ text helpers

const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "ABC-123" -> "A B C 123" so speech engines read the letters instead of guessing a word. */
export function spokenKey(key: string): string {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(key);
  if (!m) return key;
  const proj = (m[1] as string).length <= 4 && /^[A-Za-z]+$/.test(m[1] as string) ? (m[1] as string).split('').join(' ') : (m[1] as string);
  return `${proj} ${m[2]}`;
}

/** Short enough to listen to: strips markup and links, cuts at a word boundary. */
export function spokenSummary(s: string, max = 70): string {
  let t = String(s ?? '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[\[\]{}<>|_*#`~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    t = t.slice(0, max);
    const sp = t.lastIndexOf(' ');
    t = (sp > 30 ? t.slice(0, sp) : t).replace(/[,;:\-–(]+$/, '') + '…';
  }
  return t;
}

export function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

interface C {
  /** Written form: "ABC-123". */
  key: string;
  /** Spoken form: "A B C 123". */
  k: string;
  /** Spoken, shortened summary. */
  sum: string;
  /** "Sir, " or "" */
  pre: string;
  /** ", sir" or "" */
  post: string;
  greet: string;
  who: string;
  from: string;
  to: string;
  n: number;
}

type T = (c: C) => string;

const TEMPLATES: Record<string, T[]> = {
  assigned: [
    (c) => `${c.greet}${c.post}. A new bug has landed on your desk. ${c.k}, ${c.sum}, has just been assigned to you. Shall we take a look?`,
    (c) => `${c.pre}you have a new assignment. ${c.k}: ${c.sum}. I would call it a fresh opportunity.`,
    (c) => `${c.pre}incoming. ${c.k} has been routed to you. ${c.sum}. I have taken the liberty of keeping your calendar clear.`,
    (c) => `New bug detected${c.post}. ${c.k}, ${c.sum}. It appears to have your name on it.`,
  ],
  status: [
    (c) => `${c.pre}a quick update. ${c.k}, ${c.sum}, has moved to ${c.to}.`,
    (c) => `${c.pre}${c.k} just changed status from ${c.from} to ${c.to}. ${c.sum}.`,
    (c) => `Movement on the board${c.post}. ${c.k} is now ${c.to}. ${c.sum}.`,
    (c) => `For your awareness${c.post}: ${c.k} is now ${c.to}.`,
  ],
  comment: [
    (c) => `${c.pre}someone has left a new comment on ${c.k}. ${c.sum}. Might be worth checking.`,
    (c) => `${c.who} has weighed in on ${c.k}${c.post}. ${c.sum}.`,
    (c) => `New commentary on ${c.k}${c.post}. I suspect a reply is expected.`,
    (c) => `${c.pre}${c.k} is attracting conversation. ${c.who} just commented.`,
  ],
  comment_many: [
    (c) => `${c.pre}${c.k} has ${c.n} new comments. ${c.sum}. The thread is getting lively.`,
    (c) => `${c.n} new comments on ${c.k}${c.post}. You may want to catch up.`,
  ],
  priority_up: [
    (c) => `Attention${c.post}. The priority of ${c.k} has just been escalated to ${c.to}. This one might need your attention.`,
    (c) => `${c.pre}${c.k} has been bumped up to ${c.to} priority. ${c.sum}. Someone clearly wants it sooner.`,
    (c) => `Priority alert${c.post}. ${c.k} is now ${c.to}. I would not leave it waiting.`,
  ],
  priority_down: [
    (c) => `${c.pre}good news. The priority of ${c.k} has been lowered to ${c.to}. You may breathe.`,
    (c) => `${c.k} has been downgraded to ${c.to} priority${c.post}. A little less urgent than before.`,
  ],
  severity_up: [
    (c) => `Attention${c.post}. The severity of ${c.k} has been raised to ${c.to}. ${c.sum}.`,
    (c) => `${c.pre}${c.k} is now rated ${c.to}. That is a step up in seriousness.`,
  ],
  severity_down: [
    (c) => `${c.pre}the severity of ${c.k} has changed to ${c.to}. Marginally less alarming.`,
    (c) => `${c.k} has been re-rated ${c.to}${c.post}. ${c.sum}.`,
  ],
  reopened: [
    (c) => `Well${c.post}. ${c.k} is back from the dead. The issue has been reopened.`,
    (c) => `${c.pre}${c.k} has returned. ${c.sum}. It seems the fix did not hold.`,
    (c) => `${c.pre}a familiar face. ${c.k} has been reopened by ${c.who}.`,
  ],
  resolved: [
    (c) => `Excellent work${c.post}. ${c.k} has been marked as resolved. One less problem on the board.`,
    (c) => `${c.pre}${c.k} is resolved. ${c.sum}. Well done.`,
    (c) => `${c.k} has been resolved${c.post}. The board looks a little tidier.`,
  ],
  closed: [
    (c) => `Mission accomplished${c.post}. ${c.k} is officially closed.`,
    (c) => `${c.pre}${c.k} is closed. ${c.sum}. That is one for the record books.`,
    (c) => `Case closed${c.post}. ${c.k} has been put to rest.`,
  ],
  reassigned_away: [
    (c) => `${c.pre}${c.k} has been reassigned to ${c.to}. One less thing on your plate.`,
    (c) => `${c.k} is no longer yours${c.post}. It now belongs to ${c.to}. ${c.sum}.`,
  ],
  unassigned: [
    (c) => `${c.pre}${c.k} has been unassigned. It is currently nobody's problem.`,
    (c) => `${c.k} was released back to the pool${c.post}. ${c.sum}.`,
  ],
  updated: [(c) => `${c.pre}${c.k} has been updated. ${c.sum}.`],
};

export function templateKey(e: Pick<JarvisEvent, 'type' | 'escalated'>, count = 1): string {
  if (e.type === 'comment' && count > 1) return 'comment_many';
  if (e.type === 'priority') return e.escalated ? 'priority_up' : 'priority_down';
  if (e.type === 'severity') return e.escalated ? 'severity_up' : 'severity_down';
  return e.type;
}

/** Remembers the last variation used per template so consecutive messages differ. */
const lastPick = new Map<string, number>();
export function pickVariant(list: T[], key: string, rng: () => number): T {
  if (list.length === 1) return list[0] as T;
  let i = Math.floor(rng() * list.length);
  if (i === lastPick.get(key)) i = (i + 1) % list.length;
  lastPick.set(key, i);
  return list[i] as T;
}

function ctxOf(e: JarvisEvent, prefs: JarvisPrefs, now: Date, n = 1): C {
  const addr = prefs.address;
  return {
    key: e.key,
    k: spokenKey(e.key),
    sum: spokenSummary(e.summary),
    pre: addr ? `${capFirst(addr)}, ` : '',
    post: addr ? `, ${addr}` : '',
    greet: greeting(now),
    who: e.actor ?? 'Someone',
    from: e.from ?? 'its previous state',
    to: e.to ?? 'a new state',
    n,
  };
}

/** One event as speech. */
export function speechFor(e: JarvisEvent, prefs: JarvisPrefs, now = new Date(), rng: () => number = Math.random, count = 1): string {
  const tk = templateKey(e, count);
  const list = TEMPLATES[tk] ?? (TEMPLATES['updated'] as T[]);
  return capFirst(pickVariant(list, tk, rng)(ctxOf(e, prefs, now, count)).replace(/\s+/g, ' ').trim());
}

/** Text shown in a desktop notification. Always names the issue and includes its summary. */
export function notificationFor(e: JarvisEvent, count = 1): { title: string; body: string } {
  const who = e.actor ? ` · ${e.actor}` : '';
  switch (e.type) {
    case 'assigned': return { title: `${e.key} assigned to you`, body: e.summary };
    case 'status': return { title: `${e.key}: ${e.from ?? '?'} → ${e.to ?? '?'}`, body: e.summary + who };
    case 'comment': return { title: count > 1 ? `${e.key}: ${count} new comments` : `${e.key}: new comment${who}`, body: e.detail || e.summary };
    case 'priority': return { title: `${e.key}: priority ${e.escalated ? 'raised' : 'lowered'} to ${e.to ?? '?'}`, body: e.summary };
    case 'severity': return { title: `${e.key}: severity ${e.escalated ? 'raised' : 'changed'} to ${e.to ?? '?'}`, body: e.summary };
    case 'reopened': return { title: `${e.key} was reopened`, body: e.summary + who };
    case 'resolved': return { title: `${e.key} resolved`, body: e.summary + who };
    case 'closed': return { title: `${e.key} closed`, body: e.summary + who };
    case 'reassigned_away': return { title: `${e.key} reassigned to ${e.to ?? 'someone else'}`, body: e.summary };
    case 'unassigned': return { title: `${e.key} unassigned`, body: e.summary };
    default: return { title: `${e.key} updated`, body: `${e.summary}${e.detail ? ` (${e.detail})` : ''}` };
  }
}

// ------------------------------------------------------------------ policy

/** "22:00" to "08:00" wraps over midnight. */
export function inQuietHours(q: JarvisPrefs['quiet'], d: Date): boolean {
  if (!q.on) return false;
  const mins = (s: string): number => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const now = d.getHours() * 60 + d.getMinutes(), a = mins(q.from), b = mins(q.to);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

const RANK: Record<JarvisEvent['importance'], number> = { high: 0, normal: 1, low: 2 };
const isImportant = (e: JarvisEvent): boolean => e.importance === 'high' || e.type === 'resolved' || e.type === 'closed';

export interface Announcement {
  /** Events covered by this announcement, newest last. */
  events: JarvisEvent[];
  title: string;
  body: string;
  speech: string | null;
  notify: boolean;
  /** Highest importance among the events. */
  importance: JarvisEvent['importance'];
}

/**
 * Turns a burst of events (normally one sync's worth) into the announcements to make.
 *  - own actions, disabled types and quiet hours produce nothing
 *  - the same type on the same bug collapses into one ("3 new comments")
 *  - up to two events are spoken one by one; three or more become a single briefing
 *  - low-importance events are never spoken
 */
export function plan(batch: JarvisEvent[], prefs: JarvisPrefs, now = new Date(), rng: () => number = Math.random): Announcement[] {
  if (inQuietHours(prefs.quiet, now)) return [];
  let evs = batch.filter((e) => !e.own && prefs.types[e.type]);
  if (prefs.frequency === 'important') evs = evs.filter(isImportant);
  if (!evs.length) return [];

  // collapse repeats (same bug + same type): keep the latest, remember how many
  const groups = new Map<string, JarvisEvent[]>();
  for (const e of evs) {
    const k = `${e.key}|${e.type}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const items = [...groups.values()].map((g) => ({ e: g[g.length - 1] as JarvisEvent, n: g.length, all: g }));
  items.sort((a, b) => RANK[a.e.importance] - RANK[b.e.importance] || Date.parse(a.e.occurredAt) - Date.parse(b.e.occurredAt));

  const speakable = items.filter((i) => i.e.importance !== 'low');
  const digest = prefs.frequency === 'digest' ? speakable.length >= 2 : speakable.length >= 3;
  const out: Announcement[] = [];

  const speakIndividually = !digest;
  items.forEach((it, idx) => {
    const n = notificationFor(it.e, it.n);
    const overflowNotify = items.length > 3 && idx >= 2;
    out.push({
      events: it.all,
      title: n.title,
      body: n.body,
      speech: speakIndividually && it.e.importance !== 'low' ? speechFor(it.e, prefs, now, rng, it.n) : null,
      notify: !overflowNotify,
      importance: it.e.importance,
    });
  });

  if (items.length > 3) {
    const rest = items.slice(2);
    out.push({ events: rest.flatMap((r) => r.all), title: `${rest.length} more updates on your bugs`, body: rest.map((r) => r.e.key).join(', '), speech: null, notify: true, importance: 'normal' });
  }
  if (digest) {
    out.push({
      events: speakable.flatMap((i) => i.all),
      title: 'JARVIS briefing',
      body: speakable.map((i) => i.e.key).join(', '),
      speech: briefing(speakable.map((i) => i.e), prefs, now),
      notify: false,
      importance: speakable.some((i) => i.e.importance === 'high') ? 'high' : 'normal',
    });
  }
  // notifications first (in importance order), then the spoken briefing
  return out.filter((a) => a.notify || a.speech);
}

const PLURAL: Partial<Record<JarvisEventType, [string, string]>> = {
  assigned: ['new assignment', 'new assignments'], comment: ['new comment', 'new comments'], status: ['status change', 'status changes'],
  priority: ['priority change', 'priority changes'], severity: ['severity change', 'severity changes'], reopened: ['reopened bug', 'reopened bugs'],
  resolved: ['resolved bug', 'resolved bugs'], closed: ['closed bug', 'closed bugs'], reassigned_away: ['reassignment', 'reassignments'], unassigned: ['unassignment', 'unassignments'],
};

/** "Sir, a briefing. Five updates across three bugs: two new comments, one reopened bug..." */
export function briefing(evs: JarvisEvent[], prefs: JarvisPrefs, now: Date): string {
  const pre = prefs.address ? `${capFirst(prefs.address)}, ` : '';
  const bugs = new Set(evs.map((e) => e.key));
  const counts = new Map<JarvisEventType, number>();
  for (const e of evs) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => RANK[evs.find((e) => e.type === a[0])?.importance ?? 'normal'] - RANK[evs.find((e) => e.type === b[0])?.importance ?? 'normal'])
    .slice(0, 4)
    .map(([t, n]) => `${n} ${(PLURAL[t] ?? ['update', 'updates'])[n === 1 ? 0 : 1]}`);
  const top = [...evs].sort((a, b) => RANK[a.importance] - RANK[b.importance])[0] as JarvisEvent;
  const topText = ` Most notable: ${spokenKey(top.key)}, ${top.type === 'assigned' ? 'newly assigned' : (EVENT_LABEL[top.type] ?? 'updated').toLowerCase()}.`;
  void now;
  return `${pre}a quick briefing. ${evs.length} updates across ${bugs.size} ${bugs.size === 1 ? 'bug' : 'bugs'}: ${parts.join(', ')}.${topText}`;
}

/** Spoken when the app opens and finds things that happened while it was closed. */
export function welcomeBack(evs: JarvisEvent[], prefs: JarvisPrefs, now: Date, name?: string): string | null {
  const real = evs.filter((e) => !e.own && e.importance !== 'low' && prefs.types[e.type]);
  if (!real.length) return null;
  const who = prefs.address || name || '';
  const bugs = new Set(real.map((e) => e.key));
  const assigned = real.filter((e) => e.type === 'assigned').length;
  const extra = assigned ? ` ${assigned} ${assigned === 1 ? 'is a new assignment' : 'are new assignments'}.` : '';
  return `${greeting(now)}${who ? `, ${who}` : ''}. While you were away, ${real.length} ${real.length === 1 ? 'thing' : 'things'} happened across ${bugs.size} of your ${bugs.size === 1 ? 'bug' : 'bugs'}.${extra}`;
}

/** One-line description for lists and history. */
export function describeEvent(e: JarvisEvent): string {
  const by = e.actor ? ` by ${e.actor}` : '';
  switch (e.type) {
    case 'assigned': return `Assigned to you${by}`;
    case 'reassigned_away': return `Reassigned to ${e.to ?? 'someone else'}`;
    case 'unassigned': return 'Unassigned';
    case 'status': return `Status ${e.from ?? '?'} → ${e.to ?? '?'}${by}`;
    case 'reopened': return `Reopened${by}`;
    case 'resolved': return `Resolved${by}`;
    case 'closed': return `Closed${by}`;
    case 'comment': return `New comment${by}`;
    case 'priority': return `Priority ${e.escalated ? 'raised' : 'lowered'} to ${e.to ?? '?'}${by}`;
    case 'severity': return `Severity ${e.escalated ? 'raised' : 'changed'} to ${e.to ?? '?'}${by}`;
    default: return `Updated${e.detail ? `: ${e.detail}` : ''}${by}`;
  }
}
