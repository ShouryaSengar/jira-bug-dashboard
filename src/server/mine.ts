// Local edition: "For You" queries, issue detail and the per-site lookups JARVIS needs.
// Thin wrappers around ../core, which holds the logic shared with the Cloud edition.

import type { IssueDetail, MyBug, MyBugsResponse } from '../shared/types.js';
import type { Config } from './config.js';
import * as core from '../core/jira.js';
import type { Json } from '../core/jira.js';
import { jira, localApi, resolveSeverityFieldIds } from './jira.js';

export { BASE_FIELDS, adfToText, blockedInfo, severityRank } from '../core/jira.js';

export interface Me {
  accountId: string;
  name: string;
  email: string | null;
}

// ---------------------------------------------------------------- small per-site caches
const meCache = new Map<string, Me>();
const statusCache = new Map<string, { at: number; map: Map<string, { name: string; cat: string }> }>();
const priorityCache = new Map<string, { at: number; rank: (name: string | null) => number }>();
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

export async function getPriorityRank(cfg: Config): Promise<(name: string | null) => number> {
  let hit = priorityCache.get(cfg.jiraUrl);
  if (!hit || Date.now() - hit.at >= TTL) {
    let names: string[] | null = null;
    try {
      names = ((await jira(cfg, '/rest/api/3/priority')) as Json[]).map((p) => String(p.name));
    } catch {
      /* fall through to the name heuristic */
    }
    hit = { at: Date.now(), rank: core.makePriorityRank(names) };
    priorityCache.set(cfg.jiraUrl, hit);
  }
  return hit.rank;
}

export const assignedJql = (cfg: Config, closedWindowDays: number): string => core.assignedJql(cfg.issueTypes, closedWindowDays);

export const searchAll = (cfg: Config, jql: string, fields: string[], max = 1000): Promise<{ issues: Json[]; truncated: boolean }> =>
  core.searchAll(localApi(cfg), jql, fields, max);

export const recentChangelog = (cfg: Config, key: string, want = 100): Promise<Json[]> => core.recentChangelog(localApi(cfg), key, want);
export const recentComments = (cfg: Config, key: string, max = 20): Promise<Json[]> => core.recentComments(localApi(cfg), key, max);

export async function getMyBugs(
  cfg: Config,
  closedWindowDays: number,
  lastActivity: (key: string) => MyBug['lastActivity'],
  assignedEvents: (key: string) => boolean
): Promise<MyBugsResponse> {
  const me = await getMe(cfg);
  return core.getMyBugs(localApi(cfg), {
    me: { name: me.name, email: me.email },
    severityIds: await resolveSeverityFieldIds(cfg),
    issueTypes: cfg.issueTypes,
    closedWindowDays,
    lastActivity,
    assignedEvents,
  });
}

export async function getIssueDetail(cfg: Config, key: string): Promise<IssueDetail> {
  return core.getIssueDetail(localApi(cfg), key, await resolveSeverityFieldIds(cfg));
}
