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

## Where your data lives

| Data | Location |
|---|---|
| Jira URL, email, API token | `~/.jira-bug-dashboard/config.json`, mode `0600`, outside the project. The browser never receives the token. |
| Tracked issues, filters, stars, cached results, theme | This browser's `localStorage`. Settings has *Clear all local data*. |
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

## Free hosting

Real Jira data cannot be shown from a purely static site. Jira Cloud blocks calls from browsers (CORS), and a hosted proxy
would mean your token passes through someone else's server. So there are two parts:

| Part | Where | Cost |
|---|---|---|
| **Live demo and landing page** (static, sample data, auto-detected when no server is present) | GitHub Pages (workflow included), Cloudflare Pages, Netlify or Vercel | Free |
| **Real use** | On each user's own computer (`npm start`) | Free |

GitHub Pages: push to a public repo, set *Settings → Pages → Source: GitHub Actions*; `.github/workflows/pages.yml` does the rest.
Any other host: run `npm run build:site` and publish the `site/` folder. Open `?demo` on a local run to preview demo mode.

## Roadmap

- Phase 2: migrate the UI to React + TypeScript and ship it as an installable PWA.
- Phase 3 (optional): a self-hostable multi-user mode with its own login, for teams who want one shared instance.

## Project layout

```
src/server/   Node server: Jira client, credential storage, static files
src/client/   Browser app (TypeScript modules, no framework)
src/shared/   Types shared by both
public/       index.html, css, icon
scripts/      build-site.mjs (static demo bundle)
```

MIT licensed.
