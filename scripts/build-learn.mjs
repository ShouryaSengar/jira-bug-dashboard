// Builds the Learn guides: docs-src/learn/*.body + catalogue.json -> public/learn/*.html (+ catalogue.js).
//
// Every page is written with its complete frame (header, sidebar, breadcrumbs, "on this page", pager and a reserved
// box for each diagram), so the first paint already has its final layout and nothing jumps when learn.js starts.
// learn.js only adds behaviour on top (search, progress, diagrams, theme).
//
//   node scripts/build-learn.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'docs-src', 'learn');
const OUT = path.join(root, 'public', 'learn');
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(SRC, 'catalogue.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const slugify = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const ARTICLES = [];
for (const c of CATALOGUE) for (const s of c.subs) for (const [slug, title, summary, minutes] of s.items) ARTICLES.push({ slug, title, summary, minutes, cat: c, sub: s.title });
const bySlug = new Map(ARTICLES.map((a) => [a.slug, a]));
const href = (slug) => `${slug}.html`;

// ---------------------------------------------------------------- pieces of the frame
const headerHtml = () => `<header class="top learn-top">
<div class="top-row">
  <button class="btn icon side-toggle" type="button" aria-label="Open the topic list">☰</button>
  <a class="brand" href="../index.html" aria-label="Back to the dashboard">
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--accent)"/><path d="M7 15l3-3 2 2 5-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>Bug Dashboard</span></a>
  <nav class="views" aria-label="Sections"><a class="vbtn" href="../index.html">App</a><a class="vbtn on" href="index.html" aria-current="page">Learn</a></nav>
  <div class="top-actions"><button class="btn icon" id="learnTheme" type="button" title="Switch theme" aria-label="Switch theme">◐</button></div>
</div>
</header>`;

function sidebarHtml(current) {
  let h = `<nav class="learn-side" id="learnSide" aria-label="All guides">
<div class="learn-search"><input id="learnSearch" type="search" placeholder="Search the guides…  ( / )" aria-label="Search the guides" autocomplete="off"/><div id="learnResults" class="learn-results" hidden></div></div>
<div class="learn-progress"><span id="learnProgressText">0 of ${ARTICLES.length} guides done</span><div class="bar"><span id="learnProgressBar" style="width:0%"></span></div></div>
<p style="margin:12px 0 0"><a href="index.html">← All topics</a></p>`;
  for (const c of CATALOGUE) {
    h += `\n<h4>${esc(c.title)}</h4>`;
    for (const s of c.subs) {
      if (s.title) h += `\n<h5>${esc(s.title)}</h5>`;
      h += '\n<ul>' + s.items.map(([slug, title]) => `<li><a href="${href(slug)}" data-slug="${slug}"${slug === current ? ' class="on" aria-current="page"' : ''}><span class="done-dot" aria-hidden="true"></span><span>${esc(title)}</span></a></li>`).join('') + '</ul>';
    }
  }
  // side.js restores the sidebar's scroll position; the marker after it, together with <link rel="expect"> in the
  // head, makes browsers that support it wait for that before the first paint.
  return h + '\n<script src="side.js"></script><span id="learnSideReady" hidden></span>\n</nav>';
}

/** Gives h2/h3 an id and returns { body, toc } */
function headings(body) {
  const used = new Set();
  const items = [];
  const out = body.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (all, lvl, attrs, inner) => {
    let id = (/\sid="([^"]+)"/.exec(attrs) ?? [])[1];
    const text = decode(inner.replace(/<[^>]+>/g, ''));
    if (!id) { id = slugify(inner); while (used.has(id)) id += '-x'; attrs += ` id="${id}"`; }
    used.add(id);
    items.push({ lvl, id, text });
    return `<h${lvl}${attrs}>${inner}</h${lvl}>`;
  });
  const toc = items.length < 2 ? '' : `<nav class="learn-toc" aria-label="On this page"><h4>On this page</h4>${items.map((i) => `<a href="#${i.id}"${i.lvl === '3' ? ' class="h3"' : ''}>${esc(i.text)}</a>`).join('')}</nav>`;
  return { body: out, toc };
}

/** The diagram's <script type=json> becomes a figure whose svg already has the right size, so no space is added later. */
function diagrams(body, slug) {
  return body.replace(/<script type="application\/json" class="diagram"([^>]*)>([\s\S]*?)<\/script>/g, (all, attrs, json) => {
    let spec;
    try { spec = JSON.parse(json); } catch (e) { throw new Error(`${slug}: bad diagram JSON: ${e.message}`); }
    const kind = /data-kind="(\w+)"/.exec(attrs)?.[1] ?? 'flow';
    const caption = decode(/data-caption="([^"]*)"/.exec(attrs)?.[1] ?? '');
    let w = spec.w ?? 800, h = spec.h ?? 400;
    if (kind === 'seq') { // same maths as seq() in learn.js
      const gap = spec.gap ?? 150;
      w = 20 * 2 + 120 + (spec.actors.length - 1) * gap;
      h = 16 + 44 + spec.steps.length * 34 + 30;
    }
    const label = esc(caption || 'Diagram');
    return `<figure class="diagram${spec.wide ? ' wide' : ''}" data-kind="${kind}"><svg class="dg" viewBox="0 0 ${w} ${h}" width="${w}" role="img" aria-label="${label}"></svg><script type="application/json" class="diagram-spec">${json.trim()}</script>${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
  });
}

function homeCats() {
  return CATALOGUE.map((c) => `<section class="cat" id="${c.id}"><h3>${esc(c.title)}</h3><p>${esc(c.blurb)}</p><ul>${
    c.subs.flatMap((s) => s.items).map(([slug, title, , min]) => `<li><span class="mark" data-slug="${slug}">▫️</span> <a href="${href(slug)}">${esc(title)}</a> <small class="muted">${min} min</small></li>`).join('')}</ul></section>`).join('');
}

function articleHtml(slug, rawBody) {
  const a = bySlug.get(slug);
  let { body, toc } = headings(diagrams(rawBody, slug));
  if (slug === 'index') {
    const minutes = ARTICLES.reduce((n, x) => n + x.minutes, 0);
    body = body
      .replace('<div class="cats" id="learnCats"></div>', `<div class="cats" id="learnCats">${homeCats()}</div>`)
      .replace('<p class="muted" id="learnStats"></p>', `<p class="muted" id="learnStats" data-base="${ARTICLES.length} guides in ${CATALOGUE.length} categories, about ${Math.round(minutes / 60)} hours of reading.">${ARTICLES.length} guides in ${CATALOGUE.length} categories, about ${Math.round(minutes / 60)} hours of reading. 0 done so far.</p>`);
    return { html: body, toc };
  }
  const i = ARTICLES.indexOf(a);
  const crumbs = `<div class="crumbs"><a href="index.html">Learn</a> › <a href="index.html#${a.cat.id}">${esc(a.cat.title)}</a>${a.sub ? ` › ${esc(a.sub)}` : ''}</div>`;
  const meta = `<div class="meta-line"><span>⏱ ${a.minutes} min read</span><span>Guide ${i + 1} of ${ARTICLES.length}</span></div>`;
  const lede = /<(\w+)[^>]*class="[^"]*\blede\b[^"]*"[^>]*>[\s\S]*?<\/\1>/.exec(body);
  if (lede) body = body.slice(0, lede.index + lede[0].length) + meta + body.slice(lede.index + lede[0].length);
  else body = body.replace(/<\/h1>/, `</h1>${meta}`);
  const prev = ARTICLES[i - 1], next = ARTICLES[i + 1];
  const pager = `<nav class="pager" aria-label="Previous and next guide">${prev ? `<a class="prev" href="${href(prev.slug)}"><small>← Previous</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${href(next.slug)}"><small>Next →</small>${esc(next.title)}</a>` : ''}</nav>`;
  const done = `<div class="done-toggle"><button class="btn primary" type="button" id="doneBtn">Mark this guide as done</button></div>`;
  return { html: crumbs + body + done + pager, toc };
}

// ---------------------------------------------------------------- pages
const PAGE = ({ title, desc, slug, header, side, article, toc }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'" />
<meta name="color-scheme" content="light dark" />
<title>${title}</title>
<meta name="description" content="${desc}" />
<link rel="icon" href="../icon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="../css/app.css" />
<link rel="stylesheet" href="learn.css" />
<link rel="expect" href="#learnSideReady" blocking="render" />
<script src="../js/boot.js"></script>
</head>
<body data-slug="${slug}">
${header}
<main>
<div class="learn">
${side}
<article class="doc">
${article}
</article>
${toc}
</div>
</main>
<script src="catalogue.js"></script>
<script src="learn.js"></script>
</body>
</html>
`;

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.body')).sort();
let n = 0;
for (const f of files) {
  const slug = f.slice(0, -5);
  const a = bySlug.get(slug);
  if (!a && slug !== 'index') throw new Error(`${f} is not in catalogue.json`);
  const { html, toc } = articleHtml(slug, fs.readFileSync(path.join(SRC, f), 'utf8').trim());
  const title = slug === 'index' ? 'Learn · Jira Bug Dashboard' : `${esc(a.title)} · Learn · Jira Bug Dashboard`;
  const desc = esc(a?.summary ?? 'Guides to how Jira Bug Dashboard works: architecture, code, Jira, Cloudflare, security and deployment.');
  fs.writeFileSync(path.join(OUT, `${slug}.html`), PAGE({ title, desc, slug: slug === 'index' ? 'home' : slug, header: headerHtml(), side: sidebarHtml(slug === 'index' ? '' : slug), article: html, toc }));
  n++;
}
const missing = ARTICLES.filter((a) => !files.includes(`${a.slug}.body`)).map((a) => a.slug);
if (missing.length) throw new Error(`catalogue entries without a .body file: ${missing.join(', ')}`);
fs.writeFileSync(path.join(OUT, 'catalogue.js'), `// Generated by scripts/build-learn.mjs from docs-src/learn/catalogue.json. Do not edit.\nwindow.LEARN_CATALOGUE = ${JSON.stringify(CATALOGUE)};\n`);
console.log(`built ${n} pages, ${ARTICLES.length} guides in ${CATALOGUE.length} categories`);
