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
# MiniMax 流水线开发包使用说明

推荐使用方式：

1. 把整个 ZIP 解压到 MiniMax 能读取的位置。
2. 第一条消息直接喂 `06_MINIMAX_START_PROMPT.zh-CN.md`。
3. 同时要求它完整读取本目录所有文件。
4. 不要让它先“重新设计一个更好的方案”，直接要求按 T00 开始施工。
5. 每完成一个 Task，必须按 `07_TASK_REPORT_TEMPLATE.md` 汇报并等待该 Task 自检通过后继续。

如果 MiniMax 上下文不方便读取多个文件，则直接提供 `FULL_PLAN.md`，再补充 `06_MINIMAX_START_PROMPT.zh-CN.md`。

本包核心原则：恢复 v4.1.22 的成熟产品能力，但保留当前 4.2.x 的 CommitReconciler、Promotion、IndexService、StorageLayout v2、Bridge、Development Conversation 外部捕捉等新架构。
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
# 01 — Baseline and Feature Preservation Matrix

## Baseline facts

- `v4.1.22` commit: `ba505bb2ae031e8d06ec3032657482f40d57ecf8`.
- At package creation, `main` package version: `4.2.4`.
- `v4.1.22 -> main`: 44 commits ahead.
- The refactor removed/replaced many modules and rewrote the UI. The correct goal is feature preservation on new architecture, not source restoration.

## Classification

- **RESTORE** — user capability must return.
- **RESTORE/ADAPT** — restore UX/behavior using current architecture.
- **KEEP CURRENT** — newer architecture intentionally replaces old behavior.
- **DO NOT RESTORE** — old subsystem must stay removed.

| Capability | v4.1.22 baseline | Current regression | Decision | Priority |
|---|---|---|---|---|
| Project import | folder picker, preflight, Git init, AI profile selection/fallback, knowledge language, team binding | UI reduced to path; prerequisites/fallback disconnected | RESTORE/ADAPT | P0 |
| Existing imported projects | commit auto-update worked | existing projects no longer reliably update | RESTORE | P0 |
| Post-commit hook | managed hook executed Node trigger | v2 migration/runtime path may be invalid in Desktop | RESTORE/FIX | P0 |
| Startup missed-commit recovery | discovers pending commits | must remain functional and observable | KEEP/FIX | P0 |
| Effective AI profile | default/usable fallback | CommitReconciler can reject null project profile | RESTORE shared resolver | P0 |
| Hook status/repair | visible/manageable | user diagnostics lost | RESTORE/ADAPT | P1 |
| UI language zh/en | complete I18N | hard-coded Chinese | RESTORE | P1 |
| Knowledge output language | zh-CN/en-US | backend capability remains, UI lost | RESTORE | P1 |
| GitHub auth/status | OAuth/PAT/status | removed from current UI/API composition | RESTORE/ADAPT | P1 |
| Gitea auth/status | custom Gitea/OAuth | removed | RESTORE/ADAPT | P1 |
| Team Knowledge | discover/checkout/bind | partial backend artifacts remain, product flow broken | RESTORE/ADAPT | P1 |
| Prompt settings | system/user/allowedTools + hook prompt preview | schema contains promptOverrides but UI/API flow lost | RESTORE/ADAPT | P1 |
| Project Goal | GOAL.md editor/API | entry/API lost | RESTORE | P1 |
| Claude permission decisions | Allow/Deny | backend route exists, UI lost | RESTORE | P0/P1 |
| Permission mode | default/acceptEdits/auto/bypass/plan | UI lost | RESTORE | P1 |
| Integration Setup | knowledge integration + capture | backend exists; visible setup incomplete | RESTORE UI | P1 |
| AI profile test/advanced settings | provider/model/context/test | reduced UI | RESTORE/ADAPT | P2 |
| Embedding configuration | remote host/local path/offline/download/status | UI/services reduced | RESTORE/ADAPT | P2 |
| Knowledge Store Git options | remote/branch/autoCommit/autoPush | UI lost | RESTORE if compatible | P2 |
| Markdown maintenance | audit/optimize/backup | old subsystem removed | RESTORE UX on new storage | P2 |
| Vector/DB maintenance | rebuild/migration/rollback | old implementation obsolete | REDESIGN using IndexService | P2 |
| Token usage/session restore/slash commands | present in old Workbench | lost/reduced | RESTORE if current Claude runner supports it | P2 |
| Desktop update controls | check/download/install | UI lost | RESTORE | P2 |
| Development Conversation | old internal capture semantics | replaced with external bridge architecture | KEEP CURRENT | protected |
| CommitConversationSnapshot | newer immutable evidence model | did not exist as current design in old baseline | KEEP CURRENT | protected |
| Markdown authoritative + derived LanceDB | newer architecture | replaces older DB ownership | KEEP CURRENT | protected |
| CLAUDE.md manager | old app-managed behavior | intentionally removed | DO NOT RESTORE | forbidden |
| Legacy automation queue | second analysis path | intentionally replaced | DO NOT RESTORE | forbidden |
| Multiple index writers | legacy ownership patterns | replaced by IndexService | DO NOT RESTORE | forbidden |

## Minimum product success definition

Before advanced P2 work is considered, all P0/P1 capabilities must pass end-to-end tests on both:

1. a fresh project imported by current code;
2. a synthetic project created with a v4.1.22-compatible legacy data fixture and migrated forward.
# 02 — P0 Core Recovery Pipeline (T00–T09)

Do these tasks first. No P1 UI restoration may begin until T09 passes.

---

## T00 — Freeze baseline, reproduce, and create regression harness

### Goal
Create deterministic tests that reproduce the user-visible breakage before changing production behavior.

### Inspect first
- `package.json`
- `desktop/package.json`
- `_site/_test/run-all-tests.js`
- `_site/lib/server-app.js`
- `_site/lib/migration-service.js`
- `_site/lib/hook-manager.js`
- `_site/lib/project-lifecycle-service.js`
- `_site/lib/commit-reconciler.js`
- `_site/lib/scanner.js`
- `_site/scripts/hook-trigger.js`
- same relevant paths at tag `v4.1.22`

### Required actions
1. Record initial `git rev-parse HEAD` and `git status --short`.
2. Run root `npm test`. Save failing test names; do not fix unrelated failures yet.
3. Run `cd desktop && npm test`.
4. Add a characterization test for a legacy v4.1.22 project fixture that contains:
   - repository path;
   - tracking start / last analyzed commit;
   - AI profile reference or legacy default profile data;
   - v1 managed post-commit hook marker.
5. Add an E2E regression test proving current behavior before fix:
   - migrate fixture;
   - create a new Git commit;
   - verify whether hook trigger reaches backend/reconciler;
   - verify startup reconciliation behavior separately.
6. Do not change production code in T00 except minimal test seams if absolutely required.

### New test names
Prefer:
- `_site/_test/legacy-project-upgrade-e2e-test.js`
- `_site/_test/desktop-hook-runtime-regression-test.js`

### Pass condition
T00 passes when tests deterministically distinguish:
- hook live trigger;
- startup recovery;
- analyzer/profile failure;
without relying on sleep-heavy timing or external network.

---

## T01 — Introduce one Effective AI Profile resolver

### Goal
Remove inconsistent profile fallback between Workbench/import/CommitReconciler.

### Inspect first
- `_site/lib/settings-store.js`
- `_site/lib/server-app.js`
- `_site/lib/project-lifecycle-service.js`
- `_site/lib/commit-reconciler.js`
- `_site/lib/knowledge-promotion.js`
- existing AI profile tests
- v4.1.22 AI profile selection code

### Required implementation
Create one shared helper/service, for example:

`resolveEffectiveAiProfile(settings, projectConfig)`

Required order:
1. `projectConfig.aiProfileId` if it references a usable configured profile.
2. `settings.ai.defaultProfileId` if usable.
3. first usable configured profile in stable configured order.
4. otherwise return/throw one explicit actionable `AI_PROFILE_REQUIRED` style failure.

A "usable" profile must satisfy current runtime's actual minimum requirements; do not invent additional requirements.

### Required wiring
Use the same resolver in:
- project import default assignment or effective resolution;
- CommitReconciler / analyzer preparation;
- Workbench session/send path;
- any prompt preview/test path restored later.

### Forbidden
- separate fallback code in each caller;
- silently selecting a disabled/invalid profile;
- mutating user profile order.

### Tests
Add/extend tests for:
- explicit project profile;
- default profile fallback;
- first usable fallback;
- stale project profile ID falls back safely;
- no usable profile produces one clear error;
- Workbench and CommitReconciler resolve the same profile.

### Pass condition
A migrated legacy project with a valid global/default profile can analyze a commit even if its project config does not contain an explicit profile ID.

---

## T02 — Fix Desktop hook runtime execution

### Goal
Ensure the installed Git hook runs a real Node-compatible trigger in CLI and packaged Desktop environments.

### Known risk to verify
Current hook builder defaults `nodeExecutable = process.execPath`. Desktop backend runs under Electron executable with `ELECTRON_RUN_AS_NODE=1`; an external Git hook does not inherit that environment. Therefore a hook may invoke the Electron/Product executable as if it were Node.

### Inspect first
- `_site/lib/hook-manager.js`
- `_site/scripts/hook-trigger.js`
- `desktop/main.cjs`
- `desktop/lib/backend-runtime.cjs`
- packaging scripts
- v4.1.22 hook manager

### Required design
Do not leave hook execution dependent on ambient `ELECTRON_RUN_AS_NODE`.

Implement one explicit hook trigger runtime contract. Acceptable patterns, in preference order:

1. a packaged, stable executable/shim dedicated to executing `hook-trigger.js`; or
2. a resolved real Node executable guaranteed to exist in the supported installation; or
3. a small packaged launcher that sets the required runtime mode itself before invoking the trigger.

The agent must choose the smallest solution compatible with both npm/CLI and packaged Desktop. Document the chosen contract in code comments/tests.

### Hook requirements
- absolute stable paths;
- supports spaces/unicode in paths;
- works in Git for Windows shell;
- exits 0 even if Project-Knowledge is unavailable;
- writes useful trigger diagnostics to the existing durable error/log location when dispatch fails;
- does not launch the visible Electron UI as a side effect.

### Tests
Must include:
- CLI install hook -> execute hook -> trigger script runs;
- simulated Desktop executable/runtime contract -> execute hook -> trigger script runs;
- path with spaces;
- Windows-style path quoting;
- backend offline -> Git commit remains successful.

### Pass condition
A real or deterministic synthetic post-commit hook execution calls the trigger exactly once and does not open Electron UI.

---

## T03 — Repair legacy hook migration semantics

### Goal
Every legacy managed project ends startup with one of three explicit states: verified current hook, third-party conflict, or repair failure. "Missing" is never marked successfully migrated.

### Inspect first
- `_site/lib/hook-manager.js`
- `migrateManagedHooks()` in `_site/lib/server-app.js`
- project state hook schema
- v4.1.22 hook marker

### Required state machine

Legacy current status -> action:

1. Current v2 hook + verified -> set `migrationVersion=2`, update verification timestamp.
2. Legacy v1 managed hook -> replace using T02 runtime contract -> execute/readback verify -> then set migration complete.
3. Missing hook -> install new managed hook -> verify -> then set migration complete.
4. Third-party hook -> do not overwrite -> persist/report conflict -> do NOT mark migration complete.
5. Broken/unverifiable managed hook -> attempt repair only if safely identifiable as Project-Knowledge-managed; otherwise report conflict.

### Critical rule
`reason: missing` cannot result in `migrationVersion=2` unless installation and verification succeeded.

### Tests
- v1 -> v2 success;
- missing -> newly installed;
- current v2 -> idempotent;
- third-party -> untouched and migration incomplete;
- failed write/verify -> migration incomplete;
- second startup after successful migration -> no duplicate rewrite.

### Pass condition
Legacy-project E2E proves the old project's hook is functional after upgrade without manual re-import.

---

## T04 — Restore Hook status, verify, and repair service API

### Goal
Make hook health observable and repairable instead of silently failing.

### Required backend behavior
Expose/restore current-architecture endpoints/service methods that can return per project:
- repo path;
- hook path;
- installed;
- managed;
- managed version;
- runtime target/shim;
- last verified at;
- conflict reason;
- repair availability.

Add an explicit repair action that:
- only repairs missing/broken Project-Knowledge-managed hook;
- never overwrites third-party hook without a separate explicit future UX decision.

### Tests
API/service test for healthy, missing, legacy, third-party, bad runtime target.

### Pass condition
Backend can tell the UI exactly why commit auto-update is unavailable and can repair safe cases.

---

## T05 — Prove startup reconciliation independently from hook

### Goal
Even when live hook notification is missed, restarting Project-Knowledge must discover and analyze pending commits.

### Inspect first
- `startServer()` / startupPromise in `_site/lib/server-app.js`
- `_site/lib/commit-reconciler.js`
- `_site/lib/scanner.js`
- project state baseline semantics

### Required test
1. Create managed project and establish tracking baseline.
2. Stop/omit hook delivery.
3. Make 2 commits.
4. Start backend.
5. Wait for startup reconciliation completion using deterministic API/state/log signal, not arbitrary long sleeps.
6. Assert commits processed oldest-first.
7. Assert final `lastAnalyzedCommit == HEAD`.
8. Assert knowledge Markdown updated for both commits.

### Forbidden
- changing baseline to HEAD to hide pending commits;
- skipping pending commits because conversation evidence is missing.

### Pass condition
Missed live notifications do not cause permanent knowledge loss.

---

## T06 — Restore import prerequisite resolution

### Goal
Import works for a normal user without hidden prerequisites.

### Required backend logic
Preflight must resolve/report:
- path exists and is directory;
- Git repository or can be initialized;
- canonical repo/workspace identity;
- knowledge root configured and writable;
- effective AI profile available or clear requirement;
- duplicate/already-managed project;
- existing non-managed hook conflict;
- knowledge language selection;
- optional team binding compatibility.

### Behavior
For a non-Git directory, preserve v4.1.22 behavior only if current product still intends auto-`git init`. If yes, preflight must clearly report planned initialization and import transaction must roll back safely on later failure.

### Tests
- existing Git repo;
- non-Git folder auto-init path;
- empty repo;
- missing knowledge root;
- duplicate import;
- path with spaces/unicode;
- no AI profile;
- third-party hook conflict.

### Pass condition
Import failure is explicit before mutation whenever possible; successful import leaves project config/state/hook consistent.

---

## T07 — Restore full Import UI flow

### Goal
Bring back usable v4.1.22 import UX on current UI.

### Required UI elements
- local project path;
- Desktop folder picker when `window.projectKnowledgeDesktop` capability exists;
- manual path fallback for web mode;
- Preflight button/automatic preflight;
- detected Git status/repo root;
- selected/effective AI profile;
- knowledge output language (`zh-CN`, `en-US`);
- knowledge root readiness;
- optional Team Knowledge binding when available;
- exact error/action guidance;
- final Import button disabled until mandatory conditions pass.

### Required integration
Do not implement Git/AI rules in JS UI. UI consumes backend preflight result.

### Tests
Extend browser/UI tests to cover successful import and blocked import.

### Pass condition
A fresh user can configure prerequisites and import a project without editing JSON or using CLI.

---

## T08 — Existing project forward-compatibility migration

### Goal
Ensure v4.1.22 projects migrate without losing identity, baseline, AI profile, language, team binding, or knowledge path.

### Inspect first
- `_site/lib/migration-service.js`
- `_site/lib/project-store.js`
- `_site/lib/settings-store.js`
- v4.1.22 legacy data files and schemas

### Required migration verification
For each migrated project assert preservation/derivation of:
- deterministic current projectId;
- repoPath;
- knowledgePath;
- enabled;
- trackingStartCommit;
- lastAnalyzedCommit;
- AI profile semantics via T01;
- knowledgeLanguage;
- teamBinding when present;
- canonical repo identity upgrade when possible;
- hook migration state via T03.

Do not set repo path to a data directory fallback if a valid legacy project path exists.

### Tests
Create realistic legacy fixture with 2 projects and global settings. Migrate twice; second run must be idempotent.

### Pass condition
No manual re-import is needed and pending commits remain detectable.

---

## T09 — P0 end-to-end commit knowledge update gate

### Goal
Prove the primary product contract before UI feature work.

### Required scenario A — fresh project
1. Configure one AI test profile/fake analyzer.
2. Configure knowledge root.
3. Import project through current lifecycle service.
4. Verify hook.
5. Commit a code change.
6. Verify hook trigger accepted/recorded.
7. Verify `CommitReconciler` processes commit.
8. Verify Markdown knowledge changes.
9. Verify analyzed pointer advances only after successful promotion semantics.
10. Verify index dirty/retry semantics remain valid.

### Required scenario B — v4.1.22 legacy project
Same end-to-end sequence after migration, without re-import.

### Required scenario C — backend offline
1. Stop backend.
2. Commit.
3. Git commit succeeds.
4. Restart backend.
5. Startup reconciliation processes missed commit.

### Required scenario D — no conversation captured
Commit still analyzes from Git evidence.

### Pass condition
All four scenarios pass. Only then proceed to T10.
# 03 — Product Feature Restoration Pipeline (T10–T19)

These tasks restore v4.1.22 product capabilities on current architecture. T09 must already be green.

---

## T10 — Restore UI internationalization (zh-CN / en-US)

### Goal
Restore runtime UI language switching without duplicating entire pages.

### Required design
- one translation dictionary/module;
- one persisted UI language setting;
- default `zh-CN` if no prior preference;
- all user-visible labels/errors/tooltips/settings section names routed through translation keys where practical;
- dynamic backend error messages may remain backend-provided but UI wrapper labels must translate.

### Restore from v4.1.22
Use old `I18N.zh/en` content as functional baseline, not as mandatory code structure.

### Tests
- switch zh -> en without reload if practical;
- persistence across reload/restart;
- import/settings/workbench core labels change;
- no missing translation key placeholders in smoke test.

### Pass condition
Core UI is usable in both languages.

---

## T11 — Restore knowledge output language controls

### Goal
Expose current backend `knowledgeLanguage` as a real product setting.

### Required locations
- import flow;
- per-project settings after import;
- project summary/status.

### Rules
- only supported values `zh-CN` / `en-US` unless current contracts already define more;
- changing language affects future generated knowledge, not silent rewrite of historical files;
- if historical rewrite is desired, it must be a separate explicit operation, not part of this task.

### Tests
Import with both languages; update project language; next analyzer invocation receives correct value.

---

## T12 — Restore Prompt Settings on canonical analysis path

### Goal
Restore user-editable prompts without recreating multiple analyzer pipelines.

### Inspect first
- current `settings.promptOverrides` schema
- `_site/lib/commit-prompt.js`
- Knowledge Analyzer/Promotion call chain
- v4.1.22 `claude-prompts.json` and `/api/prompts` behavior

### Required backend
Provide one prompt settings service/API supporting current-safe equivalents of:
- system prompt override;
- user/commit prompt template override;
- allowed tools only if current analyzer runtime actually supports/tool-controls them;
- reset to default;
- preview effective prompt for a selected project/commit fixture without running analysis.

### Mandatory rule
All overrides feed the existing canonical `commit-prompt` generation. Do not bypass evidence manifests, prompt hashes, staging, or promotion validation.

### UI
Settings -> Prompt Settings with:
- default/effective value display;
- edited indicator;
- reset;
- preview.

### Tests
- defaults unchanged when no override;
- override changes prompt hash/effective prompt deterministically;
- reset restores default;
- malformed template rejected;
- prompt preview does not mutate project state.

---

## T13 — Restore Project Goal editor

### Goal
Restore user management of project `GOAL.md`.

### Required behavior
- read goal;
- edit/save atomically;
- show project context;
- do not overwrite unrelated knowledge files;
- if goal file does not exist, create it only on explicit save;
- analyzer/retrieval sees updated goal through existing Markdown knowledge path where appropriate.

### UI
A visible project-level Goal action/editor, not hidden JSON.

### Tests
read existing, create new, update, path safety, project isolation.

---

## T14 — Restore Claude Workbench permission UI and modes

### Goal
Reconnect existing backend permission lifecycle to UI.

### Required UI
- pending permission card/dialog;
- request details/tool name if backend exposes them;
- Allow / Deny;
- permission mode selector for modes supported by current `claude-cli-runner`;
- visible session state (`running`, `pending-permission`, etc.).

### Mandatory architecture rule
These Workbench messages remain internal and must not be written to Development Conversation.

### Tests
- fake permission request -> Allow resolves;
- fake permission request -> Deny resolves;
- selected permission mode reaches send/session API;
- no Development Conversation append from Workbench.

---

## T15 — Restore GitHub account/provider status

### Goal
Restore a user-visible GitHub integration status/auth workflow equivalent to v4.1.22, using current security/storage conventions.

### Inspect first
- v4.1.22 GitHub routes/UI
- current `github-team-store.js`
- current settings integrations schema
- Desktop proxy handling

### Required capabilities
Where current provider code supports them:
- GitHub login status;
- authenticated username/account summary;
- PAT setup/status without ever returning raw token to UI;
- OAuth device flow if maintained/appropriate;
- logout/remove credential;
- connection/test status;
- proxy-aware network path in Desktop.

### Security
- no token in logs;
- no token in normal API response;
- reuse existing redaction/secrets handling;
- tests use fake HTTP/provider adapter, not real GitHub secrets.

### Pass condition
UI accurately distinguishes not configured / authenticating / connected / error.

---

## T16 — Restore Gitea provider status and custom-instance auth

### Goal
Restore the v4.1.22 Gitea capability if current product still supports Team Knowledge via Gitea.

### Required behavior
- configurable base URL;
- auth status;
- safe token/OAuth handling according to existing supported implementation;
- provider test;
- no GitHub-specific assumptions in shared code.

### If obsolete
If current current-architecture Team Knowledge explicitly no longer supports Gitea, do not fake it. Produce a task report explaining exact incompatibility and keep this task blocked pending product decision.

### Tests
Fake local provider; no live service required.

---

## T17 — Restore Team Knowledge discovery/binding flow

### Goal
Reconnect team store discovery/checkout/binding to current project/store model.

### Required behavior
- list/discover available team stores for configured provider;
- checkout/select local team store using safe paths;
- bind/unbind project;
- import flow optional binding;
- show current binding status;
- preserve migrated `teamBinding` from legacy project.

### Mandatory
Do not create a second index writer or a second authoritative project registry.

### Tests
Two projects, two team stores, bind/unbind isolation, migrated binding preserved.

---

## T18 — Restore visible unified Integration Setup

### Goal
Make the current integration backend discoverable in UI.

### Required display per client
For Claude Code / Codex / OpenCode show separately:
- Knowledge Integration status;
- Development Capture status;
- conflict/error reason;
- install action;
- uninstall action if safe;
- repair/reinstall action.

### Required behavior
One "Install All" action may orchestrate all clients, but status remains per component.

### Mandatory
- MCP/Skill/Instructions are knowledge integration.
- Bridge hook/notify/plugin is development capture.
- Do not tell the user that MCP itself captures conversations.
- Project-Knowledge Bridge consumer lifecycle is host-level, not tied to uninstalling one client connector.

### Tests
Use installer fakes/temp HOME. Verify config merge and third-party config preservation.

---

## T19 — Restore user-visible Hook health in project UI

### Goal
Close the loop for the P0 commit problem with diagnostics users can understand.

### UI per project
Show:
- Auto knowledge update: Healthy / Needs repair / Conflict / Repository missing;
- hook path/version;
- last verified timestamp;
- last successful reconciliation summary if existing logs/state expose it;
- Repair button for safe repair cases;
- explanation that startup recovery can catch missed commits.

### Test
Browser test drives missing-hook -> Repair -> Healthy.

### Pass condition
A user no longer has to inspect `.git/hooks` manually to understand why commit updates stopped.
# 04 — Advanced Feature Restoration Pipeline (T20–T24)

Do not begin these tasks until P0/P1 pipeline is green. These are valuable, but they must not destabilize the primary commit workflow.

---

## T20 — Restore advanced AI Profile management and profile test

### Goal
Restore user control that existed in v4.1.22 while keeping current profile schema.

### Restore where supported
- provider/vendor;
- model;
- API base URL;
- API key update/remove semantics;
- context/model-specific options already present in schema/runtime;
- default profile selection;
- per-project assignment;
- connection/profile test using a deterministic test seam in automated tests.

### Do not
Invent fields no longer supported by the actual runtime.

### Critical
T01 effective resolver remains single source of profile selection truth.

---

## T21 — Restore Embedding configuration/status/download UX

### Goal
Restore management of the current local embedding service.

### Current architecture constraints
- use current `LocalEmbeddingService` / current settings schema;
- do not restore removed standalone `embedding-config.js` merely for nostalgia;
- model cache path must follow current StorageLayout/cache conventions.

### UI/API capabilities where supported
- model ID;
- remote host;
- local model path;
- local-files-only/offline;
- model availability/status;
- explicit download/prepare operation;
- clear errors.

### Tests
Use fake/local fixture; no network in standard unit tests.

---

## T22 — Restore Knowledge Store Git options if compatible

### Goal
Restore remote/branch/autoCommit/autoPush management only if it still applies to the current authoritative knowledge root design.

### Required evaluation first
Determine whether current `StorageLayout` and user-selected knowledge root still safely support this feature.

If yes, restore using current root and safe Git operations.

If no, mark this capability as intentionally redesigned/blocked and document exact reason. Do not add an unrelated second clone/repository.

### Tests if implemented
local bare remote only; no internet.

---

## T23 — Restore Maintenance UX on new architecture

### Goal
Restore useful maintenance capabilities without resurrecting old DB ownership.

### Allowed operations
- audit Markdown knowledge structure;
- report project/file issues;
- create explicit backups before destructive maintenance;
- rebuild derived LanceDB index through `IndexService` only;
- retry dirty indexes;
- display index dirty/healthy status.

### Forbidden
- direct LanceDB writes outside `IndexService`;
- old vector migration service if it bypasses new index ownership;
- silent rewriting of immutable commit snapshots.

### Tests
- Markdown audit read-only;
- rebuild uses IndexService;
- failed rebuild leaves Markdown untouched and dirty state observable;
- backup/restore boundaries safe.

---

## T24 — Restore Desktop update controls and optional Workbench conveniences

### Goal
Restore remaining low-risk product conveniences.

### Desktop update UI
Reconnect existing Desktop preload/app-updater capabilities:
- current version;
- check update;
- available version;
- download/install actions where current desktop service supports them;
- web mode shows not available instead of broken buttons.

### Workbench conveniences
Only if current Claude runner exposes reliable data:
- session restore/list;
- token usage;
- slash commands.

Do not invent fake UI data.

### Tests
- Desktop IPC fake tests;
- web mode capability detection;
- no update operation in unit tests reaches internet.
# 05 — Mandatory Final Test and Acceptance Gates

No task is considered complete until all applicable gates are green.

## G00 — Repository hygiene

Run:

```bash
git status --short
git diff --check
```

Requirements:
- no unexplained generated files;
- no secrets/tokens;
- no unrelated mass formatting;
- no test disabling.

## G01 — Root test suite

Run:

```bash
npm test
```

Must exit 0.

If a test is platform-specific, it must skip only through an existing explicit platform capability contract, never because it is inconvenient.

## G02 — Desktop test suite

Run:

```bash
cd desktop
npm test
```

Must exit 0.

If packaging/runtime files changed, also run applicable package audit/smoke tests available in `desktop/package.json`.

## G03 — Fresh project E2E

Required flow:
1. start with empty Project-Knowledge data dir;
2. configure knowledge root;
3. configure AI fake/test profile;
4. import a Git project through same service used by UI;
5. verify hook healthy;
6. commit change;
7. verify one reconciliation;
8. verify Markdown knowledge updated;
9. verify index update/dirty semantics;
10. restart and verify no duplicate reanalysis.

PASS: final analyzed commit equals Git HEAD and no duplicate knowledge promotion occurs.

## G04 — Legacy v4.1.22 upgrade E2E

Required flow:
1. construct/use v4.1.22 data fixture;
2. include existing managed project, tracking state, profile data, and v1 hook;
3. upgrade/migrate with current runtime;
4. do NOT re-import project;
5. verify config/state preserved;
6. verify hook migrated/repaired;
7. commit change;
8. verify knowledge update;
9. restart;
10. verify idempotence.

PASS: user project continues functioning without manual reset.

## G05 — Missed hook/startup recovery E2E

1. backend offline/unreachable;
2. commit succeeds;
3. no knowledge update while offline;
4. restart backend;
5. startup reconciliation discovers commit;
6. knowledge updates.

PASS: Git history is the durable pending-work source.

## G06 — UI regression gate

Browser/CDP test must verify at minimum:
- project import flow;
- zh/en switch;
- knowledge language control;
- AI profile/default assignment view;
- prompt settings visible and preview works;
- Project Goal visible;
- Workbench permission Allow/Deny;
- GitHub integration status panel;
- Integration Setup panel;
- Hook health/repair panel.

The browser helper must fail fast with diagnostics and clean up child processes. No 300-second zombie timeout behavior.

## G07 — Protected architecture gate

Add/assert tests proving:
- Workbench input does not append Development Conversation;
- Knowledge Analyzer does not append Development Conversation;
- external bridge events can still be ingested;
- cross-repo conversation isolation remains intact;
- CommitConversationSnapshot remains immutable;
- IndexService remains only index writer;
- no `CLAUDE.md` manager is reintroduced.

## G08 — Manual acceptance checklist

The agent must produce a final table with PASS/FAIL and evidence for:

1. Existing imported project commit updates knowledge.
2. Fresh import works.
3. Backend-offline commit is recovered at startup.
4. Chinese/English UI switch works.
5. Knowledge output language setting works.
6. GitHub status/auth UI exists and behaves with test adapter.
7. Gitea status/auth restored or explicitly blocked with evidence.
8. Prompt settings persist and affect canonical prompt.
9. Project Goal editor works.
10. Workbench permissions work.
11. Integration Setup visible.
12. Hook health/repair visible.
13. Legacy project migration requires no re-import.
14. Full root tests green.
15. Desktop tests green.
16. No protected architecture invariant violated.

If any required item is FAIL, final result must be reported as INCOMPLETE, not "done".
# MiniMax Agent Start Prompt

You are modifying the repository `SanQianX/project-knowledge-base` to recover product regressions introduced after tag `v4.1.22` while preserving the current `4.2.x` architecture.

You are NOT the architect for this task. The architecture and execution order are already specified in the attached development package. Your job is to execute the package mechanically and verify each checkpoint.

## Before doing anything

1. Read every file in `minimax-pkb-regression-recovery-package/`.
2. Read `README_FIRST.md` and `00_AGENT_OPERATING_RULES.md` twice.
3. Inspect current repository status and HEAD.
4. Confirm tag `v4.1.22` exists and resolve its commit.
5. Do not edit production code until T00 regression tests/harness are created or existing tests are shown to cover the same behavior.

## Execution order

Execute exactly:

T00, T01, T02, T03, T04, T05, T06, T07, T08, T09,
T10, T11, T12, T13, T14, T15, T16, T17, T18, T19,
T20, T21, T22, T23, T24,
then G00 through G08.

Do not skip a task silently. If a task is not applicable, prove why with current code evidence and record it using the Task Report template.

## Core intent you must not forget

The user wants the mature PRODUCT CAPABILITIES of v4.1.22 restored on top of the NEW architecture. Do not roll back the new architecture.

Especially:

- Existing projects imported in v4.1.22 must continue to work without re-import.
- Git commit must trigger knowledge update again.
- Missed hook delivery must recover on startup.
- Import UI must be functional, not just a text path box.
- UI zh/en switching must return.
- GitHub/Gitea status and team knowledge capabilities must return where supported.
- Prompt settings must return and feed the single canonical commit prompt.
- Project Goal and Claude permission UI must return.
- Do not restore app-managed CLAUDE.md.
- Do not restore the old automation queue as a second analysis pipeline.
- Do not allow Workbench/Knowledge Analyzer conversations into Development Conversation.
- Do not bypass IndexService for LanceDB.

## How to work

For EACH task:

A. Print the task ID and exact files you inspected.
B. State the current behavior and the v4.1.22 behavior relevant to this task.
C. State the minimal implementation you will make.
D. Implement only the task scope.
E. Add/update required tests.
F. Run task-specific tests.
G. Run `git diff --check`.
H. Inspect `git status --short`.
I. Produce the Task Report.
J. Only if PASS, move to the next task.

If tests fail, fix the current task. Do not continue and promise to fix later.

## Definition of done

You may say the work is complete only after:

- `npm test` passes;
- `cd desktop && npm test` passes;
- all G03/G04/G05 E2E gates pass;
- G06 UI regression gate passes;
- G07 architecture protection gate passes;
- G08 acceptance table has no required FAIL item.

Do not claim success based only on unit tests or based only on code review.
# MiniMax Agent 开工提示词（中文版）

你现在要修改仓库 `SanQianX/project-knowledge-base`。本次工作的目标是：**以 `v4.1.22` 为产品功能基线，把最近大重构过程中丢失/断开的用户功能恢复到当前 `4.2.x` 新架构上。**

你不是本次工作的架构设计者。附件施工包已经规定了架构边界、任务顺序、测试方法和通过条件。你必须机械执行，不得自由发挥。

## 开工前必须执行

1. 阅读施工包目录中的全部文件。
2. `README_FIRST.md` 和 `00_AGENT_OPERATING_RULES.md` 必须完整阅读两遍。
3. 执行并记录：
   - `git rev-parse HEAD`
   - `git status --short`
   - `git tag --list v4.1.22`
   - `git rev-parse v4.1.22`
4. 确认 `v4.1.22` 对应基线 commit。
5. 在 T00 的回归测试/复现测试建立之前，不允许直接开始修改核心生产代码。

## 唯一允许的任务顺序

严格执行：

`T00 -> T01 -> T02 -> T03 -> T04 -> T05 -> T06 -> T07 -> T08 -> T09 -> T10 -> T11 -> T12 -> T13 -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20 -> T21 -> T22 -> T23 -> T24 -> G00 -> G01 -> ... -> G08`

禁止跳任务。禁止把几个 Task 混在一次大修改中。禁止“先全部改完最后再测试”。

## 你必须始终记住的产品意图

- v4.1.22 已经导入的老项目升级后必须继续可用，不能要求用户删除项目重新导入。
- Git commit 后必须重新触发知识库更新。
- 即使 Hook 通知丢失，Project-Knowledge 重启后也必须通过 startup reconciliation 补分析漏掉的 commit。
- 新项目导入必须恢复成完整可用流程：文件夹选择、preflight、Git 状态、知识库根目录、AI Profile、知识输出语言等都要正确处理。
- UI 中英文切换必须恢复。
- GitHub/Gitea 登录/连接状态、Team Knowledge 能力按当前架构恢复。
- 提示词设置必须恢复，但只能进入当前唯一的 canonical commit prompt/analyzer 链路，不能新建第二套分析链路。
- Project Goal 编辑必须恢复。
- Claude Workbench 的 Permission Allow/Deny 和 permission mode UI 必须恢复。
- Integration Setup 必须在 UI 可见，并区分 Knowledge Integration 与 Development Capture。

## 绝对禁止

- 禁止回滚整个仓库到 v4.1.22。
- 禁止恢复 Project-Knowledge 自动管理 `CLAUDE.md`。
- 禁止恢复旧 `automation-queue` 作为第二套 commit 分析系统。
- 禁止绕过 `CommitReconciler` 新建另一套分析入口。
- 禁止绕过 `IndexService` 直接写 LanceDB。
- 禁止把 Project-Knowledge Workbench 对话写入 Development Conversation。
- 禁止把 Knowledge Analyzer 自己的内部对话写入 Development Conversation。
- 禁止修改/删除旧的 immutable `CommitConversationSnapshot` 来让测试通过。
- 禁止弱化、删除、skip 测试来制造绿色结果。
- 禁止顺手做无关重构、全局重命名、格式化整个仓库或升级无关依赖。

## 每个 Task 的固定施工流程

每执行一个 Task，都必须按下面顺序：

1. 输出当前 Task 编号和名称。
2. 阅读 Task 指定的当前 `main` 文件。
3. 阅读 `v4.1.22` 对应文件，确认旧功能真实行为。
4. 用 5～10 行说明：当前为什么坏、旧版怎么工作、本 Task 最小修改是什么。
5. 只修改本 Task 范围。
6. 添加/修改 Task 明确要求的测试。
7. 先运行 Task 专项测试。
8. 再运行受影响的既有测试。
9. 执行 `git diff --check`。
10. 执行 `git status --short`，确认没有超范围文件。
11. 按 `07_TASK_REPORT_TEMPLATE.md` 输出完整 Task Report。
12. 所有通过条件都是 PASS 后，才允许进入下一个 Task。

如果测试失败：继续停留在当前 Task 修复。禁止跳到下一个 Task，禁止说“最后一起修”。

## 本次最高优先级 P0

优先确保以下链路完全恢复：

`旧项目/新项目 -> Git commit -> post-commit hook -> hook-trigger -> CommitReconciler -> analyzer -> promotion -> Markdown knowledge -> IndexService`

其中重点核对施工包中的已知风险：

1. Desktop 下 Hook 不能错误地把 Electron/Project-Knowledge.exe 当成普通 Node executable。
2. Hook 文件 missing 时不能错误标记为 migration completed。
3. AI Profile 必须统一使用一个 effective resolver：
   `project profile -> default profile -> first usable profile -> explicit error`。
4. startup reconciliation 必须独立于 Hook 通知可靠工作。

## 你什么时候才可以说“完成”

必须同时满足：

- 根目录 `npm test` PASS；
- `cd desktop && npm test` PASS；
- Fresh project E2E PASS；
- v4.1.22 legacy project upgrade E2E PASS；
- Backend offline -> commit -> restart recovery E2E PASS；
- UI regression Gate PASS；
- Protected architecture Gate PASS；
- `G08` 验收表所有 required 项目没有 FAIL。

只要有一个 required Gate 失败，你的最终结论必须是 `INCOMPLETE`，不能说“基本完成”“应该可以”“主要功能完成”。
# 07 — Required Task Report Template

MiniMax must output this after every task.

```text
TASK: Txx — <name>
STATUS: PASS | FAIL | BLOCKED

FILES INSPECTED:
- ...

FILES MODIFIED:
- ...

BASELINE BEHAVIOR (v4.1.22):
- ...

CURRENT PRE-TASK BEHAVIOR:
- ...

IMPLEMENTATION:
1. ...
2. ...

TESTS ADDED/CHANGED:
- ...

TEST COMMANDS RUN:
- command: ...
  result: PASS/FAIL
- command: ...
  result: PASS/FAIL

ACCEPTANCE CONDITIONS:
[PASS/FAIL] condition 1
[PASS/FAIL] condition 2
...

GLOBAL INVARIANTS CHECK:
[PASS/FAIL] Markdown authoritative
[PASS/FAIL] IndexService only index writer
[PASS/FAIL] no second analyzer queue
[PASS/FAIL] no CLAUDE.md manager restored
[PASS/FAIL] internal Workbench/Analyzer excluded from Development Conversation

GIT CHECK:
- git diff --check: PASS/FAIL
- unexpected files modified: NONE | list

OPEN ISSUES:
- none | exact issue

NEXT ACTION:
- Proceed to Txx | Stay on current task | Blocked pending product decision
```
# 08 — Known Root Causes / High-Confidence Regression Findings

These findings must be verified in T00–T05 and then fixed, not merely documented.

## RC-01 — Desktop hook runtime may write Electron executable as Node runtime

Current hook builder defaults its executable from `process.execPath`.

Current Desktop backend launches the core CLI through the Electron executable with `ELECTRON_RUN_AS_NODE=1` in the backend child environment.

A Git post-commit hook runs later from Git/IDE/terminal and does not automatically inherit that backend-only environment variable. Therefore a hook containing the Desktop `process.execPath` can attempt to launch the Electron/Product executable with `hook-trigger.js` arguments instead of executing JavaScript as Node.

Expected symptom:
- old and new projects both stop receiving live commit trigger after migration/install;
- Git commit itself still succeeds because hook is fail-open;
- startup reconciliation may still catch up if downstream analyzer is healthy.

Required fix: T02.

## RC-02 — Missing hook can be falsely marked as migration complete

Current startup `migrateManagedHooks()` updates hook migration state after calling the migration function. The hook migration function can return a non-error result such as `reason: missing` when the hook file does not exist.

If the caller still writes `migrationVersion = 2`, future startup skips the project and never repairs the missing hook.

Required fix: T03.

## RC-03 — AI Profile resolution is inconsistent

Current import/project config can store `aiProfileId: null`.

Current Workbench path has fallback behavior using project profile or settings default, while the commit-analysis path can require `config.aiProfileId` directly. This creates a state where chat works but commit analysis fails.

Legacy v4.1.22 had default/first-usable profile fallback during import/configuration.

Required fix: T01.

## RC-04 — Import UX lost prerequisite guidance

Current UI was rewritten and the old folder picker/preflight/profile/language/team selection flow was not fully migrated. Hidden prerequisites such as knowledge root or AI profile can cause import failure with poor UX.

Required fixes: T06–T08.

## RC-05 — Many user-facing features were removed from UI/API composition, not merely hidden

Confirmed categories from v4.1.22 baseline include:
- UI I18N;
- GitHub/Gitea integration status/auth;
- Prompt settings;
- Project Goal editor;
- Workbench permissions/modes;
- advanced settings/maintenance/desktop update controls.

Required fixes: T10–T24 according to feature matrix.

## RC-06 — CI/browser harness previously caused long false delays

The project recently added a hardened CDP helper and failure test after a Windows browser startup failure caused a test process to hang until an outer timeout. The recovery work must keep the fail-fast cleanup behavior and must not reintroduce browser child leaks.

G06 protects this.
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
