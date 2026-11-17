import type { Bug } from '../shared/types.js';
import { DAY } from './util.js';
import type { Baseline, Filters, Prefs, SortCol } from './store.js';

export const isDone = (b: Bug): boolean => b.statusCategory === 'done';

/** Open: time since created. Closed: time it took to close. */
export function ageMs(b: Bug, now = Date.now()): number {
  const end = isDone(b) ? new Date(b.resolved ?? b.updated).getTime() : now;
  return end - new Date(b.created).getTime();
}

export type Level = 'ok' | 'warn' | 'crit' | 'done';
export function ageLevel(b: Bug, p: Prefs, now = Date.now()): Level {
  if (isDone(b)) return 'done';
  const d = ageMs(b, now) / DAY;
  return d >= p.critDays ? 'crit' : d >= p.warnDays ? 'warn' : 'ok';
}

export const isStale = (b: Bug, p: Prefs, now = Date.now()): boolean =>
  !isDone(b) && (now - new Date(b.updated).getTime()) / DAY >= p.staleDays;

export const isOverdue = (b: Bug, p: Prefs, now = Date.now()): boolean => !isDone(b) && ageLevel(b, p, now) === 'crit';

export type Change = 'new' | 'updated' | null;
export function changeOf(b: Bug, base: Baseline | null): Change {
  if (!base) return null;
  const seen = base.seen[b.key];
  if (seen === undefined) return 'new';
  return seen !== b.updated ? 'updated' : null;
}

export const makeBaseline = (bugs: Bug[]): Baseline => ({
  at: new Date().toISOString(),
  seen: Object.fromEntries(bugs.map((b) => [b.key, b.updated])),
});

// ---- colours (CSS variables, so themes can restyle them)
const STATUS_COLORS: [RegExp, string][] = [
  [/retest\s*fail|reopen/i, 'var(--red)'],
  [/need.*info|blocked|hold/i, 'var(--orange)'],
  [/retest|ready\s*to\s*merge|qa|test|review/i, 'var(--teal)'],
  [/bug\s*fix|fixed|dev\s*done/i, 'var(--purple)'],
  [/progress/i, 'var(--yellow)'],
  [/closed|done|resolved|complete/i, 'var(--green)'],
];
export function statusColor(status: string, category?: string): string {
  for (const [re, c] of STATUS_COLORS) if (re.test(status)) return c;
  if (category === 'done') return 'var(--green)';
  if (category === 'indeterminate') return 'var(--accent)';
  return 'var(--grey)';
}
export function severityColor(sev: string | null | undefined): string {
  if (!sev) return 'var(--grey)';
  if (/\b1\b|critical|blocker|highest|sev\s*1/i.test(sev)) return 'var(--red)';
  if (/\b2\b|major|high/i.test(sev)) return 'var(--orange)';
  if (/\b3\b|medium|moderate/i.test(sev)) return 'var(--yellow)';
  return 'var(--accent)';
}

// ---- grouping
export function countBy<T>(list: T[], fn: (x: T) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) {
    const k = fn(x) || '—';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
export const assigneeOf = (b: Bug): string => b.assignee?.name ?? 'Unassigned';
export const severityLabel = (b: Bug): string => b.severity ?? '—';
export const priorityLabel = (b: Bug): string => b.priority ?? '—';

export const AGE_BUCKETS: { label: string; max: number }[] = [
  { label: '< 1d', max: 1 }, { label: '1–3d', max: 3 }, { label: '3–7d', max: 7 },
  { label: '1–2w', max: 14 }, { label: '2–4w', max: 30 }, { label: '30d+', max: Infinity },
];
export function ageHistogram(open: Bug[], now = Date.now()): { label: string; n: number }[] {
  const out = AGE_BUCKETS.map((b) => ({ label: b.label, n: 0 }));
  for (const b of open) {
    const d = ageMs(b, now) / DAY;
    const i = AGE_BUCKETS.findIndex((x) => d < x.max);
    (out[i] as { n: number }).n++;
  }
  return out;
}

export interface TrendPoint {
  label: string;
  created: number;
  resolved: number;
  open: number;
}
/** Weekly created vs resolved counts plus the open backlog at the end of each week. */
export function trend(bugs: Bug[], now = Date.now()): TrendPoint[] {
  if (!bugs.length) return [];
  const weekStart = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    return d.getTime();
  };
  const resolvedAt = (b: Bug): number | null => (isDone(b) ? new Date(b.resolved ?? b.updated).getTime() : null);
  const first = Math.min(...bugs.map((b) => new Date(b.created).getTime()));
  let start = weekStart(first);
  const end = weekStart(now);
  // Keep the chart readable: at most the last 26 weeks, earlier bugs count towards the opening backlog.
  const maxWeeks = 26;
  start = Math.max(start, end - (maxWeeks - 1) * 7 * DAY);
  const points: TrendPoint[] = [];
  for (let t = start; t <= end; ) {
    const next = new Date(t);
    next.setDate(next.getDate() + 7);
    const hi = next.getTime();
    let created = 0, resolved = 0, open = 0;
    for (const b of bugs) {
      const c = new Date(b.created).getTime();
      const r = resolvedAt(b);
      if (c >= t && c < hi) created++;
      if (r !== null && r >= t && r < hi) resolved++;
      if (c < hi && (r === null || r >= hi)) open++;
    }
    points.push({ label: new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), created, resolved, open });
    t = hi;
  }
  return points;
}

// ---- filtering and sorting
export interface Ctx {
  prefs: Prefs;
  baseline: Baseline | null;
  stars: Set<string>;
  now: number;
}

export function applyFilters(bugs: Bug[], f: Filters, c: Ctx): Bug[] {
  const q = f.q.trim().toLowerCase();
  const pass = (sel: string[], v: string): boolean => !sel.length || sel.includes(v);
  return bugs.filter(
    (b) =>
      pass(f.status, b.status) &&
      pass(f.severity, severityLabel(b)) &&
      pass(f.priority, priorityLabel(b)) &&
      pass(f.assignee, assigneeOf(b)) &&
      (!f.openOnly || !isDone(b)) &&
      (!f.starred || c.stars.has(b.key)) &&
      (!f.changed || changeOf(b, c.baseline) !== null) &&
      (!f.stale || isStale(b, c.prefs, c.now)) &&
      (!f.overdue || isOverdue(b, c.prefs, c.now)) &&
      (!q || [b.key, b.summary, b.reporter?.name, b.assignee?.name, b.status, b.severity, b.priority].some((x) => (x ?? '').toLowerCase().includes(q)))
  );
}

const sevRank = (s: string | null): number => {
  const m = /\d+/.exec(s ?? '');
  return m ? Number(m[0]) : 99;
};
const sortVal: Record<SortCol, (b: Bug, now: number) => string | number> = {
  key: (b) => Number(b.key.split('-')[1]),
  summary: (b) => b.summary.toLowerCase(),
  status: (b) => b.status.toLowerCase(),
  severity: (b) => sevRank(b.severity),
  priority: (b) => b.priority ?? '~',
  reporter: (b) => b.reporter?.name ?? '~',
  assignee: (b) => b.assignee?.name ?? '~',
  created: (b) => b.created,
  updated: (b) => b.updated,
  age: (b, now) => (isDone(b) ? -1e15 : 0) + ageMs(b, now),
};
export function sortBugs(bugs: Bug[], col: SortCol, dir: 1 | -1, now = Date.now()): Bug[] {
  const val = sortVal[col];
  return [...bugs].sort((a, b) => {
    const x = val(a, now), y = val(b, now);
    return (x < y ? -1 : x > y ? 1 : a.key.localeCompare(b.key)) * dir;
  });
}
