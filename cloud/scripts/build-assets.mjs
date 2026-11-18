// Assembles the Cloud edition's static assets into cloud/dist-assets: the same web app as the Local
// edition (../public + compiled ../dist/client), plus the service worker and security headers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(cloud, '..');
const out = path.join(cloud, 'dist-assets');
if (!fs.existsSync(path.join(root, 'dist', 'client', 'main.js'))) throw new Error('Run `npm --prefix .. run build` first (compiles the shared frontend).');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
fs.cpSync(path.join(root, 'dist', 'client'), path.join(out, 'js'), { recursive: true, filter: (f) => !f.endsWith('.map') });
fs.cpSync(path.join(cloud, 'public'), out, { recursive: true });
console.log('Cloud assets written to cloud/dist-assets');
