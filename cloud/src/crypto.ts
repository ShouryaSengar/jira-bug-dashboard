// Small Web Crypto helpers. Everything here runs on the Workers runtime's native crypto.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i] as number);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
export const fromB64 = (s: string): Uint8Array => fromB64url(s.replace(/=+$/, ''));

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Constant-time comparison, so secrets cannot be guessed byte by byte from response timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- token encryption at rest

const keyCache = new Map<string, CryptoKey>();
async function aesKey(b64: string): Promise<CryptoKey> {
  let k = keyCache.get(b64);
  if (!k) {
    const raw = fromB64(b64);
    if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64 encoded');
    k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(b64, k);
  }
  return k;
}

/** Key id = first 8 chars of the key's hash, so rotation can tell which key encrypted a row. */
export const keyId = async (b64: string): Promise<string> => (await sha256(`jbd-key:${b64}`)).slice(0, 8);

/**
 * AES-256-GCM with a random 96-bit IV. The additional authenticated data binds the ciphertext to its owner,
 * so a row copied into another user's record fails to decrypt instead of granting access.
 */
export async function encryptJson(keyB64: string, aad: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(keyB64), enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptJson<T>(keyB64: string, aad: string, blob: string): Promise<T> {
  const [iv, ct] = blob.split('.');
  if (!iv || !ct) throw new Error('Corrupt ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(aad) }, await aesKey(keyB64), fromB64url(ct));
  return JSON.parse(dec.decode(pt)) as T;
}
