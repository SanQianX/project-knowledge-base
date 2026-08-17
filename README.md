<p align="center">
  <img src="docs/assets/logo.svg" alt="project-knowledge" width="540">
</p>

<p align="center">
  <strong>Local, Git-triggered knowledge for software projects.</strong><br>
  Markdown is the source of truth; the local vector index is always derived and rebuildable.
</p>

## Install

### npm

```bash
npm install -g project-knowledge
project-knowledge
```

The local service listens on `127.0.0.1:5757` by default. The CLI can select a
nearby free port and records the active loopback endpoint so managed Git Hooks
do not depend on a hard-coded port.

```bash
project-knowledge              # start in the background and open the UI
project-knowledge --fg         # run in the foreground
project-knowledge status       # show the active local backend
project-knowledge stop         # stop the background backend
project-knowledge --port 9000
project-knowledge --no-open
```

Requires Node.js 18 or newer and Git on `PATH`.

### Windows desktop

Install `Project-Knowledge-<version>-Setup.exe` from a project release. The
desktop app and npm CLI use the same data directory and endpoint-ownership
record, so only one backend owns a data directory at a time. Git and Claude
Code are not bundled.

## Runtime model

There are exactly two public analysis triggers:

```text
post-commit Hook ----+
                     +--> reconcileProjectCommits(projectId, trigger)
application startup -+      trigger: git-hook | startup
```

Import establishes a Git tracking baseline, installs and verifies the managed
Hook, and creates project metadata. It does not run AI, infer requirements from
the repository, or generate placeholder knowledge. For an empty repository,
the first later Commit is eligible for analysis.

The Hook only sends a small `hook-event/v2` notification to the local backend.
It always exits successfully when the backend is unavailable; startup then
discovers reachable pending Commits from Git history. There is no offline task
spool and no manual Hook or manual analysis API.

Within a project, Commits run oldest-first and stop at the first failure.
Different projects may reconcile concurrently. Hook/startup overlap for the
same project shares one in-flight reconciliation.

## Knowledge safety

AI receives a frozen claim containing the Commit SHA, real patch evidence,
bound requirement IDs, prompt hash, and fixed knowledge path. It can write only
to an internal per-run staging directory. A manifest must validate before any
file reaches the final project knowledge directory.

Promotion uses verified hashes, backups, and a durable journal. Only after
Markdown promotion succeeds does the analyzed-Commit pointer advance and mark
the index dirty. Index failure never rolls back Markdown or reruns AI; it stays
visible as dirty state and is retried.

`IndexService` is the only production LanceDB writer. Incremental updates and
full rebuilds share one process-wide FIFO. A full rebuild creates and validates
a separate database, atomically swaps it into place, and retains the previous
index under recovery.

The application does not create, edit, refresh, or delete `CLAUDE.md`.

## Requirement capture

Coding-agent integrations can append the user's real request before code is
changed. Requirement capture writes bounded metadata to the selected project's
`requirements.jsonl`; it does not start analysis or write knowledge.

The MCP server exposes:

- read-only `resolve`, `search`, `ask`, `get`, and `history` tools;
- one write-only `record_requirement` metadata tool.

```bash
npx project-knowledge@latest install
npx project-knowledge@latest install --ide claude
npx project-knowledge@latest install --ide codex
npx project-knowledge@latest install --ide opencode
```

Read-only CLI examples:

```bash
project-knowledge-kb search --project <projectId> --query "refresh token policy" --json
project-knowledge-kb ask --project <projectId> --query "what was decided about login?"
project-knowledge-kb get --project <projectId> --entry modules/auth.md --json
project-knowledge-kb history --project <projectId> --json
```

Queries never create or rewrite configuration. If the internal index is
missing, dirty, or unavailable, search falls back to the project's Markdown
and explicitly configured related projects.

## Storage

Default internal data directory: `~/.project-knowledge/`

Override it with `KB_DATA_DIR`:

```powershell
$env:KB_DATA_DIR = 'D:\data\project-knowledge'
project-knowledge
```

The user selects a global knowledge root before importing projects. That root
only chooses the directory for future imports. Each imported project stores an
absolute, fixed `knowledgePath`; changing the global root does not move existing
projects.

The selected knowledge root contains only authoritative project Markdown.
Settings, metadata, indexes, caches, runtime state, logs, and recovery assets
remain in the internal data directory:

```text
~/.project-knowledge/
├── settings.json
├── projects.json                         # minimal project ID/order index
├── projects/<projectId>/
│   ├── config.json                       # fixed repoPath/knowledgePath
│   ├── state.json                        # tracking, claim, index, Hook state
│   └── requirements.jsonl                # created only when used
├── index/knowledge.lancedb               # one derived index
├── cache/                                # models, exports, context packs
├── runtime/                              # claims, staging, journals, locks
├── logs/
│   ├── app/
│   ├── projects/<projectId>/
│   └── hooks/
└── recovery/                             # migrations, promotion/index backups

<selected knowledge root>/
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

## Logging UI

The production web UI is a focused structured-log console. It provides:

- trace/debug/info/warn/error/fatal filtering;
- local-date, project, component, event, operation, Commit, and text filters;
- newest-first cursor pagination, pause/auto-refresh, and filtered export;
- operation-flow and structured error/stack details;
- logger health/degraded state and Hook/index/project read-only status;
- light/dark themes and a responsive narrow-screen layout.

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
ui/index.html                         # single production logging UI
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

The Windows suite includes real Git Hooks, paths with spaces/non-ASCII text,
online and offline Commit reconciliation, crash-lock recovery, atomic index
replacement, migration fault injection, packaged-startup contracts, API
security, log redaction/cursors, and browser-level UI flows.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
