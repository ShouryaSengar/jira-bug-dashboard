// End-to-end check of JARVIS event detection against scripts/mock-jira.mjs.
// Start the mock and the dashboard first (see mock-jira.mjs), then: node scripts/test-jarvis.mjs
const D = process.env.DASH || 'http://localhost:4800', M = process.env.MOCK || 'http://127.0.0.1:4700';
const post = (b, p, body = {}) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JBD': '1' }, body: JSON.stringify(body) }).then((r) => r.json());
const mock = (a, body) => post(M, '/__mock/' + a, body);
const events = async (after = 0) => (await (await fetch(`${D}/api/jarvis/events?after=${after}`)).json()).events;
const status = async () => (await fetch(D + '/api/jarvis/status')).json();
const sync = async () => { await post(D, '/api/jarvis/sync'); await new Promise((r) => setTimeout(r, 1500)); };
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const summarize = (es) => es.map((e) => `${e.type}:${e.key}${e.own ? '(own)' : ''}`).join(', ') || '(none)';

let last = (await status()).lastEventId;
const step = async (name, act, expect) => {
  await act(); await sync();
  const es = await events(last); last = es.at(-1)?.id ?? last;
  const got = summarize(es);
  check(name, got === expect, `expected [${expect}] got [${got}]`);
  return es;
};

check('baseline produced no events', last === 0, String(last));
await step('nothing changed -> no events', async () => {}, '(none)');
await step('updated bump without changelog -> no events', () => mock('noise', { key: 'ABC-1' }), '(none)');
await step('new bug assigned to me', async () => { await mock('add', { key: 'ABC-3', summary: 'Brand new bug', assignee: null }); await mock('assign', { key: 'ABC-3', to: 'me' }); }, 'assigned:ABC-3');
await step('status To Do -> In Progress', () => mock('status', { key: 'ABC-2', to: 2 }), 'status:ABC-2');
await step('priority escalated', () => mock('priority', { key: 'ABC-2', to: 'Highest' }), 'priority:ABC-2');
let es = await events(0); const pr = es.find((e) => e.type === 'priority');
check('priority flagged escalated', pr?.escalated === true && pr.from === 'Medium' && pr.to === 'Highest');
await step('priority lowered is not escalated', () => mock('priority', { key: 'ABC-2', to: 'Low' }), 'priority:ABC-2');
check('lowered priority escalated=false', (await events(0)).filter((e) => e.type === 'priority').at(-1)?.escalated === false);
await step('severity escalated', () => mock('severity', { key: 'ABC-1', to: '1 - Critical' }), 'severity:ABC-1');
await step('comment from someone else', () => mock('comment', { key: 'ABC-1', text: 'Can you check the logs?' }), 'comment:ABC-1');
check('comment excerpt captured', (await events(0)).at(-1)?.detail === 'Can you check the logs?');
await step('my own comment is flagged own', () => mock('comment', { key: 'ABC-1', self: true }), 'comment:ABC-1(own)');
await step('resolved', () => mock('status', { key: 'ABC-1', to: 3 }), 'resolved:ABC-1');
await step('reopened', () => mock('status', { key: 'ABC-1', to: 4 }), 'reopened:ABC-1');
await step('reassigned away', () => mock('assign', { key: 'ABC-2', to: 'bob' }), 'reassigned_away:ABC-2');
await step('unassigned', () => mock('assign', { key: 'ABC-3', to: null }), 'unassigned:ABC-3');
await step('assigned back', () => mock('assign', { key: 'ABC-2', to: 'me' }), 'assigned:ABC-2');
await step('other field edit -> low importance "updated"', () => mock('edit', { key: 'ABC-1', summary: 'Login fails on Safari 17' }), 'updated:ABC-1');
await step('two changes at once -> two events, one sync', async () => { await mock('status', { key: 'ABC-2', to: 2 }); await mock('comment', { key: 'ABC-2' }); }, 'status:ABC-2, comment:ABC-2');
await step('repeat sync -> no duplicates', async () => {}, '(none)');

const ids = (await events(0)).map((e) => e.id);
check('event ids are unique and increasing', new Set(ids).size === ids.length && ids.every((v, i) => i === 0 || v > ids[i - 1]));
const s = await status();
check('status reports monitored bugs', s.monitored >= 3 && s.state === 'online', JSON.stringify(s));
const mine = await (await fetch(D + '/api/mine')).json();
check('/api/mine returns only my bugs', mine.bugs.every((b) => b.assignee?.name === 'Me Tester') && !mine.bugs.some((b) => b.key === 'ABC-7'), mine.bugs.map((b) => b.key).join());
check('/api/mine has project, severity, last activity', mine.bugs.every((b) => b.project.key) && mine.bugs.some((b) => b.severity) && mine.bugs.some((b) => b.lastActivity));
const det = await (await fetch(D + '/api/issue?key=ABC-1')).json();
check('/api/issue returns comments, history, description', det.comments.length >= 1 && det.history.length >= 1 && /broken/.test(det.description), JSON.stringify(det).slice(0, 200));

console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
process.exit(fails ? 1 : 0);
