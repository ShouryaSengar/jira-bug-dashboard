// Assembles the static site (for GitHub Pages, Cloudflare Pages, Netlify...) into ./site.
// It contains only the web app. There is no server, so it runs in demo mode with sample data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
fs.cpSync(path.join(root, 'dist', 'client'), path.join(out, 'js'), { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');
fs.copyFileSync(path.join(out, 'index.html'), path.join(out, '404.html'));
console.log('Static site written to ./site');
