# 00 — MiniMax Agent Operating Rules

These rules are mandatory. They exist to prevent the agent from making independent architectural decisions.

## A. Execution discipline

A-01. Read the entire package before editing any source file.

A-02. Execute tasks strictly in numeric order. Do not start T(n+1) until T(n) passes its checkpoint.

A-03. Before each task, inspect the current implementation files named by the task and the corresponding `v4.1.22` files.

A-04. Do not assume the package's line numbers are current. Resolve symbols by name and behavior.

A-05. If the repository has changed since this plan was prepared, preserve the intent/invariants of this plan and adapt only the minimum necessary file locations.

A-06. Do not perform unrelated cleanup, renaming, formatting sweeps, dependency upgrades, or UI redesign.

A-07. Do not delete historical user data to make tests pass.

A-08. Do not weaken, skip, comment out, or reduce test assertions to obtain a green result.

A-09. Do not push, publish, release, tag, or open a PR unless explicitly authorized outside this package.

A-10. Never use destructive Git commands (`reset --hard`, `clean -fd`, rewriting history) as part of implementation.

## B. Non-negotiable architecture invariants

I-01. Markdown knowledge files are authoritative source of truth.

I-02. LanceDB is derived/rebuildable. `IndexService` remains the only LanceDB writer.

I-03. There is one commit reconciliation path: post-commit trigger + startup recovery -> `CommitReconciler`.

I-04. Do not restore the old parallel/manual automation queue as a second analyzer pipeline.

I-05. Development Conversation automatic source is external Claude Code / Codex / OpenCode through `ai-coding-event-bridge`.

I-06. Project-Knowledge Workbench messages are internal and MUST NOT become Development Conversation events.

I-07. Knowledge Analyzer sessions are internal and MUST NOT become Development Conversation events.

I-08. Commit/Conversation automatic binding must first match canonical workspace/repository identity; never bind by mere time proximity or current UI selection.

I-09. A commit with no captured conversation must still be analyzable using Git evidence.

I-10. Existing immutable `CommitConversationSnapshot` history is not silently rewritten.

I-11. Import establishes a Git tracking baseline; it must not automatically re-analyze the entire historical repository.

I-12. External Git commit must never fail because Project-Knowledge is offline or broken. Hook/capture is fail-open to Git.

I-13. Do not reintroduce Project-Knowledge management of `CLAUDE.md`.

I-14. Do not create a second persistent knowledge database to restore old maintenance UI.

## C. Compatibility rules

C-01. v4.1.22 user data must migrate forward without requiring the user to delete/re-import projects.

C-02. Existing project `aiProfileId` is preserved when valid.

C-03. If an existing/new project does not have an explicit AI profile, use ONE shared effective-profile resolver:

`project.aiProfileId -> settings.ai.defaultProfileId -> first usable profile -> explicit actionable error`.

C-04. Never let Workbench use one AI-profile fallback rule while CommitReconciler uses another.

C-05. Missing legacy managed hook is not a successful migration. It must be repaired/installed and verified before marking migration complete.

C-06. A legacy third-party hook must not be overwritten automatically.

C-07. UI restoration must use current APIs/services when they already exist; do not copy obsolete server implementations blindly.

## D. Task checkpoint rule

At the end of every task:

1. Run the new/changed task-specific test file(s).
2. Run directly related existing test files.
3. Run `git diff --check`.
4. Inspect `git status --short`.
5. Inspect the diff for files outside task scope.
6. Verify every task acceptance condition.
7. Write a Task Report using `07_TASK_REPORT_TEMPLATE.md`.
8. If any required condition fails, stay on the same task and fix it. Do not continue.

## E. Stop-and-report conditions

Stop the current task instead of guessing if:

- required legacy behavior cannot be found in v4.1.22;
- a requested restoration would violate I-01 through I-14;
- current data schema makes safe migration impossible without a new explicit migration;
- third-party Git hooks would be overwritten;
- account credentials/tokens would need to be hardcoded;
- a test requires external secrets and no deterministic fake/test adapter exists.

When stopped, report: observed state, exact conflicting files/symbols, why the invariant would be violated, and the smallest safe decision needed.
