// Deterministic sample data for the hosted demo. No network, no real Jira data.

import type { Bug, BugsResponse, Person, StatusCategory } from '../shared/types.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

const PEOPLE: Person[] = ['Ava Chen', 'Noah Patel', 'Mia Rossi', 'Liam Okafor', 'Zoe Müller', 'Ethan Park'].map((name) => ({
  name,
  email: null,
}));
const STATUSES: [string, StatusCategory][] = [
  ['Open', 'new'], ['In Progress', 'indeterminate'], ['Need Info', 'indeterminate'], ['Bug Fixed', 'indeterminate'],
  ['Retest', 'indeterminate'], ['Retest Failed', 'indeterminate'], ['Closed', 'done'], ['Closed', 'done'], ['Closed', 'done'],
];
const SEVERITIES = ['1 - Critical', '2 - Major', '2 - Major', '3 - Medium', '3 - Medium', '4 - Minor'];
const PRIORITIES = ['Highest', 'High', 'High', 'Medium', 'Medium', 'Low'];
const RELATIONS = ['child of', 'relates to', 'is blocked by', 'created by', 'child of'];
const AREAS = ['Login', 'Checkout', 'Search', 'Profile', 'Notifications', 'Export', 'Settings', 'Upload', 'Sync', 'Dashboard'];
const PROBLEMS = [
  'crashes on submit', 'shows wrong total', 'times out after 30s', 'does not save changes', 'layout breaks on mobile',
  'returns 500 for empty input', 'loses state after refresh', 'duplicates entries', 'is slow with large data',
  'displays stale values', 'fails silently', 'misaligned in dark mode',
];

export function demoBugs(key: string): BugsResponse {
  const r = rng(hash(key));
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
  const now = Date.now();
  const prefix = key.split('-')[0] ?? 'DEMO';
  const base = 100 + Math.floor(r() * 800);
  const count = 48 + Math.floor(r() * 30);
  const bugs: Bug[] = [];
  for (let i = 0; i < count; i++) {
    const [status, cat] = pick(STATUSES);
    const created = now - Math.floor(r() ** 1.4 * 84 * 864e5) - 36e5;
    const open = cat !== 'done';
    const updated = open ? Math.min(now, created + Math.floor(r() * (now - created))) : Math.min(now, created + Math.floor((0.2 + r() * 12) * 864e5));
    const bugKey = `${prefix}-${base + i * 3}`;
    bugs.push({
      key: bugKey,
      url: `https://jira.example.com/browse/${bugKey}`,
      summary: `${pick(AREAS)} ${pick(PROBLEMS)}`,
      type: 'Bug',
      status,
      statusCategory: cat,
      priority: pick(PRIORITIES),
      severity: pick(SEVERITIES),
      reporter: pick(PEOPLE),
      assignee: r() < 0.12 ? null : pick(PEOPLE),
      created: new Date(created).toISOString(),
      updated: new Date(updated).toISOString(),
      resolved: open ? null : new Date(updated).toISOString(),
      relation: pick(RELATIONS),
    });
  }
  bugs.sort((a, b) => b.created.localeCompare(a.created));
  return {
    parent: {
      key,
      url: `https://jira.example.com/browse/${key}`,
      summary: 'Sample epic: Customer portal revamp (demo data)',
      status: 'In Progress',
      type: 'Epic',
    },
    bugs,
    severityFieldsUsed: [],
    jql: '(demo data, no query was run)',
    fetchedAt: new Date().toISOString(),
  };
}
