// Unit checks for the announcement policy (no browser needed): node scripts/test-core.mjs  (after npm run build)
import * as C from '../dist/client/jarvis-core.js';
let fails = 0; const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); if (!c) fails++; };
const ev = (o) => ({ id: 1, type: 'status', at: '', occurredAt: new Date().toISOString(), key: 'ABC-123', summary: 'Login button does not respond on Safari', project: 'ABC', url: '', actor: 'Bob', from: 'To Do', to: 'In Progress', detail: null, escalated: false, importance: 'normal', own: false, read: false, ...o });
const P = C.DEFAULT_JARVIS_PREFS, evening = new Date(2026, 0, 1, 19, 0), noon = new Date(2026, 0, 1, 10, 0), r0 = () => 0;
const say = (e, p = P, d = evening, n = 1) => C.speechFor(e, p, d, r0, n);

ok('assigned greets by time of day', /^Good evening, sir\. A new bug has landed on your desk\. A B C 123/.test(say(ev({ type: 'assigned', importance: 'high' }))), say(ev({ type: 'assigned' })));
ok('morning greeting', /^Good morning/.test(say(ev({ type: 'assigned' }), P, noon)));
ok('speech includes the summary', say(ev({ type: 'assigned' })).includes('Login button does not respond'));
ok('status names the new state', /In Progress/.test(say(ev())));
ok('escalation wording', /escalated/.test(say(ev({ type: 'priority', escalated: true, to: 'Highest' }))));
ok('lowered priority is not "escalated"', !/escalated/.test(say(ev({ type: 'priority', escalated: false, to: 'Low' }))));
ok('reopened', /back from the dead/.test(say(ev({ type: 'reopened' }))));
ok('resolved', /Excellent work, sir/.test(say(ev({ type: 'resolved' }))));
ok('closed', /Mission accomplished, sir/.test(say(ev({ type: 'closed' }))));
ok('no address -> no "sir", still capitalised', !/sir/i.test(say(ev({ type: 'closed' }), { ...P, address: '' })) && /^[A-Z]/.test(say(ev({ type: 'closed' }), { ...P, address: '' })), say(ev({ type: 'closed' }), { ...P, address: '' }));
ok('address "ma\'am"', /Ma'am, /.test(say(ev({ type: 'resolved' }), { ...P, address: "ma'am" }, evening, 1)) || /ma'am/.test(say(ev({ type: 'resolved' }), { ...P, address: "ma'am" })));
ok('many comments collapse', /3 new comments/.test(say(ev({ type: 'comment' }), P, evening, 3)));
ok('spoken key', C.spokenKey('ABC-123') === 'A B C 123' && C.spokenKey('PLATFORM-9') === 'PLATFORM 9');
ok('summary trimmed + links removed', C.spokenSummary('See https://x.io/a?b=1 now '.repeat(10)).length <= 72 && !/https/.test(C.spokenSummary('see https://x.io')));
// variation never repeats back-to-back
let rep = false, prev = ''; const seq = [0, 0, 0, 0, 0, 0].map(() => C.speechFor(ev({ type: 'status' }), P, evening, () => 0)); seq.forEach((s) => { if (s === prev) rep = true; prev = s; });
ok('same variation is not used twice in a row', !rep, seq.join(' | '));

// policy
ok('own actions are silent', C.plan([ev({ own: true })], P, evening).length === 0);
ok('disabled type is silent', C.plan([ev({ type: 'comment' })], { ...P, types: { ...P.types, comment: false } }, evening).length === 0);
ok('low importance is never spoken', C.plan([ev({ type: 'updated', importance: 'low' })], { ...P, types: { ...P.types, updated: true } }, evening)[0].speech === null);
const q = { ...P, quiet: { on: true, from: '22:00', to: '08:00' } };
ok('quiet hours 23:00 silent', C.plan([ev()], q, new Date(2026, 0, 1, 23, 0)).length === 0);
ok('quiet hours 03:00 silent (wraps midnight)', C.plan([ev()], q, new Date(2026, 0, 1, 3, 0)).length === 0);
ok('quiet hours 12:00 audible', C.plan([ev()], q, noon).length === 1);
ok('quiet hours disabled', C.inQuietHours({ on: false, from: '00:00', to: '23:59' }, noon) === false);
ok('same-day quiet window', C.inQuietHours({ on: true, from: '13:00', to: '15:00' }, new Date(2026, 0, 1, 14, 0)) && !C.inQuietHours({ on: true, from: '13:00', to: '15:00' }, noon));
const one = C.plan([ev(), ev({ id: 2, key: 'ABC-9' })], P, evening);
ok('two events spoken individually', one.filter((a) => a.speech).length === 2 && one.every((a) => a.notify));
const burst = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6'].map((key, i) => ev({ id: i + 10, key, type: i === 0 ? 'assigned' : 'comment', importance: i === 0 ? 'high' : 'normal' }));
const b = C.plan(burst, P, evening);
ok('burst -> one spoken briefing, never six voices', b.filter((a) => a.speech).length === 1, JSON.stringify(b.map((a) => a.speech)));
ok('burst -> at most 3 desktop notifications', b.filter((a) => a.notify).length <= 3, String(b.filter((a) => a.notify).length));
ok('briefing mentions counts and top item', /6 updates across 6 bugs/.test(b.find((a) => a.speech).speech) && /A 1/.test(b.find((a) => a.speech).speech), b.find((a) => a.speech).speech);
const dup = C.plan([ev({ id: 1, type: 'comment' }), ev({ id: 2, type: 'comment' }), ev({ id: 3, type: 'comment' })], P, evening);
ok('3 comments on one bug -> one announcement', dup.length === 1 && /3 new comments/.test(dup[0].speech) && /3 new comments/.test(dup[0].title), JSON.stringify(dup));
const imp = C.plan([ev({ type: 'comment' }), ev({ type: 'assigned', key: 'Z-1', importance: 'high' })], { ...P, frequency: 'important' }, evening);
ok('"important only" drops plain comments', imp.length === 1 && imp[0].events[0].key === 'Z-1');
const dg = C.plan([ev(), ev({ key: 'X-2' })], { ...P, frequency: 'digest' }, evening);
ok('digest mode batches two events into one briefing', dg.filter((a) => a.speech).length === 1);
ok('notification text has key and summary', (() => { const n = C.notificationFor(ev({ type: 'assigned' })); return n.title.includes('ABC-123') && n.body.includes('Login button'); })());
const wb = C.welcomeBack([ev({ type: 'assigned' }), ev({ key: 'Q-1' })], P, evening);
ok('welcome back digest', /Good evening, sir\. While you were away, 2 things happened across 2 of your bugs\. 1 is a new assignment/.test(wb), wb);
ok('welcome back is silent when nothing happened', C.welcomeBack([ev({ own: true })], P, evening) === null);
console.log(fails ? `\n${fails} FAILED` : '\nAll passed'); process.exit(fails ? 1 : 0);
