// A tiny fake Jira Cloud used to test JARVIS without real credentials.
//   node scripts/mock-jira.mjs            (listens on 127.0.0.1:4700)
// Point the dashboard at it:  JIRA_URL=http://127.0.0.1:4700 JIRA_USERNAME=me@x.com JIRA_API_TOKEN=x npm start
// Then change things through the /__mock/* endpoints (see the bottom of this file).
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4700);
const ME = { accountId: 'acc-me', displayName: 'Me Tester', emailAddress: 'me@x.com' };
const OTHER = { accountId: 'acc-bob', displayName: 'Bob Builder' };
const STATUSES = { 1: ['To Do', 'new'], 2: ['In Progress', 'indeterminate'], 3: ['Done', 'done'], 4: ['Reopened', 'new'] };
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
let clock = Date.now() - 3600_000;
const tick = () => new Date((clock += 1000)).toISOString().replace('Z', '+0000');
let hid = 100, cid = 500;
const issues = new Map();

function add(key, o = {}) {
  const t = tick();
  issues.set(key, { key, summary: o.summary || `Bug ${key}`, status: o.status || 1, priority: o.priority || 'Medium', sev: o.sev || '3 - Medium',
    assignee: o.assignee === undefined ? ME : o.assignee, reporter: OTHER, created: t, updated: t, project: { key: key.split('-')[0], name: 'Project ' + key.split('-')[0] },
    labels: [], parent: null, history: [], comments: [], links: [] });
}
const touch = (i) => { i.updated = tick(); };
const hist = (i, author, items) => { i.history.push({ id: String(++hid), author, created: tick(), items }); touch(i); };
const f = (i) => ({
  summary: i.summary, status: { id: String(i.status), name: STATUSES[i.status][0], statusCategory: { key: STATUSES[i.status][1] } },
  priority: { name: i.priority }, customfield_10100: { value: i.sev }, assignee: i.assignee, reporter: i.reporter, created: i.created, updated: i.updated,
  resolutiondate: STATUSES[i.status][1] === 'done' ? i.updated : null, issuetype: { name: 'Bug' }, project: i.project, labels: i.labels,
  parent: i.parent && { key: i.parent, fields: { summary: 'Parent epic', issuetype: { name: 'Epic' } } }, issuelinks: i.links,
  description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It is broken.' }] }] },
});

add('ABC-1', { summary: 'Login fails on Safari', status: 2, priority: 'High' });
add('ABC-2', { summary: 'Export hangs', status: 1 });
add('XYZ-9', { summary: 'Old closed bug', status: 3 });
add('ABC-7', { summary: 'Belongs to Bob', assignee: OTHER });

const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = async (req) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {}; };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (p === '/rest/api/3/myself') return send(res, 200, ME);
    if (p === '/rest/api/3/field') return send(res, 200, [{ id: 'customfield_10100', name: 'Defect Severity' }]);
    if (p === '/rest/api/3/status') return send(res, 200, Object.entries(STATUSES).map(([id, [name, k]]) => ({ id, name, statusCategory: { key: k } })));
    if (p === '/rest/api/3/priority') return send(res, 200, PRIORITIES.map((name) => ({ name })));
    if (p === '/rest/api/3/search/jql') {
      const b = await body(req); const jql = b.jql || '';
      let list = [...issues.values()].filter((i) => i.assignee?.accountId === ME.accountId);
      if (!/CHANGED TO/.test(jql)) list = list.filter((i) => STATUSES[i.status][1] !== 'done' || /updated >= -/.test(jql));
      else list = [];
      return send(res, 200, { issues: list.map((i) => ({ key: i.key, fields: f(i) })), isLast: true });
    }
    let m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9-]+)\/changelog$/);
    if (m) { const i = issues.get(m[1]); return i ? send(res, 200, { values: i.history, total: i.history.length, isLast: true }) : send(res, 404, { errorMessages: ['nope'] }); }
    m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9-]+)\/comment$/);
    if (m) { const i = issues.get(m[1]); return i ? send(res, 200, { comments: [...i.comments].reverse() }) : send(res, 404, { errorMessages: ['nope'] }); }
    m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9-]+)$/);
    if (m) { const i = issues.get(m[1]); return i ? send(res, 200, { key: i.key, fields: f(i) }) : send(res, 404, { errorMessages: ['nope'] }); }

    // ---- control endpoints
    m = p.match(/^\/__mock\/(\w+)$/);
    if (m && req.method === 'POST') {
      const a = await body(req); const i = issues.get(a.key); const act = m[1];
      if (act === 'add') add(a.key, a);
      else if (act === 'assign') { const prev = i.assignee; i.assignee = a.to === 'me' ? ME : a.to === 'bob' ? OTHER : null;
        hist(i, OTHER, [{ field: 'assignee', fieldId: 'assignee', from: prev?.accountId ?? null, to: i.assignee?.accountId ?? null, fromString: prev?.displayName ?? null, toString: i.assignee?.displayName ?? null }]); }
      else if (act === 'status') { const from = i.status; i.status = a.to; hist(i, a.self ? ME : OTHER, [{ field: 'status', fieldId: 'status', from: String(from), to: String(a.to), fromString: STATUSES[from][0], toString: STATUSES[a.to][0] }]); }
      else if (act === 'priority') { const from = i.priority; i.priority = a.to; hist(i, OTHER, [{ field: 'priority', fieldId: 'priority', fromString: from, toString: a.to }]); }
      else if (act === 'severity') { const from = i.sev; i.sev = a.to; hist(i, OTHER, [{ field: 'Defect Severity', fieldId: 'customfield_10100', fromString: from, toString: a.to }]); }
      else if (act === 'comment') { i.comments.push({ id: String(++cid), author: a.self ? ME : OTHER, created: tick(), body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: a.text || 'Please look at this.' }] }] } }); touch(i); }
      else if (act === 'edit') { i.summary = a.summary; hist(i, OTHER, [{ field: 'summary', fieldId: 'summary', fromString: 'old', toString: a.summary }]); }
      else if (act === 'noise') { touch(i); } // updated changes with no new changelog entry
      else if (act === 'fail') { global.failNext = a.n || 1; }
      return send(res, 200, { ok: true });
    }
    send(res, 404, { errorMessages: ['not found ' + p] });
  } catch (e) { send(res, 500, { errorMessages: [String(e)] }); }
}).listen(PORT, '127.0.0.1', () => console.log(`mock jira on http://127.0.0.1:${PORT}`));
