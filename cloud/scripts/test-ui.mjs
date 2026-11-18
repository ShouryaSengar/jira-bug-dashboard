// Browser test of the Cloud edition UI (Playwright, not a project dependency):
//   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install chromium
//   PLAYWRIGHT=/tmp/pw/node_modules/playwright/index.mjs node scripts/test-ui.mjs
// Needs the mock (scripts/mock-atlassian.mjs) and the Worker (scripts/dev-server.sh) running, on an empty DB.
//
// Push path under test: Worker --encrypted Web Push--> mock push service --(decrypt, as a browser's push
// service + browser would)--> CDP ServiceWorker.deliverPushMessage --> real service worker --> page speaks.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

const { chromium } = await import(process.env.PLAYWRIGHT || '/tmp/pw/node_modules/playwright/index.mjs');
const W = 'http://localhost:8787', M = 'http://127.0.0.1:4710';
let fails = 0, passes = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); c ? passes++ : fails++; };
const mock = async (a, b = {}) => { const r = await fetch(`${M}/__mock/${a}`, { method: 'POST', body: JSON.stringify(b) }); if (!r.ok) throw new Error(`mock ${a}: ${r.status}`); return r.json(); };
const mockState = () => fetch(`${M}/__mock/state`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake browser push subscription. The page's PushManager is stubbed to return it.
const ua = createECDH('prime256v1'); ua.generateKeys();
const auth = randomBytes(16);
const SUB = { endpoint: `${M}/push/ui1`, expirationTime: null, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
function decrypt(b64) {
  const body = Buffer.from(b64, 'base64'); const salt = body.subarray(0, 16), n = body[20], as = body.subarray(21, 21 + n), ct = body.subarray(21 + n);
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(as), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), as]), 32));
  const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return pt.subarray(0, pt.length - 1).toString();
}

const browser = await chromium.launch({ channel: 'chromium' }); // full Chromium: the headless shell always denies notifications
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.grantPermissions(['notifications'], { origin: W });
await ctx.addInitScript((sub) => {
  window.__spoken = [];
  Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ name: 'Daniel', lang: 'en-GB', default: true }], speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 20); }, cancel() {}, addEventListener() {} }, configurable: true });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  if (window.PushManager) {
    let current = null;
    const fake = () => ({ ...sub, toJSON: () => sub, unsubscribe: async () => { current = null; return true; } });
    PushManager.prototype.subscribe = async function (opts) { window.__subscribeOpts = { userVisibleOnly: opts.userVisibleOnly, keyLen: opts.applicationServerKey.byteLength }; current = fake(); return current; };
    PushManager.prototype.getSubscription = async function () { return current; };
  }
}, SUB);
const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/401|favicon/.test(m.text()) && errors.push(m.text()));

// ---- signed out landing
await page.goto(W + '/');
await page.waitForSelector('#empty:not([hidden])');
ok('landing (signed out) offers "Sign in with Atlassian"', (await page.textContent('#heroConnect')) === 'Sign in with Atlassian');
ok('landing copy describes the cloud edition (no "stays on your machine")', /encrypted on the server/.test(await page.textContent('#empty p')));
ok('"Get the app" download button hidden in the cloud', await page.isHidden('#getBtn'));
ok('JARVIS indicator offline before sign-in', (await page.getAttribute('#jarvisBtn', 'data-tone')) === 'off');
await page.click('#settingsBtn');
ok('settings shows the cloud sign-in, not the API-token form', await page.isVisible('#cloudOut') && await page.isHidden('#connForm'));
await page.keyboard.press('Escape');

// ---- sign in (real redirects through the mock Atlassian)
await page.click('#heroConnect');
await page.waitForURL(/view=foryou/);
await page.waitForSelector('#fyBody:not([hidden])', { timeout: 15000 });
ok('sign-in lands on For You with my bugs', (await page.$$eval('#fyBodyRows tr', (r) => r.map((x) => x.dataset.fyRow))).sort().join() === 'ABC-1,ABC-2');
ok('success toast and clean URL', /Connected to Mock Site/.test(await page.textContent('#toasts')) && !page.url().includes('connected='));
ok('greeting uses the Atlassian name', /Me\./.test(await page.textContent('#fyHello')));
const cookies = await ctx.cookies(W);
const sid = cookies.find((c) => c.name === '__Host-jbd_sid');
ok('session cookie: HttpOnly, Secure, SameSite=Lax', sid && sid.httpOnly && sid.secure && sid.sameSite === 'Lax');
ok('no token in page JS-visible storage', !(await page.evaluate(() => JSON.stringify(localStorage) + document.cookie)).match(/at_|rt_|jbd_sid/));

// ---- issue detail
await page.click('[data-fy-open="ABC-1"] >> nth=0');
await page.waitForSelector('.detail-title');
await sleep(400);
ok('issue detail loads through the Worker', /broken/.test(await page.textContent('#detailBody')) && (await page.getAttribute('#detailBody a.btn', 'href')).startsWith('https://mock.atlassian.net/browse/ABC-1'));
await page.keyboard.press('Escape');

// ---- settings (signed in)
await page.click('#settingsBtn');
ok('settings shows account, site and disconnect / delete', /Me Tester/.test(await page.textContent('#cUser')) && (await page.$$eval('#cSite option', (o) => o.length)) === 1 && await page.isVisible('#cloudIn'));
await page.keyboard.press('Escape');

// ---- JARVIS + push
await page.click('body');
await page.click('#jarvisBtn');
await sleep(400);
ok('JARVIS online, says it checks in the cloud', /checked every \d+ min in the cloud|Watching/.test(await page.textContent('#jpBody')) || (await page.getAttribute('#jarvisBtn', 'data-tone')) !== 'err');
ok('overview offers to enable background notifications', /Background notifications are off/.test(await page.textContent('#jpBody')));
await page.click('[data-j="enable-push"]');
await sleep(900);
const so = await page.evaluate(() => window.__subscribeOpts);
ok('subscribed with userVisibleOnly and the 65-byte VAPID key', so?.userVisibleOnly === true && so.keyLen === 65, JSON.stringify(so));
const devs = await page.evaluate(() => fetch('/api/push/devices').then((r) => r.json()));
ok('server stored this device', devs.devices.length === 1 && /Chrome/.test(devs.devices[0].label ?? ''), JSON.stringify(devs));
await page.click('#jpTab-settings');
await sleep(300);
ok('settings: cloud intervals only (no sub-minute polling)', !(await page.$$eval('#js-interval option', (o) => o.map((x) => x.value))).includes('30'));
ok('settings: push switch on', await page.isChecked('#js-push'));
// quiet hours change syncs to the server
await page.check('#js-quiet');
await sleep(1200);
const np = await page.evaluate(() => fetch('/api/jarvis/notify', { method: 'POST', headers: { 'X-JBD': '1', 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()));
ok('quiet hours and time zone synced to the server for background pushes', np.notify.quiet.on === true && !!np.notify.tz, JSON.stringify(np));
await page.uncheck('#js-quiet');
await sleep(1200);
await page.keyboard.press('Escape');

// baseline + interval 1 min (dev), then a real change in Jira
await page.evaluate(() => fetch('/api/jarvis/prefs', { method: 'POST', headers: { 'X-JBD': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalSec: 60 }) }));
await page.evaluate(() => fetch('/api/__dev/tick', { method: 'POST', headers: { 'X-JBD': '1' } }).then((r) => r.json()));
await mock('reset-counters');
await mock('add', { key: 'ABC-4', summary: 'Checkout total is wrong', assignee: null });
await mock('assign', { key: 'ABC-4', to: 'me' });
const tick = await page.evaluate(() => fetch('/api/__dev/tick', { method: 'POST', headers: { 'X-JBD': '1' } }).then((r) => r.json()));
const pushes = (await mockState()).pushes;
ok('cron tick detected the assignment and sent one push', tick.checked[0]?.events === 1 && pushes.length === 1, JSON.stringify(tick));
const plain = decrypt(pushes[0].body);
ok('push payload names the bug', /ABC-4 assigned to you/.test(plain));

// deliver it to the real service worker, exactly as the push service would after decryption
const cdp = await ctx.newCDPSession(page);
await cdp.send('ServiceWorker.enable');
let regId = null;
cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { for (const r of e.registrations) if (r.scopeURL.startsWith(W)) regId = r.registrationId; });
await cdp.send('ServiceWorker.enable');
for (let i = 0; i < 20 && !regId; i++) await sleep(100);
ok('service worker registered for the origin', !!regId);
const spokenBefore = (await page.evaluate(() => window.__spoken)).length;
await cdp.send('ServiceWorker.deliverPushMessage', { origin: W, registrationId: regId, data: plain });
await sleep(2500);
const notes = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title));
ok('service worker showed the system notification', notes.some((t) => /ABC-4 assigned to you/.test(t)), JSON.stringify(notes));
const spoken = (await page.evaluate(() => window.__spoken)).slice(spokenBefore);
ok('open dashboard spoke the push (JARVIS voice)', spoken.some((t) => /A B C 4/.test(t) && /Checkout total is wrong/.test(t)), JSON.stringify(spoken));
await sleep(3200);
ok('For You list refreshed with the new bug', (await page.$$eval('#fyBodyRows tr', (r) => r.map((x) => x.dataset.fyRow))).includes('ABC-4'));
ok('unread badge', (await page.textContent('#jarvisBadge')) === '1');

// "Check now" runs a real check through the API
await mock('comment', { key: 'ABC-4', text: 'Repro steps added' });
const before2 = (await page.evaluate(() => window.__spoken)).length;
await page.click('#jarvisBtn');
await page.click('[data-j="sync"]');
await sleep(2500);
ok('"Check now" found the comment and spoke it', (await page.evaluate(() => window.__spoken)).slice(before2).some((t) => /A B C 4/.test(t)), JSON.stringify((await page.evaluate(() => window.__spoken)).slice(before2)));
await page.click('#jpTab-history');
ok('history lists both events', (await page.$$('#jpBody .ev-row')).length >= 2);
await page.keyboard.press('Escape');

// reload: no replay of things already announced
await page.reload();
await page.waitForSelector('#fyBody:not([hidden])');
await sleep(800);
ok('reload does not re-announce old events', (await page.evaluate(() => window.__spoken)).length === 0, JSON.stringify(await page.evaluate(() => window.__spoken)));

// ---- mobile layout of the signed-in For You
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.addCookies(cookies.filter((c) => c.name === '__Host-jbd_sid'));
const mp = await m.newPage();
await mp.goto(W + '/?view=foryou');
await mp.waitForSelector('#fyBody:not([hidden])');
ok('mobile: no horizontal overflow', !(await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
await mp.screenshot({ path: '/tmp/pw/cloud-mobile.png' });
await page.screenshot({ path: '/tmp/pw/cloud-desktop.png' });

// ---- sign out
await page.click('#settingsBtn');
await page.click('#cSignOut');
await page.waitForSelector('#empty:not([hidden]), #fyConnect:not([hidden])', { timeout: 10000 });
ok('sign out returns to the signed-out state', /Signed out/.test(await page.textContent('#toasts')) && (await page.evaluate(() => fetch('/api/mine').then((r) => r.status))) === 401);
ok('sign out clears cached Jira data from this browser', !(await page.evaluate(() => Object.keys(localStorage).some((k) => /fy\.cache|cache\./.test(k)))));

// ---- demo still works on the cloud origin
await page.goto(W + '/?demo&view=foryou');
await page.waitForSelector('#fyBody:not([hidden])');
ok('?demo on the cloud origin shows sample data', /Demo/.test(await page.textContent('#fyHello')));

console.log('errors:', errors);
ok('no page errors', errors.length === 0);
await browser.close();
console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nAll ${passes} passed`);
process.exit(fails ? 1 : 0);
