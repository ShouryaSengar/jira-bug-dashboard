// Generates the keys the Cloud edition needs.
//   node scripts/gen-vapid.mjs          print production values (set them with `wrangler secret put` / wrangler.jsonc)
//   node scripts/gen-vapid.mjs --dev    write cloud/.dev.vars for local development (git-ignored)
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const b64url = (b) => Buffer.from(b).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = b64url(await crypto.subtle.exportKey('raw', kp.publicKey));
const priv = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
const tokenKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

if (process.argv.includes('--dev')) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
  if (fs.existsSync(file) && !process.argv.includes('--force')) {
    console.log('cloud/.dev.vars already exists (use --force to replace it).');
    process.exit(0);
  }
  fs.writeFileSync(file, [
    '# Local development secrets. Never commit this file.',
    'ATLASSIAN_CLIENT_SECRET=dev-client-secret',
    `TOKEN_ENC_KEY=${tokenKey}`,
    `VAPID_PRIVATE_KEY=${priv}`,
    `VAPID_PUBLIC_KEY=${pub}`,
    '',
  ].join('\n'), { mode: 0o600 });
  console.log('Wrote cloud/.dev.vars');
} else {
  console.log('Set these for production (keep the private values secret):\n');
  console.log(`  wrangler.jsonc  env.production.vars.VAPID_PUBLIC_KEY = "${pub}"`);
  console.log(`  npx wrangler secret put VAPID_PRIVATE_KEY --env production   ->  ${priv}`);
  console.log(`  npx wrangler secret put TOKEN_ENC_KEY --env production       ->  ${tokenKey}`);
  console.log('  npx wrangler secret put ATLASSIAN_CLIENT_SECRET --env production   (from developer.atlassian.com)');
}
