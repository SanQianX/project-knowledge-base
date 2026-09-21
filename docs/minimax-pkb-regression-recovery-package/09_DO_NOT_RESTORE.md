# 09 — Explicit DO NOT RESTORE List

The agent must not interpret "restore v4.1.22 features" as "restore every deleted v4.1.22 file".

## 1. Do not restore Project-Knowledge CLAUDE.md management

Do not resurrect:
- `claude-md-manager.js` behavior;
- bulk CLAUDE.md refresh;
- automatic insertion/removal of shared rules in project CLAUDE.md.

Current product architecture intentionally does not own user/project CLAUDE.md.

## 2. Do not restore the old automation queue as a second analyzer pipeline

Do not resurrect old `automation-queue.js` / `commit-automation-store.js` semantics that create a parallel path around `CommitReconciler`.

Required path remains:

post-commit OR startup recovery -> CommitReconciler -> frozen evidence -> analyzer -> promotion -> Markdown -> IndexService.

## 3. Do not restore multiple index writers

Do not allow UI, maintenance, migration, or analyzer code to write LanceDB directly. Use IndexService.

## 4. Do not restore internal Workbench conversation capture

Workbench/Analyzer activity is not Development Conversation. Keep the bridge/exclusion architecture.

## 5. Do not roll back StorageLayout/project-store v2 simply to reuse old APIs

Implement compatibility/migration adapters instead.

## 6. Do not silently rewrite old immutable commit conversation snapshots

If future product needs re-binding/reanalysis, it must be an explicit maintenance operation with audit trail.

## 7. Do not copy old maintenance modules if they assume obsolete database ownership

Restore user capability using current Markdown-authoritative/derived-index model.

## 8. Do not reintroduce manual full-history analysis on project import

Import establishes a baseline. Historical analysis is a separate explicit future feature, not an import side effect.
