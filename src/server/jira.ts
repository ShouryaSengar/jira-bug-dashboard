// Local edition: Jira Cloud client using the user's own email + API token (Basic auth), plus the
// "bugs of an issue" query. The Jira logic itself lives in ../core and is shared with the Cloud edition.

import type { BugsResponse } from '../shared/types.js';
import type { Config } from './config.js';
import { HttpError, getBugs as coreGetBugs, matchSeverityFields, split, type JiraApi, type Json } from '../core/jira.js';

export { HttpError, iso, mapBug as coreMapBug, severityOf, split, userOf } from '../core/jira.js';

export async function jira(cfg: Pick<Config, 'jiraUrl' | 'email' | 'apiToken'>, apiPath: string, init: RequestInit = {}): Promise<Json> {
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

/** Adapts the local Basic-auth client to the shared core interface. */
export function localApi(cfg: Pick<Config, 'jiraUrl' | 'email' | 'apiToken'>): JiraApi {
  return {
    siteUrl: cfg.jiraUrl,
    cacheKey: cfg.jiraUrl,
    request: (path, init) =>
      jira(cfg, path, init?.body !== undefined ? { method: init.method ?? 'POST', body: JSON.stringify(init.body) } : { method: init?.method ?? 'GET' }),
  };
}

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

export async function resolveSeverityFieldIds(cfg: Config): Promise<string[]> {
  const wanted = split(cfg.severityFields);
  if (wanted.every((w) => /^customfield_\d+$/.test(w))) return wanted;
  return matchSeverityFields(cfg.severityFields, await allFields(cfg));
}

export async function getBugs(cfg: Config, key: string): Promise<BugsResponse> {
  return coreGetBugs(localApi(cfg), key, { severityIds: await resolveSeverityFieldIds(cfg), issueTypes: cfg.issueTypes });
}
