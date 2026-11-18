# Jira Bug Dashboard: Cloud edition

A hosted, multi-user version of the dashboard on Cloudflare's free tier. People open the website, sign in with
Atlassian, and get the full app (Epics view, For You, JARVIS voice, background notifications) without installing anything.

The **Local edition** in the repository root is unchanged and does not depend on this folder.

| | Local edition | Cloud edition | Demo (GitHub Pages) |
|---|---|---|---|
| Install | Node.js + `npm start` | nothing | nothing |
| Jira auth | your email + API token, stored in `~/.jira-bug-dashboard` | Atlassian OAuth 2.0 (3LO), tokens encrypted on the server | none (sample data) |
| Who can use it | you, on your computer | anyone you share the URL with | anyone |
| Background monitoring | while the local server runs | always (Cron Trigger) | simulated |
| Notifications with the browser closed | macOS/Linux system notifications | Web Push | no |
| Voice | while a tab is open | while a tab is open | while a tab is open |

## Architecture

```
Browser ──HTTPS──▶ one Cloudflare Worker ─────────────▶ api.atlassian.com/ex/jira/{cloudId}   (user's OAuth token)
  │  same web app       ├─ Static Assets: the shared frontend (free, unlimited, not counted as requests)
  │  as the Local       ├─ /auth/*  sign-in with Atlassian (3LO)
  │  edition            ├─ /api/*   same API contract as the Local server + push/account routes
  │                     ├─ D1       users, sessions, encrypted grants, settings, checkpoints, history, devices
  │                     └─ Cron "* * * * *"  shared monitor: checks the users whose turn it is
  └─ service worker ◀── Web Push (FCM / Mozilla / Apple)  ◀── Worker (VAPID + aes128gcm)
```

**Reuse.** The Jira logic (search, For You, issue detail, the Epics query, event classification) lives in
`../src/core` and is used by both editions; the Local server was refactored onto it and verified byte-identical
against a real Jira. The frontend in `../public` and `../src/client` is the same code with a third mode, `cloud`.
`cloud/src` only contains what is genuinely different: OAuth, sessions, encryption, D1, the cron engine and Web Push.

**Services chosen**

- **Workers + Static Assets** (not Pages + a separate Worker): one deployment, one URL, assets are free.
- **D1** for everything persistent. Relational data with per-user scoping, foreign keys and indexes fits it well.
- **One Cron Trigger** for all users. Each user has a slot (0–59), so checks spread across minutes.
- **Not used:** KV (D1 already covers the small caches), Queues and Durable Objects (not needed at this scale,
  and the work is resumable without them), R2 (no files). Fewer moving parts, nothing extra to configure.

### How monitoring works

Every minute the cron run loads the users who are due in **one query**, then for each user:

1. Refreshes the OAuth access token if it expires within 2 minutes (see *Token rotation* below).
2. Runs **one incremental JQL search**:
   `issuetype in (Bug) AND ((assignee = currentUser() AND updated >= -Nm) OR assignee CHANGED FROM currentUser() AFTER -Nm)`.
   Relative windows avoid time-zone problems; *N* covers the time since the last successful check plus a margin.
3. For each result:
   - newly mine → read its changelog → **assigned** (by whom)
   - mine and changed → read changelog + comments → **status / reopened / resolved / closed / priority / severity / comment**
   - no longer mine → the search result already says who has it → **reassigned / unassigned** (no extra call)
4. Every changelog item and comment has a stable id, stored in `monitor_state.seen`, so nothing is announced twice.
5. Writes events and the checkpoint in one batch, then sends Web Push to the user's devices.

A full list comparison runs every 6 hours (bugs that aged out, deletions, missed windows). The very first check only
records a baseline, so existing history is never announced. Your own actions are recorded but never pushed.

**Free-tier safety.** Every outgoing call (Jira, Atlassian, D1, push) goes through a budget. A user who does not fit
into the current run is marked *deferred* and checked first next minute; the checkpoint only advances when a user's
changes are fully processed, so nothing is lost. Idle checks write nothing to D1 (a heartbeat every 20 minutes).
Failed pushes stay pending and are retried for 6 hours. Errors back off exponentially (honouring `Retry-After`).

## Free-tier assessment

Limits checked on 18 Nov 2026 ([Workers](https://developers.cloudflare.com/workers/platform/limits/),
[D1](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).
Verify them again before relying on these numbers.

| Limit (Workers Free) | Value | How the app stays inside it |
|---|---|---|
| Requests | 100,000 / day | cron = 1,440/day; static assets are free; API calls only on user actions |
| CPU per invocation (HTTP and cron) | 10 ms | measured ~0.4 ms per idle user check, ~2.5 ms for a 300-bug For You page; runs capped at 12 users (`MONITOR_MAX_USERS_PER_RUN`) |
| Subrequests per invocation (D1 included) | 50 | per-run budget of 45 (`MONITOR_SUBREQUEST_BUDGET`); For You capped at 300 bugs |
| Cron Triggers | 5 per account | uses 1 |
| D1 rows written | 100,000 / day | idle checks write nothing; ~100 writes per user per day typical |
| D1 rows read | 5 million / day | due-user query reads every active user once per minute |
| D1 storage | 500 MB per DB | no issue payloads stored; history pruned after 30 days |

**Capacity on the free plan**, at the default 5-minute interval: about **60 actively monitored users**
(12 checks per minute). With a 10-minute interval, about 120. Beyond that, checks queue up (deferred users go
first) and the effective interval grows; nothing breaks or is dropped. On Workers Paid, raise
`MONITOR_MAX_USERS_PER_RUN` (the CPU limit becomes 30 s). The Free plan cannot incur charges: over a limit, requests
fail with Cloudflare error 1027 / 429 and D1 returns errors until the daily reset at 00:00 UTC. The monitor treats
those as temporary failures and resumes.

CPU numbers come from `scripts/test-unit.mjs` on an Apple M1 Pro with Node's V8 (the same engine as workerd).
Cloudflare does not enforce CPU limits in `wrangler dev`, so watch *Metrics → CPU time* after deploying.

## Security model

- **Identity**: the Atlassian account. No passwords exist to leak.
- **OAuth**: authorization-code flow only (Atlassian does not support implicit grants). `state` is random and bound
  to the browser by an HttpOnly `__Host-` cookie; codes cannot be replayed; scopes are checked after the exchange.
- **Scopes** (all read-only): `read:jira-work`, `read:jira-user`, `read:me`, `offline_access`.
- **Tokens**: AES-256-GCM, key in the `TOKEN_ENC_KEY` Worker secret (never in D1). The additional data binds each
  ciphertext to its user id, so a row copied to another user fails to decrypt. `TOKEN_ENC_KEY_OLD` allows key rotation.
  Tokens never reach the browser, logs or API responses.
- **Token rotation**: Atlassian issues a new refresh token on every refresh and disables the old one (10-minute
  reuse leeway). Refreshes take a 30-second lease with a conditional UPDATE and commit only if the row's `version` is
  unchanged, so concurrent requests and cron runs never corrupt the grant. Tested with 4 parallel requests → 1 refresh.
- **Revocation**: an `invalid_grant` marks the grant revoked; the UI asks the user to reconnect; the monitor skips them.
- **Sessions**: 32-byte random token in `__Host-jbd_sid` (HttpOnly, Secure, SameSite=Lax). D1 stores only its
  SHA-256. 30-day absolute and 7-day idle expiry; expired rows are deleted hourly.
- **CSRF**: every state-changing request needs the `X-JBD` header (not sendable cross-site without a CORS preflight,
  which is never granted), a matching `Origin`, and a non-cross-site `Sec-Fetch-Site`.
- **Isolation**: every query is scoped by the session's user id; no endpoint accepts a user id. Client-supplied ids
  (events, devices) are always combined with that scope. Jira itself enforces issue permissions per user token.
- **Input**: issue keys are validated by regex; JQL only interpolates validated or quoted values; push endpoints are
  restricted to known push services (SSRF); settings and notification rules are validated and length-limited.
- **Rate limits**: sign-in is limited per IP in D1; other routes have a per-user in-memory limit (per isolate, so a
  speed bump rather than a global quota). If you put the Worker on your own domain, also add a Cloudflare WAF
  rate-limiting rule for `/auth/*` and `/api/*`; check your plan's rule allowance first.
- **Headers**: strict CSP, `frame-ancestors 'none'`, HSTS, `nosniff`, no referrer (`public/_headers`).
- **Atlassian Personal Data Reporting API** (required for apps that store personal data, `src/privacy.ts`): every stored
  accountId (signed-in users, and people named in notification history) is reported to `POST /app/report-accounts/`
  with the time its data was fetched, in batches of 90, once per cycle (default 7 days, or the `Cycle-Period` header).
  It runs from the cron at minute :37 (not on the hour), resumes where it stopped, and honours `Retry-After`.
  `closed` → the person is erased everywhere ("Former user" in history); `updated` → the stale copy is cleared.
  Optional var `ATLASSIAN_APP_OWNER_ACCOUNT_ID` makes it use the app owner's token, as Atlassian recommends.
- **Retention**: history 30 days; accounts whose Jira access ended (disconnected or revoked) are erased 30 days after the last sign-in.
- **Data you can delete**: *Settings → Disconnect Jira* removes tokens, sites, devices and sessions; *Delete account*
  removes every row. To remove the grant on Atlassian's side too, use id.atlassian.com → Connected apps.

## Database

`migrations/0001_init.sql`: `users`, `sessions`, `oauth_grants`, `jira_sites`, `user_settings`, `monitor_state`,
`events` (notification history with read state and push delivery state), `push_subscriptions`, `rate_limits`.
`migrations/0002_personal_data_reporting.sql`: `users.profile_at`, `events.actor_id`, `pdr_reports`, `app_meta`.
All user tables reference `users(id) ON DELETE CASCADE`. Schema changes go in new numbered files
(`0002_...sql`) and are applied with `wrangler d1 migrations apply` (D1 records which ran).

## Run it locally (no Cloudflare or Atlassian account needed)

```sh
cd cloud
npm install
node scripts/gen-vapid.mjs --dev        # writes .dev.vars (git-ignored) with local keys
npm run build                           # shared frontend + assets
npm run db:migrate:local                # local D1 (SQLite under .wrangler/)
node scripts/mock-atlassian.mjs &       # fake Atlassian + Jira + push service on :4710
sh scripts/dev-server.sh                # Worker on http://localhost:8787 (cron testing enabled)
```

Open http://localhost:8787 and sign in (the mock signs you in as "Me Tester").
Trigger the cron: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

Tests (with the mock and dev server running, on an empty local DB):

```sh
node scripts/test-unit.mjs     # 16: encryption, Web Push crypto, rules, CPU measurements
node scripts/test-e2e.mjs      # 82: OAuth flow and attacks, CSRF, isolation, monitoring, rotation, push, deletion
node scripts/test-ui.mjs       # 34: browser UI incl. service worker push → notification → voice (needs Playwright)
```

## Deployment checklist

Steps marked 👤 need your own account and cannot be done by the code.

1. 👤 **Cloudflare account** (free). `cd cloud && npx wrangler login`.
2. 👤 **Database**: `npx wrangler d1 create jbd-cloud` → copy the `database_id` into `env.production.d1_databases` in `wrangler.jsonc`.
3. **Keys**: `npm run vapid` prints a VAPID key pair and a token-encryption key. Put `VAPID_PUBLIC_KEY` into
   `env.production.vars`. `VAPID_SUBJECT` (e.g. `mailto:you@example.com`) is set as a secret in step 6 so your
   address is not published in the repository.
4. 👤 **First deploy** to learn your URL: `npm run deploy`. Wrangler prints
   `https://jira-bug-dashboard-cloud.<your-subdomain>.workers.dev`. Set it as `APP_ORIGIN`. (The API answers
   "not configured" until the remaining steps are done; that is expected.)
5. 👤 **Atlassian app** at https://developer.atlassian.com/console/myapps:
   *Create → OAuth 2.0 integration*.
   - *Permissions*: add **Jira API** with classic scopes `read:jira-work` and `read:jira-user`; add **User identity API** (`read:me`).
   - *Authorization → OAuth 2.0 (3LO)*: callback URL `https://<your worker URL>/auth/callback`.
   - *Settings*: copy the **Client ID** into `ATLASSIAN_CLIENT_ID` (wrangler.jsonc) and keep the **Secret** for step 6.
   - *Distribution*: an app is private to its developer until you set it to **Sharing** (Atlassian asks for a
     vendor name and privacy policy URL). Until then only you can sign in.
6. 👤 **Secrets** (prompted, never stored in files):
   ```sh
   npx wrangler secret put ATLASSIAN_CLIENT_SECRET --env production
   npx wrangler secret put TOKEN_ENC_KEY --env production       # from npm run vapid
   npx wrangler secret put VAPID_PRIVATE_KEY --env production   # from npm run vapid
   npx wrangler secret put VAPID_SUBJECT --env production       # mailto:you@example.com
   ```
7. **Deploy**: `npm run deploy` (applies D1 migrations remotely, then deploys; the cron trigger comes from `wrangler.jsonc`).
8. 👤 **Optional hardening**: a custom domain, plus a WAF rate-limiting rule on `/auth/*` and `/api/*` if your plan allows it.
9. **Smoke test**: sign in, open For You, JARVIS → Enable background notifications → Send a test push.

Never commit `.dev.vars`; it is in `.gitignore`. Rotating `TOKEN_ENC_KEY`: move the current value to
`TOKEN_ENC_KEY_OLD`, set a new `TOKEN_ENC_KEY`; rows are re-encrypted on their next refresh.

## Notifications and voice: what works where

- **Detection** runs in the cloud, whether or not any browser is open.
- **Background notifications** use Web Push: Chrome, Edge, Firefox on desktop and Android; Safari 16.4+ on macOS;
  on iPhone/iPad only after *Share → Add to Home Screen* (an Apple rule). The service worker always shows a
  notification for each push (browsers revoke push permission otherwise).
- **Voice** uses the browser's speech synthesis and therefore needs an open dashboard tab. Pushes are relayed from
  the service worker to open tabs, which speak them. Browsers cannot speak from a closed tab or a service worker.
- Event types, quiet hours (in your time zone) and "important only" are applied on the server, so they also govern
  pushes sent while the browser is closed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cloud edition is not configured: missing …` | a `REPLACE_` value or secret is not set (steps 3–6) |
| Sign-in returns `?auth=state` | cookies blocked, or the sign-in took more than 10 minutes; try again |
| Only you can sign in | set the Atlassian app's *Distribution* to Sharing (step 5) |
| `?auth=nosite` | the account has no Jira Cloud site, or the site was not selected on the consent screen |
| "Jira access was revoked" banner | the user revoked the app or was inactive 90 days; *Reconnect with Atlassian* |
| No push on iPhone | add the site to the Home Screen first, then enable notifications from there |
| Error 1027 / 429 | daily free limits reached; resets 00:00 UTC |
| Checks slower than the interval | more users than `MONITOR_MAX_USERS_PER_RUN × interval`; increase the interval or upgrade |

## Known limitations

- One active Jira site per user (switch in Settings); multiple sites from one grant are listed.
- For You shows at most 300 bugs per site in the cloud (CPU limit); the monitor tracks up to 500.
- Jira Server / Data Center are not supported (Cloud REST v3 and 3LO only).
- Atlassian has no public endpoint to revoke a 3LO grant from the app side; *Delete account* removes everything
  stored here, and the user revokes the grant itself at id.atlassian.com.
- Cloudflare's free-tier limits change over time; re-check them (links above).

## Verification status

| Area | Status |
|---|---|
| OAuth flow, state/replay/CSRF protection, sessions, encryption at rest, isolation between users | ✅ verified locally (workerd + local D1) against `mock-atlassian.mjs` |
| Monitoring: baseline, all event types, dedup, reassignment, deferral under the cap | ✅ verified locally |
| Personal Data Reporting API: reporting, cycle, closed/updated handling | ✅ verified locally against a mock of the documented contract; ⏳ first real report after deploying |
| Refresh-token rotation, concurrency lease, revocation handling | ✅ verified locally against a mock that implements Atlassian's documented rotation and reuse rules |
| Web Push: VAPID JWT, RFC 8291 encryption (decrypted independently), service worker notification, voice relay | ✅ verified locally; the push *service* was a mock |
| CPU inside 10 ms | ✅ measured in Node; ⏳ confirm in Cloudflare metrics after deploying |
| Real Atlassian OAuth (resource-level grant), token exchange, encrypted storage, real Jira data through `api.atlassian.com`, production cron baseline | ✅ verified on the live deployment (18 Nov 2026) |
| Real FCM/Apple/Mozilla push, refresh-token rotation after the first hour, event detection on real Jira changes | ⏳ to confirm on the live deployment |
| Atlassian app registration, Cloudflare D1 / secrets / deploy | 👤 manual (checklist above) |
| Voice while the browser is closed | ❌ not possible in browsers (notifications are used instead) |
