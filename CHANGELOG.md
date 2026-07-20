# Changelog

## [4.1.10] - 2026-07-21

- Made startup-recovery's staging copy (`prepareKnowledgeWorkspace`) and
  Claude-executable lookup (`findClaudeExecutableForSdk`) asynchronous
  so the server's HTTP handlers (notably `/api/state`) stay responsive
  while pending-commit workers are being dispatched. Previously the
  desktop client would time out with `backend request timed out` when
  several projects had pending commits on startup, because the sync
  `fs.cpSync` and `spawnSync` calls were freezing the event loop for
  several seconds during `/api/state` polling.

## [4.1.9] - 2026-07-21

- Refused to import or upsert a project whose `kbPath` resolves to the
  same directory as `gitPath` / `localPath`. Writing the knowledge base
  inside the source tree pollutes the repo (and trips Windows symlink
  errors in the staging workspace), so both entry points now return 400.

## [4.1.8] - 2026-07-21

- Stopped the post-commit automation worker from being auto-paused when a
  user aborts the Claude session in the terminal. Pending commits queued
  before the abort are now picked up again on the next desktop launch.

## [4.1.7] - 2026-07-19

- Restored GitHub and Gitea login in the Windows desktop client through an
  acknowledged Electron bridge that opens OAuth pages in the system browser.
  Browser launch failures are now reported immediately instead of appearing
  later as an authorization timeout.
- Added support for HTTP authorization URLs used by private, intranet Gitea
  installations while continuing to reject local-file and script URLs at the
  desktop security boundary.
- Forwarded Electron's Windows system-proxy resolution to the backend and made
  GitHub OAuth plus remote repository discovery proxy-aware, while preserving
  loopback and `NO_PROXY` bypasses for private Gitea installations.
- Verified the full team-knowledge path after desktop migration: GitHub device
  authorization, Gitea callback/token persistence, remote repository scanning,
  manifest discovery, cached store loading, and team knowledge-base binding.
- Added desktop bridge/security regressions and an end-to-end Gitea OAuth plus
  remote team-store discovery test.

## [4.1.6] - 2026-07-19

- Replaced overlapping post-commit batches with a single per-project worker
  that treats Git history as the durable queue. Live hooks and desktop startup
  recovery now use the same path and process exactly one commit at a time,
  strictly from oldest to newest.
- Preserved the original knowledge contract: every analyzed commit must create
  an independent `changes/` Markdown record containing its full hash, including
  test-only, documentation, and infrastructure commits.
- Added transactional knowledge workspaces. Claude edits a temporary KB copy;
  validated Markdown is applied to the live KB only after the session succeeds,
  and LanceDB must finish before `lastAnalyzedCommit` advances.
- Added resumable vector finalization and automatic startup recovery. Index
  failures retry without rerunning Claude or duplicating Markdown, while an
  interrupted desktop session resumes from the oldest unfinished commit.
- Made Stop pause the project's automatic commit worker, discard uncommitted
  staged knowledge, and prevent queued work from immediately restarting. The
  Claude Code UI now provides a dedicated Resume automatic analysis action.
- Added end-to-end regressions for duplicate Hook delivery, strict commit order,
  per-commit changes records, staged Markdown, abort behavior, and vector-index
  recovery. The complete core suite now contains 53 passing test files.

## [4.1.5] - 2026-07-19

- Added a desktop-client card in Settings that always shows the installed
  application version and provides Check for updates / Restart and install
  actions without opening a browser.
- Integrated Electron's Squirrel updater with a stable GitHub Latest Release
  feed. Release automation now uploads `RELEASES` and the full `.nupkg` beside
  the installer so future desktop versions download and install in-app.
- Hardened the PowerShell folder-picker fallback: scripts are unpacked from the
  desktop ASAR, stdout uses UTF-8, and only an existing absolute directory can
  be returned. PowerShell banners and error text can never populate a path
  field.
- Added updater lifecycle and folder-output regressions, bringing the complete
  core suite to 52 passing test files while retaining the native Electron
  folder dialog introduced in 4.1.4.

## [4.1.4] - 2026-07-19

- Fixed Windows Claude Code discovery so extensionless npm shell shims and
  command wrappers are never passed to the Agent SDK. The resolver now prefers
  the installed package's native `bin/claude.exe` and retains `cli.js` only as
  a legacy fallback.
- Changed the post-commit Hook endpoint to acknowledge valid events with HTTP
  202 before commit inspection and Claude startup. Dispatch continues in the
  background, while the Hook accepts every successful 2xx response instead of
  recording a false timeout/error after a run was already created.
- Restored both desktop directory-selection flows with a narrow Electron IPC
  bridge and native directory dialog. Project import and Team Knowledge folder
  selection no longer execute a PowerShell script from inside the packaged
  ASAR or mistake PowerShell banner text for a selected path.

## [4.1.3] - 2026-07-19

- Removed the bundled 218 MiB Claude Code executable from the Windows desktop
  application. The small Agent SDK control layer now discovers the user's
  installed Claude Code through `CLAUDE_CODE_EXECPATH`, `PATH`, or the npm
  global installation and reports a clear error without disabling knowledge
  management when Claude Code is unavailable.
- Removed LanceDB's unused optional embedding-provider stack and its duplicate
  Transformers.js 3.0.2 / ONNX Runtime 1.19.2 dependency tree while retaining
  the application's supported Transformers.js 3.8.1 embedding service.
- Pruned non-Windows and non-x64 ONNX binaries, browser-only ONNX Web runtimes,
  Transformers browser builds, source maps, and unused platform packages from
  the Windows x64 bundle.
- Added packaged runtime probes for LanceDB, Transformers.js, ONNX Runtime, and
  the real 512-dimensional `bge-small-zh-v1.5` embedding model, plus release
  size auditing that rejects bundled Claude binaries, duplicate runtimes, and
  oversized artifacts.
- Reduced the measured Windows installer from 476.0 MiB to 221.1 MiB and the
  installed application bundle from 1,491.1 MiB to 617.5 MiB without changing
  existing model caches, Markdown sources, LanceDB data, or storage paths.

## [4.1.2] - 2026-07-16

- Made the desktop dependency lock reproducible under the newer npm version on
  GitHub's Windows runner by explicitly locking the encoding compatibility
  dependency used by the packaging tree.
- Made the desktop release workflow fail immediately when a native npm command
  fails instead of allowing PowerShell to continue into a misleading later
  step.

## [4.1.1] - 2026-07-16

- Fixed Windows GitHub Actions browser discovery for the `windows-2025`
  runner by detecting system-level Chrome and Microsoft Edge installations.
- Restored the release gate for all three real-browser UI suites so the
  Windows desktop installer can be built, smoke-tested, and uploaded only
  after the complete 50-file core regression suite passes.

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
