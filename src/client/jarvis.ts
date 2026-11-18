// JARVIS in the browser: receives events from the local server (or simulates them in the demo),
// decides what to say and show, and renders the header indicator and the control panel.

import type { JarvisEvent, JarvisEventType, JarvisServerPrefs, JarvisStatus } from '../shared/types.js';
import { jarvisEvents, jarvisPost, jarvisStatus, setJarvisPrefs, type Mode } from './api.js';
import { simulateEvent, demoMine } from './demo.js';
import {
  EVENT_LABEL, EVENT_TYPES, describeEvent, inQuietHours, plan, speechFor, welcomeBack, type Address, type Frequency, type JarvisPrefs,
} from './jarvis-core.js';
import { Speaker, englishVoices, notifyPermission, pickVoice, requestNotifyPermission, showNotification, speechSupported } from './speech.js';
import {
  DEFAULT_SIM, loadAnnounced, loadDemoEvents, loadJarvisPrefs, loadSim, saveAnnounced, saveDemoEvents, saveJarvisPrefs, saveSim,
} from './store.js';
import { $, esc, timeAgo, toast } from './util.js';

export interface Hooks {
  /** Open the in-app detail view of an issue. */
  openIssue(key: string): void;
  /** New events arrived (live), so the For You list can refresh. */
  onActivity(events: JarvisEvent[]): void;
  /** Called when the app wants the Jira connection dialog. */
  openConnect(): void;
}

let mode: Mode = 'demo';
let configured = false;
let hooks: Hooks;
let prefs: JarvisPrefs = loadJarvisPrefs();
let sim: JarvisServerPrefs = DEFAULT_SIM;
let status: JarvisStatus | null = null;
let history: JarvisEvent[] = [];
let stream: EventSource | null = null;
let streamUp = false;
let batch: JarvisEvent[] = [];
let batchTimer: number | undefined;
let tab: 'overview' | 'history' | 'settings' = 'overview';
let histFilter: 'all' | 'unread' = 'all';
let speakerBlocked = false;
const TAB_ID = Math.random().toString(36).slice(2);
const MAX_HISTORY = 500;

const speaker = new Speaker(() => prefs);

// ------------------------------------------------------------------ public API

export function initJarvis(m: Mode, isConfigured: boolean, h: Hooks): void {
  mode = m;
  configured = isConfigured;
  hooks = h;
  sim = loadSim();
  speaker.onChange = () => {
    if ($<HTMLDialogElement>('jarvisPanel').open && tab === 'overview') renderBody();
  };
  speaker.onBlocked = (b) => {
    speakerBlocked = b;
    renderIndicator();
  };
  if (speechSupported) window.speechSynthesis.addEventListener?.('voiceschanged', () => $<HTMLDialogElement>('jarvisPanel').open && tab === 'settings' && renderBody());
  bind();
  void start();
  setInterval(() => {
    if ($<HTMLDialogElement>('jarvisPanel').open && tab === 'overview') renderBody();
    renderIndicator();
  }, 15_000);
}

/** Jira credentials were saved or removed. */
export function jarvisConfigChanged(isConfigured: boolean): void {
  configured = isConfigured;
  void start();
}

export const openJarvisPanel = (t: typeof tab = 'overview'): void => {
  tab = t;
  const dlg = $<HTMLDialogElement>('jarvisPanel');
  renderBody();
  if (!dlg.open) dlg.showModal();
};

export const recentEvents = (n = 6): JarvisEvent[] => history.filter((e) => !e.own).slice(-n).reverse();
export const jarvisHistory = (): JarvisEvent[] => history;
export const unreadKeys = (): Set<string> => new Set(history.filter((e) => !e.read && !e.own).map((e) => e.key));
export const markIssueRead = (key: string): void => {
  const ids = history.filter((e) => e.key === key && !e.read).map((e) => e.id);
  if (ids.length) markRead(ids);
};

// ------------------------------------------------------------------ connection

async function start(): Promise<void> {
  stream?.close();
  stream = null;
  streamUp = false;
  if (mode === 'demo') {
    history = loadDemoEvents();
    sim = loadSim();
    status = demoStatus();
    renderIndicator();
    return;
  }
  if (!configured) {
    status = null;
    history = [];
    renderIndicator();
    return;
  }
  try {
    [status, history] = await Promise.all([jarvisStatus(), jarvisEvents()]);
  } catch {
    status = null;
  }
  welcomeIfMissed();
  renderIndicator();
  openStream();
}

function openStream(): void {
  stream = new EventSource('api/jarvis/stream');
  stream.onopen = () => {
    streamUp = true;
    renderIndicator();
  };
  stream.onerror = () => {
    streamUp = false;
    renderIndicator();
  };
  stream.addEventListener('jarvis', (m) => ingest(JSON.parse((m as MessageEvent<string>).data) as JarvisEvent, true));
  stream.addEventListener('status', (m) => {
    status = JSON.parse((m as MessageEvent<string>).data) as JarvisStatus;
    renderIndicator();
    if ($<HTMLDialogElement>('jarvisPanel').open && tab !== 'settings') renderBody();
  });
}

/** Things that happened while no tab was open: one friendly briefing instead of a replay. */
function welcomeIfMissed(): void {
  const announced = loadAnnounced();
  const maxId = history.reduce((m, e) => Math.max(m, e.id), 0);
  if (announced > 0) {
    const missed = history.filter((e) => e.id > announced && !e.read && !e.own);
    const text = prefs.voice && !inQuietHours(prefs.quiet, new Date()) ? welcomeBack(missed, prefs, new Date()) : null;
    if (text) speaker.say(text);
  }
  if (maxId > announced) saveAnnounced(maxId);
}

// ------------------------------------------------------------------ ingesting events

function ingest(e: JarvisEvent, live: boolean): void {
  if (history.some((h) => h.id === e.id)) return;
  history = [...history, e].slice(-MAX_HISTORY);
  if (mode === 'demo') saveDemoEvents(history);
  if (live) {
    batch.push(e);
    clearTimeout(batchTimer);
    // Events from one sync arrive together; wait briefly so they can be announced as a group.
    batchTimer = window.setTimeout(() => void flush(), prefs.frequency === 'digest' ? 12_000 : 1200);
  }
  renderIndicator();
  if ($<HTMLDialogElement>('jarvisPanel').open && tab !== 'settings') renderBody();
  hooks.onActivity([e]);
}

/** Only one open tab should speak. Web Locks make the check-and-claim atomic across tabs. */
async function claim(id: number): Promise<boolean> {
  const run = (): boolean => {
    try {
      const k = 'jbd.jarvis.claim';
      const cur = JSON.parse(localStorage.getItem(k) || 'null') as { id: number; tab: string } | null;
      if (cur && cur.id >= id && cur.tab !== TAB_ID) return false;
      localStorage.setItem(k, JSON.stringify({ id, tab: TAB_ID }));
    } catch {
      /* storage blocked: announce anyway */
    }
    return true;
  };
  if (navigator.locks) return navigator.locks.request('jbd-jarvis-claim', run);
  return run();
}

async function flush(): Promise<void> {
  const events = batch;
  batch = [];
  if (!events.length) return;
  const real = events.filter((e) => !e.simulated);
  if (real.length && !(await claim(Math.max(...real.map((e) => e.id))))) return;
  if (real.length) saveAnnounced(Math.max(loadAnnounced(), ...real.map((e) => e.id)));
  for (const a of plan(events, prefs, new Date())) {
    const first = a.events[a.events.length - 1] as JarvisEvent;
    if (a.notify && prefs.desktop) {
      showNotification({
        title: a.title,
        body: a.body,
        tag: `jbd-${first.key}-${first.type}`,
        silent: prefs.voice && !!a.speech,
        sticky: a.importance === 'high',
        onClick: () => {
          markRead(a.events.map((e) => e.id));
          hooks.openIssue(first.key);
        },
      });
    }
    if (a.speech && prefs.voice) speaker.say(a.speech);
  }
  renderIndicator();
}

// ------------------------------------------------------------------ read state & history

function markRead(ids: number[] | 'all'): void {
  const set = ids === 'all' ? null : new Set(ids);
  history = history.map((e) => (!e.read && (!set || set.has(e.id)) ? { ...e, read: true } : e));
  if (mode === 'demo') saveDemoEvents(history);
  else {
    const real = ids === 'all' ? ('all' as const) : ids.filter((i) => i > 0);
    if (real === 'all' || real.length) void jarvisPost<JarvisStatus>('read', real === 'all' ? { all: true } : { ids: real }).then((s) => { status = s; renderIndicator(); }, () => undefined);
  }
  renderIndicator();
  if ($<HTMLDialogElement>('jarvisPanel').open) renderBody();
}

const unreadCount = (): number => history.filter((e) => !e.read && !e.own).length;

// ------------------------------------------------------------------ demo (simulated monitor)

function demoStatus(): JarvisStatus {
  const open = demoMine().bugs.filter((b) => b.statusCategory !== 'done').length;
  return {
    state: !sim.enabled ? 'off' : sim.paused ? 'paused' : 'online',
    prefs: sim, lastSyncAt: new Date().toISOString(), nextSyncAt: null, lastError: null, monitored: open,
    unread: unreadCount(), lastEventId: 0, clients: 1, osNotifySupported: false,
  };
}

function simulate(type: JarvisEventType, count = 1): void {
  if (mode === 'demo' && (!sim.enabled || sim.paused)) return void toast('JARVIS is switched off or paused. Resume it first.', 'error');
  const bugs = demoMine().bugs;
  for (let i = 0; i < count; i++) {
    const types: JarvisEventType[] = ['assigned', 'comment', 'status', 'priority', 'reopened', 'resolved'];
    ingest(simulateEvent(count > 1 ? (types[i % types.length] as JarvisEventType) : type, bugs), true);
  }
}

function testAnnouncement(): void {
  const e = simulateEvent('assigned', demoMine().bugs);
  e.key = 'ABC-123';
  e.summary = 'Login button does not respond on Safari';
  if (prefs.voice || !speechSupported) {
    if (!speechSupported) toast('This browser has no speech synthesis. Notifications will still work.', 'error');
    else speaker.say(speechFor(e, prefs), true);
  } else toast('Voice is switched off. Turn it on in Settings to hear the test.', 'error');
  if (prefs.desktop) showNotification({ title: 'JARVIS test: ABC-123 assigned to you', body: e.summary, tag: 'jbd-test', silent: prefs.voice, onClick: () => undefined });
}

// ------------------------------------------------------------------ state labels

interface View {
  label: string;
  detail: string;
  tone: 'ok' | 'warn' | 'err' | 'off';
}

function view(): View {
  const s = status;
  if (mode === 'local' && !configured) return { label: 'Offline', detail: 'Connect Jira to start monitoring.', tone: 'off' };
  if (!s) return { label: 'Offline', detail: 'Cannot reach the local server.', tone: 'err' };
  if (mode === 'local' && !streamUp) return { label: 'Reconnecting', detail: 'Lost the connection to the local server. Retrying…', tone: 'warn' };
  switch (s.state) {
    case 'off': return { label: 'Off', detail: 'JARVIS is switched off.', tone: 'off' };
    case 'paused': return { label: 'Paused', detail: 'Monitoring is paused. Nothing is being checked.', tone: 'off' };
    case 'backoff': return { label: 'Retrying', detail: s.lastError ?? 'Jira did not respond. Retrying with a delay.', tone: 'warn' };
    case 'syncing': return { label: 'Syncing', detail: 'Checking Jira now…', tone: 'ok' };
    case 'unconfigured': return { label: 'Offline', detail: 'Connect Jira to start monitoring.', tone: 'off' };
    default: return { label: 'Online', detail: mode === 'demo' ? 'Demo: events are simulated.' : `Watching ${s.monitored} bug${s.monitored === 1 ? '' : 's'}.`, tone: 'ok' };
  }
}

function renderIndicator(): void {
  const v = view();
  const b = $('jarvisBtn');
  b.dataset['tone'] = v.tone;
  b.dataset['state'] = status?.state ?? 'off';
  const n = unreadCount();
  b.setAttribute('aria-label', `JARVIS ${v.label}${n ? `, ${n} unread` : ''}`);
  b.title = `JARVIS: ${v.label}. ${v.detail}`;
  const badge = $('jarvisBadge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  $('jarvisHint').hidden = !speakerBlocked;
}

// ------------------------------------------------------------------ control panel

const EV_CLASS: Record<JarvisEventType, string> = {
  assigned: 'accent', reassigned_away: 'grey', unassigned: 'grey', status: 'purple', reopened: 'red', resolved: 'green', closed: 'green',
  comment: 'teal', priority: 'orange', severity: 'orange', updated: 'grey',
};
const EV_SHORT: Record<JarvisEventType, string> = {
  assigned: 'ASSIGNED', reassigned_away: 'REASSIGNED', unassigned: 'UNASSIGNED', status: 'STATUS', reopened: 'REOPENED', resolved: 'RESOLVED',
  closed: 'CLOSED', comment: 'COMMENT', priority: 'PRIORITY', severity: 'SEVERITY', updated: 'UPDATED',
};

export const eventListHtml = (evs: JarvisEvent[]): string => `<ul class="ev-list">${evs.map(eventRow).join('')}</ul>`;

function eventRow(e: JarvisEvent): string {
  return `<li><button type="button" class="ev-row${e.read || e.own ? '' : ' unread'}" data-open-issue="${esc(e.key)}" data-ev="${e.id}">
    <span class="ev ev-${EV_CLASS[e.type]}">${EV_SHORT[e.type]}</span>
    <span class="ev-main"><b>${esc(e.key)}</b> <span class="ev-sum">${esc(e.summary)}</span>
      <small class="muted">${esc(describeEvent(e))}${e.simulated ? ' · simulated' : ''}${e.own ? ' · by you' : ''}</small></span>
    <time class="muted small" title="${esc(new Date(e.at).toLocaleString())}">${esc(timeAgo(e.at))}</time></button></li>`;
}

function renderBody(): void {
  for (const t of ['overview', 'history', 'settings'] as const) {
    const el = $(`jpTab-${t}`);
    el.setAttribute('aria-selected', String(t === tab));
    el.classList.toggle('on', t === tab);
  }
  const body = $('jpBody');
  const scroll = body.scrollTop;
  body.innerHTML = tab === 'overview' ? overviewHtml() : tab === 'history' ? historyHtml() : settingsHtml();
  body.scrollTop = scroll;
}

function overviewHtml(): string {
  const v = view();
  const s = status;
  const next = s?.nextSyncAt ? Math.max(0, Math.round((Date.parse(s.nextSyncAt) - Date.now()) / 1000)) : null;
  const pending = [...speaker.pending()];
  const canControl = mode === 'demo' || (configured && !!s);
  const enabled = (mode === 'demo' ? sim : s?.prefs)?.enabled ?? true;
  const paused = (mode === 'demo' ? sim : s?.prefs)?.paused ?? false;
  const recent = recentEvents(5);
  const cap =
    mode === 'demo'
      ? 'This is the hosted demo. Events here are simulated so you can try the voice and notifications. Run the app on your computer to monitor real Jira bugs.'
      : 'JARVIS checks Jira from your local server, so detection keeps running while no tab is open. Voice and in-browser notifications need a tab open; optional system notifications cover the rest.';
  return `
  <section class="jp-card jp-status tone-${v.tone}">
    <div class="jp-dot" aria-hidden="true"></div>
    <div><b>${esc(v.label)}</b><p class="muted small">${esc(v.detail)}</p></div>
  </section>
  <dl class="jp-stats">
    <div><dt>Monitoring</dt><dd>${s ? s.monitored : '—'} bugs</dd></div>
    <div><dt>Last sync</dt><dd>${s?.lastSyncAt ? esc(timeAgo(s.lastSyncAt)) : '—'}</dd></div>
    <div><dt>Next check</dt><dd>${next === null ? '—' : next < 5 ? 'now' : `in ${next >= 90 ? Math.round(next / 60) + ' min' : next + 's'}`}</dd></div>
    <div><dt>Unread</dt><dd>${unreadCount()}</dd></div>
  </dl>
  <div class="row jp-actions">
    ${canControl && enabled ? `<button class="btn" data-j="${paused ? 'resume' : 'pause'}">${paused ? 'Resume' : 'Pause'}</button>` : ''}
    ${canControl && enabled && mode === 'local' ? '<button class="btn" data-j="sync">Check now</button>' : ''}
    ${canControl ? `<button class="btn" data-j="${enabled ? 'off' : 'on'}">${enabled ? 'Turn off' : 'Turn on'}</button>` : '<button class="btn primary" data-j="connect">Connect Jira</button>'}
  </div>
  <section class="jp-card">
    <h3>Pending announcements</h3>
    ${pending.length ? `<ol class="jp-pending">${pending.map((p, i) => `<li>${i === 0 && speaker.pending().length ? '<span class="speaking" aria-hidden="true"></span>' : ''}${esc(p)}</li>`).join('')}</ol>` : '<p class="muted small">Nothing waiting.</p>'}
    ${speakerBlocked ? '<p class="small warn-text">Your browser needs one click or key press on this page before it lets JARVIS speak. Click anywhere to enable voice.</p>' : ''}
  </section>
  <section class="jp-card">
    <h3>Try it</h3>
    <div class="row">
      <button class="btn primary" data-j="test">Test announcement</button>
      <select id="jpSimType" aria-label="Simulated event type">${EVENT_TYPES.filter((t) => t !== 'updated').map((t) => `<option value="${t}">${esc(EVENT_LABEL[t])}</option>`).join('')}</select>
      <button class="btn" data-j="simulate">Simulate</button>
      <button class="btn" data-j="burst" title="Several updates at once, to hear how JARVIS groups them">Simulate burst</button>
    </div>
    <p class="muted small">Simulated events use sample or your own bug keys and are never sent to Jira.</p>
  </section>
  <section class="jp-card">
    <h3>Latest events</h3>
    ${recent.length ? `<ul class="ev-list">${recent.map(eventRow).join('')}</ul>` : '<p class="muted small">No events yet. New activity on your bugs will show up here.</p>'}
  </section>
  <p class="note small">${esc(cap)}</p>`;
}

function historyHtml(): string {
  const list = history.filter((e) => histFilter === 'all' || (!e.read && !e.own)).slice().reverse();
  return `
  <div class="row jp-bar">
    <div class="seg" role="tablist" aria-label="Filter history">
      <button type="button" class="${histFilter === 'all' ? 'on' : ''}" data-hf="all">All</button>
      <button type="button" class="${histFilter === 'unread' ? 'on' : ''}" data-hf="unread">Unread ${unreadCount() ? `<b>${unreadCount()}</b>` : ''}</button>
    </div>
    <button class="btn small" data-j="readall" ${unreadCount() ? '' : 'disabled'}>Mark all read</button>
    <button class="btn small danger" data-j="clear" ${history.length ? '' : 'disabled'}>Clear</button>
  </div>
  ${list.length ? `<ul class="ev-list">${list.slice(0, 150).map(eventRow).join('')}</ul>` : `<p class="muted jp-empty">${histFilter === 'unread' ? 'You are all caught up.' : 'No events yet.'}</p>`}
  ${list.length > 150 ? '<p class="muted small">Showing the latest 150 events.</p>' : ''}`;
}

function settingsHtml(): string {
  const sp = mode === 'demo' ? sim : (status?.prefs ?? DEFAULT_SIM);
  const perm = notifyPermission();
  const voices = englishVoices();
  const chosen = pickVoice(prefs.voiceName);
  const sw = (id: string, on: boolean, label: string, sub = ''): string =>
    `<label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}/><span><b>${label}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</span></label>`;
  const permNote =
    perm === 'unsupported' ? 'This browser does not support desktop notifications.'
    : perm === 'denied' ? 'Blocked by the browser. Allow notifications for this site in the address-bar site settings, then reload.'
    : perm === 'granted' ? 'Permission granted.' : 'The browser will ask for permission when you switch this on.';
  return `
  <section class="jp-card">
    <h3>Monitoring</h3>
    ${sw('js-enabled', sp.enabled, 'JARVIS enabled')}
    ${sw('js-paused', sp.paused, 'Pause monitoring', 'Nothing is checked while paused.')}
    <label>Check Jira every
      <select id="js-interval" ${mode === 'demo' ? 'disabled' : ''}>${[30, 60, 120, 300, 600, 900].map((n) => `<option value="${n}" ${sp.intervalSec === n ? 'selected' : ''}>${n < 60 ? n + ' seconds' : n / 60 + (n === 60 ? ' minute' : ' minutes')}</option>`).join('')}</select>
    </label>
    <p class="muted small">${mode === 'demo' ? 'Polling does not apply to the demo.' : 'Shorter intervals notice changes sooner but use more of your Jira rate limit. One minute is a good default.'}</p>
  </section>
  <section class="jp-card">
    <h3>Desktop notifications</h3>
    ${sw('js-desktop', prefs.desktop && perm === 'granted', 'Show desktop notifications', 'Clicking one opens the bug in the dashboard.')}
    <p class="small ${perm === 'denied' ? 'warn-text' : 'muted'}" id="js-permnote">${esc(permNote)}</p>
    ${mode === 'local' && status?.osNotifySupported ? sw('js-os', sp.osNotify, 'Also use system notifications when no browser tab is open', 'Sent by the local server (macOS or Linux). They cannot speak.') : ''}
  </section>
  <section class="jp-card">
    <h3>Voice</h3>
    ${speechSupported ? '' : '<p class="small warn-text">This browser has no speech synthesis. Voice is unavailable.</p>'}
    ${sw('js-voice', prefs.voice, 'Voice announcements')}
    <label>Voice
      <select id="js-voicename" ${speechSupported ? '' : 'disabled'}><option value="">Automatic${chosen ? ` (${esc(chosen.name)})` : ''}</option>${voices.map((v) => `<option value="${esc(v.name)}" ${prefs.voiceName === v.name ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('')}</select>
    </label>
    <label>Speed <output id="o-rate">${prefs.rate.toFixed(2)}×</output><input type="range" id="js-rate" min="0.7" max="1.4" step="0.05" value="${prefs.rate}"/></label>
    <label>Volume <output id="o-vol">${Math.round(prefs.volume * 100)}%</output><input type="range" id="js-volume" min="0" max="1" step="0.05" value="${prefs.volume}"/></label>
    <label>Address me as
      <select id="js-address">${(['sir', "ma'am", 'boss', ''] as Address[]).map((a) => `<option value="${esc(a)}" ${prefs.address === a ? 'selected' : ''}>${a || '(no title)'}</option>`).join('')}</select>
    </label>
    <button class="btn" data-j="test" type="button">Test announcement</button>
  </section>
  <section class="jp-card">
    <h3>What to announce</h3>
    <div class="jp-types">${EVENT_TYPES.map((t) => sw(`jt-${t}`, prefs.types[t], esc(EVENT_LABEL[t]))).join('')}</div>
    <label>How often
      <select id="js-freq">
        <option value="all" ${prefs.frequency === 'all' ? 'selected' : ''}>Every update (up to two spoken, larger bursts become one briefing)</option>
        <option value="important" ${prefs.frequency === 'important' ? 'selected' : ''}>Important only (assignments, reopens, escalations, resolutions)</option>
        <option value="digest" ${prefs.frequency === 'digest' ? 'selected' : ''}>Digest (collect updates for 12 seconds, then one briefing)</option>
      </select>
    </label>
    <p class="muted small">Low-importance edits are never spoken. Your own actions are never announced. Everything is still kept in the history.</p>
  </section>
  <section class="jp-card">
    <h3>Quiet hours</h3>
    ${sw('js-quiet', prefs.quiet.on, 'Silence voice and notifications', 'Events are still recorded as unread.')}
    <div class="grid2"><label>From<input type="time" id="js-qfrom" value="${esc(prefs.quiet.from)}"/></label><label>To<input type="time" id="js-qto" value="${esc(prefs.quiet.to)}"/></label></div>
  </section>`;
}

// ------------------------------------------------------------------ events

function savePrefs(patch: Partial<JarvisPrefs>): void {
  prefs = { ...prefs, ...patch };
  saveJarvisPrefs(prefs);
}

async function serverPrefs(patch: Partial<JarvisServerPrefs>): Promise<void> {
  if (mode === 'demo') {
    sim = { ...sim, ...patch };
    saveSim(sim);
    status = demoStatus();
  } else {
    try {
      const r = await setJarvisPrefs(patch);
      status = r.status;
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  renderIndicator();
  renderBody();
}

function bind(): void {
  $('jarvisBtn').addEventListener('click', () => openJarvisPanel('overview'));
  for (const t of ['overview', 'history', 'settings'] as const) {
    $(`jpTab-${t}`).addEventListener('click', () => {
      tab = t;
      renderBody();
    });
  }
  const panel = $('jpBody');

  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const open = t.closest<HTMLElement>('[data-open-issue]');
    if (open?.dataset['openIssue']) {
      const id = Number(open.dataset['ev']);
      if (Number.isFinite(id)) markRead([id]);
      $<HTMLDialogElement>('jarvisPanel').close();
      hooks.openIssue(open.dataset['openIssue']);
      return;
    }
    const hf = t.closest<HTMLElement>('[data-hf]')?.dataset['hf'];
    if (hf) {
      histFilter = hf as 'all' | 'unread';
      return renderBody();
    }
    const act = t.closest<HTMLElement>('[data-j]')?.dataset['j'];
    if (!act) return;
    switch (act) {
      case 'pause': return void serverPrefs({ paused: true });
      case 'resume': return void serverPrefs({ paused: false });
      case 'off': return void serverPrefs({ enabled: false });
      case 'on': return void serverPrefs({ enabled: true, paused: false });
      case 'sync':
        void jarvisPost('sync').then(() => toast('Checking Jira…'), (err) => toast((err as Error).message, 'error'));
        return;
      case 'connect': $<HTMLDialogElement>('jarvisPanel').close(); return hooks.openConnect();
      case 'test': return testAnnouncement();
      case 'simulate': return simulate($<HTMLSelectElement>('jpSimType').value as JarvisEventType);
      case 'burst': return simulate('status', 7);
      case 'readall': return markRead('all');
      case 'clear':
        if (!confirm('Delete the whole notification history?')) return;
        history = [];
        if (mode === 'demo') saveDemoEvents([]);
        else void jarvisPost<JarvisStatus>('clear').then((s) => { status = s; renderIndicator(); }, () => undefined);
        renderIndicator();
        return renderBody();
      default:
    }
  });

  panel.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'js-rate') {
      savePrefs({ rate: Number(t.value) });
      $('o-rate').textContent = `${Number(t.value).toFixed(2)}×`;
    } else if (t.id === 'js-volume') {
      savePrefs({ volume: Number(t.value) });
      $('o-vol').textContent = `${Math.round(Number(t.value) * 100)}%`;
    }
  });

  panel.addEventListener('change', async (e) => {
    const t = e.target as HTMLInputElement & HTMLSelectElement;
    const id = t.id;
    if (id === 'js-enabled') return void serverPrefs({ enabled: t.checked });
    if (id === 'js-paused') return void serverPrefs({ paused: t.checked });
    if (id === 'js-interval') return void serverPrefs({ intervalSec: Number(t.value) });
    if (id === 'js-os') return void serverPrefs({ osNotify: t.checked });
    if (id === 'js-desktop') {
      if (t.checked) {
        const p = await requestNotifyPermission(); // runs inside the click, as browsers require
        savePrefs({ desktop: p === 'granted' });
        if (p !== 'granted') toast(p === 'denied' ? 'Notifications are blocked in your browser settings.' : 'Notifications are not available here.', 'error');
        else showNotification({ title: 'JARVIS is online', body: 'Desktop notifications are on.', tag: 'jbd-welcome', silent: true, onClick: () => undefined });
      } else savePrefs({ desktop: false });
      return renderBody();
    }
    if (id === 'js-voice') {
      savePrefs({ voice: t.checked });
      if (!t.checked) speaker.clear();
      return;
    }
    if (id === 'js-voicename') return savePrefs({ voiceName: t.value });
    if (id === 'js-address') return savePrefs({ address: t.value as Address });
    if (id === 'js-freq') return savePrefs({ frequency: t.value as Frequency });
    if (id === 'js-quiet') return savePrefs({ quiet: { ...prefs.quiet, on: t.checked } });
    if (id === 'js-qfrom') return savePrefs({ quiet: { ...prefs.quiet, from: t.value || '22:00' } });
    if (id === 'js-qto') return savePrefs({ quiet: { ...prefs.quiet, to: t.value || '08:00' } });
    if (id.startsWith('jt-')) savePrefs({ types: { ...prefs.types, [id.slice(3)]: t.checked } });
  });

  $('jarvisHint').addEventListener('click', () => speaker.pending().length && toast('Voice enabled'));
}
