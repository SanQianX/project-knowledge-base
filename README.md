<p align="center">
  <img src="docs/assets/logo.svg" alt="project-knowledge" width="540">
</p>

<p align="center">
  <strong>Local knowledge-base manager for Git projects.</strong><br>
  Scan history. Generate reviewable AI drafts. Ship a curated bilingual KB.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/project-knowledge"><img src="https://img.shields.io/npm/v/project-knowledge.svg?style=flat-square" alt="npm"></a>
  <img src="https://img.shields.io/node/v/project-knowledge.svg?style=flat-square" alt="Node 18+">
  <img src="https://img.shields.io/github/license/SanQianX/project-knowledge-base?style=flat-square" alt="Apache-2.0">
  <a href="https://github.com/SanQianX/project-knowledge-base/actions"><img src="https://img.shields.io/badge/tests-45%20passed-2f7d64?style=flat-square" alt="Tests"></a>
  <a href="#star-history"><img src="https://img.shields.io/badge/star_history-⬇-7492a5?style=flat-square" alt="Star history"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="docs/README.zh-CN.md">简体中文</a>
</p>

---

## Install

```bash
npm install -g project-knowledge
project-knowledge
```

The dashboard opens at **http://127.0.0.1:5757**. If 5757 is busy, the CLI
walks `5757–5776` and prints the actual URL. The daemon survives terminal
close — `project-knowledge stop` shuts it down.

```bash
project-knowledge            # start (default), auto-open browser
project-knowledge --fg       # foreground, Ctrl+C to stop
project-knowledge stop       # stop the background daemon
project-knowledge status     # print running PID + port
project-knowledge --port 9000   # bind to a specific port
project-knowledge --no-open     # don't auto-open browser
```

Requires **Node.js 18+** and **Git on `PATH`**. Optional: any
Anthropic-compatible API profile for AI drafts.

Expected output on first launch:

```text
project-knowledge  ·  v4.0.2
Local knowledge-base dashboard

  ▸ Resolving data directory …      ~/.project-knowledge/
  ▸ Migrating legacy state …        no legacy data found
  ▸ Loading AI profiles …           3 profiles · default: claude-opus-4-7
  ▸ Starting HTTP server …          listening on 127.0.0.1:5757
  ▸ Watching 4 projects · 12 pending commits · 1 active run
  ▸ Opening dashboard in browser …

  → http://127.0.0.1:5757

Ctrl+C in this window, or run `project-knowledge stop` elsewhere.
```

---

## What it does

```
   git commit ──► post-commit hook ──► scanner ──► orchestrator ──► AI
                                                          │            │
                                                          ▼            ▼
                          ~/.project-knowledge/      drafts/      Anthropic-compat
                                                          │
                                                          ▼
                                              browser diff review
                                                          │
                                                          ▼
                                           your KB grows only by your click
```

`project-knowledge` watches your local Git projects, asks an
Anthropic-compatible LLM to draft knowledge entries from each commit or
branch, and surfaces those drafts in a side-by-side diff. You **apply**,
**edit**, or **reject** each one. The trusted KB (`modules/`, `changes/`)
only grows when you say so.

---

## Features

<table>
  <tr>
    <td width="50%" valign="top">

**Local-first**

- Browser dashboard on `127.0.0.1` — no public exposure.
- All state under `~/.project-knowledge/` (or `$KB_DATA_DIR`).
- Runtime data survives every `npm install -g` upgrade.
- API keys stored locally in `ai-profiles.json`, never synced.
- Server binds to loopback only.

</td>
    <td width="50%" valign="top">

**Git-aware**

- Per-project pending-commit scan from `git log`.
- Post-commit hook auto-fires on every commit.
- Add one home-relative shared-rule import to each project's `CLAUDE.md` so
  detailed instructions are maintained once under `~/.project-knowledge/`.
- Branches, remotes, HEAD metadata, reflog.

</td>
  </tr>
  <tr>
    <td valign="top">

**Vector knowledge search (v4.0+)**

- Original text + 512-dimensional local embeddings in LanceDB.
- Chinese semantic search plus n-gram/BM25 keyword retrieval.
- Incremental upsert removes stale chunks instead of accumulating duplicates.
- Read-only `search`, `get`, `ask`, and `history` tools for Claude Code.

</td>
    <td valign="top">

**Team Knowledge Mode (v3.0.13+)**

- Shared KB repo via GitHub or Gitea OAuth (client-secret, v3.0.12+).
- Sparse-checkout pulls only `changes/` and `modules/`.
- Discovery lists repos with a `team-store.json` manifest.
- Personal-mode projects continue to work alongside team bindings.

</td>
  </tr>
</table>

---

## Vector knowledge and one-click upgrade

Version 4 stores the complete human-readable knowledge text, metadata, and
`Xenova/bge-small-zh-v1.5` vectors in
`<configured knowledge root>/.project-knowledge/knowledge.lancedb`. The exact
path is displayed below the Knowledge Store root setting. Vectors are retrieval indexes — they
cannot be decoded back into prose. `project-knowledge-kb` retrieves the
original `chunk_text`, and Claude uses that source text to answer.

Open **Settings → One-click vector knowledge migration** after upgrading:

1. Every registered legacy Markdown KB is discovered.
2. Markdown is copied to `_backup/vector-migration/`; the source is untouched.
3. Files are split by Markdown headings and embedded locally.
4. File, entry, chunk, content-hash, and vector-search probes are verified.
5. Only the verified project is atomically switched to `knowledgeBackend:
   "lancedb"`. Failed projects remain on Markdown and can be retried.

The migration is resumable and idempotent. **Roll back to Markdown** changes
the project backend without deleting either the original files or LanceDB.
Post-commit automation incrementally re-indexes migrated projects: unchanged
files are skipped, changed chunks are replaced, and chunks from deleted files
are removed.

When upgrading an existing v4.0.0 installation, use **Compact database** once
in the same settings panel. It builds a separate compact database from the
current valid rows, excludes generated `00-index.md` files, verifies vector
and keyword retrieval, and only then atomically switches databases. By default
the old oversized database is deleted after verification. Select **Keep old
database for manual rollback** only when you can temporarily afford both
copies on disk.

The model downloads on first use (about 100 MB). For restricted networks or
offline installations:

```bash
# Alternative Hugging Face-compatible endpoint
KB_EMBEDDING_REMOTE_HOST=https://your-model-mirror.example/ project-knowledge

# Pre-downloaded model tree
KB_EMBEDDING_LOCAL_PATH=D:/models project-knowledge
```

### Related projects and team knowledge

Each Git project has one primary write space. In project settings you can
explicitly select related projects; search then covers the primary, shared,
and selected spaces with source labels and weights. Relationships are
non-transitive, and post-commit updates still write only to the current
project's primary space.

Team Knowledge Mode remains compatible. GitHub/Gitea Markdown v1 stays the
portable, reviewable sync transport, while every teammate generates vectors
locally. LanceDB directories and model files are never committed to the team
repository. Projects bound to the same stable team `kbId` resolve to the same
local `space_id`.

Read-only CLI examples:

```bash
project-knowledge-kb search --project my-api --query "how are refresh tokens rotated?" --json
project-knowledge-kb ask --project my-api --query "what did we decide about login?"
project-knowledge-kb get --project my-api --entry "modules/auth.md" --json
project-knowledge-kb history --project my-api --json
```

---

## Dashboard

<p align="center">
  <img src="docs/assets/dashboard.png" alt="Project Supervision dashboard" width="1280">
</p>

The supervision view at a glance: pending-commit counts across every
project, the selected project's status pill (repo / pending / goal / KB),
the issues panel, and a Claude workbench on the right for project-scoped
conversation.

---

## Review before it ships

<p align="center">
  <img src="docs/assets/runs-drafts.png" alt="Runs / Drafts" width="1280">
</p>

Each analysis run produces a list of drafts. Click a run to see its
drafts — check the ones you want to apply, then **Apply selected**
writes them into the KB. **Reject run** discards everything.

<p align="center">
  <img src="docs/assets/draft-review.png" alt="Draft review" width="1280">
</p>

For per-draft diffs, open a draft directly in the editor.

---

## Configuration

<p align="center">
  <img src="docs/assets/settings.png" alt="Settings drawer" width="1280">
</p>

The settings drawer manages AI profiles, team-knowledge repository
binding, Windows scheduled task, log retention, and language/theme.
Every action is local; nothing leaves your machine except the AI
request body itself.

---

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture" width="1180">
</p>

The flow above shows the four layers: user-facing UI (browser + CLI +
hook + Claude Code), the local Node.js server with its specialized
modules, the data layer (`~/.project-knowledge/` + your Git repos +
generated KB), and the external LLM endpoint.

The dashed line on the right represents the **KB reading rule**: when
Claude Code (or any Anthropic-compatible agent) opens a project that has
this app's `CLAUDE.md` block, it reads `GOAL.md` and the module / change
indexes before opening detail files. That keeps context window usage
linear with task size, not with KB size.

---

## CLI reference

| Command | Effect |
|---|---|
| `project-knowledge` | Start in background, auto-open browser |
| `project-knowledge --fg` | Foreground (Ctrl+C to stop) |
| `project-knowledge stop` | Stop the background daemon |
| `project-knowledge status` | Print running PID + port, or `not running` |
| `project-knowledge --port <p>` | Bind to `<p>`; auto-fallback to `<p>+1…+19` |
| `project-knowledge --host <h>` | Bind to host `<h>` (default `127.0.0.1`) |
| `project-knowledge --no-open` | Don't open the browser |
| `project-knowledge -v` / `--version` | Print version and exit |
| `project-knowledge -h` / `--help` | Print full help |
| `project-knowledge-kb search …` | Scoped semantic + keyword knowledge search |
| `project-knowledge-kb ask …` | Human-readable answer with source citations |
| `project-knowledge-kb get …` | Read one stored entry's original chunks |
| `project-knowledge-kb history …` | Read scoped change history |

The CLI writes a PID file at `os.tmpdir()/.project-knowledge.pid`.
Closing the original terminal does **not** stop the dashboard — use
`project-knowledge stop`.

---

## CLAUDE.md reading rule

Imported projects keep only one import line in their managed
`CLAUDE.md` block:

```markdown
<!-- KB-MANAGED:CLAUDE-MD:START — managed by project-knowledge -->
@~/.project-knowledge/claude-code-rules.md
<!-- KB-MANAGED:CLAUDE-MD:END -->
```

The detailed read-only, index-first, and post-commit ownership rules live in
`~/.project-knowledge/claude-code-rules.md`. That file resolves the current
Git root against `~/.project-knowledge/projects.json`, where the project's
`kbPath` remains authoritative. Updating the application refreshes this one
central file instead of rewriting every repository.

At startup the dashboard audits all registered projects without modifying
them. Settings → Central CLAUDE.md Rules shows outdated blocks and provides a
single **Refresh all CLAUDE.md** action. It only replaces complete managed
blocks; user-only, missing, malformed, symlinked, or unavailable files are
reported and left untouched. The refresh does not reinstall or alter Git
hooks. Uninstall still removes only the managed block and preserves your own
content.

This means **Claude Code (or any Anthropic-compatible agent) reads the
KB indexes before opening modules**, drastically cutting token usage on
context-heavy tasks. It does not maintain the KB while code is still in
progress; the managed `post-commit` worker performs that update from committed
evidence.

---

## Runtime data

Everything lives in a single directory **outside** the npm package, so
`npm install -g project-knowledge` upgrades never touch your registry,
profiles, KBs, drafts, or logs.

**Default:** `~/.project-knowledge/` &nbsp;·&nbsp; **Override:** `KB_DATA_DIR`

```bash
KB_DATA_DIR=D:/data/project-knowledge project-knowledge
```

On first run after upgrading from 1.x, legacy runtime files inside the old
npm package directory are silently copied into the new data directory.
Migration only runs when `<dataDir>/projects.json` does not yet exist,
never overwrites anything in the new location, and never prompts.

```
~/.project-knowledge/
├── projects.json              # local project registry
├── projects/<slug>/           # generated KB (per project)
│   ├── GOAL.md
│   ├── modules/<area>.md      # curated module docs
│   └── changes/release-v*.md  # curated change records
├── _ai/<slug>/drafts/         # reviewable AI drafts (never auto-applied)
├── ai-profiles.json           # AI profile config + API keys
├── knowledge-store.json       # external / team KB settings
├── logging.json               # log retention
├── logs/                      # structured runtime logs
└── claude-prompts.json        # bundled prompt registry
```

---

## Repository layout

```
_site/
├── index.html                # dashboard UI (Vue + Tailwind, single file)
├── server.js                 # local HTTP API (REST + WebSocket)
└── lib/
    ├── scanner.js              # git state walker
    ├── analysis-orchestrator.js  # initial / commit analysis
    ├── context-pack-builder.js   # AI prompt assembly
    ├── kb-framework.js          # KB layout, write, validate
    ├── draft-apply.js           # apply / reject drafts
    ├── knowledge-store.js       # external KB config
    ├── github-team-store.js     # team mode · Gitea OAuth · sparse checkout
    ├── hook-manager.js          # post-commit hook install / uninstall
    ├── claude-md-manager.js     # CLAUDE.md managed block writer
    ├── ai-adapter.js            # Anthropic-compatible LLM client
    └── supervision.js           # issues / warnings aggregator

bin/project-knowledge.js       # CLI entrypoint
templates/                    # KB markdown templates
docs/                         # public schemas, plans, screenshots
```

The public boundary is documented in [`INDEX.md`](INDEX.md) and
[`CHANGELOG.md`](CHANGELOG.md).

---

## Team Knowledge Mode

v3.0.13+ adds team-store support: turn a GitHub repository (or a
self-hosted Gitea instance) into a shared knowledge layer without running
a cloud service of our own.

- One Git repo holds many projects' KBs as sub-directories.
- A `team-store.json` manifest declares which KBs exist.
- Per-user local clone uses **sparse-checkout** so only `changes/` and
  `modules/` materialize — the full history never touches your disk.
- v3.0.12 adds **client-secret OAuth** for Gitea (and any GitHub-compatible
  OAuth provider), so you don't have to mint personal access tokens.

Design: [`docs/team-knowledge-mode-a-plan.md`](docs/team-knowledge-mode-a-plan.md) ·
Schema: [`docs/project-registry-schema.md`](docs/project-registry-schema.md)

---

## Testing

```bash
npm test
```

The regression suite under `_site/_test/` covers:

- AI profile validation, scanner behavior, context pack generation
- Initial and commit analysis
- Draft apply / reject, knowledge-store, structured logs
- Project control panel flows, Runs / Drafts UI flow
- CLI startup / stop / status
- Gitea OAuth + sparse checkout
- 45 tests, 0 failures

---

## Publishing

Tag-driven: pushing a `v*` tag triggers
`.github/workflows/publish.yml` → `npm publish --provenance --access public`.

```bash
npm test
npm pack --dry-run
git status --short
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
npm view project-knowledge version dist-tags
```

The workflow expects the `NPM_TOKEN` repository secret. Verify that
runtime data, KBs, drafts, logs, and credentials are not part of the Git
tree or npm package before tagging.

---

## Requirements

- **Node.js 18+** — uses native `fetch` and ES2022 features
- **Git** on `PATH` — every scanner call goes through it
- **Windows, macOS, or Linux** — only the Windows scheduled-task workflow
  is platform-specific
- **Optional** — Claude Code CLI or any Anthropic-compatible API profile
  for drafts. Without one, the dashboard still scans and visualizes git
  state.

The server binds to `127.0.0.1` by default. Do not expose it publicly.

---

## Contributing

Issues and pull requests welcome on
[github.com/SanQianX/project-knowledge-base](https://github.com/SanQianX/project-knowledge-base).
Run `npm test` before opening a PR; for larger changes, open an issue
first so we can align on direction.

## License

[Apache-2.0](LICENSE) — see also [NOTICE](NOTICE).

## Star history

<p align="center">
  <a href="https://star-history.com/#SanQianX/project-knowledge-base">
    <img src="https://api.star-history.com/svg?repos=SanQianX/project-knowledge-base&type=Date" alt="Star history">
  </a>
</p>
