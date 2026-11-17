export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for use in HTML content or attribute values. All dynamic text goes through this. */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/** Only allow http(s) links, so a malformed URL can never become a javascript: link. */
export const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : '#');

export const DAY = 864e5;
export const HOUR = 36e5;

export function fmtAge(ms: number): string {
  const h = Math.max(0, Math.floor(ms / HOUR));
  const d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : `${h}h`;
}

export const fmtDate = (s: string | null | undefined): string =>
  s ? new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

const KEY_RE = /[A-Z][A-Z0-9_]+-\d+/i;
/** Accepts "abc-12", or a pasted Jira URL such as https://x.atlassian.net/browse/ABC-12. */
export function parseKey(input: string): string | null {
  const m = KEY_RE.exec(input.trim());
  return m ? m[0].toUpperCase() : null;
}

export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

export function download(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Stops CSV cells from being interpreted as formulas when opened in a spreadsheet. */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
