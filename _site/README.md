# KB · Management Site

Visual management UI for the knowledge base at `D:\SanQian.Xu\project-knowledge-base\`.

## Quick start

1. Double-click `start.bat`
2. Browser opens to <http://localhost:5757/>
3. To stop: double-click `stop.bat` (or close the minimized "KB-Site" console)

If port 5757 is busy, set `KB_SITE_PORT=8888` (or any free port) before launching.

## What it does

The site has four tabs:

| Tab | Purpose |
|-----|---------|
| **Projects** | List of all projects in `project-knowledge-base/projects.json` with status badges (KB ready / missing), tags, links to README, and a tree viewer. "Remove" deletes from `projects.json` only (KB files untouched). |
| **+ Add** | Form to register a new project: slug, display name, local/git path, language, tags, optional reference flag. With "Create KB directory structure now" checked, it also seeds `architecture/`, `modules/`, `commits/`, `operations/`, `references/` plus README/framework from templates. |
| **Schedule & Run** | Live read of `KB-GitCommits-Daily` Windows task (state, next run, last result). Change frequency (off / hourly / every 6h / every 12h / daily / weekly). Run `gen-commit-doc.ps1` manually for a single project or ALL. |
| **Log** | Tail of the last script run (output + status). |

The page auto-refreshes every 30 seconds. The "Refresh" button forces an immediate reload.

## Architecture

```
_start.bat (double-click) → node server.js (port 5757)
                                │
                                ├─ GET  /            → index.html
                                ├─ GET  /api/state   → projects.json + schedule + lastRun
                                ├─ GET  /api/projects
                                ├─ PUT  /api/projects   (add or replace)
                                ├─ POST /api/projects/:slug/init
                                ├─ GET  /api/dirs/:slug (tree)
                                ├─ GET  /api/schedule   (Get-ScheduledTaskInfo)
                                ├─ PUT  /api/schedule   (schtasks /create or /delete)
                                ├─ POST /api/script/run (spawn gen-commit-doc.ps1)
                                └─ GET  /api/script/status
```

The server is **zero npm install** — uses only Node built-ins (`http`, `fs`, `path`, `child_process`). The frontend is **Vue 3 + Tailwind from CDN** — no build step.

## Requirements

- Node.js 18+ (already present on this machine via the pnpm monorepo)
- Windows (uses `schtasks` and `Get-ScheduledTask` PowerShell cmdlets)
- Knowledge base initialized at `D:\SanQian.Xu\project-knowledge-base\` with `projects.json`

## Security note

The server binds to `127.0.0.1` only — it is **not accessible from the network**. The endpoints can write to `projects.json` and invoke schtasks/PowerShell; do not expose this port.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Vue 3 SPA (loaded from CDN) |
| `server.js` | Node HTTP server, ~270 lines |
| `start.bat` | Launcher (open browser, start minimized console) |
| `stop.bat` | Kill the listening process |
| `README.md` | This file |
