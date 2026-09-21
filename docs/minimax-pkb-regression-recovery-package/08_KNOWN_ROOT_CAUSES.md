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
