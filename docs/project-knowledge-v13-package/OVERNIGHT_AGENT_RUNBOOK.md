# OVERNIGHT_AGENT_RUNBOOK.md

## 0. Mission

Execute PROJECT_KNOWLEDGE_REFACTOR_PLAN-v13 mechanically across the Bridge, Project Knowledge and DevTask-Radar repositories. Do not redesign approved product behavior. Do not create a mega-commit. Stop on a failed gate.

## 1. Preflight — no source writes until complete

For every existing repo:
1. `git status --short --branch`
2. `git fetch --all --prune`
3. record `git rev-parse HEAD`, default branch, remote URL, `git worktree list --porcelain`.
4. compare remote HEAD with v13 audit baseline; if drifted, list changed files/symbols/workflows and determine which planned commits need rebasing. Do not silently reset.
5. detect user dirty files; mark as protected. Never reset/clean/stash without explicit ownership.
6. read package.json/lock/workflows and all repository instruction files.
7. verify Node versions required by each repo.

Package preflight:
- `npm whoami` must succeed before any release planning.
- verify control of `@sanqianx` scope; query intended package names. If permissions/name ownership are unclear, development may continue with local tarballs, but final release is BLOCKED.

Bridge repo preflight:
- If `SanQianX/ai-coding-event-bridge` does not exist and the agent has authenticated repository-create permission, create it PUBLIC with no generated code beyond requested scaffold. If creation cannot be proven safe, stop before BR01 and report the blocker; never fall back to copying into Project Knowledge.

## 1A. Working branches

Use dedicated remote branches (names may be adjusted only for existing branch policy):
- Project Knowledge: `refactor/project-knowledge-v13`
- Bridge: `feat/ai-coding-event-bridge`
- DevTask-Radar: `refactor/bridge-consumer`

Push every verified intermediate commit to these branches. Do not force-push. The final release runbook fast-forwards `main` only after rechecking that remote main has not advanced unexpectedly.

## 2. Baseline tests

Project Knowledge: npm ci; npm test -- --no-report; desktop test; pack dry-run. Record exit codes and classify existing failures SOURCE_BASELINE or ENVIRONMENT. DevTask: npm install/ci according to lock availability and `npm run smoke`. Bridge starts after BR01.

## 3. Commit loop

For each COMMIT_SEQUENCE ID:
1. Read `.agent-state/current.json`, this commit section, v13 P/R/TS IDs and actual current source symbols.
2. Verify every dependency commit exists on the expected remote branch.
3. Check clean/protected worktree.
4. Add/update targeted tests first where practical.
5. Implement only owned scope.
6. Run syntax → targeted unit → integration → fault/negative → UI visual if needed → relevant regression.
7. Run `git diff --check`, inspect status/stat/full diff. No secret/debug/TODO/temp paths.
8. If any required test fails: do not commit/push; fix within current scope. If unable, stop and write failure checkpoint.
9. Commit the exact COMMIT_SEQUENCE subject.
10. Push immediately.
11. If non-release CI exists, wait/query required checks. Red/queued-cancelled-required means STOP. Never start next commit on red remote CI.
12. Update local checkpoint with actual remote SHA and test evidence.

## 4. Cross-repo development dependency rule

Until BR10 publishes Bridge, Project Knowledge/DevTask may test Bridge through dependency injection and `npm pack` tarball from an explicit Bridge commit SHA. Do not persist file: paths or nonexistent npm versions in production package-lock. A consumer intermediate commit must still boot with its prior production dependency state or a guarded optional adapter.

## 5. Special stop conditions

Stop immediately if:
- a P0/P1 audit invariant cannot be implemented without changing approved product behavior;
- a third-party Claude/Codex/OpenCode config would be overwritten rather than merged;
- Bridge boundary cannot be appended durably/atomically;
- Codex event cannot be uniquely tied to session/repo and implementation is about to guess;
- migration/delete fault test loses source data;
- knowledge pointer advances after evidence/retrieval/promotion failure;
- UI visual gate fails;
- required remote CI fails;
- npm scope/package ownership is not verified before publish;
- release tag/version does not match workflow requirements.

## 6. Checkpoint

`.agent-state/current.json` is local/ignored. Store plan version, current sequence ID, repos + remote SHA, passed tests, pending tests, known issue, next files, Bridge package SHA/version. Git history/remote SHA is the remote checkpoint; do not commit a checkpoint after every step.

## 7. Final publication wave

After PK19 and DR01/Bridge CI are green:
1. Execute BR10 release gate; push the Bridge release commit, then publish Bridge core+ui through protected workflow_dispatch using the exact verified SHA/version. Do not create a Bridge tag. Verify clean npm install/provenance.
2. Execute PK20 exact dependency pin; full clean test.
3. Execute DR02/DR03; push and validate.
4. Execute PK21 release metadata-only commit.
5. Run RELEASE_RUNBOOK.md final clean gate.
6. Only then create/push final Project Knowledge `v<version>` tag.

No other `v*` test tags are permitted.
