// Learn section runtime: navigation (categories, sub-categories), search, table of contents, reading progress
// and the diagram renderer. Plain JavaScript, no dependencies, no network: works on GitHub Pages, the Local
// server and the Cloudflare Worker alike. Each article page only contains its <article>; this file adds the rest.
(() => {
  'use strict';

  // ------------------------------------------------------------------ catalogue
  // category -> sub-categories -> articles. Order here is the reading order.
  const CATALOGUE = [
    { id: 'start', title: 'Start here', blurb: 'What this app is, how to read these guides, and every term explained.', subs: [
      { title: null, items: [
        ['welcome', 'Welcome: how to use these guides', 'A map of everything you can learn here.', 4],
        ['big-picture', 'The big picture, explained simply', 'The whole system as a story with no jargon.', 8],
        ['glossary', 'Glossary: every term in plain words', 'From API to VAPID, explained like you are ten.', 15],
      ] }] },
    { id: 'product', title: 'The product', blurb: 'What the app does for its users and the three editions.', subs: [
      { title: 'Using the app', items: [
        ['features', 'Feature tour', 'Epics view, For You, JARVIS, filters, markers and themes.', 10],
        ['journeys', 'User journeys and use cases', 'Who uses the app and how, with diagrams.', 8],
      ] },
      { title: 'Editions', items: [
        ['editions', 'Local, Cloud and Demo editions', 'Same app, three ways to run it, and when to pick which.', 7],
      ] }] },
    { id: 'hld', title: 'Architecture (HLD)', blurb: 'High-level design: the big boxes, how data flows, and why it was built this way.', subs: [
      { title: 'System design', items: [
        ['hld-overview', 'High-level design', 'Components, responsibilities and data flow.', 12],
        ['decisions', 'Design decisions and trade-offs', 'Why Workers, D1, polling, no framework, and more.', 12],
        ['nfr', 'Quality goals: security, speed, cost, reliability', 'The non-functional requirements and how they are met.', 8],
      ] }] },
    { id: 'lld', title: 'Low-level design (LLD)', blurb: 'Every module, table, endpoint and algorithm in detail.', subs: [
      { title: 'Code', items: [
        ['code-map', 'Code map: every folder and module', 'Where each piece lives and what it is responsible for.', 10],
        ['frontend', 'Frontend internals', 'Modes, state, rendering, storage and charts in the browser.', 14],
        ['core', 'The shared Jira core', 'The JiraApi interface and logic shared by both servers.', 10],
        ['local-server', 'Local server internals', 'The Node.js server, its routes, storage and live stream.', 10],
        ['worker', 'Cloud Worker internals', 'Every file of the Cloudflare Worker explained.', 16],
      ] },
      { title: 'Data and APIs', items: [
        ['database', 'Database design (D1)', 'Tables, columns, keys, indexes and migrations with an ER diagram.', 14],
        ['api-reference', 'API reference', 'Every HTTP endpoint with requests and responses.', 12],
      ] },
      { title: 'JARVIS', items: [
        ['jarvis-engine', 'JARVIS: how changes are detected', 'Snapshots, changelogs, de-duplication and the incremental query.', 14],
        ['jarvis-voice', 'JARVIS: speech and notifications', 'Templates, grouping, quiet hours, voices and tabs.', 10],
      ] }] },
    { id: 'flows', title: 'End-to-end flows', blurb: 'Step-by-step sequence diagrams of what happens when you click.', subs: [
      { title: null, items: [
        ['flow-page-load', 'Opening the app', 'From typing the URL to a rendered dashboard.', 7],
        ['flow-signin', 'Signing in with Atlassian', 'The OAuth 2.0 (3LO) dance, every hop explained.', 12],
        ['flow-foryou', 'Loading "For You"', 'Browser to Worker to Atlassian to Jira and back.', 8],
        ['flow-cron', 'The background check (cron)', 'What happens every minute while you sleep.', 12],
        ['flow-push', 'A notification\'s journey', 'From a Jira comment to a voice in your ear.', 10],
        ['flow-token-refresh', 'Refreshing and rotating tokens', 'How access stays alive without races.', 9],
      ] }] },
    { id: 'jira', title: 'Jira and Atlassian', blurb: 'How Jira\'s API works and how apps get permission to use it.', subs: [
      { title: null, items: [
        ['jira-api', 'How Jira\'s REST API works', 'Issues, fields, JQL, changelogs, comments, pagination.', 12],
        ['atlassian-auth', 'API tokens vs OAuth 2.0 (3LO)', 'Two ways to log in, scopes, consent and grants.', 10],
        ['atlassian-console', 'The developer console, sharing and privacy duties', 'Registering an app and the Personal Data Reporting API.', 9],
      ] }] },
    { id: 'cloudflare', title: 'Cloudflare', blurb: 'What Cloudflare is, how Workers run your code, and the free tier.', subs: [
      { title: null, items: [
        ['cf-basics', 'What Cloudflare is and how the edge works', 'Data centres, the edge and why it is fast.', 9],
        ['cf-workers', 'Workers: how your code runs', 'Isolates, handlers, requests, limits.', 11],
        ['cf-storage', 'D1, assets, cron, secrets and environments', 'Every Cloudflare feature this app uses.', 12],
        ['cf-limits', 'The free tier and capacity maths', 'What is free, where the limits are, how many users fit.', 9],
        ['cf-wrangler', 'Wrangler cheat sheet', 'Every command you will need, with examples.', 8],
      ] }] },
    { id: 'web', title: 'Web fundamentals', blurb: 'The browser and internet basics that everything else stands on.', subs: [
      { title: null, items: [
        ['web-http', 'HTTP, cookies, CORS and same-origin', 'Why the browser cannot call Jira directly.', 12],
        ['web-push', 'Service workers and Web Push', 'How a closed browser still gets notifications.', 11],
        ['web-speech', 'Speech, notifications and browser rules', 'Speech synthesis, permissions and autoplay rules.', 7],
      ] }] },
    { id: 'security', title: 'Security and privacy', blurb: 'The threats, the defences, the cryptography and your data\'s life cycle.', subs: [
      { title: null, items: [
        ['security-threats', 'Threat model and defences', 'CSRF, IDOR, SSRF, XSS and how each is stopped.', 13],
        ['security-crypto', 'The cryptography, simply', 'Hashes, AES-GCM, ECDSA, ECDH and HKDF without maths.', 11],
        ['privacy-lifecycle', 'Privacy and the data life cycle', 'What is stored, for how long, and how it is erased.', 8],
      ] }] },
    { id: 'deploy', title: 'Deploy and operate', blurb: 'Hands-on guides: run, deploy, ship any new app, and keep it healthy.', subs: [
      { title: 'This app', items: [
        ['run-local', 'Run the Local edition', 'From zero to a running dashboard on your computer.', 6],
        ['deploy-cloud', 'Deploy the Cloud edition, step by step', 'The exact path, including every gotcha we hit.', 16],
        ['github', 'Git, GitHub and GitHub Pages', 'Branches, tags, pushes and the demo site.', 9],
      ] },
      { title: 'Any app', items: [
        ['cf-playbook', 'Playbook: deploy any new app on Cloudflare', 'A reusable recipe for your next project.', 15],
      ] },
      { title: 'Production', items: [
        ['operate', 'Operating in production', 'Logs, metrics, rollbacks, backups and key rotation.', 10],
        ['troubleshooting', 'Troubleshooting', 'Symptoms, causes and fixes.', 8],
      ] }] },
    { id: 'quality', title: 'Quality and growth', blurb: 'How the app is tested and how to extend it.', subs: [
      { title: null, items: [
        ['testing', 'How this app is tested', 'Mocks, end-to-end, browser and unit tests.', 9],
        ['extending', 'How to add a feature', 'A worked example from idea to deploy.', 9],
        ['roadmap', 'Roadmap and ideas', 'What could come next and why.', 4],
      ] }] },
  ];

  const ARTICLES = [];
  for (const c of CATALOGUE) for (const s of c.subs) for (const [slug, title, summary, minutes] of s.items) ARTICLES.push({ slug, title, summary, minutes, cat: c, sub: s.title });
  const bySlug = new Map(ARTICLES.map((a) => [a.slug, a]));

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, html = '') => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (html) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const DONE_KEY = 'jbd.v1.learn.done';
  const loadDone = () => { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); } };
  const saveDone = (s) => { try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch { /* storage blocked */ } };
  let done = loadDone();
  const href = (slug) => `${slug}.html`;

  // ------------------------------------------------------------------ chrome: header, sidebar, toc, pager
  function header() {
    const h = el('header', { class: 'top learn-top' });
    h.innerHTML = `<div class="top-row">
      <button class="btn icon side-toggle" type="button" aria-label="Open the topic list">☰</button>
      <a class="brand" href="../index.html" aria-label="Back to the dashboard">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--accent)"/><path d="M7 15l3-3 2 2 5-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Bug Dashboard</span></a>
      <nav class="views" aria-label="Sections"><a class="vbtn" href="../index.html">App</a><a class="vbtn on" href="index.html" aria-current="page">Learn</a></nav>
      <div class="top-actions"><button class="btn icon" id="learnTheme" type="button" title="Switch theme" aria-label="Switch theme">◐</button></div>
    </div>`;
    return h;
  }

  function sidebar(current) {
    const total = ARTICLES.length, n = ARTICLES.filter((a) => done.has(a.slug)).length;
    let html = `<div class="learn-search"><input id="learnSearch" type="search" placeholder="Search the guides…  ( / )" aria-label="Search the guides" autocomplete="off"/><div id="learnResults" class="learn-results" hidden></div></div>
      <div class="learn-progress">${n} of ${total} guides done<div class="bar"><span style="width:${Math.round((n / total) * 100)}%"></span></div></div>
      <p style="margin:12px 0 0"><a href="index.html">← All topics</a></p>`;
    for (const c of CATALOGUE) {
      html += `<h4>${esc(c.title)}</h4>`;
      for (const s of c.subs) {
        if (s.title) html += `<h5>${esc(s.title)}</h5>`;
        html += '<ul>' + s.items.map(([slug, title]) => `<li><a href="${href(slug)}" class="${slug === current ? 'on' : ''}" ${slug === current ? 'aria-current="page"' : ''}><span class="done-dot${done.has(slug) ? ' done' : ''}" aria-hidden="true"></span><span>${esc(title)}</span></a></li>`).join('') + '</ul>';
      }
    }
    return el('nav', { class: 'learn-side', id: 'learnSide', 'aria-label': 'All guides' }, html);
  }

  function slugify(t) { return t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }

  function toc(article) {
    const hs = [...article.querySelectorAll('h2, h3')];
    if (hs.length < 2) return null;
    const used = new Set();
    for (const h of hs) {
      if (!h.id) { let id = slugify(h.textContent); while (used.has(id)) id += '-x'; h.id = id; }
      used.add(h.id);
    }
    const nav = el('nav', { class: 'learn-toc', 'aria-label': 'On this page' }, '<h4>On this page</h4>' + hs.map((h) => `<a href="#${h.id}" class="${h.tagName === 'H3' ? 'h3' : ''}">${esc(h.textContent)}</a>`).join(''));
    const links = [...nav.querySelectorAll('a')];
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        links.forEach((l) => l.classList.toggle('on', l.getAttribute('href') === `#${e.target.id}`));
      }
    }, { rootMargin: '-80px 0px -70% 0px' });
    hs.forEach((h) => obs.observe(h));
    return nav;
  }

  function decorate(article, a) {
    const i = ARTICLES.indexOf(a);
    const crumbs = el('div', { class: 'crumbs' }, `<a href="index.html">Learn</a> › <a href="index.html#${a.cat.id}">${esc(a.cat.title)}</a>${a.sub ? ` › ${esc(a.sub)}` : ''}`);
    const h1 = article.querySelector('h1');
    article.insertBefore(crumbs, article.firstChild);
    if (h1) {
      const meta = el('div', { class: 'meta-line' }, `<span>⏱ ${a.minutes} min read</span><span>Guide ${i + 1} of ${ARTICLES.length}</span>`);
      (article.querySelector('.lede') ?? h1).after(meta);
    }
    const isDone = done.has(a.slug);
    const toggle = el('div', { class: 'done-toggle' }, `<button class="btn ${isDone ? '' : 'primary'}" type="button" id="doneBtn">${isDone ? '✓ Marked as done (undo)' : 'Mark this guide as done'}</button>`);
    article.append(toggle);
    toggle.querySelector('button').addEventListener('click', () => {
      done = loadDone();
      if (done.has(a.slug)) done.delete(a.slug); else done.add(a.slug);
      saveDone(done);
      location.reload();
    });
    const prev = ARTICLES[i - 1], next = ARTICLES[i + 1];
    article.append(el('nav', { class: 'pager', 'aria-label': 'Previous and next guide' },
      (prev ? `<a class="prev" href="${href(prev.slug)}"><small>← Previous</small>${esc(prev.title)}</a>` : '<span></span>') +
      (next ? `<a class="next" href="${href(next.slug)}"><small>Next →</small>${esc(next.title)}</a>` : '')));
  }

  // ------------------------------------------------------------------ home page
  function home(article) {
    const cats = CATALOGUE.map((c) => `<section class="cat" id="${c.id}"><h3>${esc(c.title)}</h3><p>${esc(c.blurb)}</p><ul>${
      c.subs.flatMap((s) => s.items).map(([slug, title, , min]) => `<li>${done.has(slug) ? '✅' : '▫️'} <a href="${href(slug)}">${esc(title)}</a> <small class="muted">${min} min</small></li>`).join('')}</ul></section>`).join('');
    const holder = article.querySelector('#learnCats');
    if (holder) holder.innerHTML = cats;
    const minutes = ARTICLES.reduce((n, a) => n + a.minutes, 0);
    const stats = article.querySelector('#learnStats');
    if (stats) stats.textContent = `${ARTICLES.length} guides in ${CATALOGUE.length} categories, about ${Math.round(minutes / 60)} hours of reading. ${[...done].filter((d) => bySlug.has(d)).length} done so far.`;
  }

  // ------------------------------------------------------------------ search
  function wireSearch() {
    const input = $('#learnSearch'), box = $('#learnResults');
    if (!input) return;
    let sel = -1, hits = [];
    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { box.hidden = true; return; }
      const words = q.split(/\s+/);
      hits = ARTICLES.map((a) => {
        const hay = `${a.title} ${a.summary} ${a.cat.title} ${a.sub ?? ''}`.toLowerCase();
        const score = words.reduce((s, w) => s + (hay.includes(w) ? (a.title.toLowerCase().includes(w) ? 3 : 1) : -100), 0);
        return { a, score };
      }).filter((h) => h.score > 0).sort((x, y) => y.score - x.score).slice(0, 8);
      sel = hits.length ? 0 : -1;
      box.innerHTML = hits.length ? hits.map((h, i) => `<a href="${href(h.a.slug)}" class="${i === sel ? 'sel' : ''}">${esc(h.a.title)}<small>${esc(h.a.cat.title)} · ${esc(h.a.summary)}</small></a>`).join('') : '<p class="muted small" style="padding:8px">No guide matches. Try fewer words.</p>';
      box.hidden = false;
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!hits.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        [...box.querySelectorAll('a')].forEach((x, i) => x.classList.toggle('sel', i === sel));
      } else if (e.key === 'Enter' && hits[sel]) location.href = href(hits[sel].a.slug);
      else if (e.key === 'Escape') { input.value = ''; box.hidden = true; }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.learn-search')) box.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/input|textarea/i.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); input.focus(); }
    });
  }

  // ------------------------------------------------------------------ diagrams
  // <script type="application/json" class="diagram" data-kind="flow|seq" data-caption="..."> {...} </script>
  const NS = 'http://www.w3.org/2000/svg';
  const KIND = {
    user: ['var(--purple)', 'color-mix(in srgb, var(--purple) 12%, var(--card))'],
    browser: ['var(--accent)', 'color-mix(in srgb, var(--accent) 10%, var(--card))'],
    server: ['var(--teal)', 'color-mix(in srgb, var(--teal) 10%, var(--card))'],
    cf: ['var(--orange)', 'color-mix(in srgb, var(--orange) 10%, var(--card))'],
    db: ['var(--green)', 'color-mix(in srgb, var(--green) 10%, var(--card))'],
    ext: ['var(--red)', 'color-mix(in srgb, var(--red) 8%, var(--card))'],
    note: ['var(--grey)', 'var(--card-2)'],
    plain: ['var(--border)', 'var(--card)'],
  };
  const svg = (w, h) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', `0 0 ${w} ${h}`); s.setAttribute('width', w); s.setAttribute('class', 'dg'); s.setAttribute('role', 'img'); return s; };
  const node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  function defs(s) {
    const d = node('defs', {});
    for (const [id, color] of [['arr', 'var(--muted)'], ['arrA', 'var(--accent)']]) {
      const m = node('marker', { id: `${id}-${s.dataset.uid}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
      m.append(node('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
      d.append(m);
    }
    s.append(d);
  }
  let uid = 0;
  function label(s, x, y, text, cls = 'el') {
    const t = node('text', { x, y, 'text-anchor': 'middle', class: cls }, text);
    (s.__labels ?? s).append(t);
    try {
      const b = t.getBBox();
      const r = node('rect', { x: b.x - 3, y: b.y - 1, width: b.width + 6, height: b.height + 2, rx: 3, class: 'lbl-bg' });
      t.parentNode.insertBefore(r, t);
    } catch { /* not rendered yet */ }
  }
  // where the line from the centre of a box towards (tx, ty) leaves the box
  function clip(n, tx, ty) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const sx = dx ? (n.w / 2) / Math.abs(dx) : Infinity, sy = dy ? (n.h / 2) / Math.abs(dy) : Infinity, k = Math.min(sx, sy);
    return [cx + dx * k, cy + dy * k];
  }
  function flow(spec, s) {
    const nodes = new Map();
    // Layers: zones, then edges (behind boxes), then boxes, then edge labels (on top of everything).
    const zoneL = node('g', {}), edgeL = node('g', {}), nodeL = node('g', {}), labelL = node('g', {});
    s.append(zoneL, edgeL, nodeL, labelL);
    s.__labels = labelL;
    for (const z of spec.zones ?? []) {
      zoneL.append(node('rect', { x: z.x, y: z.y, width: z.w, height: z.h, rx: 14, fill: 'none', stroke: KIND[z.kind ?? 'note'][0], 'stroke-dasharray': '6 5', 'stroke-width': 1.4 }));
      zoneL.append(node('text', { x: z.x + 12, y: z.y + 18, class: 'zone-l' }, z.label));
    }
    for (const n of spec.nodes) {
      const [stroke, fill] = KIND[n.kind ?? 'plain'];
      const lines = n.lines ?? [];
      n.h = n.h ?? 28 + (n.sub ? 16 : 0) + lines.length * 15 + (lines.length ? 8 : 0);
      nodes.set(n.id, n);
      const g = node('g', { 'data-id': n.id, 'data-box': `${n.x},${n.y},${n.w},${n.h}` });
      g.append(node('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'db' ? 6 : 10, fill, stroke, 'stroke-width': 1.6 }));
      if (n.kind === 'db') g.append(node('path', { d: `M${n.x},${n.y + 22} H${n.x + n.w}`, stroke, 'stroke-width': 1 }));
      const tx = lines.length || n.left ? n.x + 10 : n.x + n.w / 2;
      const anchor = lines.length || n.left ? 'start' : 'middle';
      g.append(node('text', { x: tx, y: n.y + 17, 'text-anchor': anchor, class: 't' }, `${n.icon ? n.icon + ' ' : ''}${n.title}`));
      let y = n.y + 17;
      if (n.sub) { y += 16; g.append(node('text', { x: tx, y, 'text-anchor': anchor, class: 'l' }, n.sub)); }
      if (lines.length) y += 8;
      for (const l of lines) { y += 15; g.append(node('text', { x: n.x + 10, y, class: 'm' }, l)); }
      nodeL.append(g);
    }
    for (const e of spec.edges ?? []) {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) continue;
      // optional "via": [[x, y], ...] bends the line through waypoints so it can go around other boxes
      const via = e.via ?? [];
      const bc = [b.x + b.w / 2 + (e.dx2 ?? 0), b.y + b.h / 2 + (e.dy2 ?? 0)], ac = [a.x + a.w / 2 + (e.dx1 ?? 0), a.y + a.h / 2 + (e.dy1 ?? 0)];
      const aim1 = via.length ? via[0] : bc, aim2 = via.length ? via[via.length - 1] : ac;
      const [x1, y1] = clip({ ...a, x: a.x + (e.dx1 ?? 0), y: a.y + (e.dy1 ?? 0) }, ...aim1), [x2, y2] = clip({ ...b, x: b.x + (e.dx2 ?? 0), y: b.y + (e.dy2 ?? 0) }, ...aim2);
      const pts = [[x1, y1], ...via, [x2, y2]];
      const p = node('path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '), class: `edge${e.dashed ? ' dash' : ''}${e.accent ? ' accent' : ''}`, 'marker-end': `url(#${e.accent ? 'arrA' : 'arr'}-${s.dataset.uid})`, 'data-from': e.from, 'data-to': e.to });
      if (e.both) p.setAttribute('marker-start', `url(#${e.accent ? 'arrA' : 'arr'}-${s.dataset.uid})`);
      edgeL.append(p);
      // label sits on the middle segment of the line, or on segment "lseg", or exactly at "lpos"
      const m = e.lseg ?? Math.floor((pts.length - 1) / 2), [p1, p2] = [pts[m], pts[m + 1]];
      if (e.label) {
        if (e.lpos) label(s, e.lpos[0], e.lpos[1], e.label);
        else label(s, (p1[0] + p2[0]) / 2 + (e.lx ?? 0), (p1[1] + p2[1]) / 2 - 4 + (e.ly ?? 0), e.label);
      }
    }
  }
  function seq(spec, s) {
    const gap = spec.gap ?? 150, left = 20, top = 16, colW = 120;
    const xs = new Map(spec.actors.map((a, i) => [a.id, left + colW / 2 + i * gap]));
    const rows = spec.steps.length;
    const height = top + 44 + rows * 34 + 30;
    s.setAttribute('viewBox', `0 0 ${left * 2 + colW + (spec.actors.length - 1) * gap} ${height}`);
    s.setAttribute('width', left * 2 + colW + (spec.actors.length - 1) * gap);
    for (const a of spec.actors) {
      const x = xs.get(a.id), [stroke, fill] = KIND[a.kind ?? 'plain'];
      s.append(node('line', { x1: x, y1: top + 40, x2: x, y2: height - 8, class: 'lifeline' }));
      s.append(node('rect', { x: x - colW / 2, y: top, width: colW, height: 40, rx: 10, fill, stroke, 'stroke-width': 1.6 }));
      s.append(node('text', { x, y: top + (a.sub ? 17 : 25), 'text-anchor': 'middle', class: 't' }, `${a.icon ? a.icon + ' ' : ''}${a.label}`));
      if (a.sub) s.append(node('text', { x, y: top + 32, 'text-anchor': 'middle', class: 'l' }, a.sub));
    }
    let y = top + 64;
    let n = 0;
    for (const st of spec.steps) {
      if (st.note) {
        const ids = st.over ?? [st.from];
        const x1 = Math.min(...ids.map((i) => xs.get(i))) - colW / 2 + 6, x2 = Math.max(...ids.map((i) => xs.get(i))) + colW / 2 - 6;
        s.append(node('rect', { x: x1, y: y - 16, width: x2 - x1, height: 24, rx: 6, fill: 'color-mix(in srgb, var(--yellow) 16%, var(--card))', stroke: 'color-mix(in srgb, var(--yellow) 60%, var(--border))' }));
        s.append(node('text', { x: (x1 + x2) / 2, y: y, 'text-anchor': 'middle', class: 'l' }, st.note));
        y += 34;
        continue;
      }
      n++;
      const x1 = xs.get(st.from), x2 = xs.get(st.to);
      const mk = `url(#${st.accent ? 'arrA' : 'arr'}-${s.dataset.uid})`;
      if (x1 === x2) {
        // self-call: loop to the right, or to the left for the last column so the text stays inside
        const last = x1 === Math.max(...xs.values()), d = last ? -1 : 1;
        s.append(node('path', { d: `M${x1},${y - 8} h${34 * d} v14 h${-30 * d}`, class: `edge${st.ret ? ' dash' : ''}`, 'marker-end': mk }));
        s.append(node('text', { x: x1 + 42 * d, y: y + 2, class: 'el', 'text-anchor': last ? 'end' : 'start' }, `${n}. ${st.text}`));
      } else {
        s.append(node('path', { d: `M${x1},${y} L${x2 + (x2 > x1 ? -2 : 2)},${y}`, class: `edge${st.ret ? ' dash' : ''}${st.accent ? ' accent' : ''}`, 'marker-end': mk }));
        label(s, (x1 + x2) / 2, y - 6, `${n}. ${st.text}`);
      }
      y += 34;
    }
  }
  function renderDiagrams() {
    for (const src of document.querySelectorAll('script.diagram')) {
      let spec;
      try { spec = JSON.parse(src.textContent); } catch (e) { console.error('bad diagram', e); continue; }
      const fig = el('figure', { class: `diagram${spec.wide ? ' wide' : ''}` });
      const s = svg(spec.w ?? 800, spec.h ?? 400);
      s.dataset.uid = String(++uid);
      s.setAttribute('aria-label', src.dataset.caption ?? 'Diagram');
      fig.append(s);
      if (src.dataset.caption) fig.append(el('figcaption', {}, esc(src.dataset.caption)));
      src.replaceWith(fig);
      defs(s);
      (src.dataset.kind === 'seq' ? seq : flow)(spec, s);
    }
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    const article = $('article.doc');
    if (!article) return;
    const slug = document.body.dataset.slug;
    const a = bySlug.get(slug);
    document.body.prepend(header());
    const layout = el('div', { class: 'learn' });
    article.parentElement.insertBefore(layout, article);
    layout.append(sidebar(slug));
    layout.append(article);
    renderDiagrams();
    if (a) decorate(article, a);
    else if (slug === 'home') home(article);
    const t = toc(article);
    if (t) layout.append(t);
    if (a) document.title = `${a.title} · Learn · Jira Bug Dashboard`;
    wireSearch();
    const side = $('#learnSide');
    $('.side-toggle')?.addEventListener('click', () => side.classList.toggle('open'));
    document.addEventListener('click', (e) => { if (side.classList.contains('open') && !e.target.closest('#learnSide, .side-toggle')) side.classList.remove('open'); });
    $('#learnTheme')?.addEventListener('click', () => {
      const order = ['system', 'light', 'paper', 'dark', 'midnight'];
      let p = {};
      try { p = JSON.parse(localStorage.getItem('jbd.v1.prefs') || '{}'); } catch { /* default */ }
      p.theme = order[(order.indexOf(p.theme ?? 'system') + 1) % order.length];
      try { localStorage.setItem('jbd.v1.prefs', JSON.stringify(p)); } catch { /* blocked */ }
      document.documentElement.dataset.theme = p.theme;
    });
    // a deep link to a heading
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
