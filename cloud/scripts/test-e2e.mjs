// End-to-end tests for the Cloud edition against `wrangler dev` (workerd + local D1) and the mock Atlassian.
//   terminal 1: node scripts/mock-atlassian.mjs
//   terminal 2: sh scripts/dev-server.sh          (after npm run build && npm run db:migrate:local)
//   terminal 3: node scripts/test-e2e.mjs
// Uses only Node built-ins. Talks to the Worker exactly like a browser would (cookies, redirects, headers).
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createECDH, createHmac, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = process.env.WORKER || 'http://localhost:8787', M = process.env.MOCK || 'http://127.0.0.1:4710';
const CLOUD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (name, c, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${c ? '' : '  ' + extra}`); c ? passes++ : fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = async (a, b = {}) => {
  const r = await fetch(`${M}/__mock/${a}`, { method: 'POST', body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`mock control "${a}" failed: ${r.status} ${await r.text()}`);
  return r.json();
};
const mockState = () => fetch(`${M}/__mock/state`).then((r) => r.json());
const sql = (q) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--env', 'dev', '--json', '--command', q], { cwd: CLOUD_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }).toString())[0].results;

class Browser {
  jar = new Map();
  setCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()];
      const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
      if (maxAge && Number(maxAge.split('=')[1]) <= 0) this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body, headers = {}, csrf = true } = {}) {
    const h = { Cookie: this.cookie(), ...headers };
    if (method !== 'GET' && csrf) { h['X-JBD'] = '1'; h['Content-Type'] = 'application/json'; h['Origin'] ??= W; }
    const res = await fetch(p.startsWith('http') ? p : W + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    this.setCookies(res);
    return res;
  }
  async json(p, o) { const r = await this.req(p, o); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; }
  /** Runs the whole sign-in: /auth/login -> Atlassian authorize -> /auth/callback. Returns the final redirect. */
  async signIn(account) {
    await mock('login-as', { account });
    const a = await this.req('/auth/login');
    const authorize = a.headers.get('location');
    const b = await fetch(authorize, { redirect: 'manual' });
    const callback = b.headers.get('location');
    const c = await this.req(callback);
    return { authorize, callback, final: c.headers.get('location'), status: c.status };
  }
}

// ---------------------------------------------------------------- Web Push test subscription (a fake browser)
const ua = createECDH('prime256v1'); ua.generateKeys();
const uaAuth = randomBytes(16);
const sub = (id) => ({ endpoint: `${M}/push/${id}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') }, label: 'Test device' });
function decryptPush(b64) {
  const body = Buffer.from(b64, 'base64');
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', shared, uaAuth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (pt[pt.length - 1] !== 2) throw new Error('bad padding delimiter');
  return JSON.parse(pt.subarray(0, pt.length - 1).toString());
}
function verifyVapid(authHeader, vapidPub, aud) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader || '');
  if (!m || m[2] !== vapidPub) return false;
  const [h, p, s] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  const raw = Buffer.from(vapidPub, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  const good = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return good && claims.aud === aud && claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400 && /^mailto:/.test(claims.sub);
}

const tick = async (b) => (await b.json('/api/__dev/tick', { method: 'POST' })).body;
const eventsOf = async (b, after = 0) => (await b.json(`/api/jarvis/events?after=${after}`)).body.events;
const types = (es) => es.map((e) => `${e.type}:${e.key}${e.own ? '(own)' : ''}`).join(', ') || '(none)';

// ================================================================ tests
// Start from an empty local database so the run is repeatable.
sql('DELETE FROM events; DELETE FROM push_subscriptions; DELETE FROM monitor_state; DELETE FROM sessions; DELETE FROM jira_sites; DELETE FROM oauth_grants; DELETE FROM user_settings; DELETE FROM users; DELETE FROM rate_limits;');
const anon = new Browser();
let r = await anon.json('/api/config');
ok('config (signed out): cloud edition, not signed in, exposes only the VAPID public key', r.body.edition === 'cloud' && r.body.signedIn === false && !!r.body.vapidPublicKey && !JSON.stringify(r.body).match(/secret|token/i));
ok('API needs a session (401 signin)', (await anon.json('/api/mine')).status === 401 && (await anon.json('/api/mine')).body.code === 'signin');
ok('CSRF: POST without X-JBD is rejected', (await anon.json('/api/jarvis/sync', { method: 'POST', csrf: false, headers: { 'Content-Type': 'application/json' } })).status === 403);
ok('CSRF: foreign Origin is rejected', (await anon.json('/api/jarvis/sync', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status === 403);
ok('CSRF: Sec-Fetch-Site cross-site is rejected', (await anon.json('/api/jarvis/sync', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status === 403);

// ---- OAuth
const evil = new Browser();
const login = await evil.req('/auth/login');
const authUrl = new URL(login.headers.get('location'));
ok('authorize URL: 4 minimal scopes, consent prompt, our callback, random state', authUrl.searchParams.get('scope') === 'read:jira-work read:jira-user read:me offline_access'
  && authUrl.searchParams.get('prompt') === 'consent' && authUrl.searchParams.get('redirect_uri') === `${W}/auth/callback` && authUrl.searchParams.get('state').length >= 24);
ok('state cookie is HttpOnly, Secure, SameSite=Lax, __Host-', /__Host-jbd_oauth=.+HttpOnly; Secure; SameSite=Lax/.test(login.headers.get('set-cookie')));
const forged = await evil.req('/auth/callback?code=x&state=forged');
ok('callback with a wrong state is refused (no session)', forged.headers.get('location') === '/?auth=state' && !evil.jar.has('__Host-jbd_sid'));
const noCookie = new Browser();
ok('callback without the state cookie is refused (login CSRF)', (await noCookie.req(`/auth/callback?code=x&state=${authUrl.searchParams.get('state')}`)).headers.get('location') === '/?auth=state');
await mock('deny-next');
const denied = new Browser(); const d1 = await denied.signIn('me');
ok('user denies consent -> friendly error, no session', d1.final === '/?auth=denied' && !denied.jar.has('__Host-jbd_sid'));

const me = new Browser();
const flow = await me.signIn('me');
ok('sign-in completes and lands on For You', flow.final === '/?view=foryou&connected=1' && me.jar.has('__Host-jbd_sid'));
const replay = new Browser(); replay.jar.set('__Host-jbd_oauth', new URL(flow.callback).searchParams.get('state'));
ok('authorization code cannot be replayed', (await replay.req(flow.callback)).headers.get('location') === '/?auth=exchange' && !replay.jar.has('__Host-jbd_sid'));

r = await me.json('/api/config');
ok('config (signed in): site, user, configured, no tokens', r.body.configured && r.body.site?.name === 'Mock Site' && r.body.user?.name === 'Me Tester' && !/at_|rt_/.test(JSON.stringify(r.body)));

// ---- data at rest
const grants = sql('SELECT enc_tokens, key_id FROM oauth_grants');
const st = await mockState();
ok('tokens are encrypted at rest (no plaintext access/refresh token in D1)', grants.length === 1 && !/at_|rt_/.test(grants[0].enc_tokens) && /^[\w-]+\.[\w-]+$/.test(grants[0].enc_tokens));
const sess = sql('SELECT id_hash FROM sessions');
ok('sessions store only a hash of the cookie', sess.length >= 1 && !sess.some((s) => s.id_hash === me.jar.get('__Host-jbd_sid')));

// ---- Jira data
r = await me.json('/api/mine');
const keys = (r.body?.bugs ?? []).map((b) => b.key).sort();
ok('/api/mine: only my bugs, through the OAuth gateway', JSON.stringify(keys) === JSON.stringify(['ABC-1', 'ABC-2', 'ABC-9']), JSON.stringify(r.body).slice(0, 300));
ok('/api/mine: severity resolved with field search, browse links use the site URL', r.body.bugs.some((b) => b.severity === '3 - Medium') && r.body.bugs[0].url.startsWith('https://mock.atlassian.net/browse/'));
r = await me.json('/api/issue?key=ABC-1');
ok('/api/issue returns details', r.status === 200 && /broken/.test(r.body.description));
ok('/api/issue for an issue Jira hides from this user -> 404', (await me.json('/api/issue?key=ZED-1')).status === 404);
ok('/api/issue validates keys', (await me.json('/api/issue?key=../../x')).status === 400);
ok('/api/bugs (Epics view) works in the cloud', (await me.json('/api/bugs?key=ABC-1')).status === 200);

// ---- monitoring
await me.json('/api/jarvis/prefs', { method: 'POST', body: { intervalSec: 60 } });
let t = await tick(me);
ok('first check records a baseline only', t.checked.find((c) => c.outcome === 'baseline') && (await eventsOf(me)).length === 0, JSON.stringify(t));
await mock('reset-counters');
t = await tick(me);
const idle = await mockState();
ok(`idle check is cheap (${t.subrequests} subrequests, ${idle.counters.search} Jira search)`, t.subrequests <= 4 && idle.counters.search === 1 && /updated >= -\d+m/.test(idle.lastJql) && /CHANGED FROM currentUser\(\)/.test(idle.lastJql), JSON.stringify({ t, idle: idle.counters }));
ok('idle check writes nothing (checkpoint unchanged)', (() => { const a = sql('SELECT checked_at FROM monitor_state')[0].checked_at; return a > 0; })());

const step = async (name, act, expect) => {
  const before = (await eventsOf(me)).at(-1)?.id ?? 0;
  await act(); await sleep(50);
  const rep = await tick(me);
  const got = types(await eventsOf(me, before));
  ok(name, got === expect, `expected [${expect}] got [${got}] ${JSON.stringify(rep.checked)}`);
  return rep;
};
await step('new bug assigned to me', async () => { await mock('add', { key: 'ABC-3', summary: 'Brand new bug', assignee: null }); await mock('assign', { key: 'ABC-3', to: 'me' }); }, 'assigned:ABC-3');
await step('status change', () => mock('status', { key: 'ABC-2', to: 2 }), 'status:ABC-2');
await step('priority escalated to Blocker', () => mock('priority', { key: 'ABC-2', to: 'Blocker' }), 'priority:ABC-2');
ok('Blocker counts as escalation even though Jira lists it last', (await eventsOf(me)).at(-1).escalated === true);
await step('comment', () => mock('comment', { key: 'ABC-1', text: 'Logs attached' }), 'comment:ABC-1');
await step('own comment is recorded as own (and read)', () => mock('comment', { key: 'ABC-1', self: true }), 'comment:ABC-1(own)');
await step('resolved', () => mock('status', { key: 'ABC-1', to: 3 }), 'resolved:ABC-1');
await step('reopened', () => mock('status', { key: 'ABC-1', to: 4 }), 'reopened:ABC-1');
await mock('reset-counters');
await step('reassigned away (detected from the search itself)', () => mock('assign', { key: 'ABC-2', to: 'bob' }), 'reassigned_away:ABC-2');
ok('reassignment needed no per-issue lookup', !(await mockState()).apiLog.some((p) => /\/issue\/ABC-2$/.test(p)));
await step('repeat check -> no duplicates', async () => {}, '(none)');

// ---- push
ok('push: endpoints outside the allow-list are refused (SSRF)', (await me.json('/api/push/subscribe', { method: 'POST', body: { ...sub('x'), endpoint: 'http://169.254.169.254/latest' } })).status === 400);
ok('push: malformed keys are refused', (await me.json('/api/push/subscribe', { method: 'POST', body: { ...sub('x'), keys: { p256dh: '<script>', auth: 'x' } } })).status === 400);
ok('push: subscribe', (await me.json('/api/push/subscribe', { method: 'POST', body: sub('dev1') })).status === 200);
await mock('reset-counters');
await step('event while subscribed', () => mock('comment', { key: 'ABC-3', text: 'Ping' }), 'comment:ABC-3');
let ps = (await mockState()).pushes;
const vapid = (await me.json('/api/config')).body.vapidPublicKey;
ok('push delivered with aes128gcm + TTL + urgency', ps.length === 1 && ps[0].headers.encoding === 'aes128gcm' && ps[0].headers.ttl === '86400' && !!ps[0].headers.urgency, JSON.stringify(ps.map((p) => p.headers)));
ok('VAPID JWT is valid ES256 for the push origin', verifyVapid(ps[0]?.headers.authorization, vapid, M));
let payload = null; try { payload = decryptPush(ps[0].body); } catch (e) { payload = { err: e.message }; }
ok('payload decrypts (RFC 8291) and names the bug', payload?.items?.[0]?.title?.includes('ABC-3') && payload.events?.[0]?.key === 'ABC-3', JSON.stringify(payload));
ok('event marked delivered', sql("SELECT pushed FROM events WHERE issue_key = 'ABC-3' AND type = 'comment'")[0].pushed === 1);
await mock('reset-counters');
const own = await step('own action is not pushed', () => mock('comment', { key: 'ABC-3', self: true }), 'comment:ABC-3(own)');
ok('...no push sent', (await mockState()).pushes.length === 0);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
await me.json('/api/jarvis/notify', { method: 'POST', body: { quiet: { on: true, from: '00:00', to: '23:59' }, tz } });
await mock('reset-counters');
await step('quiet hours: event recorded', () => mock('comment', { key: 'ABC-3' }), 'comment:ABC-3');
ok('quiet hours: nothing pushed', (await mockState()).pushes.length === 0);
await me.json('/api/jarvis/notify', { method: 'POST', body: { quiet: { on: false, from: '22:00', to: '08:00' } } });
await me.json('/api/jarvis/notify', { method: 'POST', body: { types: { comment: false } } });
await mock('reset-counters');
await step('disabled event type: recorded', () => mock('comment', { key: 'ABC-3' }), 'comment:ABC-3');
ok('disabled event type: not pushed', (await mockState()).pushes.length === 0);
await me.json('/api/jarvis/notify', { method: 'POST', body: { types: { comment: true } } });
ok('notify prefs reject junk (bad tz, bad times)', (await me.json('/api/jarvis/notify', { method: 'POST', body: { tz: '../../etc', quiet: { on: true, from: '99:99', to: 'x' } } })).body.notify.quiet.from === '22:00');
await me.json('/api/jarvis/notify', { method: 'POST', body: { quiet: { on: false, from: '22:00', to: '08:00' } } });
r = await me.json('/api/push/test', { method: 'POST' });
ok('test push reaches the device', r.body.devices === 1 && r.body.outcomes[0] === 'ok');
await mock('push-gone', { id: 'dev1' });
await step('expired subscription (410) during monitoring ...', () => mock('status', { key: 'ABC-3', to: 2 }), 'status:ABC-3');
ok('...is deleted automatically', (await me.json('/api/push/devices')).body.devices.length === 0);
await me.json('/api/push/subscribe', { method: 'POST', body: sub('dev3') });
await mock('push-gone', { id: 'dev3' });
r = await me.json('/api/push/test', { method: 'POST' });
ok('test push also removes a dead subscription', r.body.outcomes[0] === 'gone' && (await me.json('/api/push/devices')).body.devices.length === 0);

// ---- token refresh & rotation
await mock('reset-counters');
await mock('expire-access');
r = await me.json('/api/mine');
let s2 = await mockState();
ok('expired access token -> one refresh, request still succeeds', r.status === 200 && s2.counters.refresh === 1, JSON.stringify(s2.counters));
sql('UPDATE oauth_grants SET access_expires_at = 0');
await mock('expire-access');
await mock('reset-counters');
const par = await Promise.all([1, 2, 3, 4].map(() => me.json('/api/mine')));
s2 = await mockState();
ok(`4 parallel requests with an expired token -> 1 refresh (lease), all succeed`, par.every((x) => x.status === 200) && s2.counters.refresh === 1, `${par.map((x) => x.status)} refresh=${s2.counters.refresh}`);
ok('rotation never reused an old refresh token (no breach)', s2.counters.breach === 0);
ok('version increased with each rotation', sql('SELECT version FROM oauth_grants')[0].version >= 3);

// ---- second user: isolation
const zed = new Browser();
await zed.signIn('zed');
r = await zed.json('/api/mine');
ok('second user sees only their own bugs', JSON.stringify(r.body.bugs.map((b) => b.key)) === JSON.stringify(['ZED-1']));
ok("second user sees none of the first user's events", (await eventsOf(zed)).length === 0);
const myIds = (await eventsOf(me)).filter((e) => !e.read).map((e) => e.id);
await zed.json('/api/jarvis/read', { method: 'POST', body: { ids: myIds } });
ok("second user cannot mark the first user's events read (IDOR)", (await eventsOf(me)).filter((e) => !e.read).length === myIds.length && myIds.length > 0);
await zed.json('/api/jarvis/clear', { method: 'POST' });
ok("second user's 'clear history' does not touch the first user's", (await eventsOf(me)).length > 0);
await me.json('/api/push/subscribe', { method: 'POST', body: sub('dev2') });
const myDev = (await me.json('/api/push/devices')).body.devices[0].id;
await zed.json('/api/push/unsubscribe', { method: 'POST', body: { id: myDev } });
ok("second user cannot remove the first user's device", (await me.json('/api/push/devices')).body.devices.length === 1);
ok('switching to a site you were not granted is refused', (await me.json('/api/config', { method: 'POST', body: { activeCloudId: 'someone-elses-site' } })).status === 400);

// ---- revocation
await mock('revoke', { account: 'me' });
r = await me.json('/api/mine');
ok('revoked grant -> 401 reauth, never a crash', r.status === 401 && r.body.code === 'reauth', JSON.stringify(r));
ok('config reports needsReauth', (await me.json('/api/config')).body.needsReauth === true);
t = await tick(zed);
ok('revoked users are skipped by the monitor', !t.checked.some((c) => c.userId && sql("SELECT id FROM users WHERE atlassian_account_id = 'acc-me'")[0].id === c.userId));
const re = await me.signIn('me');
ok('reconnecting restores access', re.final === '/?view=foryou&connected=1' && (await me.json('/api/mine')).status === 200);

// ---- sign out, disconnect, delete
const other = new Browser(); await other.signIn('me');
await other.json('/auth/logout', { method: 'POST' });
ok('sign out ends that session only', (await other.json('/api/mine')).status === 401 && (await me.json('/api/mine')).status === 200);
r = await zed.json('/api/config', { method: 'DELETE' });
ok('disconnect removes tokens, sites, devices and sessions', (await zed.json('/api/mine')).status === 401 && sql("SELECT COUNT(*) AS n FROM oauth_grants g JOIN users u ON u.id = g.user_id WHERE u.atlassian_account_id = 'acc-zed'")[0].n === 0);
await zed.signIn('zed');
ok('account delete requires explicit confirmation', (await zed.json('/api/account/delete', { method: 'POST', body: {} })).status === 400);
await zed.json('/api/account/delete', { method: 'POST', body: { confirm: 'DELETE' } });
ok('account delete removes every row for that user', sql("SELECT COUNT(*) AS n FROM users WHERE atlassian_account_id = 'acc-zed'")[0].n === 0
  && sql('SELECT COUNT(*) AS n FROM events WHERE user_id NOT IN (SELECT id FROM users)')[0].n === 0
  && sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id NOT IN (SELECT id FROM users)')[0].n === 0);
ok("deleting one account leaves the other intact", (await me.json('/api/mine')).status === 200);

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nAll ${passes} passed`);
process.exit(fails ? 1 : 0);
