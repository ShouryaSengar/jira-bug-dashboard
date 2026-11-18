// "For You": every bug assigned to me, across all projects and epics.

import type { IssueDetail, JarvisEvent, MyBug, MyBugsResponse } from '../shared/types.js';
import { fetchIssue, fetchMine, type Mode } from './api.js';
import { ageHistogram, ageLevel, ageMs, countBy, isDone, isStale, severityColor, statusColor } from './analysis.js';
import { columns, donut, hbars } from './charts.js';
import { greeting } from './jarvis-core.js';
import { eventListHtml, markIssueRead, openJarvisPanel, recentEvents, unreadKeys } from './jarvis.js';
import { DEFAULT_FY, loadFy, loadMineCache, saveFy, saveMineCache, type FyFilters, type FySort, type Prefs } from './store.js';
import { $, debounce, esc, fmtAge, fmtDate, safeUrl, timeAgo } from './util.js';

export interface FyDeps {
  mode(): Mode;
  configured(): boolean;
  prefs(): Prefs;
  openConnect(): void;
}

type Group = 'status' | 'project' | 'priority' | 'severity';
const GROUPS: Group[] = ['status', 'project', 'priority', 'severity'];
const GROUP_LABEL: Record<Group, string> = { status: 'Status', project: 'Project', priority: 'Priority', severity: 'Severity' };
const groupVal: Record<Group, (b: MyBug) => string> = {
  status: (b) => b.status,
  project: (b) => b.project.key,
  priority: (b) => b.priority ?? '—',
  severity: (b) => b.severity ?? '—',
};
const DAY = 864e5;
const PAGE = 50;

let deps: FyDeps;
let data: MyBugsResponse | null = null;
let filters: FyFilters = loadFy();
let visible = PAGE;
let seq = 0;
let loaded = false;
let detailKey: string | null = null;
let detailSeq = 0;
let detailTab: 'comments' | 'history' = 'comments';
let detail: IssueDetail | null = null;

const show = (id: string, on: boolean): void => void ($(id).hidden = !on);
const prefs = (): Prefs => deps.prefs();
const now = (): number => Date.now();

// ------------------------------------------------------------------ loading

export async function showForYou(): Promise<void> {
  renderShell();
  if (!loaded) {
    loaded = true;
    if (deps.mode() !== 'demo') {
      data = loadMineCache();
      if (data) render();
    }
  }
  await refreshForYou();
}

export async function refreshForYou(): Promise<void> {
  if ($('foryouView').hidden) return;
  if (deps.mode() !== 'demo' && !deps.configured()) return renderShell();
  const mine = ++seq;
  $('refreshBtn').classList.add('spin');
  if (!data) show('fyLoading', true);
  try {
    const r = await fetchMine(deps.mode());
    if (mine !== seq) return;
    data = r;
    if (deps.mode() !== 'demo') saveMineCache(r);
    show('fyError', false);
    render();
  } catch (e) {
    if (mine !== seq) return;
    const msg = (e as Error).message;
    if (/not set up/i.test(msg) || ['signin', 'reauth'].includes((e as { code?: string }).code ?? '')) return renderShell();
    $('fyError').innerHTML = `<span>Could not load your bugs: ${esc(msg)}. ${data ? `Showing saved data from ${esc(timeAgo(data.fetchedAt))}.` : ''}</span> <button class="link" data-fy="retry">Retry</button>`;
    show('fyError', true);
    if (data) render();
  } finally {
    if (mine === seq) {
      show('fyLoading', false);
      $('refreshBtn').classList.remove('spin');
    }
  }
}

function renderShell(): void {
  const needsJira = deps.mode() !== 'demo' && !deps.configured();
  show('fyConnect', needsJira);
  show('fyBody', !needsJira && data !== null);
  if (needsJira) show('fyLoading', false);
}

/** New activity from JARVIS: reload quietly so the list matches what was just announced. */
export const onActivity = debounce(() => {
  if (!$('foryouView').hidden) void refreshForYou();
}, 2500);

// ------------------------------------------------------------------ derived data

const isOpen = (b: MyBug): boolean => !isDone(b);
const inProgress = (b: MyBug): boolean => b.statusCategory === 'indeterminate' && !b.blocked;
const recentlyUpdated = (b: MyBug): boolean => now() - Date.parse(b.updated) < DAY;

function matches(b: MyBug, f: FyFilters): boolean {
  const p = prefs();
  const pass = (sel: string[], v: string): boolean => !sel.length || sel.includes(v);
  if (!pass(f.status, b.status) || !pass(f.project, b.project.key) || !pass(f.priority, b.priority ?? '—') || !pass(f.severity, b.severity ?? '—')) return false;
  if (f.openOnly && !isOpen(b)) return false;
  if (f.closedOnly && isOpen(b)) return false;
  if (f.inProgress && !(isOpen(b) && inProgress(b))) return false;
  if (f.blocked && !b.blocked) return false;
  if (f.stale && !isStale(b, p, now())) return false;
  if (f.recentAssigned && !b.recentlyAssigned) return false;
  if (f.recentUpdated && !recentlyUpdated(b)) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  return [b.key, b.summary, b.project.key, b.project.name, b.status, b.priority, b.severity, b.reporter?.name, b.parent?.key, b.parent?.summary, b.lastActivity?.label, ...b.labels]
    .some((x) => (x ?? '').toLowerCase().includes(q));
}

const sevNum = (s: string | null): number => {
  const m = /\d+/.exec(s ?? '');
  return m ? Number(m[0]) : 99;
};
const sortVal: Record<FySort, (b: MyBug) => string | number> = {
  key: (b) => b.project.key + String(Number(b.key.split('-')[1])).padStart(8, '0'),
  summary: (b) => b.summary.toLowerCase(),
  project: (b) => b.project.key,
  status: (b) => b.status.toLowerCase(),
  severity: (b) => sevNum(b.severity),
  priority: (b) => b.priority ?? '~',
  reporter: (b) => b.reporter?.name ?? '~',
  created: (b) => b.created,
  updated: (b) => b.updated,
  age: (b) => (isDone(b) ? -1e15 : 0) + ageMs(b, now()),
};

function rows(): MyBug[] {
  if (!data) return [];
  const val = sortVal[filters.sort];
  return data.bugs.filter((b) => matches(b, filters)).sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : a.key.localeCompare(b.key)) * filters.dir;
  });
}

function setFilters(patch: Partial<FyFilters>, resetPage = true): void {
  filters = { ...filters, ...patch };
  if (patch.closedOnly) filters.openOnly = false;
  if (patch.openOnly) filters.closedOnly = false;
  if (resetPage) visible = PAGE;
  saveFy(filters);
  renderResults();
}

// ------------------------------------------------------------------ rendering

function render(): void {
  if (!data) return;
  renderShell();
  show('fyBody', true);
  renderHeader();
  renderCharts();
  renderAttention();
  renderResults();
}

function renderHeader(): void {
  if (!data) return;
  const bugs = data.bugs, p = prefs(), t = now();
  const open = bugs.filter(isOpen);
  const first = data.me.name.split(/\s+/)[0] ?? '';
  const stale = open.filter((b) => isStale(b, p, t)).length;
  const blocked = open.filter((b) => b.blocked).length;
  const oldest = open.reduce((m, b) => Math.max(m, ageMs(b, t)), 0);
  $('fyHello').textContent = `${greeting(new Date())}, ${first}.`;
  $('fySub').textContent = open.length
    ? `${open.length} open ${open.length === 1 ? 'bug' : 'bugs'} on your plate${stale ? `, ${stale} gone stale` : ''}${blocked ? `, ${blocked} blocked` : ''}.`
    : 'Nothing open. Enjoy the quiet.';
  const kpis: { n: string | number; l: string; act: string; tone?: string }[] = [
    { n: bugs.length, l: 'Total assigned', act: 'all' },
    { n: open.length, l: 'Open', act: 'open' },
    { n: open.filter(inProgress).length, l: 'In progress', act: 'progress' },
    { n: blocked, l: 'Blocked', act: 'blocked', tone: blocked ? 'crit' : '' },
    { n: bugs.length - open.length, l: 'Resolved / closed', act: 'closed' },
    { n: bugs.filter((b) => b.recentlyAssigned).length, l: 'Newly assigned (7d)', act: 'newly', tone: 'accent' },
    { n: bugs.filter(recentlyUpdated).length, l: 'Updated (24h)', act: 'updated' },
    { n: stale, l: `Stale ${p.staleDays}d+`, act: 'stale', tone: stale ? 'warn' : '' },
    { n: open.length ? fmtAge(oldest) : '—', l: 'Oldest unresolved', act: 'oldest', tone: oldest / DAY >= p.critDays ? 'crit' : '' },
  ];
  $('fyKpis').innerHTML = kpis.map((k) => `<button type="button" class="kpi ${k.tone ?? ''}" data-fy-kpi="${k.act}"><b>${esc(k.n)}</b><span>${esc(k.l)}</span></button>`).join('');
  $('fyMeta').innerHTML = `${data.truncated ? '<span class="warn-text">Showing the first 1000 bugs only. </span>' : ''}Fetched ${esc(timeAgo(data.fetchedAt))}`;
}

function renderCharts(): void {
  if (!data) return;
  const bugs = data.bugs, open = bugs.filter(isOpen);
  const catOf = new Map(bugs.map((b) => [b.status, b.statusCategory]));
  $('fyStatus').innerHTML = donut(
    countBy(bugs, (b) => b.status).map(([label, n]) => ({ label, n, color: statusColor(label, catOf.get(label)) })),
    filters.status, 'status', 'bugs'
  );
  $('fyProject').innerHTML = hbars(countBy(open, (b) => b.project.key), () => 'var(--accent)', filters.project, 'project');
  $('fyPriority').innerHTML = hbars(countBy(open, (b) => b.priority), () => 'var(--accent)', filters.priority, 'priority');
  $('fySeverity').innerHTML = hbars(countBy(open, (b) => b.severity), severityColor, filters.severity, 'severity');
  const palette = ['var(--green)', 'var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)', 'var(--red)'];
  $('fyAge').innerHTML = open.length ? columns(ageHistogram(open, now()), palette) : '<p class="muted">No open bugs.</p>';
}

function miniList(list: MyBug[], right: (b: MyBug) => string): string {
  return list.length
    ? `<ul class="mini">${list.map((b) => `<li><button type="button" data-fy-open="${esc(b.key)}"><b>${esc(b.key)}</b><span class="lbl">${esc(b.summary)}</span><em>${esc(right(b))}</em></button></li>`).join('')}</ul>`
    : '<p class="muted small">Nothing here. Nice.</p>';
}

function renderAttention(): void {
  if (!data) return;
  const p = prefs(), t = now(), open = data.bugs.filter(isOpen);
  $('fyOldest').innerHTML = miniList([...open].sort((a, b) => ageMs(b, t) - ageMs(a, t)).slice(0, 5), (b) => fmtAge(ageMs(b, t)));
  const stale = open.filter((b) => isStale(b, p, t)).sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated));
  $('fyStale').innerHTML = miniList(stale.slice(0, 5), (b) => `${Math.floor((t - Date.parse(b.updated)) / DAY)}d quiet`);
  const ev = recentEvents(4);
  $('fyJarvis').innerHTML = ev.length ? eventListHtml(ev) : '<p class="muted small">No activity yet. JARVIS will list changes to your bugs here.</p>';
}

function renderResults(): void {
  if (!data) return;
  renderCharts();
  renderToolbar();
  renderTable();
}

const QUICK: { k: keyof FyFilters; label: string }[] = [
  { k: 'openOnly', label: 'Open only' },
  { k: 'inProgress', label: 'In progress' },
  { k: 'blocked', label: 'Blocked' },
  { k: 'stale', label: 'Stale' },
  { k: 'recentAssigned', label: 'Newly assigned' },
  { k: 'recentUpdated', label: 'Updated 24h' },
  { k: 'closedOnly', label: 'Closed' },
];

function activeCount(): number {
  return GROUPS.reduce((n, g) => n + filters[g].length, 0);
}

function renderToolbar(): void {
  const sel = $<HTMLSelectElement>('fySort');
  if (!sel.options.length) {
    const labels: Record<FySort, string> = { key: 'Issue', summary: 'Summary', project: 'Project', status: 'Status', severity: 'Severity', priority: 'Priority', reporter: 'Reporter', created: 'Created', updated: 'Updated', age: 'Age' };
    sel.innerHTML = (Object.keys(labels) as FySort[]).map((k) => `<option value="${k}">Sort: ${labels[k]}</option>`).join('');
  }
  sel.value = filters.sort;
  $('fyDir').textContent = filters.dir === 1 ? '↑' : '↓';
  const n = activeCount();
  $('fyFilterCount').hidden = n === 0;
  $('fyFilterCount').textContent = String(n);
  const input = $<HTMLInputElement>('fySearch');
  if (document.activeElement !== input) input.value = filters.q;
  $('fyQuick').innerHTML = QUICK.map((q) => `<button type="button" class="chip${filters[q.k] ? ' on' : ''}" data-fy-quick="${q.k}" aria-pressed="${!!filters[q.k]}">${esc(q.label)}</button>`).join('');
  const chips: string[] = [];
  for (const g of GROUPS) for (const v of filters[g]) chips.push(`<button type="button" class="chip removable" data-fy-rm="${g}" data-v="${esc(v)}">${GROUP_LABEL[g]}: ${esc(v)} <span aria-hidden="true">×</span><span class="sr">remove</span></button>`);
  if (chips.length || filters.q || QUICK.some((q) => q.k !== 'openOnly' && filters[q.k]) || !filters.openOnly) chips.push('<button type="button" class="link" data-fy="clear">Reset filters</button>');
  $('fyChips').innerHTML = chips.join('');
}

function rowHtml(b: MyBug, unread: Set<string>, t: number): string {
  const p = prefs();
  const lvl = ageLevel(b, p, t);
  const marks = [
    b.recentlyAssigned && isOpen(b) ? '<span class="mark new">NEW</span>' : '',
    unread.has(b.key) ? '<span class="mark upd">UPDATED</span>' : '',
    b.blocked ? `<span class="mark blocked" title="${esc(b.blockedReason ?? 'Blocked')}">BLOCKED</span>` : '',
    isStale(b, p, t) ? '<span class="mark stale" title="Not updated recently">STALE</span>' : '',
  ].join('');
  const act = b.lastActivity ? `${esc(b.lastActivity.label)}<small class="muted"> · ${esc(timeAgo(b.lastActivity.at, t))}</small>` : '<span class="muted">—</span>';
  return `<tr class="lvl-${lvl}" data-fy-row="${esc(b.key)}">
    <td class="c-key"><div class="keywrap"><div><button type="button" class="keybtn" data-fy-open="${esc(b.key)}">${esc(b.key)}</button>
      <a class="ext" href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(b.key)} in Jira" title="Open in Jira">↗</a></div>${marks ? `<span class="marks">${marks}</span>` : ''}</div></td>
    <td class="c-summary" data-label="Summary">${esc(b.summary)}</td>
    <td data-label="Project"><span title="${esc(b.project.name)}">${esc(b.project.key)}</span></td>
    <td data-label="Status"><span class="pill" style="--c:${statusColor(b.status, b.statusCategory)}">${esc(b.status)}</span></td>
    <td data-label="Priority">${esc(b.priority ?? '—')}</td>
    <td data-label="Severity">${b.severity ? `<span class="pill" style="--c:${severityColor(b.severity)}">${esc(b.severity)}</span>` : '<span class="muted">—</span>'}</td>
    <td data-label="Assignee">${esc(b.assignee?.name ?? 'You')}</td>
    <td data-label="Reporter">${esc(b.reporter?.name ?? '—')}</td>
    <td data-label="Parent">${b.parent ? `<span title="${esc(b.parent.summary)}">${esc(b.parent.key)}</span>` : '<span class="muted">—</span>'}</td>
    <td data-label="Created">${esc(fmtDate(b.created))}</td>
    <td data-label="Updated">${esc(fmtDate(b.updated))}</td>
    <td data-label="Age"><span class="age ${lvl}">${esc(fmtAge(ageMs(b, t)))}</span>${isDone(b) ? ' <small class="muted">to close</small>' : ''}</td>
    <td class="c-act" data-label="Latest activity">${act}</td></tr>`;
}

const COLS: { id: FySort | null; label: string; cls?: string }[] = [
  { id: 'key', label: 'Issue' }, { id: 'summary', label: 'Summary', cls: 'c-summary' }, { id: 'project', label: 'Project' }, { id: 'status', label: 'Status' },
  { id: 'priority', label: 'Priority' }, { id: 'severity', label: 'Severity' }, { id: null, label: 'Assignee' }, { id: 'reporter', label: 'Reporter' },
  { id: null, label: 'Parent' }, { id: 'created', label: 'Created' }, { id: 'updated', label: 'Updated' }, { id: 'age', label: 'Age' }, { id: null, label: 'Latest activity', cls: 'c-act' },
];

function renderTable(): void {
  if (!data) return;
  $('fyHead').innerHTML = COLS.map((c) => {
    const on = c.id !== null && filters.sort === c.id;
    return `<th scope="col" class="${c.cls ?? ''}" aria-sort="${on ? (filters.dir === 1 ? 'ascending' : 'descending') : 'none'}">${
      c.id ? `<button type="button" data-fy-sort="${c.id}">${esc(c.label)}<span class="arrow">${on ? (filters.dir === 1 ? '▲' : '▼') : ''}</span></button>` : `<span class="th-plain">${esc(c.label)}</span>`}</th>`;
  }).join('');
  const list = rows(), unread = unreadKeys(), t = now();
  $('fyCount').textContent = `${list.length} of ${data.bugs.length} bugs`;
  $('fyBodyRows').innerHTML = list.length
    ? list.slice(0, visible).map((b) => rowHtml(b, unread, t)).join('')
    : `<tr class="none"><td colspan="${COLS.length}">${data.bugs.length ? 'No bugs match these filters.' : 'No bugs are assigned to you. Enjoy the quiet.'}</td></tr>`;
  $('fyMore').hidden = list.length <= visible;
  $('fyMore').textContent = `Show more (${list.length - visible} left)`;
}

// ------------------------------------------------------------------ filter drawer

function renderDrawer(): void {
  if (!data) return;
  $('fyDrawerBody').innerHTML = GROUPS.map((g) => {
    const entries = countBy(data?.bugs ?? [], groupVal[g]);
    return `<details open class="fgroup"><summary>${GROUP_LABEL[g]} ${filters[g].length ? `<span class="badge">${filters[g].length}</span>` : ''}</summary>${entries
      .map(([v, n]) => `<label class="opt"><input type="checkbox" data-fy-group="${g}" value="${esc(v)}" ${filters[g].includes(v) ? 'checked' : ''}/><span>${esc(v)}</span><small>${n}</small></label>`)
      .join('')}</details>`;
  }).join('');
}
function openDrawer(): void {
  renderDrawer();
  show('fyDrawer', true);
  show('fyScrim', true);
  requestAnimationFrame(() => $('fyDrawer').classList.add('open'));
  $('fyDrawerClose').focus();
}
function closeDrawer(): void {
  $('fyDrawer').classList.remove('open');
  setTimeout(() => { show('fyDrawer', false); show('fyScrim', false); }, 180);
}

function toggle(g: Group, v: string): void {
  const cur = filters[g];
  setFilters({ [g]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<FyFilters>);
}

// ------------------------------------------------------------------ issue detail

export function openIssueDetail(key: string): void {
  detailKey = key;
  detail = null;
  const url = new URL(location.href);
  url.searchParams.set('issue', key);
  history.replaceState(null, '', url);
  show('detail', true);
  show('detailScrim', true);
  requestAnimationFrame(() => $('detail').classList.add('open'));
  markIssueRead(key);
  renderDetail('loading');
  const mine = ++detailSeq;
  fetchIssue(deps.mode(), key).then(
    (d) => {
      if (mine !== detailSeq) return;
      detail = d;
      renderDetail('ok');
    },
    (e: Error) => {
      if (mine !== detailSeq) return;
      renderDetail('error', e.message);
    }
  );
  $('detailClose').focus();
}

export function closeIssueDetail(): void {
  if (!detailKey) return;
  detailKey = null;
  detailSeq++;
  $('detail').classList.remove('open');
  setTimeout(() => { if (!detailKey) { show('detail', false); show('detailScrim', false); } }, 180);
  const url = new URL(location.href);
  url.searchParams.delete('issue');
  history.replaceState(null, '', url);
}

const fmtDateTime = (s: string): string => new Date(s).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function renderDetail(state: 'loading' | 'ok' | 'error', err = ''): void {
  const key = detailKey;
  if (!key) return;
  const fromList = data?.bugs.find((b) => b.key === key);
  const url = detail?.url ?? fromList?.url ?? '#';
  const head = `<header class="detail-head"><div><b class="detail-key">${esc(key)}</b>${deps.mode() === 'demo' ? ' <span class="muted small">(sample)</span>' : ''}</div>
    <div class="row"><a class="btn small primary" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">Open in Jira ↗</a><button class="btn icon" id="detailClose" type="button" aria-label="Close">✕</button></div></header>`;
  let body = '';
  if (state === 'loading') {
    body = `<h2 class="detail-title">${esc(fromList?.summary ?? 'Loading…')}</h2><div class="loading"><div class="spinner"></div><span>Loading details…</span></div>`;
  } else if (state === 'error' || !detail) {
    body = `<h2 class="detail-title">${esc(fromList?.summary ?? key)}</h2><div class="banner error"><span>Could not load the details: ${esc(err)}</span><button class="link" data-fy="retry-detail">Retry</button></div>`;
  } else {
    const d = detail, p = prefs();
    const b = fromList;
    const level = b ? ageLevel(b, p, now()) : 'ok';
    body = `
    <h2 class="detail-title">${esc(d.summary)}</h2>
    <div class="detail-pills"><span class="pill" style="--c:${statusColor(d.status, d.statusCategory)}">${esc(d.status)}</span>
      ${d.priority ? `<span class="pill" style="--c:var(--accent)">${esc(d.priority)}</span>` : ''}
      ${d.severity ? `<span class="pill" style="--c:${severityColor(d.severity)}">${esc(d.severity)}</span>` : ''}
      ${b ? `<span class="age ${level}">${esc(fmtAge(ageMs(b, now())))} ${isDone(b) ? 'to close' : 'open'}</span>` : ''}${d.labels.map((l) => `<span class="pill" style="--c:var(--grey)">${esc(l)}</span>`).join('')}</div>
    <dl class="meta">
      <div><dt>Project</dt><dd>${esc(d.project.name)} <span class="muted">(${esc(d.project.key)})</span></dd></div>
      <div><dt>Parent</dt><dd>${d.parent ? `<a href="${esc(safeUrl(d.parent.url))}" target="_blank" rel="noopener noreferrer">${esc(d.parent.key)}</a> ${esc(d.parent.summary)}` : '—'}</dd></div>
      <div><dt>Assignee</dt><dd>${esc(d.assignee?.name ?? 'Unassigned')}</dd></div>
      <div><dt>Reporter</dt><dd>${esc(d.reporter?.name ?? '—')}</dd></div>
      <div><dt>Created</dt><dd>${esc(fmtDateTime(d.created))}</dd></div>
      <div><dt>Updated</dt><dd>${esc(fmtDateTime(d.updated))}</dd></div>
      ${d.resolved ? `<div><dt>Resolved</dt><dd>${esc(fmtDateTime(d.resolved))}</dd></div>` : ''}
      ${b?.blocked ? `<div><dt>Blocked</dt><dd class="warn-text">${esc(b.blockedReason ?? 'Yes')}</dd></div>` : ''}
    </dl>
    ${d.links.length ? `<h3>Linked issues</h3><ul class="mini">${d.links.map((l) => `<li><a class="linkrow" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer"><span class="muted small">${esc(l.relation)}</span><b>${esc(l.key)}</b><span class="lbl">${esc(l.summary)}</span><em>${esc(l.status)}</em></a></li>`).join('')}</ul>` : ''}
    <h3>Description</h3>
    ${d.description ? `<div class="desc">${esc(d.description)}</div>` : '<p class="muted small">No description.</p>'}
    <div class="seg" role="tablist" aria-label="Activity"><button type="button" class="${detailTab === 'comments' ? 'on' : ''}" data-fy-dtab="comments">Comments (${d.comments.length})</button><button type="button" class="${detailTab === 'history' ? 'on' : ''}" data-fy-dtab="history">History (${d.history.length})</button></div>
    ${detailTab === 'comments'
      ? d.comments.length ? `<ul class="timeline">${d.comments.map((c) => `<li><div class="tl-h"><b>${esc(c.author)}</b><time class="muted small">${esc(fmtDateTime(c.created))}</time></div><div class="desc">${esc(c.body)}</div></li>`).join('')}</ul>` : '<p class="muted small">No comments yet.</p>'
      : d.history.length ? `<ul class="timeline">${d.history.map((h) => `<li><div class="tl-h"><b>${esc(h.author)}</b><time class="muted small">${esc(fmtDateTime(h.created))}</time></div>${h.items.map((it) => `<div class="chg"><span class="muted">${esc(it.field)}</span> ${it.from ? `<s>${esc(it.from)}</s> →` : ''} <b>${esc(it.to ?? '(none)')}</b></div>`).join('')}</li>`).join('')}</ul>` : '<p class="muted small">No recorded changes.</p>'}`;
  }
  $('detailBody').innerHTML = head + `<div class="detail-scroll">${body}</div>`;
}

// ------------------------------------------------------------------ events

export function initForYou(d: FyDeps): void {
  deps = d;
  $('fyBody').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const kpi = t.closest<HTMLElement>('[data-fy-kpi]')?.dataset['fyKpi'];
    if (kpi) {
      const base = { ...DEFAULT_FY, sort: filters.sort, dir: filters.dir, openOnly: false };
      const map: Record<string, Partial<FyFilters>> = {
        all: {}, open: { openOnly: true }, progress: { inProgress: true, openOnly: true }, blocked: { blocked: true, openOnly: true },
        closed: { closedOnly: true }, newly: { recentAssigned: true }, updated: { recentUpdated: true }, stale: { stale: true, openOnly: true },
        oldest: { openOnly: true, sort: 'age', dir: -1 },
      };
      setFilters({ ...base, ...(map[kpi] ?? {}) });
      $('fyQuick').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const grp = t.closest<HTMLElement>('[data-group][data-v]');
    if (grp) return toggle(grp.dataset['group'] as Group, grp.dataset['v'] ?? '');
    const q = t.closest<HTMLElement>('[data-fy-quick]')?.dataset['fyQuick'] as keyof FyFilters | undefined;
    if (q) return setFilters({ [q]: !filters[q] } as Partial<FyFilters>);
    const rm = t.closest<HTMLElement>('[data-fy-rm]');
    if (rm) return toggle(rm.dataset['fyRm'] as Group, rm.dataset['v'] ?? '');
    const sort = t.closest<HTMLElement>('[data-fy-sort]')?.dataset['fySort'] as FySort | undefined;
    if (sort) return setFilters(filters.sort === sort ? { dir: filters.dir === 1 ? -1 : 1 } : { sort, dir: ['created', 'updated', 'age'].includes(sort) ? -1 : 1 });
    const open = t.closest<HTMLElement>('[data-fy-open]')?.dataset['fyOpen'] ?? t.closest<HTMLElement>('[data-open-issue]')?.dataset['openIssue'];
    if (open) return openIssueDetail(open);
    const row = t.closest<HTMLElement>('[data-fy-row]');
    if (row && !t.closest('a, button')) return openIssueDetail(row.dataset['fyRow'] ?? '');
    const act = t.closest<HTMLElement>('[data-fy]')?.dataset['fy'];
    if (act === 'clear') setFilters({ ...DEFAULT_FY, sort: filters.sort, dir: filters.dir });
    if (act === 'retry') void refreshForYou();
    if (act === 'jarvis') openJarvisPanel('history');
  });
  $('fyError').addEventListener('click', (e) => (e.target as HTMLElement).closest('[data-fy="retry"]') && void refreshForYou());
  $('fyConnectBtn').addEventListener('click', () => deps.openConnect());
  $('fyMore').addEventListener('click', () => { visible += PAGE; renderTable(); });
  const onSearch = debounce((v: string) => setFilters({ q: v }), 120);
  $<HTMLInputElement>('fySearch').addEventListener('input', (e) => onSearch((e.target as HTMLInputElement).value));
  $<HTMLSelectElement>('fySort').addEventListener('change', (e) => {
    const sort = (e.target as HTMLSelectElement).value as FySort;
    setFilters({ sort, dir: ['created', 'updated', 'age'].includes(sort) ? -1 : 1 });
  });
  $('fyDir').addEventListener('click', () => setFilters({ dir: filters.dir === 1 ? -1 : 1 }));
  $('fyFilterBtn').addEventListener('click', openDrawer);
  $('fyDrawerClose').addEventListener('click', closeDrawer);
  $('fyDrawerDone').addEventListener('click', closeDrawer);
  $('fyScrim').addEventListener('click', closeDrawer);
  $('fyClear').addEventListener('click', () => { setFilters({ ...DEFAULT_FY, openOnly: false, sort: filters.sort, dir: filters.dir }); renderDrawer(); });
  $('fyDrawerBody').addEventListener('change', (e) => {
    const i = e.target as HTMLInputElement;
    const g = i.dataset['fyGroup'] as Group | undefined;
    if (g) toggle(g, i.value);
  });
  $('fyJarvisMore').addEventListener('click', () => openJarvisPanel('history'));

  $('detail').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#detailClose')) return closeIssueDetail();
    const tab = t.closest<HTMLElement>('[data-fy-dtab]')?.dataset['fyDtab'];
    if (tab) {
      detailTab = tab as typeof detailTab;
      return renderDetail('ok');
    }
    if (t.closest('[data-fy="retry-detail"]') && detailKey) openIssueDetail(detailKey);
  });
  $('detailScrim').addEventListener('click', closeIssueDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (detailKey) closeIssueDetail();
    else if (!$('fyDrawer').hidden) closeDrawer();
  });
}
