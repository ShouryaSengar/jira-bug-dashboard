// Small dependency-free SVG/HTML charts. Everything interactive is a real <button>, so charts are
// usable with keyboard and screen readers.

import { esc } from './util.js';
import type { TrendPoint } from './analysis.js';

export interface Slice {
  label: string;
  n: number;
  color: string;
}

/** Donut with a legend. `active` slices are the ones currently used as a filter. */
export function donut(slices: Slice[], active: string[], group: string, centerLabel: string): string {
  const total = slices.reduce((s, x) => s + x.n, 0);
  if (!total) return '<p class="muted">No data</p>';
  let offset = 25; // start at 12 o'clock
  const segs = slices
    .map((s) => {
      const pct = (s.n / total) * 100;
      const dim = active.length && !active.includes(s.label);
      const el = `<circle class="seg${dim ? ' dim' : ''}" cx="21" cy="21" r="15.9155" fill="none" stroke="${s.color}" stroke-width="6"
        stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${offset}"><title>${esc(s.label)}: ${s.n}</title></circle>`;
      offset -= pct;
      return el;
    })
    .join('');
  const legend = slices
    .map(
      (s) => `<button type="button" class="legend-row${active.includes(s.label) ? ' active' : ''}" data-group="${group}" data-v="${esc(s.label)}" aria-pressed="${active.includes(s.label)}">
        <i style="background:${s.color}"></i><span class="lbl">${esc(s.label)}</span><b>${s.n}</b></button>`
    )
    .join('');
  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 42 42" role="img" aria-label="${esc(centerLabel)}: ${total}">
      <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--border)" stroke-width="6" />${segs}
      <text x="21" y="21.5" text-anchor="middle" class="donut-n">${total}</text>
      <text x="21" y="26.5" text-anchor="middle" class="donut-l">${esc(centerLabel)}</text>
    </svg>
    <div class="legend">${legend}</div></div>`;
}

export function hbars(entries: [string, number][], color: (label: string) => string, active: string[], group: string, limit = 8): string {
  if (!entries.length) return '<p class="muted">No data</p>';
  const shown = entries.slice(0, limit);
  const max = Math.max(1, ...shown.map((e) => e[1]));
  return shown
    .map(
      ([label, n]) => `<button type="button" class="bar-row${active.includes(label) ? ' active' : ''}" data-group="${group}" data-v="${esc(label)}" aria-pressed="${active.includes(label)}">
        <span class="lbl" title="${esc(label)}">${esc(label)}</span>
        <span class="track"><span class="fill" style="width:${(n / max) * 100}%;background:${color(label)}"></span></span>
        <b>${n}</b></button>`
    )
    .join('') + (entries.length > limit ? `<p class="muted small">+${entries.length - limit} more in filters</p>` : '');
}

/** Static vertical bars (age buckets). */
export function columns(items: { label: string; n: number }[], colors: string[]): string {
  const max = Math.max(1, ...items.map((i) => i.n));
  return `<div class="cols">${items
    .map(
      (it, i) => `<div class="col" title="${esc(it.label)}: ${it.n}">
        <b>${it.n}</b><span class="colbar"><span style="height:${(it.n / max) * 100}%;background:${colors[i] ?? 'var(--accent)'}"></span></span>
        <small>${esc(it.label)}</small></div>`
    )
    .join('')}</div>`;
}

export function trendChart(points: TrendPoint[]): string {
  if (points.length < 2) return '<p class="muted">Not enough history yet.</p>';
  const W = 640, H = 220, L = 30, R = 10, T = 14, B = 26;
  const max = Math.max(1, ...points.map((p) => Math.max(p.created, p.resolved, p.open)));
  const niceMax = Math.ceil(max / 5) * 5 || 5;
  const x = (i: number): number => L + ((W - L - R) * (i + 0.5)) / points.length;
  const y = (v: number): number => T + (H - T - B) * (1 - v / niceMax);
  const bw = Math.min(14, ((W - L - R) / points.length) * 0.32);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((g) => `<line x1="${L}" x2="${W - R}" y1="${y(niceMax * g)}" y2="${y(niceMax * g)}" class="grid"/><text x="${L - 5}" y="${y(niceMax * g) + 3}" text-anchor="end" class="axis">${Math.round(niceMax * g)}</text>`)
    .join('');
  const bars = points
    .map(
      (p, i) => `<g><title>Week of ${esc(p.label)}\nCreated ${p.created}\nResolved ${p.resolved}\nOpen at end ${p.open}</title>
      <rect x="${x(i) - bw - 1}" y="${y(p.created)}" width="${bw}" height="${H - B - y(p.created)}" fill="var(--red)" rx="2"/>
      <rect x="${x(i) + 1}" y="${y(p.resolved)}" width="${bw}" height="${H - B - y(p.resolved)}" fill="var(--green)" rx="2"/></g>`
    )
    .join('');
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.open).toFixed(1)}`).join(' ');
  const step = Math.ceil(points.length / 7);
  const labels = points.map((p, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis">${esc(p.label)}</text>` : '')).join('');
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bugs created, resolved and open per week">
    ${grid}${bars}<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.open)}" r="2.6" fill="var(--accent)"/>`).join('')}${labels}</svg>
    <div class="key-row"><span><i style="background:var(--red)"></i>Created</span><span><i style="background:var(--green)"></i>Resolved</span><span><i class="ln"></i>Open backlog</span></div>`;
}
