// Learn section runtime. The page frame (header, sidebar, breadcrumbs, "on this page", pager, a reserved box for each
// diagram) is already in the HTML, written by scripts/build-learn.mjs, so this file only adds behaviour: reading
// progress, search, diagram drawing, theme, loader. Plain JavaScript, no dependencies, no network: works on GitHub
// Pages, the Local server and the Cloudflare Worker alike.
(() => {
  'use strict';

  const CATALOGUE = window.LEARN_CATALOGUE ?? [];   // category -> sub-categories -> articles (catalogue.js)
  const ARTICLES = [];
  for (const c of CATALOGUE) for (const s of c.subs) for (const [slug, title, summary, minutes] of s.items) ARTICLES.push({ slug, title, summary, minutes, cat: c, sub: s.title });
  const bySlug = new Map(ARTICLES.map((a) => [a.slug, a]));

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const DONE_KEY = 'jbd.v1.learn.done', SIDE_KEY = 'jbd.v1.learn.side';
  const loadDone = () => { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); } };
  const saveDone = (s) => { try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch { /* storage blocked */ } };
  const href = (slug) => `${slug}.html`;
  let done = loadDone();

  // ------------------------------------------------------------------ reading progress (updates the page in place)
  function applyDone() {
    const slug = document.body.dataset.slug;
    const n = ARTICLES.filter((a) => done.has(a.slug)).length;
    for (const a of $$('#learnSide a[data-slug]')) $('.done-dot', a)?.classList.toggle('done', done.has(a.dataset.slug));
    const txt = $('#learnProgressText'), bar = $('#learnProgressBar');
    if (txt) txt.textContent = `${n} of ${ARTICLES.length} guides done`;
    if (bar) bar.style.width = `${Math.round((n / ARTICLES.length) * 100)}%`;
    const btn = $('#doneBtn');
    if (btn) {
      const isDone = done.has(slug);
      btn.classList.toggle('primary', !isDone);
      btn.textContent = isDone ? '✓ Marked as done (undo)' : 'Mark this guide as done';
    }
    for (const m of $$('.mark[data-slug]')) m.textContent = done.has(m.dataset.slug) ? '✅' : '▫️';
    const stats = $('#learnStats');
    if (stats) stats.textContent = `${stats.dataset.base} ${n} done so far.`;
  }

  function wireDone() {
    const btn = $('#doneBtn'), slug = document.body.dataset.slug;
    btn?.addEventListener('click', () => {
      done = loadDone();                       // another tab may have changed it
      if (done.has(slug)) done.delete(slug); else done.add(slug);
      saveDone(done);
      applyDone();                             // no reload: nothing moves
    });
    window.addEventListener('storage', (e) => { if (e.key === DONE_KEY) { done = loadDone(); applyDone(); } });
  }

  // ------------------------------------------------------------------ "on this page" highlight
  function wireToc() {
    const toc = $('.learn-toc');
    if (!toc) return;
    const links = $$('a', toc);
    const targets = links.map((l) => document.getElementById(l.getAttribute('href').slice(1))).filter(Boolean);
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) links.forEach((l) => l.classList.toggle('on', l.getAttribute('href') === `#${e.target.id}`));
    }, { rootMargin: '-80px 0px -70% 0px' });
    targets.forEach((h) => obs.observe(h));
  }

  // ------------------------------------------------------------------ loader + sidebar position between pages
  const root = document.documentElement;
  const rememberSidebar = () => { try { sessionStorage.setItem(SIDE_KEY, String($('#learnSide')?.scrollTop ?? 0)); } catch { /* blocked */ } };
  function startLoading() { rememberSidebar(); root.classList.add('navigating'); }
  function wireNavigation() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === '_blank' || a.hasAttribute('download')) return;
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || (u.pathname === location.pathname && u.hash)) return;   // other site, or same-page anchor
      startLoading();
    });
    window.addEventListener('pagehide', rememberSidebar);
    window.addEventListener('pageshow', (e) => { if (e.persisted) root.classList.remove('navigating'); });   // back button (page cache)
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
      } else if (e.key === 'Enter' && hits[sel]) { startLoading(); location.href = href(hits[sel].a.slug); }
      else if (e.key === 'Escape') { input.value = ''; box.hidden = true; }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.learn-search')) box.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/input|textarea/i.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); input.focus(); }
    });
  }


  // ------------------------------------------------------------------ diagrams
  // <figure class="diagram" data-kind="flow|seq"><svg (reserved size)></svg><script class="diagram-spec" type="application/json">{...}</script></figure>
  // The build script reserves the svg at its final size; here the shapes are drawn into it.
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
    for (const fig of $$('figure.diagram')) {
      const s = $('svg', fig), src = $('script.diagram-spec', fig);
      if (!s || !src || s.childNodes.length) continue;
      let spec;
      try { spec = JSON.parse(src.textContent); } catch (e) { console.error('bad diagram', e); continue; }
      s.dataset.uid = String(++uid);
      defs(s);
      (fig.dataset.kind === 'seq' ? seq : flow)(spec, s);
    }
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!$('article.doc')) return;
    renderDiagrams();
    applyDone();
    wireDone();
    wireToc();
    wireSearch();
    wireNavigation();
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
    // a deep link to a heading: diagrams are already sized, so this lands in the right place
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
