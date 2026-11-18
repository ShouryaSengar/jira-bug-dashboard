// Unit tests and CPU measurements for the Cloud edition's Worker modules, run in Node.
// The real TypeScript sources are bundled with esbuild (shipped with wrangler) and imported directly.
//   node scripts/test-unit.mjs
import { build } from 'esbuild';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jbd-unit-'));
const entry = path.join(out, 'entry.ts');
fs.writeFileSync(entry, `
export * from '${cloud}/src/crypto.ts';
export { encryptPayload, endpointAllowed } from '${cloud}/src/push.ts';
export { pushPlan, quietNow } from '${cloud}/src/monitor.ts';
export { classifyChanges, classifyNew } from '${cloud}/../src/core/detect.ts';
export { getMyBugs, makePriorityRank } from '${cloud}/../src/core/jira.ts';
`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: path.join(out, 'm.mjs'), logLevel: 'error' });
const m = await import(path.join(out, 'm.mjs'));

let fails = 0, passes = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); c ? passes++ : fails++; };
const throws = async (f) => { try { await f(); return false; } catch { return true; } };

// ---------------------------------------------------------------- token encryption
const key = Buffer.from(randomBytes(32)).toString('base64');
const blob = await m.encryptJson(key, 'grant:user-a', { access: 'A', refresh: 'R' });
ok('AES-GCM round trip', JSON.stringify(await m.decryptJson(key, 'grant:user-a', blob)) === '{"access":"A","refresh":"R"}');
ok('ciphertext bound to its owner (other user id fails)', await throws(() => m.decryptJson(key, 'grant:user-b', blob)));
ok('tampered ciphertext fails', await throws(() => m.decryptJson(key, 'grant:user-a', blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-1))));
ok('wrong key fails', await throws(() => m.decryptJson(Buffer.from(randomBytes(32)).toString('base64'), 'grant:user-a', blob)));
ok('fresh IV per encryption', (await m.encryptJson(key, 'x', 1)) !== (await m.encryptJson(key, 'x', 1)));
ok('constant-time compare', m.safeEqual('abc', 'abc') && !m.safeEqual('abc', 'abd') && !m.safeEqual('abc', 'ab'));

// ---------------------------------------------------------------- push
const ua = createECDH('prime256v1'); ua.generateKeys(); const auth = randomBytes(16);
const target = { endpoint: 'https://fcm.googleapis.com/x', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
const body = Buffer.from(await m.encryptPayload(target, new TextEncoder().encode('{"hello":"world"}')));
const salt = body.subarray(0, 16), as = body.subarray(21, 21 + body[20]), ct = body.subarray(21 + body[20]);
const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(as), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), as]), 32));
const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
d.setAuthTag(ct.subarray(ct.length - 16));
const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
ok('RFC 8291 payload decrypts with Node crypto', pt.subarray(0, -1).toString() === '{"hello":"world"}' && pt.at(-1) === 2 && body.readUInt32BE(16) === 4096);
const env = { PUSH_ENDPOINT_HOSTS: 'fcm.googleapis.com,web.push.apple.com', ALLOW_INSECURE_PUSH: '0' };
ok('push allow-list: real services pass', m.endpointAllowed(env, 'https://fcm.googleapis.com/fcm/send/abc') && m.endpointAllowed(env, 'https://web.push.apple.com/x'));
ok('push allow-list: SSRF targets refused', ['http://fcm.googleapis.com/x', 'https://169.254.169.254/', 'https://fcm.googleapis.com.evil.com/x', 'https://evilfcm.googleapis.com.attacker/x', 'https://u:p@fcm.googleapis.com/x', 'notaurl']
  .every((u) => !m.endpointAllowed(env, u)));

// ---------------------------------------------------------------- notification rules
const ev = (o) => ({ id: 1, type: 'comment', at: '', occurredAt: new Date().toISOString(), key: 'ABC-1', summary: 'Login broken', project: 'ABC', url: '', actor: 'Bob', from: null, to: null, detail: null, escalated: false, importance: 'normal', own: false, read: false, ...o });
const noon = new Date('2026-06-01T06:30:00Z'); // 12:00 in Asia/Kolkata
ok('quiet hours honour the user time zone', m.quietNow({ quiet: { on: true, from: '11:00', to: '13:00' }, tz: 'Asia/Kolkata' }, noon) && !m.quietNow({ quiet: { on: true, from: '11:00', to: '13:00' }, tz: 'UTC' }, noon));
ok('quiet hours wrap past midnight', m.quietNow({ quiet: { on: true, from: '22:00', to: '08:00' }, tz: 'UTC' }, new Date('2026-06-01T02:00:00Z')));
ok('pushPlan: nothing unless push is enabled', m.pushPlan([ev()], {}).length === 0 && m.pushPlan([ev()], { push: true }).length === 1);
ok('pushPlan: disabled types and "important only" respected', m.pushPlan([ev()], { push: true, types: { comment: false } }).length === 0 && m.pushPlan([ev()], { push: true, frequency: 'important' }).length === 0);
ok('pushPlan: a burst of 6 becomes 2 notifications + 1 summary', (() => { const p = m.pushPlan([1, 2, 3, 4, 5, 6].map((i) => ev({ id: i, key: `A-${i}` })), { push: true }); return p.length === 3 && /4 more updates/.test(p[2].title); })());

// ---------------------------------------------------------------- CPU (Workers Free: 10 ms per invocation)
const cpu = (f, runs = 50) => { for (let i = 0; i < 5; i++) f(); const t = process.cpuUsage(); for (let i = 0; i < runs; i++) f(); const u = process.cpuUsage(t); return (u.user + u.system) / 1000 / runs; };
const cpuAsync = async (f, runs = 30) => { for (let i = 0; i < 3; i++) await f(); const t = process.cpuUsage(); for (let i = 0; i < runs; i++) await f(); const u = process.cpuUsage(t); return (u.user + u.system) / 1000 / runs; };
const issue = (n) => ({ key: `ABC-${n}`, fields: { summary: `Bug number ${n} with a reasonably long summary for realism`, status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, customfield_1: { value: '2 - Major' },
  assignee: { accountId: 'me', displayName: 'Me' }, reporter: { accountId: 'r', displayName: 'Reporter Person', emailAddress: 'r@x.com' }, created: '2026-10-01T10:00:00.000+0530', updated: '2026-11-18T10:00:00.000+0530', resolutiondate: null,
  issuetype: { name: 'Bug' }, project: { key: 'ABC', name: 'Alpha' }, labels: ['regression'], parent: { key: 'ABC-1', fields: { summary: 'Epic', issuetype: { name: 'Epic' } } }, issuelinks: [] } });
const page300 = JSON.stringify({ issues: Array.from({ length: 100 }, (_, i) => issue(i)), isLast: true });
const fakeApi = { siteUrl: 'https://x.atlassian.net', cacheKey: 'k', request: async (p) => (p.startsWith('/rest/api/3/search') ? JSON.parse(page300) : {}) };
const tMine = await cpuAsync(() => m.getMyBugs(fakeApi, { me: { name: 'Me', email: null }, severityIds: ['customfield_1'], issueTypes: 'Bug', closedWindowDays: 90, lastActivity: () => null, assignedEvents: () => false, maxIssues: 100 }));
const snap = JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`ABC-${i}`, ['2026-11-18T10:00:00.000+0530', `Bug ${i} summary text`, 'ABC']])));
const seen = JSON.stringify(Array.from({ length: 3000 }, (_, i) => `ABC-${i % 300}:h${i}:status`));
const tIdle = cpu(() => { const s = JSON.parse(snap); const n = new Set(JSON.parse(seen)); JSON.parse('{"issues":[],"isLast":true}'); return [s, n]; });
const tWrite = cpu(() => [JSON.stringify(JSON.parse(snap)), JSON.stringify([...new Set(JSON.parse(seen))].slice(-3000))]);
const hist = Array.from({ length: 100 }, (_, i) => ({ id: String(i), author: { accountId: 'bob', displayName: 'Bob' }, created: new Date(Date.now() - (100 - i) * 1000).toISOString(), items: [{ field: 'status', fieldId: 'status', from: '1', to: '2', fromString: 'To Do', toString: 'In Progress' }] }));
const tClassify = cpu(() => m.classifyChanges({ siteUrl: 's', meId: 'me', severityIds: new Set(), severityNames: new Set(), seen: new Set(), statusCat: () => 'indeterminate', priorityRank: m.makePriorityRank(null) }, issue(1), hist, [], Date.now() - 200_000));
const tPush = await cpuAsync(() => m.encryptPayload(target, new TextEncoder().encode('x'.repeat(2500))));
const tCrypt = await cpuAsync(() => m.decryptJson(key, 'grant:user-a', blob));
console.log(`\nCPU per operation (Node ${process.version}, same V8 as workerd; ${os.cpus()[0].model}):`);
for (const [n, v] of [['For You page: parse + map 100 issues', tMine], ['idle monitor check: load snapshot (300) + seen (3000)', tIdle], ['monitor commit: serialise snapshot + seen', tWrite], ['classify 100 changelog entries', tClassify], ['Web Push encrypt (2.5 KB)', tPush], ['decrypt OAuth tokens', tCrypt]]) console.log(`  ${v.toFixed(3).padStart(7)} ms  ${n}`);
ok(`a busy monitor run (6 idle users + 1 changed user + 1 push) stays under 10 ms CPU here (${(6 * tIdle + tWrite + tClassify + tPush + 2 * tCrypt).toFixed(2)} ms)`, 6 * tIdle + tWrite + tClassify + tPush + 2 * tCrypt < 10);
ok(`For You request stays under 10 ms CPU here (${(tMine * 3 + tCrypt).toFixed(2)} ms for 300 bugs)`, tMine * 3 + tCrypt < 10);

fs.rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nAll ${passes} passed`);
process.exit(fails ? 1 : 0);
