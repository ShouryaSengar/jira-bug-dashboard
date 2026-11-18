// Web Push without dependencies: VAPID authentication (RFC 8292) and aes128gcm payload encryption
// (RFC 8291 / RFC 8188), using only Web Crypto. Works with Chrome/Edge (FCM), Firefox (Mozilla autopush)
// and Safari 16.4+ (Apple), all of which accept standard Web Push.

import { b64url, concat, enc, fromB64url } from './crypto.js';
import type { Env } from './env.js';

export interface PushTarget {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string; // base64url, 16 bytes
}

/** Only real push services (or explicitly allowed test hosts): the endpoint is user-supplied, so this stops SSRF. */
export function endpointAllowed(env: Env, endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && !(env.ALLOW_INSECURE_PUSH === '1' && u.protocol === 'http:')) return false;
  if (u.username || u.password || endpoint.length > 1024) return false;
  const host = u.hostname.toLowerCase();
  return env.PUSH_ENDPOINT_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).some((h) => host === h || host.endsWith(`.${h}`));
}

// ---------------------------------------------------------------- VAPID

let vapidKey: { pub: string; key: CryptoKey } | null = null;
async function vapidPrivateKey(env: Env): Promise<CryptoKey> {
  if (vapidKey?.pub === env.VAPID_PUBLIC_KEY) return vapidKey.key;
  const pub = fromB64url(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 public key (base64url)');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: false },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  vapidKey = { pub: env.VAPID_PUBLIC_KEY, key };
  return key;
}

const jwtCache = new Map<string, { jwt: string; exp: number }>();
async function vapidJwt(env: Env, audience: string): Promise<string> {
  const hit = jwtCache.get(audience);
  const nowSec = Math.floor(Date.now() / 1000);
  if (hit && hit.exp - nowSec > 3600) return hit.jwt;
  const exp = nowSec + 12 * 3600; // RFC 8292: at most 24 hours
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidPrivateKey(env), enc.encode(`${head}.${body}`));
  const jwt = `${head}.${body}.${b64url(sig)}`; // Web Crypto ECDSA signatures are already raw r||s (JOSE format)
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

// ---------------------------------------------------------------- payload encryption (RFC 8291)

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encryptPayload(target: PushTarget, plaintext: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid push subscription keys');

  const asKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Standard Web Crypto field name is `public`; workers-types spells it `$public`, hence the cast.
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last (and only) record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

export type PushResult = 'ok' | 'gone' | 'retry';

/** Sends one encrypted message. `gone` means the subscription is dead and should be deleted. */
export async function sendPush(env: Env, target: PushTarget, payload: unknown, urgency: 'high' | 'normal' = 'normal'): Promise<PushResult> {
  if (!endpointAllowed(env, target.endpoint)) return 'gone';
  const body = await encryptPayload(target, enc.encode(JSON.stringify(payload)));
  const aud = new URL(target.endpoint).origin;
  let res: Response;
  try {
    res = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${await vapidJwt(env, aud)}, k=${env.VAPID_PUBLIC_KEY}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: urgency,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return 'retry';
  }
  await res.body?.cancel();
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status === 400 || res.status === 403 || res.status === 413) return 'gone'; // malformed or key mismatch: resubscribe needed
  return res.ok ? 'ok' : 'retry';
}
