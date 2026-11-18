// Runtime-agnostic Jira Cloud logic shared by the Local edition (Node server) and the Cloud edition
// (Cloudflare Worker). Only web-standard APIs are used here: no Node built-ins, no Buffer, no fs.
// Each edition supplies a `JiraApi` that knows how to authenticate and where to send requests.

import type { Bug, BugsResponse, IssueDetail, MyBug, MyBugsResponse, Person, StatusCategory } from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any; // Jira payloads are large and vary per site; only the fields read below matter.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number
  ) {
    super(message);
  }
}

export interface JiraApi {
  /** Base URL people open issues on, e.g. https://acme.atlassian.net (no trailing slash). */
  siteUrl: string;
  /** Stable key for per-site caches. */
  cacheKey: string;
  /** Calls a Jira REST path such as `/rest/api/3/myself`. Throws HttpError on failure. */
  request(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<Json>;
}

// ------------------------------------------------------------------ small helpers

export const split = (s: string): string[] =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Jira sends "+0530"; Safari only parses "+05:30". Normalise so every browser can read the dates. */
export const iso = (s: string | null | undefined): string => (s ? s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '');

/** Issue types as a JQL list. Quotes and backslashes are stripped so user input cannot break out of the string. */
export const typesJql = (issueTypes: string): string =>
  split(issueTypes)
    .map((t) => `"${t.replace(/["\\]/g, '')}"`)
    .join(',');

export const userOf = (u: Json): Person | null => (u ? { name: u.displayName, email: u.emailAddress || null } : null);

export function severityOf(fields: Json, ids: string[]): string | null {
  for (const id of ids) {
    const v = fields[id];
    if (v == null) continue;
    if (typeof v === 'string') return v;
    if (v.value) return v.value;
    if (v.name) return v.name;
  }
  return null;
}

/** Field names or ids from settings -> field ids, using a list of `{ id, name }` from Jira. */
export function matchSeverityFields(wantedCsv: string, all: { id: string; name: string }[]): string[] {
  const ids: string[] = [];
  for (const w of split(wantedCsv)) {
    if (/^customfield_\d+$/.test(w)) ids.push(w);
    else ids.push(...all.filter((f) => String(f.name).toLowerCase() === w.toLowerCase()).map((f) => f.id));
  }
  return [...new Set(ids)];
}

export function mapBug(api: JiraApi, i: Json, severityIds: string[], relation: string): Bug {
  const f = i.fields;
  return {
    key: i.key,
    url: `${api.siteUrl}/browse/${i.key}`,
    summary: f.summary,
    type: f.issuetype?.name,
    status: f.status?.name ?? 'Unknown',
    statusCategory: f.status?.statusCategory?.key as StatusCategory | undefined,
    priority: f.priority?.name || null,
    severity: severityOf(f, severityIds),
    reporter: userOf(f.reporter),
    assignee: userOf(f.assignee),
    created: iso(f.created),
    updated: iso(f.updated),
    resolved: f.resolutiondate ? iso(f.resolutiondate) : null,
    relation,
  };
}

// ------------------------------------------------------------------ search

export async function searchAll(api: JiraApi, jql: string, fields: string[], max = 1000): Promise<{ issues: Json[]; truncated: boolean }> {
  const issues: Json[] = [];
  let nextPageToken: string | undefined;
  let more = false;
  do {
    const page = await api.request('/rest/api/3/search/jql', { method: 'POST', body: { jql, fields, maxResults: 100, nextPageToken } });
    issues.push(...(page.issues || []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
    more = !!nextPageToken;
  } while (nextPageToken && issues.length < max);
  return { issues, truncated: more && issues.length >= max };
}

// ------------------------------------------------------------------ bugs of a tracked issue (Epics view)

export async function getBugs(api: JiraApi, key: string, opts: { severityIds: string[]; issueTypes: string }): Promise<BugsResponse> {
  // 1) The tracked issue, plus how each linked issue relates to it.
  const parent = await api.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,issuelinks`);
  const relation: Record<string, string> = {};
  for (const l of parent.fields.issuelinks || []) {
    if (l.outwardIssue) relation[l.outwardIssue.key] = l.type.outward;
    if (l.inwardIssue) relation[l.inwardIssue.key] = l.type.inward;
  }

  // 2) Every bug linked to it or parented by it. `key` is regex-validated by the caller; types are quoted.
  const jql = `(issue in linkedIssues("${key}") OR parent = "${key}") AND issuetype in (${typesJql(opts.issueTypes)}) ORDER BY created DESC`;
  const fields = ['summary', 'status', 'priority', 'reporter', 'assignee', 'created', 'updated', 'resolutiondate', 'issuetype', 'parent', ...opts.severityIds];
  const { issues } = await searchAll(api, jql, fields, 2000);

  return {
    parent: {
      key: parent.key,
      url: `${api.siteUrl}/browse/${parent.key}`,
      summary: parent.fields.summary,
      status: parent.fields.status?.name,
      type: parent.fields.issuetype?.name,
    },
    bugs: issues.map((i) => mapBug(api, i, opts.severityIds, relation[i.key] || (i.fields.parent?.key === key ? 'child of' : 'linked'))),
    severityFieldsUsed: opts.severityIds,
    jql,
    fetchedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ priorities & severities

export const KNOWN_PRIORITIES = ['blocker', 'highest', 'critical', 'urgent', 'high', 'major', 'medium', 'normal', 'low', 'minor', 'lowest', 'trivial'];

/**
 * Lower rank = more urgent. Jira's priority list is in the admin's chosen order, which is not always urgency
 * (one real site lists "Blocker" last). When every priority name is a familiar one, rank by meaning; otherwise
 * (custom names such as P1, P2) trust the order Jira returns.
 */
export function makePriorityRank(namesInJiraOrder: string[] | null): (name: string | null) => number {
  const rank = new Map<string, number>();
  const names = (namesInJiraOrder ?? []).map((n) => n.toLowerCase());
  const byMeaning = names.length > 0 && names.every((n) => KNOWN_PRIORITIES.includes(n));
  names.forEach((n, i) => rank.set(n, byMeaning ? KNOWN_PRIORITIES.indexOf(n) : i));
  return (name) => {
    if (!name) return 99;
    const n = name.toLowerCase();
    return rank.get(n) ?? (KNOWN_PRIORITIES.includes(n) ? KNOWN_PRIORITIES.indexOf(n) : 50);
  };
}

/** "1 - Critical" beats "2 - Major". Falls back to keywords when there is no number. */
export function severityRank(name: string | null): number {
  if (!name) return 99;
  const m = /\d+/.exec(name);
  if (m) return Number(m[0]);
  if (/blocker|critical|highest/i.test(name)) return 1;
  if (/major|high/i.test(name)) return 2;
  if (/medium|moderate|normal/i.test(name)) return 3;
  return 4;
}

// ------------------------------------------------------------------ For You

export const BASE_FIELDS = [
  'summary', 'status', 'priority', 'reporter', 'assignee', 'created', 'updated', 'resolutiondate',
  'issuetype', 'parent', 'project', 'labels', 'issuelinks',
];

export const assignedJql = (issueTypes: string, closedWindowDays: number): string =>
  `assignee = currentUser() AND issuetype in (${typesJql(issueTypes)}) AND (statusCategory != Done OR updated >= -${closedWindowDays}d) ORDER BY updated DESC`;

export function blockedInfo(f: Json): { blocked: boolean; reason: string | null } {
  if (f.status?.statusCategory?.key === 'done') return { blocked: false, reason: null };
  const status = String(f.status?.name ?? '');
  if (/block|on hold|impediment/i.test(status)) return { blocked: true, reason: `Status: ${status}` };
  if ((f.labels as string[] | undefined)?.some((l) => /^blocked$/i.test(l))) return { blocked: true, reason: 'Labelled "blocked"' };
  for (const l of f.issuelinks || []) {
    // On issue A, an inwardIssue B with the inward text "is blocked by" means "A is blocked by B".
    if (l.inwardIssue && /blocked by/i.test(l.type?.inward ?? '') && l.inwardIssue.fields?.status?.statusCategory?.key !== 'done') {
      return { blocked: true, reason: `Blocked by ${l.inwardIssue.key}` };
    }
  }
  return { blocked: false, reason: null };
}

/** Keys assigned to me in the last 7 days. Uses Jira's assignee history when the site allows it. */
async function recentlyAssignedKeys(api: JiraApi, bugs: MyBug[]): Promise<{ keys: Set<string>; source: MyBugsResponse['recentlyAssignedSource'] }> {
  try {
    const { issues } = await searchAll(api, 'assignee = currentUser() AND assignee CHANGED TO currentUser() AFTER -7d', ['summary'], 300);
    return { keys: new Set(issues.map((i) => String(i.key))), source: 'jira-history' };
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 429)) throw e;
    const cutoff = Date.now() - 7 * 864e5;
    return { keys: new Set(bugs.filter((b) => Date.parse(b.created) >= cutoff).map((b) => b.key)), source: 'created' };
  }
}

export interface MyBugsOptions {
  me: { name: string; email: string | null };
  severityIds: string[];
  issueTypes: string;
  closedWindowDays: number;
  lastActivity: (key: string) => MyBug['lastActivity'];
  assignedEvents: (key: string) => boolean;
  maxIssues?: number;
}

export async function getMyBugs(api: JiraApi, o: MyBugsOptions): Promise<MyBugsResponse> {
  const jql = assignedJql(o.issueTypes, o.closedWindowDays);
  const { issues, truncated } = await searchAll(api, jql, [...BASE_FIELDS, ...o.severityIds], o.maxIssues ?? 1000);
  const bugs: MyBug[] = issues.map((i) => {
    const f = i.fields;
    const b = blockedInfo(f);
    return {
      ...mapBug(api, i, o.severityIds, 'assigned to me'),
      project: { key: String(f.project?.key ?? i.key.split('-')[0]), name: String(f.project?.name ?? f.project?.key ?? '') },
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '', type: f.parent.fields?.issuetype?.name } : null,
      labels: f.labels ?? [],
      blocked: b.blocked,
      blockedReason: b.reason,
      recentlyAssigned: false,
      lastActivity: o.lastActivity(i.key),
    };
  });
  const { keys, source } = await recentlyAssignedKeys(api, bugs);
  for (const b of bugs) b.recentlyAssigned = keys.has(b.key) || o.assignedEvents(b.key);
  return { me: o.me, bugs, jql, truncated, recentlyAssignedSource: source, fetchedAt: new Date().toISOString() };
}

// ------------------------------------------------------------------ issue detail

/** Jira's rich text (Atlassian Document Format) as readable plain text. */
export function adfToText(node: Json, depth = 0): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const kids = (): string => (node.content || []).map((c: Json) => adfToText(c, depth + 1)).join('');
  switch (node.type) {
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text ?? '@someone';
    case 'emoji': return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard': return node.attrs?.url ?? '';
    case 'media': case 'mediaSingle': case 'mediaGroup': return '[attachment]';
    case 'listItem': return `• ${kids().trim()}\n`;
    case 'codeBlock': return `${kids()}\n`;
    case 'paragraph': case 'heading': case 'blockquote': case 'bulletList': case 'orderedList': case 'panel': case 'table': case 'tableRow':
      return `${kids()}\n`;
    case 'tableCell': case 'tableHeader': return `${kids().trim()} | `;
    default: return kids();
  }
}
const plain = (adf: Json, max: number): string => adfToText(adf).replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/** Newest changelog entries. Jira returns oldest first, so jump to the last page for long histories. */
export async function recentChangelog(api: JiraApi, key: string, want = 100): Promise<Json[]> {
  const base = `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;
  const first = await api.request(`${base}?startAt=0&maxResults=${want}`);
  const total = Number(first.total ?? (first.values || []).length);
  if (first.isLast !== false || total <= want) return first.values || [];
  const last = await api.request(`${base}?startAt=${Math.max(0, total - want)}&maxResults=${want}`);
  return last.values || [];
}

export async function recentComments(api: JiraApi, key: string, max = 20): Promise<Json[]> {
  const r = await api.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=${max}`);
  return r.comments || [];
}

export async function getIssueDetail(api: JiraApi, key: string, severityIds: string[]): Promise<IssueDetail> {
  const fields = [...BASE_FIELDS, 'description', ...severityIds].join(',');
  const [issue, comments, hist] = await Promise.all([
    api.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`),
    recentComments(api, key, 30).catch(() => [] as Json[]),
    recentChangelog(api, key, 100).catch(() => [] as Json[]),
  ]);
  const f = issue.fields;
  const links = (f.issuelinks || []).map((l: Json) => {
    const other = l.outwardIssue ?? l.inwardIssue;
    return {
      relation: l.outwardIssue ? l.type.outward : l.type.inward,
      key: other.key,
      summary: other.fields?.summary ?? '',
      status: other.fields?.status?.name ?? '',
      url: `${api.siteUrl}/browse/${other.key}`,
    };
  });
  return {
    key: issue.key,
    url: `${api.siteUrl}/browse/${issue.key}`,
    summary: f.summary,
    status: f.status?.name ?? 'Unknown',
    statusCategory: f.status?.statusCategory?.key,
    priority: f.priority?.name ?? null,
    severity: severityOf(f, severityIds),
    project: { key: String(f.project?.key ?? ''), name: String(f.project?.name ?? '') },
    assignee: userOf(f.assignee),
    reporter: userOf(f.reporter),
    created: iso(f.created),
    updated: iso(f.updated),
    resolved: f.resolutiondate ? iso(f.resolutiondate) : null,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '', url: `${api.siteUrl}/browse/${f.parent.key}` } : null,
    labels: f.labels ?? [],
    description: plain(f.description, 6000),
    comments: comments.map((c) => ({ id: String(c.id), author: c.author?.displayName ?? 'Unknown', created: iso(c.created), body: plain(c.body, 2500) })),
    history: hist
      .slice()
      .reverse()
      .slice(0, 30)
      .map((h) => ({
        id: String(h.id),
        author: h.author?.displayName ?? 'Jira',
        created: iso(h.created),
        items: (h.items || []).map((it: Json) => ({ field: String(it.field), from: it.fromString ?? null, to: it.toString ?? null })),
      })),
    links,
  };
}
