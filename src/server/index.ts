// Local Jira bug dashboard server.
//
// - Serves the static web app and proxies Jira REST calls, so the API token never reaches the browser.
// - Credentials are entered once in the UI and saved per user in ~/.jira-bug-dashboard/config.json
//   (file mode 0600, outside the project folder).
// - Listens on 127.0.0.1 only and rejects requests from other sites / hostnames.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigUpdate } from '../shared/types.js';
import { CONFIG_FILE, DEFAULTS, clearConfigFile, loadConfig, publicConfig, saveConfig, type Config } from './config.js';
import { HttpError, forgetFields, getBugs, jira } from './jira.js';
import { forgetMine, getIssueDetail, getMyBugs } from './mine.js';
import { monitor } from './jarvis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const JS_DIR = path.join(ROOT, 'dist', 'client');
const PORT = Number(process.env['PORT'] || 4545);

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- settings

function normalizeJiraUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new HttpError(400, 'Jira URL is not a valid URL (e.g. https://your-company.atlassian.net)');
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Jira URL must start with https://');
  if (u.username || u.password) throw new HttpError(400, 'Jira URL must not contain credentials');
  return u.origin; // drop any path like /browse/ABC-1 or /jira/software
}

async function updateConfig(body: Partial<ConfigUpdate>): Promise<Config> {
  const current = loadConfig();
  if (current?.source === 'env') {
    throw new HttpError(409, 'Credentials come from environment variables. Change them there.');
  }
  const jiraUrl = normalizeJiraUrl(body.jiraUrl);
  const email = String(body.email || '').trim();
  if (!email) throw new HttpError(400, 'Email is required');

  // A blank token keeps the stored one, but only for the same site and account,
  // so a saved token can never be redirected to a different host.
  let apiToken = String(body.apiToken || '').trim();
  if (!apiToken) {
    if (current && current.jiraUrl === jiraUrl && current.email === email) apiToken = current.apiToken;
    else throw new HttpError(400, 'API token is required');
  }

  const next = {
    jiraUrl,
    email,
    apiToken,
    severityFields: String(body.severityFields ?? '').trim() || DEFAULTS.severityFields,
    issueTypes: String(body.issueTypes ?? '').trim() || DEFAULTS.issueTypes,
  };

  // Verify before saving, so a typo never gets stored.
  const me = await jira(next, '/rest/api/3/myself');
  const saved = { ...next, displayName: me.displayName as string, savedAt: new Date().toISOString() };
  forgetFields(jiraUrl);
  forgetMine();
  saveConfig(saved);
  monitor.configChanged();
  return { source: 'file', ...saved };
}

// ---------------------------------------------------------------- HTTP

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function sendStatic(res: http.ServerResponse, pathname: string): boolean {
  let dir = PUBLIC_DIR;
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.startsWith('/js/')) {
    dir = JS_DIR;
    rel = rel.slice('/js'.length);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const file = path.resolve(dir, '.' + decoded);
  if (file !== dir && !file.startsWith(dir + path.sep)) return false; // path traversal
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, 'Request too large');
  }
  try {
    return JSON.parse(raw || '{}') as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * Blocks other websites from talking to this server through the user's browser:
 * - Host check stops DNS-rebinding.
 * - State-changing calls need a custom header, which a cross-site page cannot send
 *   without a CORS preflight that this server never approves.
 */
function guard(req: http.IncomingMessage): void {
  if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, 'Forbidden origin');
    if (req.headers['x-jbd'] !== '1') throw new HttpError(403, 'Missing X-JBD header');
  }
}

function requireConfig(): Config {
  const cfg = loadConfig();
  if (!cfg) throw new HttpError(428, 'Not set up yet');
  return cfg;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    guard(req);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/config') return sendJson(res, 200, publicConfig(loadConfig()));
    if (route === 'POST /api/config') {
      return sendJson(res, 200, publicConfig(await updateConfig(await readJson<Partial<ConfigUpdate>>(req))));
    }
    if (route === 'DELETE /api/config') {
      if (loadConfig()?.source === 'env') throw new HttpError(409, 'Credentials come from environment variables.');
      clearConfigFile();
      forgetFields();
      forgetMine();
      monitor.configChanged();
      return sendJson(res, 200, publicConfig(null));
    }
    if (route === 'GET /api/bugs') {
      const key = (url.searchParams.get('key') || '').trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid Jira key (e.g. ABC-123)`);
      return sendJson(res, 200, await getBugs(requireConfig(), key));
    }
    if (route === 'GET /api/mine') {
      return sendJson(res, 200, await getMyBugs(requireConfig(), monitor.prefs.closedWindowDays, (k) => monitor.lastActivityFor(k), (k) => monitor.wasAssignedRecently(k)));
    }
    if (route === 'GET /api/issue') {
      const key = (url.searchParams.get('key') || '').trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid Jira key (e.g. ABC-123)`);
      return sendJson(res, 200, await getIssueDetail(requireConfig(), key));
    }
    if (route === 'GET /api/jarvis/status') return sendJson(res, 200, monitor.status());
    if (route === 'GET /api/jarvis/events') {
      const after = Number(url.searchParams.get('after') || 0);
      return sendJson(res, 200, { events: after > 0 ? monitor.eventsAfter(after) : monitor.recentEvents() });
    }
    if (route === 'GET /api/jarvis/stream') return monitor.addClient(req, res);
    if (route === 'POST /api/jarvis/prefs') return sendJson(res, 200, { prefs: monitor.setPrefs(await readJson(req)), status: monitor.status() });
    if (route === 'POST /api/jarvis/read') {
      const b = await readJson<{ ids?: number[]; all?: boolean }>(req);
      monitor.markRead(b.all ? 'all' : (b.ids ?? []).filter((n) => Number.isInteger(n)));
      return sendJson(res, 200, monitor.status());
    }
    if (route === 'POST /api/jarvis/clear') {
      monitor.clearEvents();
      return sendJson(res, 200, monitor.status());
    }
    if (route === 'POST /api/jarvis/sync') {
      monitor.syncNow();
      return sendJson(res, 202, monitor.status());
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && sendStatic(res, url.pathname)) return;
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: status === 500 ? 'Unexpected server error' : (err as Error).message });
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Try: PORT=4546 npm start` : e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  monitor.start();
  const cfg = loadConfig();
  console.log(`Jira bug dashboard: http://localhost:${PORT}`);
  console.log(
    cfg
      ? `Using ${cfg.source === 'env' ? 'environment variables' : CONFIG_FILE} (${cfg.email} @ ${cfg.jiraUrl})`
      : 'Not set up yet. Open the link above to connect your Jira account.'
  );
});
