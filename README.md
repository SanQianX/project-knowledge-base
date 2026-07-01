# project-knowledge

Local knowledge-base manager for Git projects, AI-assisted analysis, reviewable
drafts, and a browser-based control center.

[![npm version](https://img.shields.io/npm/v/project-knowledge.svg)](https://www.npmjs.com/package/project-knowledge)
[![Node](https://img.shields.io/node/v/project-knowledge.svg)](https://www.npmjs.com/package/project-knowledge)

`project-knowledge` runs a local-only web dashboard at `127.0.0.1`. It registers
your projects, scans their Git history, builds context packs, asks an AI profile
to produce knowledge-base drafts, and lets you review those drafts before they
are applied.

The repository and npm package contain the application code only. Your local
project registry, generated knowledge bases, AI drafts, logs, and API keys are
runtime data and live in `~/.project-knowledge/` (or `$KB_DATA_DIR`) — they
are intentionally ignored by Git and survive every `npm install -g
project-knowledge` upgrade.

## Current dashboard

The control center is organized around the active project:

- The left sidebar starts with the project list.
- The import action lives beside the project list heading.
- Clicking a project opens Project Supervision directly.
- Language, theme, logs, and settings are in the top-right toolbar.
- Manual refresh, AI profiles, scheduled tasks, log settings, and Git/Hook
  maintenance live in the settings drawer.
- On mobile, the sidebar collapses into a horizontal project strip and summary
  cards stack into one column.

## Features

- Project registry with Git path validation and import preflight checks.
- Git scanner for pending commits, branches, remotes, and HEAD metadata.
- AI profile management for Anthropic-compatible providers.
- **Default AI profile auto-assignment.** Projects without an explicit
  profile automatically use the first usable AI profile; the per-project
  picker offers a `Default: <label>` option that resets to the same pick.
- Initial analysis and commit analysis orchestration.
- Context-pack generation for AI calls.
- Reviewable run/draft workflow before writing knowledge-base files.
- Claude workbench integration for project-scoped conversations.
- Structured logs, supervision issues, and job history.
- Knowledge-store configuration and migration helpers.
- Windows scheduled task and post-commit hook support.
- UI and backend regression tests for the dashboard and API contracts.
- Background-daemon CLI (`project-knowledge` / `stop` / `status` / `--fg`) with
  automatic port fallback in `5757–5776` when the default port is busy.
- Auto-injects a "Knowledge Base Reading Rule" block into each imported
  project's `CLAUDE.md` when the post-commit hook is installed, so Claude
  Code reads the project's KB indexes before non-trivial work.

## Install

```bash
npm install -g project-knowledge
project-knowledge
```

Then `project-knowledge` starts the dashboard in the background and opens
your browser to:

```text
http://127.0.0.1:5757
```

The default port is **5757**. If 5757 is busy, the CLI automatically picks
the next free port in `5757–5776` and prints the actual URL.

Requirements:

- Node.js 18 or newer
- Git on `PATH`
- Windows for the scheduled-task workflow
- Optional: Claude Code CLI or another Anthropic-compatible API profile

## CLI commands

```bash
project-knowledge           # Start in background, auto-open browser
project-knowledge stop      # Stop the background process
project-knowledge status    # Check if running
project-knowledge --fg      # Run in foreground (Ctrl+C to stop)
project-knowledge --port 9000    # Use a different port
project-knowledge --no-open      # Don't auto-open the browser
project-knowledge --help         # Show all options
```

The CLI writes a PID file at `os.tmpdir()/.project-knowledge.pid` so `stop`
and `status` can locate the running process. Closing the original terminal
does not stop the dashboard — use `project-knowledge stop`.

## Run from source

```bash
git clone https://github.com/SanQianX/project-knowledge-base.git
cd project-knowledge-base
npm install
npm start        # foreground; for background behavior, use the bin:
node bin/project-knowledge.js
```

## First-time setup

1. Start the dashboard with `project-knowledge`.
2. Open Settings and add or test at least one AI profile. The first usable
   profile is treated as the **default** — new projects that did not pick
   one explicitly are auto-assigned to it. Onboarding opens the AI Profiles
   view automatically and pre-creates an empty profile draft for you.
3. Use Import Project to register a local Git project. The import summary
   lists which default AI profile the project will use.
4. Select the project from the sidebar. Each card's profile picker always
   starts with a `Default: <label>` option that snaps the project back to
   the default profile.
5. Scan or analyze the project.
6. Open Runs / Drafts to review and apply generated knowledge-base changes.

The server creates missing runtime JSON files automatically. Invalid JSON is
backed up as `*.invalid-<timestamp>.bak` and replaced with safe defaults.

## Default AI profile

Every project carries an effective AI profile:

- If a project has an explicit `aiProfileId` that still resolves to a usable
  profile, that profile is used.
- Otherwise the **first usable profile** in `~/.project-knowledge/ai-profiles.json`
  is used as the default.
- `PUT /api/projects/:slug/ai-profile` with `{ aiProfileId: null }` **restores**
  the default profile — it no longer leaves the project with no assignment.
- The import flow (`POST /api/projects/import`) ignores the request-body
  `aiProfileId` and assigns the default server-side, so freshly imported
  projects never end up analysis-blocked.

## CLAUDE.md reading rule

When you install the post-commit hook in an imported project, `project-knowledge`
also drops a managed block into the project's `CLAUDE.md` that points Claude
Code directly at this project's knowledge base:

```markdown
<!-- KB-MANAGED:CLAUDE-MD:START — managed by project-knowledge -->
## Knowledge Base Reading Rule

This project's knowledge base lives at:

  <absolute path registered in projects.json>

Before implementing a non-trivial feature or fix in this repo:

1. Read only the indexes: <kbPath>/GOAL.md, <kbPath>/modules/00-index.md,
   <kbPath>/changes/00-index.md.
2. Compare the request, changed files, API routes, symbols, and keywords
   against the module and change indexes.
3. Open only the top-relevant module and change docs based on the match.
4. No hits? Treat as a new feature area — propose a new module + change entry
   instead of patching unrelated knowledge.
5. Do not load the whole KB unless explicitly asked.
6. After implementation, summarize whether the KB needs an update.
<!-- KB-MANAGED:CLAUDE-MD:END -->
```

The absolute `kbPath` is read from `projects.json` when the hook is
installed and embedded into the block. Re-installing the hook refreshes
the path so it always points at the current KB location. The block is
bracketed by HTML-comment markers, so re-installing replaces it in place
(no duplicates) and uninstalling removes only the block. Any pre-existing
user content in `CLAUDE.md` is preserved; if the file was created by us
and becomes empty after removal, the file itself is deleted. Pass
`updateClaudeMd: false` to either hook call to skip this behavior.

## Runtime data

`project-knowledge` keeps all of its local state in a single data directory
that lives **outside** the npm package. Upgrading (`npm install -g
project-knowledge`) never touches this directory, so project registries, AI
profiles and their API keys, generated knowledge bases, logs, and AI
workspaces all survive every future upgrade.

Default location: **`~/.project-knowledge/`** (your home directory).

You can override the location with the `KB_DATA_DIR` environment variable,
which is also what the regression test suite uses to point the server at
an isolated temp directory per test.

```bash
KB_DATA_DIR=D:\\data\\project-knowledge project-knowledge
```

On the first run after upgrading from a 1.x install, `project-knowledge`
silently copies the legacy runtime files from inside the old npm package
directory into the new data directory. The migration only runs when
`<dataDir>/projects.json` does not yet exist, never overwrites anything in
the new location, and never prompts the user. After it completes, all
subsequent upgrades keep the data dir untouched.

Inside the data directory:

| Path | Purpose |
| --- | --- |
| `projects.json` | Local project registry |
| `projects/` | Generated per-project knowledge bases using the final minimal layout |
| `ai-profiles.json` | Local AI profile configuration and keys |
| `knowledge-store.json` | External knowledge-store settings |
| `logging.json` | Log retention and storage settings |
| `logs/` | Structured runtime logs |
| `.jobs-log.json` | Job history |
| `_ai/` | Local AI workspace data |
| `claude-prompts.json` | Bundled Claude prompt registry (overridable per install) |

These files are local state and should not be committed to your project
repository. Fresh installs start with an empty registry and let each user
import their own projects.

## Repository layout

```text
_site/
  index.html              Dashboard UI
  server.js               Local HTTP API server
  lib/                    Server-side modules
  scripts/                Hook and safe-runner scripts
  vendor/                 Vendored browser assets
  _test/                  Regression and UI tests
bin/
  project-knowledge.js    CLI entrypoint
templates/                Knowledge-base markdown templates
docs/                     Public schemas, testing notes, and open-source boundary
```

Core modules:

- `_site/lib/ai-adapter.js`
- `_site/lib/analysis-orchestrator.js`
- `_site/lib/claude-md-manager.js`
- `_site/lib/context-pack-builder.js`
- `_site/lib/draft-apply.js`
- `_site/lib/hook-manager.js`
- `_site/lib/job-orchestrator.js`
- `_site/lib/kb-framework.js`
- `_site/lib/kb-validator.js`
- `_site/lib/knowledge-store.js`
- `_site/lib/scanner.js`
- `_site/lib/supervision.js`

## Testing

```bash
npm test
```

The regression runner executes backend, integration, and browser UI tests,
including:

- AI profile validation
- Git import validation
- scanner behavior
- context pack generation
- initial and commit analysis
- draft apply/reject
- knowledge-store and structured logs
- project control panel flows
- Runs / Drafts UI flow
- dashboard smoke tests

Test artifacts are generated under `_site/_test/` and are ignored by Git.

## Publishing

Releases are tag-driven. Pushing a `v*` tag triggers
`.github/workflows/publish.yml`, which runs:

```bash
npm publish --provenance --access public
```

The workflow expects the repository secret `NPM_TOKEN`.

Before publishing, run the release checklist and verify that runtime data,
local project knowledge bases, generated drafts, logs, and credentials are not
part of the Git tree or npm package.

Release checklist:

```bash
npm test
npm pack --dry-run
git status --short
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

After the workflow completes:

```bash
npm view project-knowledge version dist-tags
```

## Notes

- The server binds to `127.0.0.1` by default. Do not expose it publicly.
- Project paths may reference private local repositories. Keep runtime data out
  of Git.

## License

This project is licensed under the Apache License, Version 2.0. See
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
