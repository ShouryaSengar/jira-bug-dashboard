// "For You": every bug assigned to the authenticated user, plus issue detail and the helpers
// JARVIS needs (who am I, status categories, priority order).

import type { IssueDetail, MyBug, MyBugsResponse } from '../shared/types.js';
import type { Config } from './config.js';
import { HttpError, allFields, iso, jira, mapBug, resolveSeverityFieldIds, severityOf, typesJql, userOf } from './jira.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface Me {
  accountId: string;
  name: string;
  email: string | null;
}

// ---------------------------------------------------------------- small per-site caches
const meCache = new Map<string, Me>();
const statusCache = new Map<string, { at: number; map: Map<string, { name: string; cat: string }> }>();
const priorityCache = new Map<string, { at: number; rank: Map<string, number> }>();
const TTL = 6 * 3600_000;

export function forgetMine(): void {
  meCache.clear();
  statusCache.clear();
  priorityCache.clear();
}

export async function getMe(cfg: Config): Promise<Me> {
  const k = `${cfg.jiraUrl}|${cfg.email}`;
  let me = meCache.get(k);
  if (!me) {
    const r = await jira(cfg, '/rest/api/3/myself');
    me = { accountId: String(r.accountId), name: String(r.displayName), email: r.emailAddress ?? null };
    meCache.set(k, me);
  }
  return me;
}

/** Status id -> name and category, to tell "reopened" from "moved" and "resolved" from "in progress". */
export async function getStatusMap(cfg: Config): Promise<Map<string, { name: string; cat: string }>> {
  const hit = statusCache.get(cfg.jiraUrl);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  const map = new Map<string, { name: string; cat: string }>();
  try {
    for (const s of (await jira(cfg, '/rest/api/3/status')) as Json[]) {
      map.set(String(s.id), { name: String(s.name), cat: String(s.statusCategory?.key ?? '') });
    }
  } catch {
    /* optional: events fall back to status names */
  }
  statusCache.set(cfg.jiraUrl, { at: Date.now(), map });
  return map;
}

const FALLBACK_PRIORITIES = ['blocker', 'highest', 'critical', 'high', 'major', 'medium', 'normal', 'low', 'minor', 'lowest', 'trivial'];
/** Lower rank = more urgent. Jira returns priorities from most to least urgent. */
export async function getPriorityRank(cfg: Config): Promise<(name: string | null) => number> {
  let hit = priorityCache.get(cfg.jiraUrl);
  if (!hit || Date.now() - hit.at >= TTL) {
    const rank = new Map<string, number>();
    try {
      ((await jira(cfg, '/rest/api/3/priority')) as Json[]).forEach((p, i) => rank.set(String(p.name).toLowerCase(), i));
    } catch {
      /* fall through to the name heuristic */
    }
    hit = { at: Date.now(), rank };
    priorityCache.set(cfg.jiraUrl, hit);
  }
  const { rank } = hit;
  return (name) => {
    if (!name) return 99;
    const n = name.toLowerCase();
    const r = rank.get(n);
    if (r !== undefined) return r;
    const f = FALLBACK_PRIORITIES.indexOf(n);
    return f >= 0 ? f : 50;
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

// ---------------------------------------------------------------- searching

export const BASE_FIELDS = [
  'summary', 'status', 'priority', 'reporter', 'assignee', 'created', 'updated', 'resolutiondate',
  'issuetype', 'parent', 'project', 'labels', 'issuelinks',
];

export const assignedJql = (cfg: Config, closedWindowDays: number): string =>
  `assignee = currentUser() AND issuetype in (${typesJql(cfg)}) AND (statusCategory != Done OR updated >= -${closedWindowDays}d) ORDER BY updated DESC`;

export async function searchAll(cfg: Config, jql: string, fields: string[], max = 1000): Promise<{ issues: Json[]; truncated: boolean }> {
  const issues: Json[] = [];
  let nextPageToken: string | undefined;
  let more = false;
  do {
    const page = await jira(cfg, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields, maxResults: 100, nextPageToken }),
    });
    issues.push(...(page.issues || []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
    more = !!nextPageToken;
  } while (nextPageToken && issues.length < max);
  return { issues, truncated: more && issues.length >= max };
}

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
async function recentlyAssignedKeys(cfg: Config, bugs: MyBug[]): Promise<{ keys: Set<string>; source: MyBugsResponse['recentlyAssignedSource'] }> {
  try {
    const { issues } = await searchAll(cfg, 'assignee = currentUser() AND assignee CHANGED TO currentUser() AFTER -7d', ['summary'], 300);
    return { keys: new Set(issues.map((i) => String(i.key))), source: 'jira-history' };
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 429)) throw e;
    const cutoff = Date.now() - 7 * 864e5;
    return { keys: new Set(bugs.filter((b) => Date.parse(b.created) >= cutoff).map((b) => b.key)), source: 'created' };
  }
}

export async function getMyBugs(
  cfg: Config,
  closedWindowDays: number,
  lastActivity: (key: string) => MyBug['lastActivity'],
  assignedEvents: (key: string) => boolean
): Promise<MyBugsResponse> {
  const me = await getMe(cfg);
  const sev = await resolveSeverityFieldIds(cfg);
  const jql = assignedJql(cfg, closedWindowDays);
  const { issues, truncated } = await searchAll(cfg, jql, [...BASE_FIELDS, ...sev]);
  const bugs: MyBug[] = issues.map((i) => {
    const f = i.fields;
    const b = blockedInfo(f);
    return {
      ...mapBug(cfg, i, sev, 'assigned to me'),
      project: { key: String(f.project?.key ?? i.key.split('-')[0]), name: String(f.project?.name ?? f.project?.key ?? '') },
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '', type: f.parent.fields?.issuetype?.name } : null,
      labels: f.labels ?? [],
      blocked: b.blocked,
      blockedReason: b.reason,
      recentlyAssigned: false,
      lastActivity: lastActivity(i.key),
    };
  });
  const { keys, source } = await recentlyAssignedKeys(cfg, bugs);
  for (const b of bugs) b.recentlyAssigned = keys.has(b.key) || assignedEvents(b.key);
  return {
    me: { name: me.name, email: me.email },
    bugs,
    jql,
    truncated,
    recentlyAssignedSource: source,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- issue detail

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
export async function recentChangelog(cfg: Config, key: string, want = 100): Promise<Json[]> {
  const base = `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;
  const first = await jira(cfg, `${base}?startAt=0&maxResults=${want}`);
  const total = Number(first.total ?? (first.values || []).length);
  if (first.isLast !== false || total <= want) return first.values || [];
  const last = await jira(cfg, `${base}?startAt=${Math.max(0, total - want)}&maxResults=${want}`);
  return last.values || [];
}

export async function recentComments(cfg: Config, key: string, max = 20): Promise<Json[]> {
  const r = await jira(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=${max}`);
  return r.comments || [];
}

export async function getIssueDetail(cfg: Config, key: string): Promise<IssueDetail> {
  const sev = await resolveSeverityFieldIds(cfg);
  const fields = [...BASE_FIELDS, 'description', ...sev].join(',');
  const [issue, comments, hist, allF] = await Promise.all([
    jira(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`),
    recentComments(cfg, key, 30).catch(() => [] as Json[]),
    recentChangelog(cfg, key, 100).catch(() => [] as Json[]),
    allFields(cfg).catch(() => [] as Json[]),
  ]);
  const f = issue.fields;
  const sevIds = new Set(sev);
  const sevNames = new Set(allF.filter((x) => sevIds.has(x.id)).map((x) => String(x.name).toLowerCase()));
  void sevNames;
  const links = (f.issuelinks || []).map((l: Json) => {
    const other = l.outwardIssue ?? l.inwardIssue;
    return {
      relation: l.outwardIssue ? l.type.outward : l.type.inward,
      key: other.key,
      summary: other.fields?.summary ?? '',
      status: other.fields?.status?.name ?? '',
      url: `${cfg.jiraUrl}/browse/${other.key}`,
    };
  });
  return {
    key: issue.key,
    url: `${cfg.jiraUrl}/browse/${issue.key}`,
    summary: f.summary,
    status: f.status?.name ?? 'Unknown',
    statusCategory: f.status?.statusCategory?.key,
    priority: f.priority?.name ?? null,
    severity: severityOf(f, sev),
    project: { key: String(f.project?.key ?? ''), name: String(f.project?.name ?? '') },
    assignee: userOf(f.assignee),
    reporter: userOf(f.reporter),
    created: iso(f.created),
    updated: iso(f.updated),
    resolved: f.resolutiondate ? iso(f.resolutiondate) : null,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '', url: `${cfg.jiraUrl}/browse/${f.parent.key}` } : null,
    labels: f.labels ?? [],
    description: plain(f.description, 6000),
    comments: comments.map((c) => ({
      id: String(c.id),
      author: c.author?.displayName ?? 'Unknown',
      created: iso(c.created),
      body: plain(c.body, 2500),
    })),
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
