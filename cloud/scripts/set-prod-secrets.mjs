// One-time production key setup. Generates a VAPID key pair and a token-encryption key, writes only the
// PUBLIC key into wrangler.jsonc, and pipes the private values straight into `wrangler secret put` (stdin),
// so they never touch a file, the terminal or a log.
//   node scripts/set-prod-secrets.mjs mailto:you@example.com
// Re-running replaces the keys: existing push subscriptions stop working and everyone must sign in again.
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const subject = process.argv[2];
if (!/^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/\S+)$/.test(subject ?? '')) {
  console.error('Usage: node scripts/set-prod-secrets.mjs mailto:you@example.com');
  process.exit(1);
}
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const priv = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
const tokenKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

const put = (name, value) => {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--env', 'production'], { cwd: cloud, input: value, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, encoding: 'utf8' });
  const ok = r.status === 0 && /Success/i.test(r.stdout + r.stderr);
  console.log(`${ok ? '✓' : '✗'} secret ${name}${ok ? '' : `\n${(r.stdout + r.stderr).split('\n').filter((l) => /error|✘/i.test(l)).join('\n')}`}`);
  if (!ok) process.exit(1);
};
put('TOKEN_ENC_KEY', tokenKey);
put('VAPID_PRIVATE_KEY', priv);
put('VAPID_SUBJECT', subject);

const file = path.join(cloud, 'wrangler.jsonc');
const before = fs.readFileSync(file, 'utf8');
const prodStart = before.indexOf('"production"');
const after = before.slice(0, prodStart) + before.slice(prodStart).replace(/"VAPID_PUBLIC_KEY": "[^"]*"/, `"VAPID_PUBLIC_KEY": "${pub}"`);
fs.writeFileSync(file, after);
console.log('✓ VAPID_PUBLIC_KEY written to wrangler.jsonc (production). Deploy again to apply it.');
