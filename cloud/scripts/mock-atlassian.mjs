// A fake Atlassian for developing and testing the Cloud edition without real credentials:
//   auth.atlassian.com  /authorize, /oauth/token (rotating refresh tokens with reuse leeway + breach detection)
//   api.atlassian.com   /me, /oauth/token/accessible-resources, /ex/jira/{cloudId}/rest/api/3/...
//   a Web Push service  /push/{id} (records encrypted messages so tests can decrypt them)
// Usage: node scripts/mock-atlassian.mjs   (port 4710, or MOCK_PORT)
// Control endpoints under /__mock/* change issues and inspect state (see bottom of file).
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 4710);
const CLIENT_ID = 'dev-client-id', CLIENT_SECRET = 'dev-client-secret';
const CLOUD = 'cloud-1', SITE = 'https://mock.atlassian.net';
const ACCOUNTS = {
  me: { accountId: 'acc-me', displayName: 'Me Tester', email: 'me@example.com' },
  zed: { accountId: 'acc-zed', displayName: 'Zed Other', email: 'zed@example.com' },
};
const BOB = { accountId: 'acc-bob', displayName: 'Bob Builder' };
const STATUSES = { 1: ['To Do', 'new'], 2: ['In Progress', 'indeterminate'], 3: ['Done', 'done'], 4: ['Reopened', 'new'] };
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest', 'Blocker'];

const S = {
  nextLogin: 'me', leewayMs: 10 * 60_000, accessTtl: 3600,
  codes: new Map(), access: new Map(), refresh: new Map(), // token -> { account, exp } / { account, family, used, usedAt }
  revokedFamilies: new Set(), counters: { token: 0, refresh: 0, api: 0, search: 0, breach: 0 }, lastAuthorize: null, pushes: [],
  apiLog: [],
};
let clock = Date.now() - 3600_000;
const ts = () => new Date((clock = Math.max(clock + 1000, Date.now()))).toISOString().replace('Z', '+0000');
let hid = 100, cid = 500;
const issues = new Map();
function add(key, o = {}) {
  const t = ts();
  issues.set(key, {
    key, summary: o.summary || `Bug ${key}`, status: o.status || 1, priority: o.priority || 'Medium', sev: o.sev || '3 - Medium',
    assignee: o.assignee === undefined ? ACCOUNTS.me : o.assignee, reporter: BOB, created: t, updated: t, project: { key: key.split('-')[0], name: `Project ${key.split('-')[0]}` },
    history: [], comments: [], assigneeChanges: [],
  });
}
add('ABC-1', { summary: 'Login fails on Safari', status: 2, priority: 'High' });
add('ABC-2', { summary: 'Export hangs' });
add('ZED-1', { summary: 'Zed private bug', assignee: ACCOUNTS.zed });
add('ABC-9', { summary: 'Old closed bug', status: 3 });

const touch = (i) => { i.updated = ts(); };
const hist = (i, author, items) => { i.history.push({ id: String(++hid), author, created: ts(), items }); touch(i); };
const fields = (i) => ({
  summary: i.summary, status: { id: String(i.status), name: STATUSES[i.status][0], statusCategory: { key: STATUSES[i.status][1] } },
  priority: { name: i.priority }, customfield_10100: { value: i.sev }, assignee: i.assignee, reporter: i.reporter, created: i.created, updated: i.updated,
  resolutiondate: STATUSES[i.status][1] === 'done' ? i.updated : null, issuetype: { name: 'Bug' }, project: i.project, labels: [], parent: null, issuelinks: [],
  description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It is broken.' }] }] },
});
const ms = (s) => Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const tok = () => randomBytes(18).toString('base64url');

function issueTokens(account, family) {
  const access = 'at_' + tok(), refresh = 'rt_' + tok();
  S.access.set(access, { account, exp: Date.now() + S.accessTtl * 1000 });
  S.refresh.set(refresh, { account, family: family ?? tok(), used: false, usedAt: 0 });
  return { access_token: access, refresh_token: refresh, expires_in: S.accessTtl, scope: 'read:jira-work read:jira-user read:me offline_access', token_type: 'Bearer' };
}
function bearer(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const a = S.access.get(t);
  if (!a || a.exp < Date.now() || S.revokedFamilies.has(a.family)) return null;
  return ACCOUNTS[a.account];
}

function jqlSearch(me, jql) {
  S.counters.search++;
  const all = [...issues.values()];
  const win = /-(\d+)m\b/.exec(jql);
  if (/CHANGED TO currentUser\(\)/.test(jql)) return [];
  if (/linkedIssues/.test(jql)) return [];
  if (win) {
    const since = Date.now() - Number(win[1]) * 60_000;
    return all.filter((i) => (i.assignee?.accountId === me.accountId && ms(i.updated) >= since) ||
      i.assigneeChanges.some((c) => c.from === me.accountId && c.at >= since)).sort((a, b) => ms(a.updated) - ms(b.updated));
  }
  // full "assigned to me" list (open, or done within the window)
  return all.filter((i) => i.assignee?.accountId === me.accountId);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    // ---------------- auth.atlassian.com
    if (p === '/authorize') {
      S.lastAuthorize = Object.fromEntries(u.searchParams);
      if (u.searchParams.get('client_id') !== CLIENT_ID) return send(res, 400, { error: 'invalid_client' });
      const code = 'code_' + tok();
      S.codes.set(code, { account: S.nextLogin, redirect: u.searchParams.get('redirect_uri'), used: false });
      const back = new URL(u.searchParams.get('redirect_uri'));
      if (S.denyNext) { S.denyNext = false; back.searchParams.set('error', 'access_denied'); }
      else back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (p === '/oauth/token' && req.method === 'POST') {
      S.counters.token++;
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.client_id !== CLIENT_ID || b.client_secret !== CLIENT_SECRET) return send(res, 401, { error: 'access_denied' });
      if (b.grant_type === 'authorization_code') {
        const c = S.codes.get(b.code);
        if (!c || c.used || c.redirect !== b.redirect_uri) return send(res, 403, { error: 'invalid_grant' });
        c.used = true;
        return send(res, 200, issueTokens(c.account));
      }
      if (b.grant_type === 'refresh_token') {
        S.counters.refresh++;
        const r = S.refresh.get(b.refresh_token);
        if (!r || S.revokedFamilies.has(r.family)) return send(res, 403, { error: 'invalid_grant', error_description: 'Unknown or revoked refresh token' });
        if (r.used && Date.now() - r.usedAt > S.leewayMs) { S.revokedFamilies.add(r.family); S.counters.breach++; return send(res, 403, { error: 'invalid_grant', error_description: 'refresh token reuse detected' }); }
        if (!r.used) { r.used = true; r.usedAt = Date.now(); }
        const t = issueTokens(r.account, r.family);
        S.access.get(t.access_token).family = r.family;
        return send(res, 200, t);
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    // ---------------- api.atlassian.com
    if (p === '/me') { const me = bearer(req); return me ? send(res, 200, { account_id: me.accountId, name: me.displayName, email: me.email, picture: 'https://example.com/p.png' }) : send(res, 401, {}); }
    if (p === '/oauth/token/accessible-resources') {
      return bearer(req) ? send(res, 200, [{ id: CLOUD, name: 'Mock Site', url: SITE, scopes: ['read:jira-work', 'read:jira-user'] }]) : send(res, 401, {});
    }
    let m = p.match(/^\/ex\/jira\/([^/]+)(\/rest\/api\/3\/.*)$/);
    if (m) {
      S.counters.api++;
      S.apiLog.push(m[2]);
      const me = bearer(req);
      if (!me) return send(res, 401, { message: 'Unauthorized' });
      if (m[1] !== CLOUD) return send(res, 404, { errorMessages: ['Site not found'] });
      const r = m[2];
      if (r === '/rest/api/3/myself') return send(res, 200, me);
      if (r === '/rest/api/3/priority') return send(res, 200, PRIORITIES.map((name) => ({ name })));
      if (r.startsWith('/rest/api/3/field/search')) return send(res, 200, { values: /severity/i.test(u.searchParams.get('query') || '') ? [{ id: 'customfield_10100', name: 'Defect Severity' }] : [] });
      let mm = r.match(/^\/rest\/api\/3\/status\/(\w+)$/);
      if (mm) return STATUSES[mm[1]] ? send(res, 200, { id: mm[1], name: STATUSES[mm[1]][0], statusCategory: { key: STATUSES[mm[1]][1] } }) : send(res, 404, { errorMessages: ['nope'] });
      if (r === '/rest/api/3/search/jql') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        S.lastJql = b.jql;
        return send(res, 200, { issues: jqlSearch(me, b.jql).map((i) => ({ key: i.key, fields: fields(i) })), isLast: true });
      }
      mm = r.match(/^\/rest\/api\/3\/issue\/([A-Z0-9-]+)(\/changelog|\/comment)?$/);
      if (mm) {
        const i = issues.get(mm[1]);
        // A user may only read issues on their own account's side of the mock (simulates Jira permissions).
        if (!i || (i.project.key === 'ZED' && me.accountId !== ACCOUNTS.zed.accountId)) return send(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
        if (mm[2] === '/changelog') return send(res, 200, { values: i.history, total: i.history.length, isLast: true });
        if (mm[2] === '/comment') return send(res, 200, { comments: [...i.comments].reverse(), total: i.comments.length });
        return send(res, 200, { key: i.key, fields: fields(i) });
      }
      return send(res, 404, { errorMessages: ['not mocked: ' + r] });
    }
    // ---------------- push service
    m = p.match(/^\/push\/([\w-]+)$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      S.pushes.push({ id: m[1], headers: { authorization: req.headers.authorization, encoding: req.headers['content-encoding'], ttl: req.headers.ttl, urgency: req.headers.urgency }, body: body.toString('base64') });
      return send(res, S.pushGone?.[m[1]] ? 410 : 201, undefined);
    }
    // ---------------- control
    m = p.match(/^\/__mock\/([\w-]+)$/);
    if (m) {
      const a = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
      const i = issues.get(a.key);
      switch (m[1]) {
        case 'state': return send(res, 200, { counters: S.counters, lastAuthorize: S.lastAuthorize, lastJql: S.lastJql, pushes: S.pushes, apiLog: S.apiLog.slice(-50), revoked: S.revokedFamilies.size });
        case 'login-as': S.nextLogin = a.account; break;
        case 'deny-next': S.denyNext = true; break;
        case 'access-ttl': S.accessTtl = a.seconds; break;
        case 'leeway': S.leewayMs = a.ms; break;
        case 'expire-access': for (const v of S.access.values()) v.exp = 0; break;
        case 'revoke': for (const v of S.refresh.values()) if (v.account === a.account) S.revokedFamilies.add(v.family); for (const v of S.access.values()) if (v.account === a.account) v.exp = 0; break;
        case 'push-gone': S.pushGone = { ...(S.pushGone || {}), [a.id]: true }; break;
        case 'reset-counters': S.counters = { token: 0, refresh: 0, api: 0, search: 0, breach: 0 }; S.apiLog = []; S.pushes = []; break;
        case 'add': add(a.key, { ...a, assignee: a.assignee === 'me' ? ACCOUNTS.me : a.assignee === 'zed' ? ACCOUNTS.zed : null }); break;
        case 'assign': {
          const prev = i.assignee; i.assignee = a.to === 'me' ? ACCOUNTS.me : a.to === 'zed' ? ACCOUNTS.zed : a.to === 'bob' ? BOB : null;
          i.assigneeChanges.push({ from: prev?.accountId ?? null, to: i.assignee?.accountId ?? null, at: Date.now() });
          hist(i, BOB, [{ field: 'assignee', fieldId: 'assignee', from: prev?.accountId ?? null, to: i.assignee?.accountId ?? null, fromString: prev?.displayName ?? null, toString: i.assignee?.displayName ?? null }]);
          break;
        }
        case 'status': { const from = i.status; i.status = a.to; hist(i, a.self ? ACCOUNTS.me : BOB, [{ field: 'status', fieldId: 'status', from: String(from), to: String(a.to), fromString: STATUSES[from][0], toString: STATUSES[a.to][0] }]); break; }
        case 'priority': { const from = i.priority; i.priority = a.to; hist(i, BOB, [{ field: 'priority', fieldId: 'priority', fromString: from, toString: a.to }]); break; }
        case 'comment': i.comments.push({ id: String(++cid), author: a.self ? ACCOUNTS.me : BOB, created: ts(), body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: a.text || 'Please look at this.' }] }] } }); touch(i); break;
        default: return send(res, 404, { error: 'unknown control' });
      }
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found ' + p });
  } catch (e) { send(res, 500, { error: String(e?.stack || e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`mock atlassian on http://127.0.0.1:${PORT}`));
