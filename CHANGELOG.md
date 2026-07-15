# Changelog

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
