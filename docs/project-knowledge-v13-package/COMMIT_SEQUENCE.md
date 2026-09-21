# COMMIT_SEQUENCE.md

> Mechanical cross-repo commit DAG for PROJECT_KNOWLEDGE_REFACTOR_PLAN-v13. Every intermediate commit is pushed only after its local gate passes; after non-release CI exists, remote checks must also be green. No development tag.

## Dependency overview

```text
PK01(non-release CI)
BR01 -> BR02 -> BR03 -> {BR04,BR05,BR06} -> BR07 -> BR08 -> BR09
DR01
PK02 -> PK03
PK04 -> PK05 -> PK06
PK07
PK08 -> PK09
{PK03,PK06,PK07,PK08,PK09} -> PK10 -> PK12
{PK02,PK04,PK05} -> PK11 -> PK12
PK12 -> PK13 -> PK14/PK15/PK16 -> PK17 -> PK18 -> PK19
BR09 + PK19 + DR01 -> BR10(Bridge release commit) -> workflow_dispatch publish, NO TAG
BR10 + PK19 -> PK20
BR10 + DR01 -> DR02 -> DR03
PK20 + DR02 + DR03 -> PK21 -> final Project Knowledge tag
```

## PK01 — `ci: add non-release validation gates`

**Repo:** `project-knowledge-base`  
**Depends on:** none  
**Purpose:** Establish remote safety net before refactor.

**Owned files/modules**
- .github/workflows/ci.yml
- _site/_test baseline/characterization inventory
- .gitignore

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `npm ci`
- `npm test -- --no-report`
- `npm pack --dry-run --json`
- `npm test --prefix desktop`

**Expected result**
- No product behavior change; CI never publishes/tags/releases.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "ci: add non-release validation gates"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK01-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR01 — `chore: scaffold bridge core and ui workspaces`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** none  
**Purpose:** Create public neutral package boundary and CI.

**Owned files/modules**
- root workspace
- packages/core/package.json
- packages/ui/package.json
- .github/workflows/ci.yml

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `npm ci`
- `npm test`
- `npm pack --workspace packages/core --dry-run`
- `npm pack --workspace packages/ui --dry-run`

**Expected result**
- Node >=18 core; no host-specific code.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "chore: scaffold bridge core and ui workspaces"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR01-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR02 — `feat: add durable journal and atomic commit boundaries`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR01  
**Purpose:** Implement per-user stable runtime/shim, monotonic journal sequence, cross-process install/journal locks, append/fsync, consumer registry, minAck compaction and appendCommitBoundary.

**Owned files/modules**
- packages/core/src/core/journal*
- consumer-registry*
- compaction*
- tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `journal concurrency tests`
- `boundary interleaving race test`
- `crash/partial-tail tests`
- `multi-consumer cursor tests`

**Expected result**
- P0: event and boundary share one writer/lock; managed hooks target stable Bridge Home shim, not host node_modules.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add durable journal and atomic commit boundaries"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR02-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR03 — `feat: normalize repo session and turn identity`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR02  
**Purpose:** Define event schema, repo identity, turn lifecycle, no-fake evidence semantics.

**Owned files/modules**
- event-schema
- repo-context
- turn-identity
- normalizer

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `missing identity fixtures`
- `duplicate/reordered events`
- `open turn projection`
- `no synthetic prompt tests`

**Expected result**
- Null/partial identity is valid; unknown-session forbidden.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: normalize repo session and turn identity"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR03-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR04 — `feat: add claude code connector and installer`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR03  
**Purpose:** Migrate Claude native hooks to the stable Bridge Home shim while preserving third-party config and multi-consumer ownership.

**Owned files/modules**
- claude connector
- hooks templates
- installer/status/repair/uninstall

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `UserPromptSubmit fixture`
- `Stop last assistant fixture`
- `third-party hook merge/uninstall`
- `Windows paths`

**Expected result**
- Fail-open client, durable capture before notification.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add claude code connector and installer"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR04-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR05 — `feat: add deterministic codex capture`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR03  
**Purpose:** Replace global newest-session heuristic with per-session incremental parser/cursor.

**Owned files/modules**
- codex notify connector
- session parser
- atomic cursor state
- installer

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `two concurrent Codex sessions/projects`
- `partial JSONL line`
- `restart cursor`
- `ambiguous notify => gap`
- `preserve previous notify`

**Expected result**
- Never select by global mtime as binding truth.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add deterministic codex capture"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR05-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR06 — `feat: add opencode plugin capture`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR03  
**Purpose:** Extract OpenCode plugin without hardcoded DevTask endpoint.

**Owned files/modules**
- opencode plugin
- normalizer mapping
- installer

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `user/assistant fixtures`
- `tool optional events`
- `offline durable append`
- `uninstall preserves third-party`

**Expected result**
- No 127.0.0.1:8787 dependency.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add opencode plugin capture"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR06-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR07 — `feat: add headless conversation query`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR02, BR03, BR04, BR05, BR06  
**Purpose:** Expose project/date turns, pagination and host annotations contract.

**Owned files/modules**
- query providers
- cursor pagination
- public API

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `multi-project/date queries`
- `cursor pagination`
- `large history window`
- `privacy projections`

**Expected result**
- No host DB dependency.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add headless conversation query"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR07-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR08 — `feat: add mature conversation explorer ui`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR07  
**Purpose:** Reusable product-facing UI with only project+date controls.

**Owned files/modules**
- packages/ui ConversationExplorer/TurnCard/VirtualTurnList/CSS

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `DOM contract`
- `long prompt/reply`
- `empty state`
- `light/dark`
- `390x844 and desktop visual fixture`

**Expected result**
- No source/session/search/timeline/commit-mode controls.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add mature conversation explorer ui"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR08-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR09 — `ci: add publish readiness workflow`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR08  
**Purpose:** Prepare release workflow without tagging.

**Owned files/modules**
- publish workflow
- package files/license/readme/provenance tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `npm pack contents`
- `Node 18/24`
- `Windows hook tests`
- `npm publish --dry-run equivalent`

**Expected result**
- Workflow may publish only on final v* tag after release gate.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "ci: add publish readiness workflow"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR09-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## DR01 — `test: characterize current connector and conversation behavior`

**Repo:** `DevTask-Radar`  
**Depends on:** none  
**Purpose:** Freeze DevTask behavior before extraction.

**Owned files/modules**
- worker smoke/integration tests
- connector install fixtures
- conversation/task projection tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `npm run smoke`
- `connector fixtures`

**Expected result**
- No connector deletion yet.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "test: characterize current connector and conversation behavior"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <DR01-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK02 — `refactor: finalize logging storage contract`

**Repo:** `project-knowledge-base`  
**Depends on:** PK01  
**Purpose:** Shared logger core, system/projects daily single files, reverse reader, permanent retention, remove runtime logging settings/cleanup while keeping legacy read.

**Owned files/modules**
- structured-logger
- storage-layout
- settings/migration logging adapters
- logging tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `structured logger tests`
- `reverse chunk/cursor merge`
- `legacy log read`
- `ENOSPC/redaction`

**Expected result**
- No .001 writer, no auto cleanup.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: finalize logging storage contract"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK02-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK03 — `fix: preserve background task registry and operation context`

**Repo:** `project-knowledge-base`  
**Depends on:** PK01, PK02  
**Purpose:** Multi-operation activeTasks and one root operationId.

**Owned files/modules**
- server task registry helper
- reconciler operation-context signature
- shutdown tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `fast-fail overlap`
- `busy guard`
- `shutdown drain`
- `operation chain test`

**Expected result**
- Do not change business behavior otherwise.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "fix: preserve background task registry and operation context"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK03-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK04 — `feat: add conversation storage contracts`

**Repo:** `project-knowledge-base`  
**Depends on:** PK01  
**Purpose:** Add Project Knowledge ConversationStore/boundary/snapshot schema paths and legacy adapter interfaces.

**Owned files/modules**
- contracts
- storage-layout conversation paths
- conversation-store
- project-store adapters

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `atomic append`
- `dedupe`
- `privacy`
- `legacy requirements fixtures`

**Expected result**
- No server/UI wiring yet.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add conversation storage contracts"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK04-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK05 — `feat: persist atomic bridge commit boundaries`

**Repo:** `project-knowledge-base`  
**Depends on:** PK04, BR02, BR03  
**Purpose:** Integrate Git Hook with Bridge appendCommitBoundary; notification remains best-effort.

**Owned files/modules**
- hook-manager
- hook-trigger
- Bridge adapter
- lifecycle baseline cursor
- hook tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `real git boundary race`
- `server offline`
- `Bridge unavailable gap`
- `latency bound`
- `Windows hooksPath`

**Expected result**
- Intermediate may use injected/local packed Bridge; package lock unchanged.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: persist atomic bridge commit boundaries"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK05-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK06 — `feat: bind frozen conversations to commits`

**Repo:** `project-knowledge-base`  
**Depends on:** PK04, PK05, BR03  
**Purpose:** Replace ancestry binder with sequence-window CommitConversationBinder and two-freeze semantics.

**Owned files/modules**
- commit-conversation-binder
- claim schema/store
- legacy requirement adapter

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `R1-C1-R2 race`
- `late assistant pre/post claim`
- `shared spanning`
- `merge previous-boundary`
- `gap/unavailable`
- `retry hash`

**Expected result**
- No future prompt absorption.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: bind frozen conversations to commits"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK06-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK07 — `feat: preserve exact large diff evidence`

**Repo:** `project-knowledge-base`  
**Depends on:** PK01  
**Purpose:** Replace patch-null success with exact chunk evidence bundle.

**Owned files/modules**
- scanner/evidence bundle
- tool policy
- claim hashes
- tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `>2MiB`
- `chunk coverage/hash/order`
- `binary/rename/root/merge`
- `corrupt chunk fails/no pointer`

**Expected result**
- No source-tree Bash fallback.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: preserve exact large diff evidence"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK07-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK08 — `refactor: unify knowledge retrieval service`

**Repo:** `project-knowledge-base`  
**Depends on:** PK01  
**Purpose:** Create KnowledgeRetrievalService for Search/Ask and Commit clean-index recall/rerank.

**Owned files/modules**
- knowledge-retrieval-service
- knowledge-db metadata lookup helpers
- runtime adapters

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `100-200 doc fixture`
- `path/symbol/tag/route recall`
- `related scopes`
- `deterministic rerank`

**Expected result**
- Retire filename-first selection contract.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: unify knowledge retrieval service"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK08-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK09 — `feat: add index source manifest and markdown delta overlay`

**Repo:** `project-knowledge-base`  
**Depends on:** PK08  
**Purpose:** Guarantee fresh knowledge while index dirty/missing without blocking Commit.

**Owned files/modules**
- index-service source manifest
- delta overlay
- fallback retriever
- retrieval manifest

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `C1 promotion then immediate C2`
- `new/changed/deleted`
- `stale content exclusion`
- `hash verify`
- `missing index`

**Expected result**
- Markdown remains truth.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: add index source manifest and markdown delta overlay"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK09-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK10 — `feat: integrate reconciler analyzer and promotion evidence`

**Repo:** `project-knowledge-base`  
**Depends on:** PK03, PK06, PK07, PK08, PK09  
**Purpose:** Wire frozen conversation, exact patch, retrieval manifest into unique prompt/promotion.

**Owned files/modules**
- commit-reconciler
- commit-prompt
- knowledge-promotion
- analyzer runner

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `Hook/startup prompt hash equality`
- `failure stop`
- `promotion rollback`
- `claim retry`
- `full operation chain`

**Expected result**
- Only T09-style promotion may advance state.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: integrate reconciler analyzer and promotion evidence"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK10-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK11 — `refactor: harden lifecycle migration and delete recovery`

**Repo:** `project-knowledge-base`  
**Depends on:** PK02, PK04, PK05  
**Purpose:** Fix logging migration semantics, add delete transaction journal/tombstone, migration compatibility.

**Owned files/modules**
- migration-service
- project-lifecycle-service
- delete recovery
- fixtures

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `every-stage migration fault`
- `delete every-stage fault`
- `legacy logs/config`
- `root/path conflict`

**Expected result**
- No silent old-data deletion.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: harden lifecycle migration and delete recovery"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK11-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK12 — `refactor: finalize server security logs and task APIs`

**Repo:** `project-knowledge-base`  
**Depends on:** PK02, PK03, PK10, PK11  
**Purpose:** Wire services in server, remove logging settings routes/cleanup, keep security regressions, request correlation/SSE no-gap.

**Owned files/modules**
- server-app
- logging routes/SSE
- settings API
- security tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `origin/auth/profile secret regression`
- `GET->SSE no-gap`
- `500/5000 limits`
- `request started/completed/failed`

**Expected result**
- No manual analysis/hook routes.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: finalize server security logs and task APIs"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK12-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK13 — `feat: expose read-only development conversation api`

**Repo:** `project-knowledge-base`  
**Depends on:** PK04, PK06, PK12  
**Purpose:** Serve single-project + date conversation projection and commit annotation from frozen snapshots.

**Owned files/modules**
- conversation API/service
- host adapter

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `project/date only`
- `pagination`
- `plain-text safe rendering payload`
- `annotation source`
- `no log leakage`

**Expected result**
- API may retain internal IDs but default UI does not expose them.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "feat: expose read-only development conversation api"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK13-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK14 — `ui: restore control center shell`

**Repo:** `project-knowledge-base`  
**Depends on:** PK12  
**Purpose:** Restore v4.1.22 shell structure against current APIs.

**Owned files/modules**
- ui/index.html shell/workbench/import/settings base
- UI tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `DOM shell contract`
- `workbench/import/settings`
- `desktop/mobile light/dark visual`

**Expected result**
- No backend rollback, no debug-tech copy.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "ui: restore control center shell"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK14-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK15 — `ui: integrate shared development conversation explorer`

**Repo:** `project-knowledge-base`  
**Depends on:** PK13, PK14, BR08  
**Purpose:** Settings peer page using bridge-ui host adapter.

**Owned files/modules**
- UI vendor/serve adapter
- Settings conversation page
- UI tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `only project+date controls`
- `no main-nav/client duplicate`
- `long messages`
- `empty/no-project`
- `commit labels`

**Expected result**
- Use local packed BR08 during development; lockfile not final yet.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "ui: integrate shared development conversation explorer"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK15-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK16 — `ui: finalize mature run records`

**Repo:** `project-knowledge-base`  
**Depends on:** PK02, PK12, PK14  
**Purpose:** Implement final logs UX/full-height/no severity glyphs/event follow.

**Owned files/modules**
- Settings logs UI
- logging UI tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `200+ rows`
- `warn/error entire text`
- `time bounding boxes`
- `single scroll`
- `live follow/no gap`
- `mobile`

**Expected result**
- Match v10 structural reference and approved deltas.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "ui: finalize mature run records"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK16-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK17 — `refactor: unify cli mcp runtime and remove legacy paths`

**Repo:** `project-knowledge-base`  
**Depends on:** PK10, PK11, PK12  
**Purpose:** Route Search/Ask through RetrievalService, remove dead manual/init/simulate APIs/symbols/tests, update integrations.

**Owned files/modules**
- CLI/MCP/runtime/integration installer
- legacy deletion tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `path consistency`
- `search/ask compatibility`
- `symbol/route absence`
- `integration failures logged`

**Expected result**
- Requirement MCP remains explicit compatibility adapter only.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: unify cli mcp runtime and remove legacy paths"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK17-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK18 — `refactor: complete observability and session durability`

**Repo:** `project-knowledge-base`  
**Depends on:** PK02, PK10, PK17  
**Purpose:** Fill module stage logs, AtomicFile workbench session persistence, remove critical silent catches.

**Owned files/modules**
- claude-cli-runner
- integration manager
- module instrumentation
- coverage tests

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `operation-chain fixtures`
- `session write failure`
- `AI retry/abort`
- `integration command failure`

**Expected result**
- Live Claude session remains fail-open on persistence fault.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: complete observability and session durability"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK18-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK19 — `test: complete pre-release e2e and ui acceptance`

**Repo:** `project-knowledge-base`  
**Depends on:** PK15, PK16, PK17, PK18  
**Purpose:** Make TS-01..TS-52 and visual/fault/Windows suites green before any dependency-release tag.

**Owned files/modules**
- test suite/run-all cleanup
- visual harness
- fixtures/docs

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `npm test`
- `desktop`
- `pack`
- `all TS`
- `visual matrix`
- `migration/fault suite`

**Expected result**
- No version bump/tag in this commit.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "test: complete pre-release e2e and ui acceptance"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK19-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## BR10 — `release: prepare bridge package publication`

**Repo:** `ai-coding-event-bridge`  
**Depends on:** BR09, PK19, DR01  
**Purpose:** Bridge publication metadata only; choose/validate semver and source SHA. Push this commit, then publish core+ui by protected workflow_dispatch. Do NOT create a Bridge tag.

**Owned files/modules**
- package versions/changelog only

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `clean npm ci/test/pack`
- `npm identity/scope preflight`
- `remote CI green`

**Expected result**
- Push, verify remote CI, then invoke protected Bridge publish workflow_dispatch for this exact SHA/version. NO TAG / NO GitHub Release. Verify npm registry before consumer pin.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "release: prepare bridge package publication"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <BR10-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK20 — `build: pin released bridge packages`

**Repo:** `project-knowledge-base`  
**Depends on:** BR10, PK19  
**Purpose:** Replace development injection/local pack assumptions with exact released npm dependencies and lockfile.

**Owned files/modules**
- package.json
- package-lock.json
- adapter fallback cleanup

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `fresh npm ci`
- `full npm test`
- `desktop`
- `pack`
- `clean temp install`

**Expected result**
- Must use npm-view verified version.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "build: pin released bridge packages"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK20-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## DR02 — `refactor: consume released bridge core`

**Repo:** `DevTask-Radar`  
**Depends on:** BR10, DR01  
**Purpose:** Move hook ownership/normalization/journal to public Bridge and delete duplicated managed connector source after compatibility tests.

**Owned files/modules**
- package/lock
- integration services
- worker ingest adapters
- legacy connector removal

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `smoke`
- `Claude/Codex/OpenCode install/uninstall`
- `dual consumer cursor`
- `task analysis regression`

**Expected result**
- Task DB/calendar/analysis remains DevTask-owned.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "refactor: consume released bridge core"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <DR02-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## DR03 — `ui: consume shared conversation explorer`

**Repo:** `DevTask-Radar`  
**Depends on:** DR02, BR10  
**Purpose:** Use shared mature conversation renderer where product-facing; retain separate advanced Activity Feed if needed.

**Owned files/modules**
- web conversation UI/provider

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `project/date explorer`
- `existing admin feed regression`
- `light/dark/long text`

**Expected result**
- No Project Knowledge commit semantics in DevTask unless host supplies annotations.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "ui: consume shared conversation explorer"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <DR03-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.

## PK21 — `release: prepare project knowledge final version`

**Repo:** `project-knowledge-base`  
**Depends on:** PK20, DR02, DR03  
**Purpose:** Version/release metadata only after final clean validation.

**Owned files/modules**
- root+desktop versions/changelog/release metadata

**Preconditions**
- Working tree is clean except known user-owned files explicitly recorded in checkpoint.
- `git fetch` and verify local base SHA equals expected remote branch head; if drifted, stop and run drift audit.
- Read only this commit section + referenced v13 contracts + actual current symbols; do not redesign adjacent features.

**Mechanical steps**
1. Open the owned modules and their nearest existing tests; record current behavior/exports.
2. Add/update the smallest tests that prove this commit goal and the negative/fault cases.
3. Implement only the owned change; do not touch unrelated high-conflict files.
4. Add required structured logs without logging Prompt/Diff/assistant bodies/secrets.
5. Run syntax/lint checks on every changed executable JS file.
6. Run the targeted gate below. Fix failures in this commit before continuing.
7. Run relevant regression subset, `git diff --check`, inspect `git diff --stat` and full diff for owned files.
8. Confirm no debug code/TODO/temporary local package path/secrets were introduced.

**Exact targeted gate**
- `clean checkout npm ci/full test/desktop/pack/Windows CI/security/audit`

**Expected result**
- Push; verify remote HEAD/checks; then and only then final Project Knowledge v<version> tag.
- All targeted tests exit 0; no known new failing regression.

**Before commit gate**
- `git status --short` contains only intended files.
- `git diff --check` exit 0.
- For UI changes: UI_VISUAL_ACCEPTANCE.md gate is mandatory.
- For package/lock changes: clean `npm ci` and `npm pack --dry-run --json` must succeed.

**Commit / push**
- Commit exact intent: `git commit -m "release: prepare project knowledge final version"`.
- `git push <remote> <working-branch>`.
- If the repo has non-release CI at this point, wait/check all required checks. Any remote failure blocks the next commit.
- Update local `.agent-state/current.json` after the push; do not commit the checkpoint file.

**Rollback**
- Prefer `git revert <PK21-sha>` only if already pushed and the commit is self-contained; otherwise restore only this commit's owned changes before commit.
- Never reset/force-push over user work. Package-release commits are not rolled back by deleting tags; follow RELEASE_RUNBOOK.md.
