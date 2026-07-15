# Changelog

## [4.1.0] - 2026-07-16

- Added a Windows x64 Electron desktop application and Squirrel installer that
  reuse the existing configuration, configured knowledge root, model cache,
  Markdown sources, Team Knowledge Mode, and LanceDB without copying or
  re-vectorizing user data.
- Added single-instance and system-tray lifecycle behavior: closing the window
  keeps Git hooks available, while an explicit tray Quit stops only a backend
  owned by the desktop application.
- Added an atomic, local-only runtime endpoint record so CLI, desktop, and
  existing Git hooks discover the active fallback port dynamically and never
  open competing LanceDB writers.
- Made the desktop application safely attach to an already-running npm CLI and
  leave that external backend alive when the desktop window exits.
- Added hardened Electron navigation, context isolation, sandboxing, denied
  permission requests, bounded desktop backend logs, Squirrel lifecycle event
  handling, and explicit native-module ASAR unpacking.
- Added Windows release automation that runs all 50 core regression files,
  desktop unit tests, a packaged EXE/API smoke test, and packaged LanceDB native
  read/write tests before uploading the installer and SHA-256 to GitHub
  Releases. The existing npm provenance publish workflow remains unchanged.

## [4.0.4] - 2026-07-16

- Added a Settings-based Markdown knowledge health audit for every registered
  personal and team knowledge base, with per-project file size, deterministic
  fixes, structural errors, and semantic-review findings.
- Added safe batch or per-project optimization with retained backups under the
  configured knowledge root, atomic writes, formatting repair, compact index
  regeneration, and automatic LanceDB refresh for migrated projects.
- Reduced generated change indexes to the latest 40 entries with bounded cells
  and generated-file markers; a real 125 KiB legacy index now rebuilds to about
  9 KiB without deleting its source change documents.
- Prevented background AI automation from writing `00-index.md`, injected
  mandatory in-place-update hygiene rules even for custom prompts, and rebuilt
  compatibility indexes after every successful automatic update.
- Preserved Team Knowledge Mode by de-duplicating shared physical KB paths
  during maintenance while refreshing every aliased vector space.
- Expanded the complete regression suite to 48 passing test files.

## [4.0.3] - 2026-07-15

- Added an embedding-model setup panel with one-click download and real
  inference verification, configurable Hugging Face endpoint/mirror, local
  model directory, offline mode, and copyable PowerShell environment-variable
  examples.
- Stop a migration batch before changing any project when the shared embedding
  model cannot load, instead of reporting the same model failure once for every
  project.
- Surface migration failures through a prominent settings panel, a one-time
  browser alert, detailed per-project errors, and direct retry actions.
- Persist model settings and verified download state while rejecting partial
  cache files or verification results from a different model configuration.
- Expanded the complete regression suite to 46 passing test files.

## [4.0.2] - 2026-07-15

- Store LanceDB, its maintenance metadata, and retained database backups under
  `<configured knowledge root>/.project-knowledge/` instead of a fixed app-data
  location.
- Automatically relocate v4.0.0/v4.0.1 databases on startup to the knowledge
  root already selected in Settings.
- Safely relocate and verify the database before saving a changed knowledge
  root, including cross-volume copies, target-conflict protection, and retained
  backup path rebasing.
- Display the effective vector database path directly below the Knowledge Store
  root setting.
- Expanded the complete regression suite to 45 passing test files, including
  real LanceDB startup and live root-change relocation tests.

## [4.0.1] - 2026-07-15

- Excluded generated `00-index.md` files from embedding and removed stale
  derived-index rows while retaining the Markdown files for legacy and Team
  Knowledge Mode compatibility.
- Replaced unbounded Tags and change lists in generated Markdown indexes with
  compact, capped navigation metadata; all module links remain available.
- Stopped running LanceDB compaction after every commit. Maintenance now runs
  only after bounded mutation thresholds and never rewrites the oversized
  v4.0.0 full-text index in place.
- Added a compact full-text schema that indexes `chunk_text` once with Chinese
  bigrams instead of storing and indexing a second full document copy.
- Added one-click, atomic database rebuilding with disk statistics, vector and
  keyword verification, optional retained backup, and manual rollback.
- Added upgrade and regression coverage for old v4.0.0 databases; the complete
  suite now contains 43 passing test files.

## [4.0.0] - 2026-07-15

- Added a local LanceDB knowledge store containing original text, metadata,
  and 512-dimensional `Xenova/bge-small-zh-v1.5` embeddings.
- Added incremental Markdown indexing with heading-aware chunks, content-hash
  skips, stale-chunk deletion, Chinese n-gram/BM25 search, and hybrid RRF.
- Added scoped `search`, `get`, `ask`, and `history` HTTP/CLI tools that return
  readable source text without exposing raw vectors.
- Added explicit, bidirectional, non-transitive related-project search scopes;
  writes remain restricted to each project's primary space.
- Preserved Team Knowledge Mode: Git remains the portable Markdown transport,
  stable team `kbId` values map to local spaces, and vectors stay local.
- Added resumable one-click migration for all legacy KBs with backups,
  verification probes, per-project atomic cutover, retry, and rollback.
- Centralized Claude Code instructions in one user-relative file and added a
  safe bulk refresh for all managed `CLAUDE.md` blocks independent of Hooks.
- Enforced development-time read-only KB access; post-commit automation owns
  routine updates and re-indexes migrated projects after successful runs.
- Added configurable mirrored/offline embedding model locations through
  `KB_EMBEDDING_REMOTE_HOST` and `KB_EMBEDDING_LOCAL_PATH`.
- Expanded the regression suite to 41 test files.

## [2.4.7] - 2026-07-01

- Initial public Apache-2.0 release of the local-first `project-knowledge`
  core.
- Includes the CLI, local dashboard, Git scanner, project registry,
  knowledge-base workflow, AI profile support, prompt registry, templates,
  and regression tests.
- Keeps runtime data, local project knowledge bases, API keys, generated AI
  drafts, logs, and local maintenance notes outside the public repository.
