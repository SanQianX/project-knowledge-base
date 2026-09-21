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
