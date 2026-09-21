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
