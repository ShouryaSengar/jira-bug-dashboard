# Jira Bug Dashboard

Open-source, local-first dashboard for the bugs behind a Jira epic (or any issue). Enter a key such as `ABC-123`
or paste a Jira link. The app collects every bug that is a child of the issue or linked to it and shows charts,
filters, markers and a sortable table. It works on phones.

**Your Jira credentials never leave your computer.** They go only from your machine to your own Jira site.

## Run it on your computer

Live demo (sample data only): https://shouryasengar.github.io/jira-bug-dashboard/
Source code: https://github.com/ShouryaSengar/jira-bug-dashboard

**1. Install Node.js 18 or newer** from https://nodejs.org (check with `node -v`).

**2. Download the project.** Either:

```sh
git clone https://github.com/ShouryaSengar/jira-bug-dashboard.git
cd jira-bug-dashboard
```

or click **Code → Download ZIP** on https://github.com/ShouryaSengar/jira-bug-dashboard, unzip it, and open a terminal in the unzipped folder.

**3. Install and start:**

```sh
npm install
npm start
```

**4. Open http://localhost:4545** (if the port is taken: `PORT=4546 npm start`).

**5. Connect Jira.** On first run the app asks for your Jira URL, account email and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens). The server verifies them with Jira before saving.

**6. Track an epic.** Type a key such as `ABC-123` or paste a Jira link, then press Track.

To update later: `git pull && npm install && npm start`. For development, run `npm run dev`.

### Let your AI assistant do it

Paste this into Claude, ChatGPT, Kiro, Cursor or any AI assistant that can run terminal commands:

```text
Install and run the open-source "Jira Bug Dashboard" on my computer.

Repository: https://github.com/ShouryaSengar/jira-bug-dashboard

Steps:
1. Check that Node.js 18+ is installed (`node -v`). If not, tell me how to install it and wait.
2. Clone the repository into my current folder: `git clone https://github.com/ShouryaSengar/jira-bug-dashboard.git`
3. In the project folder run `npm install`, then `npm start`.
4. Tell me to open http://localhost:4545 in my browser. If the port is busy, use `PORT=4546 npm start`.

Rules:
- Do NOT ask me to paste my Jira API token, password or email into this chat. I will enter them myself
  in the app's setup screen in my browser. The app stores them only on my computer.
- Do not modify any files, and do not send any data to external services.
- If a command fails, show me the error and suggest a fix before continuing.
```

## What you get

- Several tracked issues as tabs, remembered between visits (browser `localStorage`) with a saved copy of the last result for instant, offline-tolerant loading.
- Charts: status donut, severity, priority, open-by-assignee, weekly created vs resolved with open backlog, open-bug age. Click any chart item to filter.
- Filters: search, multi-select status/severity/priority/assignee, quick chips (open only, over N days, stale, new/changed, starred). Filters and sort are saved per issue.
- Markers: star bugs; **NEW / UPDATED** since you last pressed *Mark all as seen*; **STALE** when not updated for N days; age coloured green/amber/red. Thresholds are in Settings.
- Themes: system, light, paper, dark, midnight, plus 5 accent colours. Column picker, CSV export, auto refresh, keyboard shortcuts (`/` search, `r` refresh).
- Mobile: bugs become cards, filters open as a bottom sheet.

## For You and JARVIS

**For You** (the second tab in the header) lists every bug assigned to you across all projects, whatever epic or tracked
issue it belongs to. It has KPI cards (total, open, in progress, blocked, closed, newly assigned, updated in 24h, stale, oldest),
charts for status, project, priority, severity and age, "oldest" and "stale" lists, search, sorting, filters, incremental
loading, and a detail drawer with the description, comments, change history, linked issues and a link to Jira.
Click any KPI, chart segment or chip to filter the list.

**JARVIS** is the assistant in the header (green dot = online). It watches your assigned bugs and tells you when something
meaningful happens: a new assignment, a status change, a comment, a priority or severity change, a reopen, a resolve or close,
a reassignment. It speaks with the browser's built-in voice and shows desktop notifications. The wording comes from
hand-written templates with several variations per event. There is no AI, no external service and no cost.

Open the JARVIS panel for status, a pause button, a test announcement, simulated events, the notification history
(read/unread), and settings: voice, speed, volume, event types, how often it speaks, quiet hours, polling interval.

### How changes are detected

The local server does the monitoring, so it keeps working while no browser tab is open and the token never reaches the page.

1. Every interval (default 60 s, configurable 30 s to 15 min) one paginated JQL search lists your assigned bugs.
2. The list is compared with the snapshot from the previous sync. A new key is a new assignment. A key that left the list is
   looked up to tell *reassigned*, *unassigned* or merely aged out.
3. For a bug whose `updated` value changed, the server reads its **changelog and comments** and turns each new entry into a typed
   event (status, reopen, resolve, close, priority, severity, comment). `updated` alone is only the trigger, never the event.
4. Every changelog entry and comment has a stable id. Seen ids are stored, so nothing is announced twice, even after a restart.
5. The first sync only records a baseline, so existing history is never announced. Your own actions are recorded but not spoken.
6. Failures back off exponentially (honouring `Retry-After` on HTTP 429); a failed issue keeps its old snapshot and is retried.

State lives in `~/.jira-bug-dashboard/jarvis.json` (mode 0600). Events reach the browser over a server-sent-events stream that
reconnects by itself and replays what it missed. Webhooks were considered and rejected: Jira Cloud cannot reach a
`localhost` server without a public tunnel, which would break the local-first, no-hosted-backend rule.

### What is and is not possible

| Situation | Detection | Voice | Desktop notification |
|---|---|---|---|
| App open in a tab (even in the background) | yes | yes | yes |
| Local server running, no tab open | yes | no (browsers cannot speak without a page) | optional system notification from the server (macOS, Linux). On return JARVIS gives one "while you were away" briefing |
| Server stopped | no. Changes made meanwhile are found on the next start | no | no |
| Static demo (GitHub Pages) | simulated events only | yes | yes |

Browser rules JARVIS works around: Chrome only allows speech after you have clicked or pressed a key on the page once
(announcements wait for that, and are dropped if they become stale); notification permission is requested only when you switch
desktop notifications on. Android Chrome only shows notifications from a service worker, which arrives with the PWA in phase 2.
If several tabs are open, only one of them speaks.

### Speaking rules

Up to two events are spoken one by one. Three or more become a single briefing. Repeats on one bug collapse
("3 new comments"). Low-importance edits are never spoken. Quiet hours silence voice and notifications but events stay unread in
the history. "Important only" and "Digest" modes reduce chatter further.

### Needs checking against a live Jira

Built from the documented Jira Cloud REST v3 contracts and tested against `scripts/mock-jira.mjs`, not a real site. Please confirm
on yours: (1) the `assignee CHANGED TO currentUser() AFTER -7d` query for "newly assigned" (falls back to creation date if your site
rejects it); (2) that your severity field shows up in changelog entries as a custom field; (3) how "blocked" shows up in your
workflow (status named *Blocked*, a `blocked` label, or an "is blocked by" link are recognised); (4) the permission to read
changelogs and comments on your projects. Jira Server / Data Center is not supported (the app already targets the Cloud v3 API).

### Testing without Jira

```sh
node scripts/mock-jira.mjs &                       # a fake Jira on :4700
JBD_CONFIG_DIR=$(mktemp -d) PORT=4800 JIRA_URL=http://127.0.0.1:4700 JIRA_USERNAME=me@x.com JIRA_API_TOKEN=x node dist/server/index.js &
node scripts/test-jarvis.mjs                       # 26 end-to-end checks of event detection
node scripts/test-core.mjs                         # 33 checks of the announcement rules
```

## Where your data lives

| Data | Location |
|---|---|
| Jira URL, email, API token | `~/.jira-bug-dashboard/config.json`, mode `0600`, outside the project. The browser never receives the token. |
| Tracked issues, filters, stars, cached results, theme, JARVIS preferences | This browser's `localStorage`. Settings has *Clear all local data*. |
| JARVIS snapshot, seen event ids, notification history | `~/.jira-bug-dashboard/jarvis.json`, mode `0600`. Delete the file to reset. |
| Environment variables (optional) | `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`; these take priority and are never written to disk. `JBD_CONFIG_DIR` moves the config folder. |

The server listens on `127.0.0.1` only, checks the `Host` header (DNS-rebinding), requires a custom header on writes
(CSRF) and refuses requests from other origins. The page has a strict Content-Security-Policy and escapes all Jira text.
There is no analytics or telemetry. Nothing secret is in the repo.

## Which bugs are included

```
(issue in linkedIssues("<KEY>") OR parent = "<KEY>") AND issuetype in (Bug)
```

Under *Settings → Jira connection → Advanced* you can change the issue types and the severity field names
(default `Defect Severity, Severity`, first match wins).

## Editions and free hosting

| Edition | For | Where your Jira credentials live | Cost |
|---|---|---|---|
| **Local** (this README) | you, on your computer | `~/.jira-bug-dashboard/config.json` on your machine | free |
| **Cloud** ([cloud/README.md](cloud/README.md)) | a team or anyone you share a URL with; nothing to install | Atlassian OAuth tokens, encrypted on your own Cloudflare Worker | free tier (about 60 monitored users at a 5-minute interval) |
| **Demo** | trying it out | none: sample data only | free (GitHub Pages) |

Jira Cloud blocks API calls from browsers (CORS), so real data always needs a server: your computer (Local) or a
Cloudflare Worker you deploy (Cloud). The Cloud edition signs people in with Atlassian instead of asking for API
tokens, monitors in the background with a Cron Trigger, and sends Web Push notifications when the browser is closed.
Setup, security model, free-tier limits and a deployment checklist are in [cloud/README.md](cloud/README.md).

Demo on GitHub Pages: push to a public repo, set *Settings → Pages → Source: GitHub Actions*; `.github/workflows/pages.yml`
does the rest. Any other static host: run `npm run build:site` and publish the `site/` folder. Open `?demo` on a local
run to preview demo mode.

## Roadmap

- Phase 2: migrate the UI to React + TypeScript and ship it as an installable PWA.
- Phase 3: the multi-user Cloud edition (see `cloud/`). Done on the `feature/cloudflare-web-edition` branch; needs your Atlassian and Cloudflare accounts to deploy.

## Project layout

```
src/server/   Node server: Jira client, credential storage, static files,
              mine.ts (For You queries), jarvis.ts (monitor and event stream)
src/client/   Browser app (TypeScript modules, no framework).
              foryou.ts, jarvis.ts (panel and stream), jarvis-core.ts (messages and rules), speech.ts
src/core/     Jira logic shared by the Local and Cloud editions (search, For You, detail, event classification)
src/shared/   Types shared by server, client and Worker
public/       index.html, css, icon
scripts/      build-site.mjs (static demo bundle), mock-jira.mjs and test-*.mjs
cloud/        Cloud edition: Cloudflare Worker, D1 migrations, service worker, mocks and tests (own package.json)
```

MIT licensed.
