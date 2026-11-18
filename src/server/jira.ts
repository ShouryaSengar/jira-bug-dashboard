// Jira Cloud REST client and the "bugs of an issue" query.

import type { Bug, BugsResponse, Person, StatusCategory } from '../shared/types.js';
import type { Config } from './config.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number
  ) {
    super(message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any; // Jira payloads are large and vary per site; only the fields read below matter.

export async function jira(
  cfg: Pick<Config, 'jiraUrl' | 'email' | 'apiToken'>,
  apiPath: string,
  init: RequestInit = {}
): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(cfg.jiraUrl + apiPath, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new HttpError(502, `Could not reach ${cfg.jiraUrl}: ${err.cause?.code || err.message}`);
  }
  if (res.status === 401) {
    throw new HttpError(401, 'Jira rejected the credentials. Check the email and API token in Settings.');
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after'));
    throw new HttpError(429, 'Jira is rate limiting requests. Backing off.', Number.isFinite(wait) && wait > 0 ? wait : 60);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as Json;
      const parts = [...(body.errorMessages || []), ...Object.values(body.errors || {})];
      if (parts.length) msg = parts.join('; ');
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError(res.status === 403 ? 403 : res.status === 404 ? 404 : 502, msg);
  }
  return res.json();
}

export const split = (s: string): string[] =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// Field name -> id lookups, cached per Jira site.
const fieldCache = new Map<string, Json[]>();
export const forgetFields = (jiraUrl?: string): void => (jiraUrl ? void fieldCache.delete(jiraUrl) : fieldCache.clear());

export async function allFields(cfg: Config): Promise<Json[]> {
  let all = fieldCache.get(cfg.jiraUrl);
  if (!all) {
    all = (await jira(cfg, '/rest/api/3/field')) as Json[];
    fieldCache.set(cfg.jiraUrl, all);
  }
  return all;
}

/** Jira sends "+0530"; Safari only parses "+05:30". Normalise so every browser can read the dates. */
export const iso = (s: string | null | undefined): string => (s ? s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '');

export const typesJql = (cfg: Config): string =>
  split(cfg.issueTypes)
    .map((t) => `"${t.replace(/["\\]/g, '')}"`)
    .join(',');

export function mapBug(cfg: Config, i: Json, severityIds: string[], relation: string): Bug {
  const f = i.fields;
  return {
    key: i.key,
    url: `${cfg.jiraUrl}/browse/${i.key}`,
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

export async function resolveSeverityFieldIds(cfg: Config): Promise<string[]> {
  const wanted = split(cfg.severityFields);
  if (wanted.every((w) => /^customfield_\d+$/.test(w))) return wanted;
  const all = await allFields(cfg);
  const ids: string[] = [];
  for (const w of wanted) {
    if (/^customfield_\d+$/.test(w)) ids.push(w);
    else ids.push(...all.filter((f) => String(f.name).toLowerCase() === w.toLowerCase()).map((f) => f.id as string));
  }
  return [...new Set(ids)];
}

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

export async function getBugs(cfg: Config, key: string): Promise<BugsResponse> {
  // 1) The tracked issue, plus how each linked issue relates to it.
  const parent = await jira(
    cfg,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,issuelinks`
  );
  const relation: Record<string, string> = {};
  for (const l of parent.fields.issuelinks || []) {
    if (l.outwardIssue) relation[l.outwardIssue.key] = l.type.outward;
    if (l.inwardIssue) relation[l.inwardIssue.key] = l.type.inward;
  }

  // 2) Every bug linked to it or parented by it. `key` is regex-validated; types are quoted.
  const severityIds = await resolveSeverityFieldIds(cfg);
  const types = typesJql(cfg);
  const jql = `(issue in linkedIssues("${key}") OR parent = "${key}") AND issuetype in (${types}) ORDER BY created DESC`;
  const fields = [
    'summary', 'status', 'priority', 'reporter', 'assignee', 'created', 'updated',
    'resolutiondate', 'issuetype', 'parent', ...severityIds,
  ];

  const issues: Json[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jira(cfg, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields, maxResults: 100, nextPageToken }),
    });
    issues.push(...(page.issues || []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken && issues.length < 2000);

  const bugs: Bug[] = issues.map((i) =>
    mapBug(cfg, i, severityIds, relation[i.key] || (i.fields.parent?.key === key ? 'child of' : 'linked'))
  );

  return {
    parent: {
      key: parent.key,
      url: `${cfg.jiraUrl}/browse/${parent.key}`,
      summary: parent.fields.summary,
      status: parent.fields.status?.name,
      type: parent.fields.issuetype?.name,
    },
    bugs,
    severityFieldsUsed: severityIds,
    jql,
    fetchedAt: new Date().toISOString(),
  };
}
