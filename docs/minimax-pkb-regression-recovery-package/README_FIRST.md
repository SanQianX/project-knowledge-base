# Project Knowledge v4.1.22 Feature Regression Recovery — MiniMax Agent Package

## Purpose

This package is a low-freedom, mechanical execution plan for restoring user-visible capabilities that existed in `v4.1.22` but were lost or disconnected during the refactor to current `main` (`4.2.4` at plan creation time), while preserving the newer architecture.

Repository: `SanQianX/project-knowledge-base`

Product baseline: tag `v4.1.22`, commit `ba505bb2ae031e8d06ec3032657482f40d57ecf8`

Implementation base: current `main` (package version `4.2.4` when this plan was prepared)

Comparison status when prepared: current `main` was 44 commits ahead of `v4.1.22`.

## Mandatory execution order

Do not choose your own order. Execute exactly:

`T00 -> T01 -> T02 -> ... -> T24 -> G00 -> G08`

Every task has a checkpoint. A task is not complete until its task-specific tests pass and its acceptance checklist is satisfied.

## Product goal

Restore the mature product capabilities of v4.1.22 on top of the new architecture. Do NOT roll the repository back to v4.1.22.

The final system must have all of these properties:

1. Existing projects imported before the refactor continue to work.
2. New project import works from UI and desktop folder picker.
3. A Git commit in a managed project reliably triggers knowledge reconciliation.
4. Restart recovery detects commits missed while the backend was offline.
5. UI Chinese/English switching is restored.
6. Knowledge output language selection is restored.
7. GitHub/Gitea account status and team knowledge workflows are restored where supported by current backend architecture.
8. Prompt settings are restored and feed the ONE canonical commit-analysis prompt path.
9. Project Goal editing is restored.
10. Claude Workbench permission UI/modes are restored.
11. Integration Setup is visible and can install knowledge integration + external development capture.
12. Advanced AI/embedding/storage/maintenance/desktop-update capabilities are restored only when they can be implemented without reintroducing obsolete architecture.
13. External Development Conversation architecture remains intact.
14. Internal Project-Knowledge Workbench/Analyzer conversations remain excluded from Development Conversation.
15. Markdown remains authoritative; LanceDB remains derived/rebuildable; IndexService remains the only index writer.

## Files in this package

- `00_AGENT_OPERATING_RULES.md` — rules MiniMax must never violate.
- `01_BASELINE_AND_FEATURE_MATRIX.md` — exact feature preservation decisions.
- `02_P0_CORE_PIPELINE.md` — T00–T09, core regression recovery.
- `03_PRODUCT_FEATURE_RESTORE_PIPELINE.md` — T10–T19, product feature restoration.
- `04_ADVANCED_FEATURE_RESTORE_PIPELINE.md` — T20–T24, advanced capabilities.
- `05_TEST_GATES.md` — final release gates G00–G08.
- `06_MINIMAX_START_PROMPT.md` — paste this into the MiniMax agent as the opening instruction.
- `07_TASK_REPORT_TEMPLATE.md` — required report format after every task.
- `08_KNOWN_ROOT_CAUSES.md` — currently known failure hypotheses/evidence.
- `09_DO_NOT_RESTORE.md` — obsolete v4.1.22 architecture that must stay removed.
- `FULL_PLAN.md` — merged single-file version for agents that work better with one document.

## Golden rule

If the old v4.1.22 feature conflicts with the current architectural invariants, preserve the user capability but re-implement it against the current architecture. Never resurrect an obsolete subsystem only because it existed in v4.1.22.
