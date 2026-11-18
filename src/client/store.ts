// Everything the app remembers lives in this browser's localStorage. Nothing is sent anywhere.

import type { BugsResponse, JarvisEvent, JarvisServerPrefs, MyBugsResponse } from '../shared/types.js';
import { DEFAULT_JARVIS_PREFS, type JarvisPrefs } from './jarvis-core.js';

const P = 'jbd.v1.';
let ns = '';
/** Separates sample data from real data. Preferences are shared. */
export const setNamespace = (n: string): void => void (ns = n);
const K = (k: string): string => P + (k === 'prefs' || k === 'jarvis' || k === 'view' ? '' : ns) + k;

function read<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(K(k));
    return raw == null ? fallback : ({ ...(typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}), ...JSON.parse(raw) } as T);
  } catch {
    return fallback;
  }
}
function readRaw<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(K(k));
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(k: string, v: unknown): boolean {
  try {
    localStorage.setItem(K(k), JSON.stringify(v));
    return true;
  } catch {
    return false; // storage full or blocked; the app keeps working without persistence
  }
}

// ---- preferences
export type ThemeName = 'system' | 'light' | 'paper' | 'dark' | 'midnight';
export type Accent = 'blue' | 'violet' | 'teal' | 'rose' | 'orange';
export type ColumnId = 'summary' | 'status' | 'severity' | 'priority' | 'reporter' | 'assignee' | 'created' | 'age' | 'updated';

export interface Prefs {
  theme: ThemeName;
  accent: Accent;
  chartsOpen: boolean;
  autoRefreshMin: number;
  /** Open bugs older than this many days show as "warning" (amber). */
  warnDays: number;
  /** Open bugs older than this many days show as "critical" (red). */
  critDays: number;
  /** Open bugs not updated for this many days get a "stale" marker. */
  staleDays: number;
  hiddenColumns: ColumnId[];
}
export const DEFAULT_PREFS: Prefs = {
  theme: 'system', accent: 'blue', chartsOpen: true, autoRefreshMin: 0,
  warnDays: 3, critDays: 7, staleDays: 5, hiddenColumns: [],
};
export const loadPrefs = (): Prefs => read('prefs', DEFAULT_PREFS);
export const savePrefs = (p: Prefs): boolean => write('prefs', p);

// ---- tracked issues (the dashboards)
export interface Tracked {
  key: string;
  title?: string;
  addedAt: string;
}
export const loadTracked = (): Tracked[] => readRaw<Tracked[]>('tracked', []);
export const saveTracked = (t: Tracked[]): boolean => write('tracked', t);
export const loadActive = (): string | null => readRaw<string | null>('active', null);
export const saveActive = (k: string | null): boolean => write('active', k);

// ---- filters, per tracked issue
export type SortCol = 'key' | 'summary' | 'status' | 'severity' | 'priority' | 'reporter' | 'assignee' | 'created' | 'age' | 'updated';
export interface Filters {
  q: string;
  status: string[];
  severity: string[];
  priority: string[];
  assignee: string[];
  openOnly: boolean;
  starred: boolean;
  changed: boolean;
  stale: boolean;
  overdue: boolean;
  sort: SortCol;
  dir: 1 | -1;
}
export const DEFAULT_FILTERS: Filters = {
  q: '', status: [], severity: [], priority: [], assignee: [],
  openOnly: false, starred: false, changed: false, stale: false, overdue: false,
  sort: 'age', dir: -1,
};
export const loadFilters = (key: string): Filters => read(`filters.${key}`, DEFAULT_FILTERS);
export const saveFilters = (key: string, f: Filters): boolean => write(`filters.${key}`, f);

// ---- markers
export const loadStars = (key: string): string[] => readRaw<string[]>(`stars.${key}`, []);
export const saveStars = (key: string, s: string[]): boolean => write(`stars.${key}`, s);

/** The state the user last acknowledged. NEW / UPDATED markers compare against it. */
export interface Baseline {
  at: string;
  /** bug key -> `updated` timestamp when it was acknowledged */
  seen: Record<string, string>;
}
export const loadBaseline = (key: string): Baseline | null => readRaw<Baseline | null>(`baseline.${key}`, null);
export const saveBaseline = (key: string, b: Baseline): boolean => write(`baseline.${key}`, b);

// ---- offline cache of the last successful fetch
export const loadCache = (key: string): BugsResponse | null => readRaw<BugsResponse | null>(`cache.${key}`, null);
export const saveCache = (key: string, d: BugsResponse): boolean => write(`cache.${key}`, d);

/** Removes everything this app stored, or only the data of one tracked issue. */
export function clearData(key?: string): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(P) && (!key || k.endsWith(`.${key}`))) doomed.push(k);
  }
  doomed.forEach((k) => localStorage.removeItem(k));
}

// ---- JARVIS (assistant preferences are shared by demo and real mode)
export function loadJarvisPrefs(): JarvisPrefs {
  const d = DEFAULT_JARVIS_PREFS;
  const raw = readRaw<Partial<JarvisPrefs>>('jarvis', {});
  return { ...d, ...raw, types: { ...d.types, ...raw.types }, quiet: { ...d.quiet, ...raw.quiet } };
}
export const saveJarvisPrefs = (p: JarvisPrefs): boolean => write('jarvis', p);

/** Highest event id this browser has already announced or reviewed. */
export const loadAnnounced = (): number => readRaw<number>('jarvis.announced', 0);
export const saveAnnounced = (n: number): boolean => write('jarvis.announced', n);

// Demo mode has no server, so the simulated assistant keeps its history and switches here.
export const loadDemoEvents = (): JarvisEvent[] => readRaw<JarvisEvent[]>('jarvis.events', []);
export const saveDemoEvents = (e: JarvisEvent[]): boolean => write('jarvis.events', e.slice(-200));
export const DEFAULT_SIM: JarvisServerPrefs = { enabled: true, paused: false, intervalSec: 60, osNotify: false, closedWindowDays: 90 };
export const loadSim = (): JarvisServerPrefs => ({ ...DEFAULT_SIM, ...readRaw<Partial<JarvisServerPrefs>>('jarvis.sim', {}) });
export const saveSim = (p: JarvisServerPrefs): boolean => write('jarvis.sim', p);

// ---- For You
export type FySort = 'key' | 'summary' | 'project' | 'status' | 'severity' | 'priority' | 'reporter' | 'created' | 'updated' | 'age';
export interface FyFilters {
  q: string;
  status: string[];
  project: string[];
  priority: string[];
  severity: string[];
  openOnly: boolean;
  blocked: boolean;
  stale: boolean;
  recentAssigned: boolean;
  recentUpdated: boolean;
  inProgress: boolean;
  closedOnly: boolean;
  sort: FySort;
  dir: 1 | -1;
}
export const DEFAULT_FY: FyFilters = {
  q: '', status: [], project: [], priority: [], severity: [], openOnly: true, blocked: false, stale: false,
  recentAssigned: false, recentUpdated: false, inProgress: false, closedOnly: false, sort: 'updated', dir: -1,
};
export const loadFy = (): FyFilters => ({ ...DEFAULT_FY, ...readRaw<Partial<FyFilters>>('fy.filters', {}) });
export const saveFy = (f: FyFilters): boolean => write('fy.filters', f);
export const loadMineCache = (): MyBugsResponse | null => readRaw<MyBugsResponse | null>('fy.cache', null);
export const saveMineCache = (d: MyBugsResponse): boolean => write('fy.cache', d);

export type ViewName = 'epics' | 'foryou';
export const loadView = (): ViewName => (readRaw<string>('view', 'epics') === 'foryou' ? 'foryou' : 'epics');
export const saveView = (v: ViewName): boolean => write('view', v);
