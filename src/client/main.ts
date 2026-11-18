import type { Bug, BugsResponse, PublicConfig } from '../shared/types.js';
import { deleteConfig, detectMode, fetchBugs, saveConfig, type Mode } from './api.js';
import {
  AGE_BUCKETS, ageHistogram, ageLevel, ageMs, applyFilters, assigneeOf, changeOf, countBy, isDone, isOverdue, isStale,
  makeBaseline, priorityLabel, severityColor, severityLabel, sortBugs, statusColor, trend, type Ctx,
} from './analysis.js';
import { columns, donut, hbars, trendChart } from './charts.js';
import {
  DEFAULT_FILTERS, DEFAULT_PREFS, clearData, loadActive, loadBaseline, loadCache, loadFilters, loadPrefs, loadStars,
  loadTracked, loadView, saveView, saveActive, saveBaseline, saveCache, saveFilters, savePrefs, saveStars, saveTracked, setNamespace,
  type Accent, type Baseline, type ViewName, type ColumnId, type Filters, type Prefs, type SortCol, type ThemeName, type Tracked,
} from './store.js';
import { initForYou, onActivity, openIssueDetail, refreshForYou, showForYou } from './foryou.js';
import { initJarvis, jarvisConfigChanged } from './jarvis.js';
import { $, csvCell, debounce, download, esc, fmtAge, fmtDate, parseKey, safeUrl, timeAgo, toast } from './util.js';

// ------------------------------------------------------------------ state
let mode: Mode = 'demo';
let config: PublicConfig = { configured: false };
let prefs: Prefs = loadPrefs();
let tracked: Tracked[] = [];
let activeKey: string | null = null;
let data: BugsResponse | null = null;
let filters: Filters = { ...DEFAULT_FILTERS };
let stars = new Set<string>();
let baseline: Baseline | null = null;
let fromCache = false;
let visible = 100;
let seq = 0;
let autoTimer: number | undefined;
let lastFetchAt = 0;
let view: ViewName = 'epics';

const PAGE = 100;
type Group = 'status' | 'severity' | 'priority' | 'assignee';
const GROUPS: Group[] = ['status', 'severity', 'priority', 'assignee'];
const GROUP_LABEL: Record<Group, string> = { status: 'Status', severity: 'Severity', priority: 'Priority', assignee: 'Assignee' };
const GROUP_OF: Record<Group, (b: Bug) => string> = {
  status: (b) => b.status, severity: severityLabel, priority: priorityLabel, assignee: assigneeOf,
};

const THEMES: ThemeName[] = ['system', 'light', 'paper', 'dark', 'midnight'];
const ACCENTS: Accent[] = ['blue', 'violet', 'teal', 'rose', 'orange'];

interface Col { id: SortCol; label: string; hideable: boolean; cls?: string }
const COLS: Col[] = [
  { id: 'key', label: 'Issue', hideable: false },
  { id: 'summary', label: 'Summary', hideable: true, cls: 'c-summary' },
  { id: 'status', label: 'Status', hideable: true },
  { id: 'severity', label: 'Severity', hideable: true },
  { id: 'priority', label: 'Priority', hideable: true },
  { id: 'reporter', label: 'Reporter', hideable: true },
  { id: 'assignee', label: 'Assignee', hideable: true },
  { id: 'created', label: 'Created', hideable: true },
  { id: 'age', label: 'Age', hideable: true },
  { id: 'updated', label: 'Updated', hideable: true },
];
const shown = (c: Col): boolean => !c.hideable || !prefs.hiddenColumns.includes(c.id as ColumnId);

const ctx = (): Ctx => ({ prefs, baseline, stars, now: Date.now() });

// ------------------------------------------------------------------ theme
function applyTheme(): void {
  document.documentElement.dataset['theme'] = prefs.theme;
  document.documentElement.dataset['accent'] = prefs.accent;
}
function updatePrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  savePrefs(prefs);
  applyTheme();
}

// ------------------------------------------------------------------ small helpers
const pill = (text: string, color: string): string => `<span class="pill" style="--c:${color}">${esc(text)}</span>`;
const show = (id: string, on: boolean): void => void ($(id).hidden = !on);

function setUrl(key: string | null): void {
  const url = new URL(location.href);
  if (key) url.searchParams.set('key', key);
  else url.searchParams.delete('key');
  history.replaceState(null, '', url);
}

function showBanner(kind: 'info' | 'warn' | 'error', html: string): void {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
}
const hideBanner = (): void => void ($('banner').hidden = true);

function persistFilters(): void {
  if (activeKey) saveFilters(activeKey, filters);
}

// ------------------------------------------------------------------ views (Epics / For You)
async function setView(v: ViewName, persist = true): Promise<void> {
  view = v;
  if (persist) saveView(v);
  const fy = v === 'foryou';
  show('epicView', !fy);
  show('foryouView', fy);
  show('tabs', !fy && tracked.length > 0);
  $('addForm').classList.toggle('gone', fy);
  for (const b of document.querySelectorAll<HTMLElement>('#viewNav [data-view]')) {
    const on = b.dataset['view'] === v;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const url = new URL(location.href);
  if (fy) {
    url.searchParams.set('view', 'foryou');
    url.searchParams.delete('key');
    document.title = 'For You · Bug Dashboard';
  } else {
    url.searchParams.delete('view');
    url.searchParams.delete('issue');
  }
  history.replaceState(null, '', url);
  if (fy) await showForYou();
  else if (activeKey && !data) await activate(activeKey);
  else if (activeKey) {
    document.title = `${activeKey} · Bug Dashboard`;
    setUrl(activeKey);
  } else {
    document.title = 'Jira Bug Dashboard';
    showShell();
  }
}

const refreshCurrent = (): Promise<void> => (view === 'foryou' ? refreshForYou() : refreshData());

/** Opens a bug in the For You detail view, from anywhere (notification click, history list). */
function openIssueEverywhere(key: string): void {
  void setView('foryou').then(() => openIssueDetail(key));
}

// ------------------------------------------------------------------ tracked issues & tabs
function renderTabs(): void {
  const nav = $('tabs');
  nav.hidden = tracked.length === 0 || view === 'foryou';
  nav.innerHTML = tracked
    .map((t) => {
      const on = t.key === activeKey;
      return `<span class="tab${on ? ' on' : ''}"><button type="button" class="tab-main" data-tab="${esc(t.key)}" ${on ? 'aria-current="page"' : ''} title="${esc(t.title ?? t.key)}">
        <b>${esc(t.key)}</b>${t.title ? `<small>${esc(t.title)}</small>` : ''}</button>
        <button type="button" class="tab-x" data-untrack="${esc(t.key)}" aria-label="Stop tracking ${esc(t.key)}">×</button></span>`;
    })
    .join('');
  nav.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function track(key: string): Promise<void> {
  if (!tracked.some((t) => t.key === key)) {
    tracked = [...tracked, { key, addedAt: new Date().toISOString() }];
    saveTracked(tracked);
  }
  await activate(key);
}

function untrack(key: string): void {
  tracked = tracked.filter((t) => t.key !== key);
  saveTracked(tracked);
  clearData(key);
  if (key === activeKey) {
    const next = tracked[0]?.key ?? null;
    if (next) void activate(next);
    else {
      activeKey = null;
      data = null;
      saveActive(null);
      setUrl(null);
      showShell();
    }
  }
  renderTabs();
  toast(`Stopped tracking ${key}`);
}

async function activate(key: string, refresh = true): Promise<void> {
  activeKey = key;
  saveActive(key);
  setUrl(key);
  filters = loadFilters(key);
  stars = new Set(loadStars(key));
  baseline = loadBaseline(key);
  visible = PAGE;
  data = mode === 'demo' ? null : loadCache(key);
  fromCache = !!data;
  document.title = `${key} · Bug Dashboard`;
  hideBanner();
  renderTabs();
  showShell();
  if (data) renderDash();
  if (refresh) await refreshData();
}

// ------------------------------------------------------------------ loading
async function refreshData(): Promise<void> {
  const key = activeKey;
  if (!key) return;
  const mine = ++seq;
  $('refreshBtn').classList.add('spin');
  if (!data) show('loading', true);
  try {
    const resp = await fetchBugs(mode, key);
    if (mine !== seq) return;
    data = resp;
    fromCache = false;
    lastFetchAt = Date.now();
    if (mode === 'local') saveCache(key, resp);
    if (!baseline) {
      baseline = makeBaseline(resp.bugs);
      saveBaseline(key, baseline);
    }
    const t = tracked.find((x) => x.key === key);
    if (t && t.title !== resp.parent.summary) {
      t.title = resp.parent.summary;
      saveTracked(tracked);
      renderTabs();
    }
    hideBanner();
    renderDash();
  } catch (e) {
    if (mine !== seq) return;
    const msg = (e as Error).message;
    if (/not set up/i.test(msg)) {
      showBanner('warn', 'Connect your Jira account to load real data. <button class="link" data-action="settings">Open settings</button>');
      openSettings();
    } else {
      const note = data ? `Showing saved data from ${esc(timeAgo(data.fetchedAt))}. ` : '';
      showBanner('error', `<span>Could not load ${esc(key)}: ${esc(msg)}. ${note}</span><button class="link" data-action="retry">Retry</button>`);
    }
    if (data) renderDash();
  } finally {
    if (mine === seq) {
      show('loading', false);
      $('refreshBtn').classList.remove('spin');
    }
  }
}

function showShell(): void {
  const has = tracked.length > 0 && activeKey !== null;
  show('empty', !has);
  show('dash', has && data !== null);
  if (!has) {
    document.title = 'Jira Bug Dashboard';
    if (mode === 'demo') showBanner('info', 'Demo mode: sample data only. Run the app locally to use your own Jira. <button class="link" data-action="get">Get the app</button>');
  }
}

// ------------------------------------------------------------------ rendering
function renderDash(): void {
  if (!data) return;
  show('dash', true);
  show('empty', false);
  if (mode === 'demo' && $('banner').hidden) {
    showBanner('info', 'Demo mode: this is generated sample data, not real Jira data. Run the app locally to use your own Jira. <button class="link" data-action="get">Get the app</button>');
  }
  renderHeader();
  renderCharts();
  renderTrendAndAge();
  renderResults();
  $('chartsToggle').textContent = prefs.chartsOpen ? 'Hide' : 'Show';
  $('chartsToggle').setAttribute('aria-expanded', String(prefs.chartsOpen));
  $('charts').hidden = !prefs.chartsOpen;
}

function renderHeader(): void {
  if (!data) return;
  const { parent, bugs } = data;
  const c = ctx();
  const open = bugs.filter((b) => !isDone(b));
  const closed = bugs.length - open.length;
  const pct = bugs.length ? Math.round((closed / bugs.length) * 100) : 0;

  $('parentCard').innerHTML = `
    <div class="parent-top">
      <a class="key" href="${esc(safeUrl(parent.url))}" target="_blank" rel="noopener noreferrer">${esc(parent.key)}</a>
      ${parent.status ? pill(parent.status, statusColor(parent.status)) : ''}
      <span class="muted small">${esc(parent.type ?? 'Issue')}</span>
    </div>
    <h1 class="parent-title">${esc(parent.summary)}</h1>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Bugs closed">
      <span style="width:${pct}%"></span></div>
    <p class="muted small">${closed} of ${bugs.length} bugs closed (${pct}%)</p>`;

  const avg = open.length ? open.reduce((s, b) => s + ageMs(b, c.now), 0) / open.length : 0;
  const oldest = open.reduce((m, b) => Math.max(m, ageMs(b, c.now)), 0);
  const overdue = open.filter((b) => isOverdue(b, prefs, c.now)).length;
  const stale = open.filter((b) => isStale(b, prefs, c.now)).length;
  const unassigned = open.filter((b) => !b.assignee).length;
  const changed = bugs.filter((b) => changeOf(b, baseline)).length;
  const kpis: { n: string | number; l: string; act?: string; tone?: string }[] = [
    { n: bugs.length, l: 'Total', act: 'all' },
    { n: open.length, l: 'Open', act: 'open' },
    { n: closed, l: 'Closed' },
    { n: overdue, l: `Open > ${prefs.critDays}d`, act: 'overdue', tone: overdue ? 'crit' : '' },
    { n: stale, l: `Stale ${prefs.staleDays}d+`, act: 'stale', tone: stale ? 'warn' : '' },
    { n: unassigned, l: 'Unassigned', act: 'unassigned', tone: unassigned ? 'warn' : '' },
    { n: changed, l: 'New / changed', act: 'changed', tone: changed ? 'accent' : '' },
    { n: open.length ? fmtAge(avg) : '—', l: 'Avg open age' },
    { n: open.length ? fmtAge(oldest) : '—', l: 'Oldest open' },
  ];
  $('kpis').innerHTML = kpis
    .map((k) =>
      k.act
        ? `<button type="button" class="kpi ${k.tone ?? ''}" data-kpi="${k.act}"><b>${esc(k.n)}</b><span>${esc(k.l)}</span></button>`
        : `<div class="kpi static ${k.tone ?? ''}"><b>${esc(k.n)}</b><span>${esc(k.l)}</span></div>`
    )
    .join('');
}

function renderCharts(): void {
  if (!data) return;
  const { bugs } = data;
  const open = bugs.filter((b) => !isDone(b));
  const catOf = new Map(bugs.map((b) => [b.status, b.statusCategory]));
  const statusEntries = countBy(bugs, (b) => b.status);
  $('cStatus').innerHTML = donut(
    statusEntries.map(([label, n]) => ({ label, n, color: statusColor(label, catOf.get(label)) })),
    filters.status, 'status', 'bugs'
  );
  $('cSeverity').innerHTML = hbars(countBy(bugs, severityLabel), severityColor, filters.severity, 'severity');
  $('cPriority').innerHTML = hbars(countBy(bugs, priorityLabel), () => 'var(--accent)', filters.priority, 'priority');
  $('cAssignee').innerHTML = hbars(countBy(open, assigneeOf), () => 'var(--accent)', filters.assignee, 'assignee');
}

function renderTrendAndAge(): void {
  if (!data) return;
  const open = data.bugs.filter((b) => !isDone(b));
  $('cTrend').innerHTML = trendChart(trend(data.bugs));
  const palette = ['var(--green)', 'var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)', 'var(--red)'];
  $('cAge').innerHTML = open.length ? columns(ageHistogram(open), palette.slice(0, AGE_BUCKETS.length)) : '<p class="muted">No open bugs.</p>';
}

function activeFilterCount(): number {
  return GROUPS.reduce((n, g) => n + filters[g].length, 0);
}

function currentRows(): Bug[] {
  if (!data) return [];
  return sortBugs(applyFilters(data.bugs, filters, ctx()), filters.sort, filters.dir);
}

/** Everything that depends on the filters. Cheap enough to run on every keystroke. */
function renderResults(): void {
  if (!data) return;
  renderCharts();
  renderQuick();
  renderChips();
  renderToolbar();
  renderTable();
}

function renderToolbar(): void {
  const sel = $<HTMLSelectElement>('sortSel');
  if (!sel.options.length) sel.innerHTML = COLS.map((c) => `<option value="${c.id}">Sort: ${esc(c.label)}</option>`).join('');
  sel.value = filters.sort;
  $('sortDir').textContent = filters.dir === 1 ? '↑' : '↓';
  const n = activeFilterCount();
  const badge = $('filterCount');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  const input = $<HTMLInputElement>('search');
  if (document.activeElement !== input) input.value = filters.q;
}

function renderQuick(): void {
  if (!data) return;
  const c = ctx();
  const { bugs } = data;
  const counts = {
    starred: bugs.filter((b) => stars.has(b.key)).length,
    changed: bugs.filter((b) => changeOf(b, baseline)).length,
    stale: bugs.filter((b) => isStale(b, prefs, c.now)).length,
    overdue: bugs.filter((b) => isOverdue(b, prefs, c.now)).length,
  };
  const chip = (k: keyof Pick<Filters, 'openOnly' | 'starred' | 'changed' | 'stale' | 'overdue'>, label: string, n?: number): string =>
    `<button type="button" class="chip${filters[k] ? ' on' : ''}" data-quick="${k}" aria-pressed="${filters[k]}">${esc(label)}${n === undefined ? '' : ` <b>${n}</b>`}</button>`;
  $('quick').innerHTML =
    chip('openOnly', 'Open only') + chip('overdue', `Open > ${prefs.critDays}d`, counts.overdue) + chip('stale', 'Stale', counts.stale) +
    chip('changed', 'New / changed', counts.changed) + chip('starred', '★ Starred', counts.starred);
}

function renderChips(): void {
  const chips: string[] = [];
  for (const g of GROUPS) {
    for (const v of filters[g]) {
      chips.push(`<button type="button" class="chip removable" data-rm-group="${g}" data-rm="${esc(v)}">${GROUP_LABEL[g]}: ${esc(v)} <span aria-hidden="true">×</span><span class="sr">remove</span></button>`);
    }
  }
  if (activeFilterCount() || filters.q || filters.openOnly || filters.starred || filters.changed || filters.stale || filters.overdue) {
    chips.push('<button type="button" class="link" data-action="clear">Clear all</button>');
  }
  $('chips').innerHTML = chips.join('');
}

function personCell(name: string | undefined | null, fallback: string): string {
  return name ? esc(name) : `<span class="muted">${fallback}</span>`;
}

function rowHtml(b: Bug, c: Ctx): string {
  const lvl = ageLevel(b, prefs, c.now);
  const change = changeOf(b, baseline);
  const starred = stars.has(b.key);
  const marks = [
    change === 'new' ? '<span class="mark new">NEW</span>' : '',
    change === 'updated' ? '<span class="mark upd">UPDATED</span>' : '',
    isStale(b, prefs, c.now) ? '<span class="mark stale" title="Not updated recently">STALE</span>' : '',
  ].join('');
  const cells: Record<SortCol, string> = {
    key: `<td class="c-key"><div class="keywrap"><button type="button" class="star${starred ? ' on' : ''}" data-star="${esc(b.key)}" aria-pressed="${starred}" aria-label="${starred ? 'Unstar' : 'Star'} ${esc(b.key)}">${starred ? '★' : '☆'}</button>
      <div><a href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener noreferrer">${esc(b.key)}</a><small class="muted">${esc(b.relation)}</small></div>${marks ? `<span class="marks">${marks}</span>` : ''}</div></td>`,
    summary: `<td class="c-summary" data-label="Summary">${esc(b.summary)}</td>`,
    status: `<td data-label="Status">${pill(b.status, statusColor(b.status, b.statusCategory))}</td>`,
    severity: `<td data-label="Severity">${b.severity ? pill(b.severity, severityColor(b.severity)) : '<span class="muted">—</span>'}</td>`,
    priority: `<td data-label="Priority">${esc(b.priority ?? '—')}</td>`,
    reporter: `<td data-label="Reporter">${personCell(b.reporter?.name, '—')}</td>`,
    assignee: `<td data-label="Assignee">${personCell(b.assignee?.name, 'Unassigned')}</td>`,
    created: `<td data-label="Created">${esc(fmtDate(b.created))}</td>`,
    age: `<td data-label="Age"><span class="age ${lvl}">${esc(fmtAge(ageMs(b, c.now)))}</span>${isDone(b) ? ' <small class="muted">to close</small>' : ''}</td>`,
    updated: `<td data-label="Updated">${esc(fmtDate(b.updated))}</td>`,
  };
  return `<tr class="lvl-${lvl}">${COLS.filter(shown).map((col) => cells[col.id]).join('')}</tr>`;
}

function renderTable(): void {
  if (!data) return;
  const cols = COLS.filter(shown);
  $('thead').innerHTML = cols
    .map((c) => {
      const on = filters.sort === c.id;
      return `<th scope="col" class="${c.cls ?? ''}" aria-sort="${on ? (filters.dir === 1 ? 'ascending' : 'descending') : 'none'}">
        <button type="button" data-sort="${c.id}">${esc(c.label)}<span class="arrow">${on ? (filters.dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;
    })
    .join('');
  const rows = currentRows();
  const c = ctx();
  $('count').textContent = `${rows.length} of ${data.bugs.length} bugs`;
  $('tbody').innerHTML = rows.length
    ? rows.slice(0, visible).map((b) => rowHtml(b, c)).join('')
    : `<tr class="none"><td colspan="${cols.length}">No bugs match these filters.</td></tr>`;
  const more = $('moreBtn');
  more.hidden = rows.length <= visible;
  more.textContent = `Show more (${rows.length - visible} left)`;
  $('foot').innerHTML = `Fetched ${esc(timeAgo(data.fetchedAt))}${fromCache ? ' (saved copy)' : ''} · <code>${esc(data.jql)}</code>`;
}

// ------------------------------------------------------------------ filters drawer
function renderDrawer(): void {
  if (!data) return;
  const bugs = data.bugs;
  $('drawerBody').innerHTML = GROUPS.map((g) => {
    const entries = countBy(bugs, GROUP_OF[g]);
    return `<details open class="fgroup"><summary>${GROUP_LABEL[g]} ${filters[g].length ? `<span class="badge">${filters[g].length}</span>` : ''}</summary>
      ${entries
        .map(
          ([v, n]) => `<label class="opt"><input type="checkbox" data-fgroup="${g}" value="${esc(v)}" ${filters[g].includes(v) ? 'checked' : ''} /><span>${esc(v)}</span><small>${n}</small></label>`
        )
        .join('')}</details>`;
  }).join('');
}
function openDrawer(): void {
  renderDrawer();
  show('drawer', true);
  show('scrim', true);
  requestAnimationFrame(() => $('drawer').classList.add('open'));
  $('drawerClose').focus();
}
function closeDrawer(): void {
  $('drawer').classList.remove('open');
  setTimeout(() => {
    show('drawer', false);
    show('scrim', false);
  }, 180);
  $('filterBtn').focus();
}

// ------------------------------------------------------------------ filter actions
function toggleValue(g: Group, v: string): void {
  const cur = filters[g];
  filters = { ...filters, [g]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
  visible = PAGE;
  persistFilters();
  renderResults();
}
function setFilters(patch: Partial<Filters>): void {
  filters = { ...filters, ...patch };
  visible = PAGE;
  persistFilters();
  renderResults();
}
function clearFilters(): void {
  setFilters({ ...DEFAULT_FILTERS, sort: filters.sort, dir: filters.dir });
  if (!$('drawer').hidden) renderDrawer();
}

// ------------------------------------------------------------------ settings dialog
function openSettings(): void {
  const dlg = $<HTMLDialogElement>('settings');
  const local = mode === 'local';
  show('demoNote', !local);
  $('connForm').hidden = !local;
  const env = config.source === 'env';
  $<HTMLInputElement>('fUrl').value = config.jiraUrl ?? '';
  $<HTMLInputElement>('fEmail').value = config.email ?? '';
  $<HTMLInputElement>('fToken').value = '';
  $<HTMLInputElement>('fToken').placeholder = config.configured ? '•••••••• saved (leave blank to keep)' : 'Paste your API token';
  $<HTMLInputElement>('fSev').value = config.severityFields ?? 'Defect Severity, Severity';
  $<HTMLInputElement>('fTypes').value = config.issueTypes ?? 'Bug';
  $('cfgPath').textContent = config.configFile ?? '~/.jira-bug-dashboard/config.json';
  for (const el of $('connForm').querySelectorAll('input, button.primary')) (el as HTMLInputElement).disabled = env;
  show('connOut', local && config.configured && !env);
  const msg = $('connMsg');
  msg.hidden = !env && !config.configured;
  msg.className = 'msg ok';
  msg.textContent = env ? 'Credentials come from environment variables. Change them there.' : config.configured ? `Connected as ${config.displayName ?? config.email}.` : '';

  $<HTMLSelectElement>('pTheme').value = prefs.theme;
  $<HTMLInputElement>('pWarn').value = String(prefs.warnDays);
  $<HTMLInputElement>('pCrit').value = String(prefs.critDays);
  $<HTMLInputElement>('pStale').value = String(prefs.staleDays);
  $<HTMLSelectElement>('pAuto').value = String(prefs.autoRefreshMin);
  renderAccents();
  if (!dlg.open) dlg.showModal();
}

function renderAccents(): void {
  $('pAccent').innerHTML = ACCENTS.map(
    (a) => `<button type="button" class="swatch" data-accent="${a}" role="radio" aria-checked="${prefs.accent === a}" aria-label="${a}" style="--s:var(--sw-${a})"></button>`
  ).join('');
}

async function submitConnection(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const msg = $('connMsg');
  const btn = $<HTMLButtonElement>('connSave');
  btn.disabled = true;
  msg.hidden = false;
  msg.className = 'msg';
  msg.textContent = 'Checking with Jira…';
  try {
    config = await saveConfig({
      jiraUrl: $<HTMLInputElement>('fUrl').value,
      email: $<HTMLInputElement>('fEmail').value,
      apiToken: $<HTMLInputElement>('fToken').value,
      severityFields: $<HTMLInputElement>('fSev').value,
      issueTypes: $<HTMLInputElement>('fTypes').value,
    });
    $<HTMLInputElement>('fToken').value = '';
    msg.className = 'msg ok';
    msg.textContent = `Connected as ${config.displayName ?? config.email}.`;
    show('connOut', true);
    hideBanner();
    toast('Jira connected');
    jarvisConfigChanged(true);
    if (view === 'foryou') void refreshForYou();
    else if (activeKey) void refreshData();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = (err as Error).message;
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ auto refresh
function scheduleAuto(): void {
  clearInterval(autoTimer);
  if (!prefs.autoRefreshMin) return;
  autoTimer = window.setInterval(() => {
    if (!document.hidden && (view === 'foryou' || activeKey)) void refreshCurrent();
  }, prefs.autoRefreshMin * 60_000);
}

// ------------------------------------------------------------------ export
function exportCsv(): void {
  if (!data) return;
  const c = ctx();
  const head = ['Key', 'Summary', 'Status', 'Severity', 'Priority', 'Reporter', 'Assignee', 'Created', 'Updated', 'Resolved', 'Age (days)', 'Relation', 'URL'];
  const lines = currentRows().map((b) =>
    [b.key, b.summary, b.status, b.severity, b.priority, b.reporter?.name, b.assignee?.name, b.created, b.updated, b.resolved,
      (ageMs(b, c.now) / 864e5).toFixed(1), b.relation, b.url].map(csvCell).join(',')
  );
  download(`${data.parent.key}-bugs.csv`, [head.join(','), ...lines].join('\n'), 'text/csv;charset=utf-8');
}

// ------------------------------------------------------------------ events
function wire(): void {
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('addInput');
    const key = parseKey(input.value);
    if (!key) return toast('Enter an issue key like ABC-123, or paste a Jira link.', 'error');
    input.value = '';
    input.blur();
    void track(key);
  });
  $('refreshBtn').addEventListener('click', () => void refreshCurrent());
  $('viewNav').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset['view'] as ViewName | undefined;
    if (v && v !== view) void setView(v);
  });
  $('themeBtn').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length] ?? 'system';
    updatePrefs({ theme: next });
    toast(`Theme: ${next}`);
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('heroConnect').addEventListener('click', openSettings);
  $('heroGet').addEventListener('click', openGetApp);
  $('getBtn').addEventListener('click', openGetApp);
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-open="getApp"]')) {
      $<HTMLDialogElement>('settings').close();
      openGetApp();
    }
    const copy = t.closest<HTMLElement>('[data-copy]')?.dataset['copy'];
    if (copy) void copyText(copy);
  });
  $('heroDemo').addEventListener('click', () => {
    // Demo keys are separate from real ones so sample data never mixes with Jira data.
    if (mode === 'local') location.href = '?demo&key=DEMO-1';
    else void track('DEMO-1');
  });

  $('tabs').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-tab]');
    const x = t.closest<HTMLElement>('[data-untrack]');
    if (x?.dataset['untrack']) untrack(x.dataset['untrack']);
    else if (tab?.dataset['tab'] && tab.dataset['tab'] !== activeKey) void activate(tab.dataset['tab']);
  });

  $('banner').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset['action'];
    if (a === 'retry') void refreshData();
    if (a === 'settings') openSettings();
    if (a === 'get') openGetApp();
  });

  $('kpis').addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-kpi]')?.dataset['kpi'];
    if (!k) return;
    const base = { ...DEFAULT_FILTERS, sort: filters.sort, dir: filters.dir };
    const map: Record<string, Partial<Filters>> = {
      all: {}, open: { openOnly: true }, overdue: { overdue: true }, stale: { stale: true }, changed: { changed: true },
      unassigned: { openOnly: true, assignee: ['Unassigned'] },
    };
    setFilters({ ...base, ...(map[k] ?? {}) });
    $('quick').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('chartsToggle').addEventListener('click', () => {
    updatePrefs({ chartsOpen: !prefs.chartsOpen });
    $('charts').hidden = !prefs.chartsOpen;
    $('chartsToggle').textContent = prefs.chartsOpen ? 'Hide' : 'Show';
    $('chartsToggle').setAttribute('aria-expanded', String(prefs.chartsOpen));
  });
  $('charts').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-group][data-v]');
    if (el) toggleValue(el.dataset['group'] as Group, el.dataset['v'] ?? '');
  });

  const onSearch = debounce((v: string) => setFilters({ q: v }), 120);
  $<HTMLInputElement>('search').addEventListener('input', (e) => onSearch((e.target as HTMLInputElement).value));
  $<HTMLSelectElement>('sortSel').addEventListener('change', (e) => {
    const col = (e.target as HTMLSelectElement).value as SortCol;
    setFilters({ sort: col, dir: col === 'created' || col === 'updated' || col === 'age' ? -1 : 1 });
  });
  $('sortDir').addEventListener('click', () => setFilters({ dir: filters.dir === 1 ? -1 : 1 }));
  $('filterBtn').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerDone').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('clearFilters').addEventListener('click', clearFilters);
  $('drawerBody').addEventListener('change', (e) => {
    const i = e.target as HTMLInputElement;
    const g = i.dataset['fgroup'] as Group | undefined;
    if (g) toggleValue(g, i.value);
  });

  $('quick').addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-quick]')?.dataset['quick'] as keyof Filters | undefined;
    if (k) setFilters({ [k]: !filters[k] } as Partial<Filters>);
  });
  $('chips').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const rm = t.closest<HTMLElement>('[data-rm]');
    if (rm) return toggleValue(rm.dataset['rmGroup'] as Group, rm.dataset['rm'] ?? '');
    if (t.closest('[data-action="clear"]')) clearFilters();
  });

  $('thead').addEventListener('click', (e) => {
    const col = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]')?.dataset['sort'] as SortCol | undefined;
    if (!col) return;
    setFilters(filters.sort === col ? { dir: filters.dir === 1 ? -1 : 1 } : { sort: col, dir: col === 'created' || col === 'updated' || col === 'age' ? -1 : 1 });
  });
  $('tbody').addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-star]')?.dataset['star'];
    if (!key) return;
    if (stars.has(key)) stars.delete(key);
    else stars.add(key);
    if (activeKey) saveStars(activeKey, [...stars]);
    renderResults();
  });
  $('moreBtn').addEventListener('click', () => {
    visible += PAGE;
    renderTable();
  });

  // columns menu
  $('colsList').innerHTML = COLS.filter((c) => c.hideable)
    .map((c) => `<label class="opt"><input type="checkbox" data-col="${c.id}" ${shown(c) ? 'checked' : ''}/><span>${esc(c.label)}</span></label>`)
    .join('');
  $('colsList').addEventListener('change', (e) => {
    const i = e.target as HTMLInputElement;
    const id = i.dataset['col'] as ColumnId;
    updatePrefs({ hiddenColumns: i.checked ? prefs.hiddenColumns.filter((c) => c !== id) : [...prefs.hiddenColumns, id] });
    renderTable();
  });

  $('exportCsv').addEventListener('click', () => { closeMenus(); exportCsv(); });
  $('markSeen').addEventListener('click', () => {
    if (!data || !activeKey) return;
    baseline = makeBaseline(data.bugs);
    saveBaseline(activeKey, baseline);
    closeMenus();
    renderHeader();
    renderResults();
    toast('Marked all as seen');
  });
  $('copyLink').addEventListener('click', async () => {
    closeMenus();
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied');
    } catch {
      toast('Could not copy the link', 'error');
    }
  });
  $('untrack').addEventListener('click', () => {
    closeMenus();
    if (activeKey && confirm(`Stop tracking ${activeKey}? Its saved filters and stars are removed from this browser.`)) untrack(activeKey);
  });

  // settings
  $('connForm').addEventListener('submit', (e) => void submitConnection(e as SubmitEvent));
  $('connOut').addEventListener('click', async () => {
    if (!confirm('Delete the saved Jira credentials from this computer?')) return;
    try {
      config = await deleteConfig();
      jarvisConfigChanged(false);
      openSettings();
      toast('Signed out');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
  $('pTheme').addEventListener('change', (e) => updatePrefs({ theme: (e.target as HTMLSelectElement).value as ThemeName }));
  $('pAccent').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-accent]')?.dataset['accent'] as Accent | undefined;
    if (a) {
      updatePrefs({ accent: a });
      renderAccents();
    }
  });
  const num = (id: string, fallback: number): number => {
    const v = Math.round(Number($<HTMLInputElement>(id).value));
    return v >= 1 && v <= 365 ? v : fallback;
  };
  const onThresholds = (): void => {
    updatePrefs({ warnDays: num('pWarn', DEFAULT_PREFS.warnDays), critDays: num('pCrit', DEFAULT_PREFS.critDays), staleDays: num('pStale', DEFAULT_PREFS.staleDays) });
    if (data) renderDash();
  };
  for (const id of ['pWarn', 'pCrit', 'pStale']) $(id).addEventListener('change', onThresholds);
  $('pAuto').addEventListener('change', (e) => {
    updatePrefs({ autoRefreshMin: Number((e.target as HTMLSelectElement).value) });
    scheduleAuto();
  });
  $('wipe').addEventListener('click', () => {
    if (!confirm('Delete all tracked issues, filters, stars and settings stored in this browser?')) return;
    clearData();
    location.href = location.pathname + (mode === 'demo' ? '?demo' : '');
  });

  // global
  document.addEventListener('click', (e) => {
    for (const m of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) if (!m.contains(e.target as Node)) m.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
    const t = e.target as HTMLElement;
    if (/input|select|textarea/i.test(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/' && (view === 'foryou' || data)) {
      e.preventDefault();
      $(view === 'foryou' ? 'fySearch' : 'search').focus();
    }
    if (e.key === 'r' && (view === 'foryou' || activeKey)) void refreshCurrent();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (view === 'foryou' || activeKey) && prefs.autoRefreshMin && Date.now() - lastFetchAt > prefs.autoRefreshMin * 60_000) void refreshCurrent();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

function openGetApp(): void {
  const dlg = $<HTMLDialogElement>('getApp');
  if (!dlg.open) dlg.showModal();
}

async function copyText(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText($(id).textContent ?? '');
    toast('Copied');
  } catch {
    toast('Could not copy. Select the text and copy it manually.', 'error');
  }
}

function closeMenus(): void {
  for (const m of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) m.open = false;
}

// ------------------------------------------------------------------ start
async function init(): Promise<void> {
  applyTheme();
  wire();
  const detected = await detectMode();
  mode = detected.mode;
  config = detected.config;
  // Sample data and real data are stored separately.
  setNamespace(mode === 'demo' ? 'demo.' : '');
  tracked = loadTracked();

  const params = new URLSearchParams(location.search);
  const urlKey = parseKey(params.get('key') ?? '');
  const issueKey = parseKey(params.get('issue') ?? '');
  const wantView: ViewName = urlKey ? 'epics' : params.get('view') === 'foryou' || issueKey ? 'foryou' : loadView();

  initForYou({ mode: () => mode, configured: () => config.configured, prefs: () => prefs, openConnect: openSettings });
  initJarvis(mode, config.configured, { openIssue: openIssueEverywhere, onActivity, openConnect: openSettings });
  scheduleAuto();
  renderTabs();

  if (wantView === 'foryou') {
    const saved = loadActive();
    activeKey = tracked.find((t) => t.key === saved)?.key ?? tracked[0]?.key ?? null;
    await setView('foryou', !issueKey);
    if (issueKey) openIssueDetail(issueKey);
    if (mode === 'local' && !config.configured) openSettings();
    return;
  }
  await setView('epics', false);
  if (urlKey) return void (await track(urlKey));
  const saved = loadActive();
  const start = tracked.find((t) => t.key === saved)?.key ?? tracked[0]?.key ?? null;
  if (start) return void (await activate(start));
  showShell();
  if (mode === 'local' && !config.configured) openSettings(); // first run: ask for credentials
}

void init();
