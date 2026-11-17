import type { BugsResponse, ConfigUpdate, PublicConfig } from '../shared/types.js';
import { demoBugs } from './demo.js';

/**
 * local: served by the Node server, talks to the real Jira.
 * demo:  served as a static site (e.g. GitHub Pages) or opened with ?demo, uses sample data only.
 */
export type Mode = 'local' | 'demo';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-JBD': '1' };

async function parse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Unexpected response (${res.status})`);
  }
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
  return body as T;
}

export async function detectMode(): Promise<{ mode: Mode; config: PublicConfig }> {
  if (new URLSearchParams(location.search).has('demo')) return { mode: 'demo', config: { configured: false } };
  try {
    const res = await fetch('api/config', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      return { mode: 'local', config: (await res.json()) as PublicConfig };
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
