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
