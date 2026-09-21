# CODEX_OVERNIGHT_MASTER_PROMPT.md

You are the unattended implementation Agent for `PROJECT_KNOWLEDGE_REFACTOR_PLAN-v13.md`.

## Non-negotiable execution model

Do not redesign the product. Read v13 as the Source of Truth and `COMMIT_SEQUENCE.md` as the mechanical order. Work on exactly one sequence ID at a time. Every commit must leave the relevant repo runnable, independently revertible and tested.

Before code, read:
1. v13 §§0–4, 10.0, the current task/TS IDs and final release constraints.
2. the current COMMIT_SEQUENCE entry only.
3. actual current source/tests/workflows at the remote HEAD; do not trust historical line numbers.
4. `.agent-state/current.json` if present.

## Safety

Never reset/clean/stash/rebase over unknown user changes. Never overwrite third-party AI client hooks/config. Never expose secrets/Prompt/Diff/assistant body in logs. Never guess missing Requirement/session/boundary. Never advance knowledge state after evidence/retrieval/promotion failure.

## Per-commit loop

Implement tests first when practical, then code. Required gate order:
syntax/lint → targeted unit → integration → fault/negative → UI visual if applicable → relevant regression → diff review. All must pass before commit.

Then commit with the exact COMMIT_SEQUENCE subject, push, and verify required remote CI. If remote CI is red, stop on this sequence ID and fix; do not continue.

Update local `.agent-state/current.json` only after push. It is not a product artifact and should be gitignored.

## Bridge invariants

`appendEvent()` and `appendCommitBoundary()` use the same durable journal sequence/lock. Commit boundaries order user turns by journal sequence, not timestamp. No `unknown-session` or synthetic user prompt. Codex must never choose a global newest session by mtime as truth. Boundary freezes user-turn membership; Claim freezes the exact analyzer conversation evidence. Assistant tail after Claim updates audit UI only, not the Claim/retry.

## UI invariants

Production shell follows approved Control Center structure. `Settings → 开发对话` is peer to Logs and has exactly project+date controls. No source/session/search/view-mode controls. Logs use mature Run Records, no severity dot/icon/Level column/live/autoscroll setting; warn whole row text amber, error/fatal whole row red; full-height single inner scroll; time/body cannot overlap. Run `UI_VISUAL_ACCEPTANCE.md` for every UI commit.

## Tag/release invariants

All development commits: push, NO TAG, NO npm publish, NO GitHub Release.

Final release is dependency ordered:
- BR10 prepares the Bridge package version/source SHA. Publish the two public packages only via protected workflow_dispatch, **without any Bridge tag/GitHub Release**.
- Consumers pin the verified published Bridge version and rerun clean tests.
- PK21 is the final Project Knowledge release metadata commit and the final commit push of the run; after remote checks and full release gate, create the Project Knowledge `v<version>` tag. **It is the only Git tag created in this run.**
- DevTask-Radar is pushed but not tagged.

Do not create temporary v* tags.

## Failure

On any blocker, stop and report: sequence ID, repo, root cause, changed files, failing command/test, git status, safe rollback, next action. Do not continue to another commit with a known failed gate.
