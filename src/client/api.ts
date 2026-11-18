import type { BugsResponse, ConfigUpdate, IssueDetail, JarvisEvent, JarvisServerPrefs, JarvisStatus, MyBugsResponse, PublicConfig } from '../shared/types.js';
import { demoBugs, demoDetail, demoMine } from './demo.js';

/**
 * local: served by the Node server, talks to the real Jira.
 * cloud: served by the Cloudflare Worker (Cloud edition); sign-in with Atlassian, tokens stay on the server.
 * demo:  served as a static site (e.g. GitHub Pages) or opened with ?demo, uses sample data only.
 */
export type Mode = 'local' | 'demo' | 'cloud';

/** An API error with the server's machine-readable code ("signin", "reauth", "rate_limited", ...). */
export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-JBD': '1' };

async function parse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Unexpected response (${res.status})`);
  }
  if (!res.ok) {
    const b = body as { error?: string; code?: string };
    throw new ApiFailure(b.error || res.statusText, res.status, b.code);
  }
  return body as T;
}

export async function detectMode(): Promise<{ mode: Mode; config: PublicConfig }> {
  if (new URLSearchParams(location.search).has('demo')) return { mode: 'demo', config: { configured: false } };
  try {
    const res = await fetch('api/config', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const config = (await res.json()) as PublicConfig;
      return { mode: config.edition === 'cloud' ? 'cloud' : 'local', config };
    }
  } catch {
    /* no server: static hosting */
  }
  return { mode: 'demo', config: { configured: false } };
}

export async function fetchBugs(mode: Mode, key: string): Promise<BugsResponse> {
  if (mode === 'demo') {
    await new Promise((r) => setTimeout(r, 350));
    return demoBugs(key);
  }
  return parse<BugsResponse>(await fetch(`api/bugs?key=${encodeURIComponent(key)}`, { cache: 'no-store' }));
}

export async function saveConfig(body: ConfigUpdate): Promise<PublicConfig> {
  return parse<PublicConfig>(await fetch('api/config', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }));
}

export async function deleteConfig(): Promise<PublicConfig> {
  return parse<PublicConfig>(await fetch('api/config', { method: 'DELETE', headers: { 'X-JBD': '1' } }));
}

export async function fetchMine(mode: Mode): Promise<MyBugsResponse> {
  if (mode === 'demo') {
    await new Promise((r) => setTimeout(r, 300));
    return demoMine();
  }
  return parse<MyBugsResponse>(await fetch('api/mine', { cache: 'no-store' }));
}

export async function fetchIssue(mode: Mode, key: string): Promise<IssueDetail> {
  if (mode === 'demo') {
    await new Promise((r) => setTimeout(r, 200));
    return demoDetail(key);
  }
  return parse<IssueDetail>(await fetch(`api/issue?key=${encodeURIComponent(key)}`, { cache: 'no-store' }));
}

export const jarvisStatus = async (): Promise<JarvisStatus> => parse<JarvisStatus>(await fetch('api/jarvis/status', { cache: 'no-store' }));
export const jarvisEvents = async (): Promise<JarvisEvent[]> => (await parse<{ events: JarvisEvent[] }>(await fetch('api/jarvis/events', { cache: 'no-store' }))).events;
export const jarvisPost = async <T>(path: string, body: unknown = {}): Promise<T> =>
  parse<T>(await fetch(`api/jarvis/${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }));
export const setJarvisPrefs = (p: Partial<JarvisServerPrefs>): Promise<{ prefs: JarvisServerPrefs; status: JarvisStatus }> => jarvisPost('prefs', p);

// ------------------------------------------------------------------ Cloud edition only

export const post = async <T>(path: string, body: unknown = {}): Promise<T> =>
  parse<T>(await fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }));

export const cloudSettings = (b: { severityFields?: string; issueTypes?: string; activeCloudId?: string }): Promise<PublicConfig> => post('api/config', b);
export const cloudLogout = (): Promise<{ ok: boolean }> => post('auth/logout');
export const cloudDeleteAccount = (): Promise<{ deleted: boolean }> => post('api/account/delete', { confirm: 'DELETE' });
export const cloudSync = (): Promise<{ events: JarvisEvent[]; status: JarvisStatus; result: { outcome: string; error?: string } }> => post('api/jarvis/sync');
export const cloudNotifyPrefs = (b: unknown): Promise<unknown> => post('api/jarvis/notify', b);
export const pushSubscribe = (sub: unknown): Promise<{ ok: boolean }> => post('api/push/subscribe', sub);
export const pushUnsubscribe = (endpoint: string): Promise<{ ok: boolean }> => post('api/push/unsubscribe', { endpoint });
export const pushTest = (): Promise<{ devices: number; outcomes: string[] }> => post('api/push/test');
export const pushDevices = async (): Promise<{ id: string; label: string | null; created_at: number; last_ok_at: number | null }[]> =>
  (await parse<{ devices: { id: string; label: string | null; created_at: number; last_ok_at: number | null }[] }>(await fetch('api/push/devices', { cache: 'no-store' }))).devices;
export const jarvisEventsAfter = async (after: number): Promise<JarvisEvent[]> =>
  (await parse<{ events: JarvisEvent[] }>(await fetch(`api/jarvis/events?after=${after}`, { cache: 'no-store' }))).events;
