// Deterministic sample data for the hosted demo. No network, no real Jira data.

import type { Bug, BugsResponse, IssueDetail, JarvisEvent, JarvisEventType, MyBug, MyBugsResponse, Person, StatusCategory } from '../shared/types.js';

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

// ---------------------------------------------------------------- For You (sample data)

const PROJECTS: [string, string][] = [['PAY', 'Payments'], ['WEB', 'Web Portal'], ['MOB', 'Mobile App'], ['API', 'Platform API']];
const PARENTS = ['Checkout revamp', 'Q4 stability push', 'Onboarding v2', 'Reporting overhaul'];
const ME: Person = { name: 'Demo User', email: null };

/** Same sample bugs on every call within a session, so the list does not reshuffle on refresh. */
export function demoMine(): MyBugsResponse {
  const r = rng(424242);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
  const now = Date.now();
  const bugs: MyBug[] = [];
  for (let i = 0; i < 34; i++) {
    const [pk, pn] = pick(PROJECTS);
    const [status, cat] = pick(STATUSES);
    const open = cat !== 'done';
    const created = now - Math.floor(r() ** 1.5 * 70 * 864e5) - 36e5;
    const updated = open ? Math.min(now, created + Math.floor(r() ** 0.7 * (now - created))) : Math.min(now, created + Math.floor((0.3 + r() * 9) * 864e5));
    const key = `${pk}-${200 + i * 7}`;
    const blocked = open && r() < 0.12;
    bugs.push({
      key, url: `https://jira.example.com/browse/${key}`, summary: `${pick(AREAS)} ${pick(PROBLEMS)}`, type: 'Bug',
      status: blocked ? 'Blocked' : status, statusCategory: blocked ? 'indeterminate' : cat, priority: pick(PRIORITIES), severity: pick(SEVERITIES),
      reporter: pick(PEOPLE), assignee: ME, created: new Date(created).toISOString(), updated: new Date(updated).toISOString(),
      resolved: open ? null : new Date(updated).toISOString(), relation: 'assigned to me',
      project: { key: pk, name: pn }, parent: r() < 0.7 ? { key: `${pk}-${10 + Math.floor(r() * 5)}`, summary: pick(PARENTS), type: 'Epic' } : null,
      labels: r() < 0.3 ? ['regression'] : [], blocked, blockedReason: blocked ? 'Blocked by PAY-77' : null,
      recentlyAssigned: now - created < 7 * 864e5 && r() < 0.8,
      lastActivity: r() < 0.7 ? { at: new Date(updated).toISOString(), label: pick(['Status: Open → In Progress', 'Comment by Noah Patel', 'Priority raised to High', 'Assigned to you by Ava Chen', 'Reopened by Mia Rossi']) } : null,
    });
  }
  bugs.sort((a, b) => b.updated.localeCompare(a.updated));
  return { me: ME, bugs, jql: '(demo data, no query was run)', truncated: false, recentlyAssignedSource: 'created', fetchedAt: new Date().toISOString() };
}

export function demoDetail(key: string, from?: MyBug): IssueDetail {
  const r = rng(hash(key));
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
  const base = from ?? demoMine().bugs.find((b) => b.key === key) ?? demoMine().bugs[0] as MyBug;
  const t0 = Date.parse(base.created), t1 = Date.parse(base.updated);
  const at = (f: number): string => new Date(t0 + (t1 - t0) * f).toISOString();
  return {
    key: base.key, url: base.url, summary: base.summary, status: base.status, statusCategory: base.statusCategory, priority: base.priority,
    severity: base.severity, project: base.project, assignee: base.assignee, reporter: base.reporter, created: base.created, updated: base.updated,
    resolved: base.resolved, parent: base.parent ? { key: base.parent.key, summary: base.parent.summary, url: `https://jira.example.com/browse/${base.parent.key}` } : null,
    labels: base.labels,
    description: `Steps to reproduce\n1. Open the ${pick(AREAS).toLowerCase()} screen.\n2. Trigger the action twice in a row.\n\nExpected: it works.\nActual: ${base.summary.toLowerCase()}.\n\n(This is generated sample text.)`,
    comments: [
      { id: '3', author: pick(PEOPLE).name, created: at(0.9), body: 'I can reproduce this on the latest build. Attaching logs shortly.' },
      { id: '2', author: pick(PEOPLE).name, created: at(0.5), body: 'Looks related to the recent refactor. Could you take a look?' },
      { id: '1', author: base.reporter?.name ?? 'Someone', created: at(0.05), body: 'Found this during regression testing.' },
    ],
    history: [
      { id: 'h3', author: pick(PEOPLE).name, created: at(0.95), items: [{ field: 'status', from: 'Open', to: base.status }] },
      { id: 'h2', author: pick(PEOPLE).name, created: at(0.4), items: [{ field: 'priority', from: 'Medium', to: base.priority }] },
      { id: 'h1', author: base.reporter?.name ?? 'Someone', created: at(0.02), items: [{ field: 'assignee', from: null, to: 'Demo User' }] },
    ],
    links: base.blocked ? [{ relation: 'is blocked by', key: 'PAY-77', summary: 'Payment gateway upgrade', status: 'In Progress', url: 'https://jira.example.com/browse/PAY-77' }] : [],
  };
}

let simId = 0;
/** A believable event for the assistant to announce, built from one of the user's open bugs. */
export function simulateEvent(type: JarvisEventType, bugs: MyBug[], rnd: () => number = Math.random): JarvisEvent {
  const pool = bugs.filter((b) => b.statusCategory !== 'done');
  const b = (pool.length ? pool : bugs)[Math.floor(rnd() * (pool.length || bugs.length))] as MyBug;
  const actor = (PEOPLE[Math.floor(rnd() * PEOPLE.length)] as Person).name;
  const nowIso = new Date().toISOString();
  const e: JarvisEvent = {
    id: -(Date.now() * 10 + (++simId % 10)), type, at: nowIso, occurredAt: nowIso, key: b.key, summary: b.summary, project: b.project.key, url: b.url,
    actor, from: null, to: null, detail: null, escalated: false, importance: 'normal', own: false, read: false, simulated: true,
  };
  switch (type) {
    case 'assigned': e.importance = 'high'; break;
    case 'status': e.from = b.status; e.to = 'In Progress'; break;
    case 'comment': e.detail = 'Could you take a look at this when you get a chance?'; break;
    case 'priority': e.from = 'Medium'; e.to = 'Highest'; e.escalated = true; e.importance = 'high'; break;
    case 'severity': e.from = '3 - Medium'; e.to = '1 - Critical'; e.escalated = true; e.importance = 'high'; break;
    case 'reopened': e.from = 'Closed'; e.to = 'Reopened'; e.importance = 'high'; break;
    case 'resolved': e.from = 'In Progress'; e.to = 'Done'; break;
    case 'closed': e.from = 'Done'; e.to = 'Closed'; break;
    case 'reassigned_away': e.to = 'Noah Patel'; break;
    case 'updated': e.detail = 'description'; e.importance = 'low'; break;
    default: break;
  }
  return e;
}
