// HTTP helpers: JSON responses, errors, cookies, CSRF and per-isolate rate limiting.

import type { Env } from './env.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  new Headers(headers).forEach((v, k) => h.append(k, v));
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  const h = new Headers({ Location: location, ...SECURITY_HEADERS });
  new Headers(headers).forEach((v, k) => h.append(k, v));
  return new Response(null, { status: 302, headers: h });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return json({ error: e.message, code: e.code }, e.status);
  const anyE = e as { status?: number; message?: string };
  if (typeof anyE?.status === 'number' && anyE.status >= 400 && anyE.status < 600) {
    // Errors from the shared Jira core (HttpError). Their messages come from Jira and contain no secrets.
    return json({ error: anyE.message ?? 'Request failed' }, anyE.status === 401 ? 502 : anyE.status);
  }
  console.error('unexpected error', (e as Error)?.stack ?? String(e));
  return json({ error: 'Unexpected server error' }, 500);
}

// ---------------------------------------------------------------- cookies

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** `__Host-` cookies must be Secure, Path=/ and have no Domain, so subdomains cannot plant or read them. */
export function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookie = (name: string): string => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// ---------------------------------------------------------------- CSRF

/**
 * State-changing requests must: come from our own origin (Origin / Sec-Fetch-Site), and carry the custom
 * X-JBD header, which a cross-site page cannot add without a CORS preflight that this API never approves.
 * Together with SameSite=Lax session cookies this blocks cross-site request forgery.
 */
export function assertSameOrigin(req: Request, env: Env): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('Origin');
  if (origin && origin !== env.APP_ORIGIN) throw new ApiError(403, 'Forbidden origin');
  const site = req.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') throw new ApiError(403, 'Cross-site request blocked');
  if (req.headers.get('X-JBD') !== '1') throw new ApiError(403, 'Missing X-JBD header');
}

export async function readJson<T>(req: Request, max = 16_000): Promise<T> {
  const text = await req.text();
  if (text.length > max) throw new ApiError(413, 'Request too large');
  try {
    return JSON.parse(text || '{}') as T;
  } catch {
    throw new ApiError(400, 'Invalid JSON');
  }
}

// ---------------------------------------------------------------- rate limiting (per isolate, best effort)

const buckets = new Map<string, { n: number; reset: number }>();

/**
 * Cheap in-memory limiter. Isolates are per data centre and short-lived, so this is a speed bump against
 * runaway clients, not a global quota. Sign-in additionally uses a D1-backed limit (see auth.ts), and the
 * README recommends a Cloudflare WAF rate-limiting rule for production.
 */
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++b.n > limit) throw new ApiError(429, 'Too many requests. Slow down a little.', 'rate_limited');
}

export const clientIp = (req: Request): string => req.headers.get('CF-Connecting-IP') ?? 'local';

export const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
