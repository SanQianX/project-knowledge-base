<p align="center">
  <img src="docs/assets/logo.svg" alt="project-knowledge" width="540">
</p>

<p align="center">
  <strong>Local, Git-triggered knowledge for software projects.</strong><br>
  Markdown is the source of truth; the local vector index is always derived and rebuildable.
</p>

## Install

### npm

Install the web product and start the local service:

```bash
npm install -g @sanqianx/project-knowledge@latest
project-knowledge-integrations install
project-knowledge
```

1. `npm install -g @sanqianx/project-knowledge@latest` installs the shell,
   three pinned module dependencies and the bundled knowledge-engine.
2. `project-knowledge-integrations install` is the one-time Integration Setup.
   For every detected client (Claude Code / Codex / OpenCode) it installs two
   independent capabilities, reported separately:
   - **Knowledge Integration** — plugin / MCP / Skill so agents can query the
     knowledge base;
   - **Development Capture** — managed Bridge hooks / notify / plugin so the
     agent conversations in real Git workspaces are captured into each
     imported project's Development Conversation.
   It also registers the host-level `project-knowledge` Bridge consumer.
   ZCode is supported for Development Capture only; an unverified knowledge
   plugin is never reported as installed. Use `install --ide zcode --capture-only`
   or System Status → 外部 Agent 采集 in the web UI. Per-client repair/removal
   preserves unrelated hooks and existing records. Failures include an operation
   ID and persist to the local system diagnostic log.
   No client UI needs to be opened; third-party hooks and configs are
   preserved. Codex setup repairs this product's stale notify paths, keeps live
   desktop notification wrappers and existing compatible Radar notifications,
   and refuses to overwrite unknown third-party commands. Changed notify
   settings are backed up beside `config.toml` without copying other settings.
3. `project-knowledge` starts a fresh v5 local backend. Import projects again;
   older registries, knowledge, sessions and unfinished tasks are not migrated.

Notes:

- Restart already-running Claude Code sessions once after installing
  Development Capture — hooks load at session start. Only conversations after
  setup are captured; history is never backfilled.
- To narrow the setup: `--ide claude`, `--capture-only`, `--knowledge-only`;
  to remove capture per client: `uninstall --capture-only`; to disable
  capture globally (including the Bridge consumer): `disable-capture`.
- To repair Codex capture after an npm or Codex desktop upgrade, use System
  Status → 外部 Agent 采集 → 接入/修复, or
  `project-knowledge-integrations install --ide codex --capture-only`.
  Repeating setup does not add notification wrappers. Removing capture restores
  the preserved notification chain and leaves captured records on disk.

The local service listens on `127.0.0.1:5757` by default. The CLI can select a
nearby free port and records the active loopback endpoint so managed Git Hooks
do not depend on a hard-coded port.

```bash
project-knowledge              # start in the background and open the UI
project-knowledge --fg         # run in the foreground
project-knowledge status       # show the active local backend
project-knowledge stop         # stop the background backend
project-knowledge status --all # list verified local instances and data directories
project-knowledge stop --port 5804 # stop a specific verified instance
project-knowledge --data "D:/data/knowledge" # select an independent data directory
project-knowledge --port 9000
project-knowledge --no-open
```

Requires Node.js 22 or newer and Git on `PATH`.

Commands such as `stop`, `STOP`, and `Stop` are equivalent. Unknown commands and
invalid arguments fail without starting a service. Default start/status/stop are
scoped to the selected data directory; stopping another directory requires an
explicit port or `--data`. The CLI uses a local control channel, not a shared PID
file or blind process termination. Stop succeeds only after the backend and its
owned modules finish shutdown; independently started modules are preserved.
An older or unverifiable instance is reported explicitly, never treated as safely
stopped. Stop the previous running version before upgrading.

### Windows desktop

Version 5.0.0 delivers the web product through npm. A new Windows installer
and desktop auto-update are not part of this release.

## Runtime model

The shell connects and projects; knowledge-engine owns the analysis pipeline:

```text
Git Hook → event-bridge journal → durable engine claim → isolated Agent
         → staging validation → Markdown promotion → vector-hub → retrieval
```

Import establishes a Git tracking baseline, installs and verifies the managed
Hook, and creates project metadata. It does not run AI, infer requirements from
the repository, or generate placeholder knowledge. For an empty repository,
the first later Commit is eligible for analysis.

The Hook writes commit evidence to the bridge journal and only notifies the
local service. Notifications may be lost; journal consumption and Git startup
reconciliation recover eligible commits. A Hook failure never blocks a commit.
Import does not trigger a costly historical analysis.

Within a project, Commits run oldest-first and stop at the first failure.
Different projects may analyze concurrently (maximum two). Duplicate events
do not re-analyze completed commits. Closing the browser does not stop work.

## Knowledge safety

AI receives a frozen claim containing the Commit SHA, real patch evidence,
bound requirement IDs, prompt hash, and fixed knowledge path. It can write only
to an internal per-run staging directory. A manifest must validate before any
file reaches the final project knowledge directory.

Promotion uses verified hashes, backups, and a durable journal. Only after
Markdown promotion succeeds does the analyzed-Commit pointer advance and mark
the index dirty. Index failure never rolls back Markdown or reruns AI; it stays
visible as dirty state and is retried.

vector-hub owns the derived index; the shell no longer runs a second index
writer. Failed indexing leaves promoted Markdown intact and repairable.

Managed vectors follow the configured knowledge root at `<knowledge>/.indexes`.
The system drawer displays the actual directory and pending wiring separately.
Root changes leave project Markdown and old indexes untouched, drain existing
index writes, switch subsequent writes, and rebuild registered knowledge with
the configured embedding model. Credentials and small runtime metadata remain
in the product data directory; no expensive historical Agent analysis is started.

The application does not create, edit, refresh, or delete `CLAUDE.md`.

## Requirement capture

Coding-agent integrations can append the user's real request before code is
changed. Requirement capture writes bounded metadata to the selected project's
`requirements.jsonl`; it does not start analysis or write knowledge.

The MCP server exposes:

- read-only `resolve`, `search`, `ask`, `get`, and `history` tools;
- one write-only `record_requirement` metadata tool.

```bash
npx @sanqianx/project-knowledge@latest install
npx @sanqianx/project-knowledge@latest install --ide claude
npx @sanqianx/project-knowledge@latest install --ide codex
npx @sanqianx/project-knowledge@latest install --ide opencode
```

Read-only CLI examples:

```bash
project-knowledge-kb search --project <projectId> --query "refresh token policy" --json
project-knowledge-kb ask --project <projectId> --query "what was decided about login?"
project-knowledge-kb get --project <projectId> --entry modules/auth.md --json
project-knowledge-kb history --project <projectId> --json
```

Queries never create or rewrite configuration. If the internal index is
unavailable, search falls back to current Markdown. Project, domain and brain
scopes are nested; unconfirmed memory candidates are not task preferences.

For engine-wired projects, the CLI and MCP delegate `search`, `ask`, `get` and
`history` to the same engine used by the web UI, including commit provenance.
They verify the running instance against the selected data directory; an
unavailable or mismatched instance is an explicit failure, not a second local
index with different facts. Only projects without engine wiring retain the
local legacy read contract. Use `--scope domain` or `--scope brain` to broaden
CLI searches; MCP accepts the equivalent `scope`. Shared-file reads accept
`--space <spaceId>` (MCP: `space` or `spaceId`).

## Storage

Version 5 is a fresh start, not a data upgrade. Stop the previous process,
remove any old `KB_DATA_DIR` override, configure models and import projects into
new empty knowledge directories. Old files remain untouched but are not read.
See [fresh v5 setup](docs/fresh-v5-start.md). Queued tasks can be cancelled by
unbinding; only an active knowledge/index writer blocks removal.

Default internal data directory: `~/.project-knowledge-v5/`

Override it with `KB_DATA_DIR`:

```powershell
$env:KB_DATA_DIR = 'D:\data\project-knowledge'
project-knowledge
```

The user selects a global knowledge root before importing projects. That root
chooses directories for future imports, new shared scopes, and derived vector
indexes (`<knowledge root>/.indexes`). Each imported project stores an
absolute, fixed `knowledgePath`; changing the global root does not move existing
projects.

Existing project and shared-knowledge directories do not move when the root
changes. Brain/domain directory bindings are retained in the shell settings
after the engine acknowledges them. Existing engine bindings are reused when
first recording those fields. A failed registration is shown as pending, not
healthy. Old index directories are retained; indexes rebuild at the new root.
Settings, registration metadata, caches, runtime state, logs, and recovery
assets remain in the internal data directory; vector payloads do not:

```text
~/.project-knowledge-v5/
├── settings.json
├── projects.json                         # minimal project ID/order index
├── projects/<projectId>/
│   ├── config.json                       # fixed repoPath/knowledgePath
│   ├── state.json                        # tracking, claim, index, Hook state
│   └── requirements.jsonl                # created only when used
├── knowledge-engine/                    # durable claims, runs and cursors
├── cache/                                # models, exports, context packs
├── runtime/                              # claims, staging, journals, locks
├── logs/
│   ├── app/
│   ├── projects/<projectId>/
│   └── hooks/
└── recovery/                             # migrations, promotion/index backups

<selected knowledge root>/
├── .indexes/                            # rebuildable vector payloads
├── _shared/<brain or domain ID>/         # fixed shared-knowledge bindings
└── <project storage name>/
    ├── README.md                         # when produced by verified knowledge
    ├── GOAL.md
    ├── ARCHITECTURE.md
    ├── modules/*.md
    └── changes/*.md
```

Team knowledge is an explicit exception: an import may bind an existing
checked-out team-store subdirectory. Its final absolute path is still fixed in
the project config, must remain inside the selected store, and is treated as
externally owned when the project registration is deleted.

## Migration

The versioned `layout-v2` migration discovers legacy assets without modifying
them, creates a journal and centralized recovery backup, stages settings and
per-project metadata, validates preserved paths/secrets/pointers and any legacy
index, then activates files with the minimal registry last. The completion
marker is written only after the new stores reopen successfully.

Interrupted or failed migration keeps the legacy reader path available and
leaves source knowledge, old logs, configuration files, and backups intact for
retry or diagnosis.

## Product UI

The six primary pages are Brain, Start work, Knowledge search, Long-term
memory, Domains/projects and Activity. Start work embeds the real Workbench,
not a second chat implementation. Import projects from Domains/projects;
confirm both code and knowledge directories and retry only failed wiring.

Domain knowledge and confirmed brain memories live alongside existing project
knowledge. Adding a brain does not move project Markdown. Model credentials
are owned by Workbench; maintenance has a persisted default independent of
temporary chat selection. Runtime credentials never enter engine state.

System status groups four-module health, configuration and diagnostics.
Activity retains the structured-log capabilities:

- trace/debug/info/warn/error/fatal filtering;
- local-date, project, component, event, operation, Commit, and text filters;
- newest-first cursor pagination, pause/auto-refresh, and filtered export;
- operation-flow and structured error/stack details;
- logger health/degraded state and Hook/index/project read-only status;
- matching light/dark themes across the shell and native module frames.

Logs use `log/v2` JSONL, daily files and bounded segments. Retention defaults to
365 days; `0` disables time-based deletion. Capacity cleanup is deterministic.
Secrets are recursively redacted during write, query, error serialization, and
export. The log root is fixed under the internal data directory.

## HTTP security

The default loopback server accepts same-origin/loopback browser requests. It
does not use wildcard CORS. Binding to a non-loopback address requires
`KB_SITE_AUTH_TOKEN`, and requests must also pass Origin validation. Public AI
profile responses expose only masked secret metadata; generic errors return an
operation ID without a stack. There is no raw-file route.

## Repository layout

```text
_site/server.js                       # thin executable entry
_site/lib/server-app.js               # HTTP/runtime composition
_site/lib/storage-layout.js           # canonical internal paths
_site/lib/project-*-store.js          # v2 registry/config/state stores
_site/lib/project-lifecycle-service.js
_site/lib/commit-reconciler.js
_site/lib/knowledge-promotion.js
_site/lib/index-service.js
_site/lib/structured-logger.js
_site/lib/knowledge-tool-runtime.js
_site/scripts/hook-trigger.js
ui/index.html                         # unified production web UI
ui/product.js, ui/product.css          # shell navigation and state projection
_modules/knowledge-engine/            # verified dependency-free engine
bin/project-knowledge*.js             # CLI and MCP entry points
desktop/                              # Windows Electron package
```

## Testing

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
```

The automated suite includes real Git Hooks, paths with spaces/non-ASCII text,
online and offline Commit reconciliation, crash-lock recovery, atomic index
replacement, migration fault injection, packaged-startup contracts, API
security and log redaction/cursors. Product browser acceptance uses one
1920×1080 desktop viewport and controlled model/embedding doubles; real-model
and real-index smoke tests are reported separately. No mobile matrix or new
Windows installer is claimed. Full crash-stage combinations and the final
switch of a user's existing data require separate acceptance.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
