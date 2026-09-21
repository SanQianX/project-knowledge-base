# Codex 主任务清单

> 状态只使用 `TODO | IN_PROGRESS | BLOCKED | DONE`；源 Plan 未定义的 TS-53–TS-55 按执行提示词保留 `UNDEFINED_IN_SOURCE_PLAN`。  
> 审查基线：`main` / `ba505bb2ae031e8d06ec3032657482f40d57ecf8` (`release: v4.1.22`)  
> 实施环境：Windows / Node `v24.13.0` / npm `11.6.2` / Git `2.45.2.windows.1`  
> Owner 采用实施任务 ID；所有任务由当前 Codex 主 Agent 串行集成。

## 现场保护与最终 Gate

- `DONE` 当前 HEAD 与审查 SHA 一致；工作分支为 `main`，未创建或切换分支。
- `DONE` 用户原有未跟踪项保持未修改：`.git.rar`、原 Plan、UI 对比原型、审查提示词、审查交付物 ZIP/目录、Claude workspace 预览。
- `DONE` 第二个 worktree `D:/SanQian.Xu/project-knowledge-base-v4.1.3` 未修改。
- `DONE` G0：`npm ci` exit `0`；基线 suite `52 passed / 0 failed`；desktop `2 passed / 0 failed`；pack dry-run exit `0`。
- `DONE` G5：`npm ci` exit `0`；最终 suite `72 passed / 0 failed`（`97642ms`）。
- `DONE` G5：`npm ci --prefix desktop --omit=optional` exit `0`；`npm test --prefix desktop` exit `0`，`2 passed / 0 failed`。
- `DONE` G5：`npm run make --prefix desktop` exit `0`；`npm run test:packaged --prefix desktop` exit `0`；包内应用、单实例、LanceDB、Claude 脚本、向量/代理依赖 smoke 全部 PASS。
- `DONE` G5：`npm run audit:package --prefix desktop` exit `0`；bundle `617.3 MiB`，installer `221 MiB`，且 ASAR 不含本地审查材料。
- `DONE` G5：`npm pack --dry-run --json` exit `0`；`1,189,242` bytes packed，`2,010,443` bytes unpacked，`155` entries，本地审查 ZIP/Plan/原型零泄露。
- `DONE` G5：`git diff --check` exit `0`（仅 Git 的 LF→CRLF 提示）；全部变更 JS/CJS `node --check` 通过。
- `DONE` G5：实际 Chromium 视觉 QA 覆盖 light/dark、窄屏、六级筛选、cursor、pause/refresh、operation flow、error stack/raw JSON、empty/XSS/长堆栈/deleted/degraded/export；无 console error。
- `DONE` Windows make 首轮发现 `jsonc-parser` 未被本地 `file:..` 依赖带入（exit `1`）；已将核心直接运行时依赖显式镜像到 desktop，并用 desktop dependency contract 回归，随后完整 workflow 通过。

## Task / Gate

| Task | Owner | Status | Gate | Evidence |
|---|---|---|---|---|
| T00 | T00 | DONE | G0 | baseline commands；`refactor-characterization-test.js` |
| T01 | T01 | DONE | G1 | `contracts.js`；`shared-contracts-test.js`；`server-security-test.js` |
| T02 | T02 | DONE | G1 | `storage-layout.js`、`atomic-file.js`、`settings-store.js`；`storage-foundation-test.js` |
| T03 | T03 | DONE | G1 | `project-registry-store.js`、`project-store.js`；`project-store-test.js` |
| T04 | T04 | DONE | G1 | `migration-service.js`；`project-layout-v2-migration-test.js`、`knowledge-migration-test.js` |
| T05 | T05 | DONE | G2 | `structured-logger.js`；`structured-logger-test.js`、`logging-api-test.js`、`log-redaction-test.js` |
| T06 | T06 | DONE | G2 | `project-lifecycle-service.js`、`hook-manager.js`；lifecycle/Hook/worktree tests |
| T07 | T07 | DONE | G2 | requirement recorder/adapters/binder；recorder/binding/integration tests |
| T08 | T08 | DONE | G3 | scanner/reconciler/prompt；evidence/concurrency/scanner tests |
| T09 | T09 | DONE | G3 | promotion/index service；promotion recovery/index concurrency tests |
| T10 | T10 | DONE | G4 | thin `server.js` + `server-app.js`；security/route/API tests |
| T11 | T11 | DONE | G4 | CLI/MCP/runtime adapters；`path-consistency-test.js`、`mcp-server-test.js`、`bin-cli-test.js` |
| T12 | T12 | DONE | G4 | single `ui/index.html`；logging UI/browser smoke/visual QA；旧 Vue/Tailwind runtime 删除 |
| T13 | T13 | DONE | G5 | `full-integration-e2e-test.js`；72-test suite；Windows make/packaged/audit；pack boundary；final diff audit |

## Requirements

| Requirement | Owner | Status | Evidence |
|---|---|---|---|
| R-TRG-01 | T08/T10 | DONE | `legacy-routes-removed-test.js`、`refactor-characterization-test.js` |
| R-TRG-02 | T08/T10 | DONE | `post-commit-automation-test.js`、`pending-sweep-test.js`、full E2E |
| R-TRG-03 | T06/T08 | DONE | `tracking-start-test.js`、`simple-import-test.js`、`baseline-schema-test.js` |
| R-TRG-04 | T03/T08 | DONE | `commit-reconciler-concurrency-test.js`、`scanner-test.js`、full E2E |
| R-REQ-01 | T07 | DONE | `requirement-recorder-test.js`、`integration-adapters-test.js`、`mcp-server-test.js` |
| R-REQ-02 | T07 | DONE | `requirement-binding-test.js`、`post-commit-automation-test.js` |
| R-HOOK-01 | T06/T10 | DONE | `project-lifecycle-transaction-test.js`、`simple-import-test.js`、full E2E |
| R-HOOK-02 | T06/T10 | DONE | `project-lifecycle-transaction-test.js`、`project-remove-running-guard-test.js` |
| R-HOOK-03 | T10/T12 | DONE | `legacy-routes-removed-test.js`、`automation-ui-test.js` |
| R-HOOK-04 | T06/T11 | DONE | `hook-trigger-test.js`、`hook-worktree-test.js`、`path-consistency-test.js` |
| R-HOOK-05 | T04/T06 | DONE | `hook-runtime-endpoint-test.js`、`hook-worktree-test.js`、`pending-sweep-test.js` |
| R-DATA-01 | T03 | DONE | `project-store-test.js`、`baseline-schema-test.js`、`path-consistency-test.js` |
| R-DATA-02 | T02/T03 | DONE | `storage-foundation-test.js`、`project-store-test.js`、`requirement-recorder-test.js` |
| R-DATA-03 | T04 | DONE | migration success + five fault stages + activation/open retry in `project-layout-v2-migration-test.js` |
| R-PATH-01 | T02/T06 | DONE | `kbpath-follow-test.js`、`path-consistency-test.js`、`simple-import-test.js` |
| R-PATH-02 | T02/T06/T09 | DONE | `storage-foundation-test.js`、lifecycle/import/promotion filesystem assertions |
| R-PATH-03 | T02/T04/T11 | DONE | `knowledge-storage-location-test.js`、`knowledge-storage-startup-test.js`、`path-consistency-test.js` |
| R-LIFE-01 | T06/T10 | DONE | `project-lifecycle-transaction-test.js`、`simple-import-test.js` |
| R-LIFE-02 | T06/T10 | DONE | delete guard/lifecycle/team knowledge tests；external team Markdown never deleted |
| R-KNOW-01 | T08/T09 | DONE | `commit-evidence-test.js`、`knowledge-promotion-recovery-test.js` |
| R-KNOW-02 | T09 | DONE | `index-writer-concurrency-test.js`、`knowledge-maintenance-test.js`、promotion recovery |
| R-LOG-01 | T05 | DONE | `structured-logger-test.js`、`logging-api-test.js` |
| R-LOG-02 | T05/T06/T08 | DONE | reconciler/lifecycle chain assertions；logging UI operation flow |
| R-LOG-03 | T05 | DONE | structured logger rotation/retention/capacity/fallback/crash recovery tests |
| R-LOG-04 | T05/T10 | DONE | `logging-api-test.js`、`log-redaction-test.js`、cursor/export tests |
| R-UI-01 | T12 | DONE | `logging-ui-test.js`、`ui-smoke-test.js`、`task15-20-ui-flow-test.js`、visual QA |
| R-COMP-01 | T10–T13 | DONE | removed-symbol/routes `rg` zero hits；dead modules/vendor removed；`package-boundary-test.js` |
| R-SEC-01 | T01/T10 | DONE | `server-security-test.js`、`log-redaction-test.js`、immutable-safe project PATCH tests |

## Confirmed Bugs

| Bug | Owner | Status | Evidence |
|---|---|---|---|
| BUG-SEC-001 | T01/T10 | DONE | public AI view/key tri-state/origin/auth/safe 500 in `ai-profile-test.js`、`server-security-test.js` |
| BUG-SEC-002 | T10 | DONE | `/api/raw` removed；`legacy-routes-removed-test.js`、security traversal assertion |
| BUG-HOOK-001 | T06/T10 | DONE | explicit real trigger + import readback in lifecycle/simple import/full E2E |
| BUG-HOOK-002 | T06 | DONE | stable projectId + runtime Git root verified update in `pending-sweep-test.js`、path consistency |
| BUG-HOOK-003 | T06 | DONE | strict marker/third-party conflict/atomic write/no CLAUDE in Hook tests |
| BUG-HOOK-004 | T06 | DONE | Git-resolved worktree/core.hooksPath in `hook-worktree-test.js` |
| BUG-LIFE-001 | T06/T10 | DONE | registry-last journal and reverse rollback in lifecycle transaction faults |
| BUG-LIFE-002 | T06/T10 | DONE | Hook failure blocks delete；knowledge default preserve；team store never owned/deleted |
| BUG-LIFE-003 | T10 | DONE | generic PUT absent；PATCH whitelist；repo/team binding mutation rejected in `simple-import-test.js` |
| BUG-LIFE-004 | T06/T10 | DONE | no-profile import succeeds without analysis in simple import/lifecycle tests |
| BUG-AUTO-001 | T08/T10 | DONE | init symbols/routes removed；import creates no speculative/TODO Markdown |
| BUG-AUTO-002 | T07/T08 | DONE | real unified patch + bound requirements + single prompt in evidence/prompt tests |
| BUG-AUTO-003 | T08/T09 | DONE | manifest/path/content/hash validation before promotion/state advance |
| BUG-AUTO-004 | T09 | DONE | promotion→pointer/indexDirty；index failure retry/generation tests |
| BUG-AUTO-005 | T03/T08 | DONE | strict per-project atomic state writes；persistence failure stops advance |
| BUG-AUTO-006 | T07/T08 | DONE | active claim freezes requirement IDs/prompt/patch hash；retry test |
| BUG-SCAN-001 | T08 | DONE | ancestry check + explicit divergence stop in `scanner-test.js` |
| BUG-SCAN-002 | T08 | DONE | reverse topo/root/merge/batch/continuation and actual patch tests |
| BUG-STATE-001 | T03/T10 | DONE | index-only registry + per-project locks；two-project barrier/concurrency tests |
| BUG-STATE-002 | T02/T03/T04 | DONE | strict corrupt JSON failures in stores/migration/storage tests |
| BUG-STATE-003 | T02 | DONE | fsync/atomic replace/Windows retry/locks/stale crash-lock recovery tests |
| BUG-MIG-001 | T04 | DONE | completion marker last；five phase faults；all activated targets rollback and retry |
| BUG-MIG-002 | T04 | DONE | backup/staging/hash/open validation/target conflict；sources retained |
| BUG-PATH-001 | T02/T04/T11 | DONE | fixed internal `index/knowledge.lancedb` tests |
| BUG-PATH-002 | T02/T11 | DONE | server/CLI/MCP share StorageLayout + ProjectStore；path consistency tests |
| BUG-PATH-003 | T02/T03 | DONE | Windows-only case folding/POSIX preservation in storage foundation |
| BUG-KNOW-001 | T06/T09 | DONE | fresh import knowledge directory empty；no TODO/empty indexes |
| BUG-KNOW-002 | T09 | DONE | internal per-run staging, allowlist/realpath/hash and journaled recovery tests |
| BUG-INDEX-001 | T09 | DONE | process-global single writer/generation CAS in index concurrency test |
| BUG-LOG-001 | T05 | DONE | six levels, queue, segment/cleanup/cursor/fallback in structured logger tests |
| BUG-LOG-002 | T12 | DONE | single target UI, default seven days, flow/detail/cursor/theme browser tests |
| BUG-REQ-001 | T07 | DONE | recorder/adapters/write-only MCP metadata/deterministic binder tests |
| BUG-TOOL-001 | T08/T09 | DONE | trusted Git reader + staging realpath boundary；source/outside writes rejected |
| BUG-CONFIG-001 | T02/T04 | DONE | corrupt settings/projects fail typed and never silently overwrite facts |

## Test Scenarios

| Test | Owner | Status | Evidence |
|---|---|---|---|
| TS-01 | T06/T08/T10/T13 | DONE | real Hook commit in `full-integration-e2e-test.js` |
| TS-02 | T05/T06/T08/T13 | DONE | two offline commits + restart ordered catch-up in full E2E |
| TS-03 | T06/T08/T10 | DONE | `simple-import-test.js`、`tracking-start-test.js` |
| TS-04 | T08/T13 | DONE | restart/idempotency in pending sweep + full E2E |
| TS-05 | T03/T08/T13 | DONE | same SHA overlap/dedupe in reconciler concurrency |
| TS-06 | T06/T10 | DONE | simple import no staging/AI dispatch |
| TS-07 | T10/T12 | DONE | removed routes return 404；UI absence tests |
| TS-08 | T08 | DONE | Hook/startup prompt hash equality test |
| TS-09 | T08/T09 | DONE | scanner order + per-commit pointer/full E2E |
| TS-10 | T07/T08/T09 | DONE | recorder/binder/prompt/promotion assertions |
| TS-11 | T08/T10/T13 | DONE | removed-symbol test + final `rg` zero hits |
| TS-12 | T06/T10 | DONE | import Hook real trigger/readback/full E2E |
| TS-13 | T06/T10 | DONE | lifecycle import fault injection and rollback |
| TS-14 | T06/T10 | DONE | lifecycle delete removes exact managed Hook |
| TS-15 | T10/T12 | DONE | API/button absence tests |
| TS-16 | T06/T11 | DONE | repo move/runtime root verified in path/pending tests |
| TS-17 | T04/T06 | DONE | legacy managed Hook one-time migration/idempotency |
| TS-18 | T06 | DONE | Hook fixture asserts CLAUDE.md untouched |
| TS-19 | T03/T08/T09 | DONE | two-project state/index concurrency tests |
| TS-20 | T03/T08 | DONE | same-project in-flight dedupe + file lock |
| TS-21 | T02/T03 | DONE | AtomicFile before-rename fault retains original |
| TS-22 | T04 | DONE | legacy registry→index/per-project metadata; pointers preserved |
| TS-23 | T03/T06/T11 | DONE | stable projectId rename/move path consistency |
| TS-24 | T02/T06/T10/T12 | DONE | root required/write probe + API/UI rejection |
| TS-25 | T02/T06/T10/T12 | DONE | root-first import and fixed generated subdir |
| TS-26 | T03/T06/T11 | DONE | two absolute project knowledge paths in path consistency |
| TS-27 | T02/T06/T11 | DONE | old config fixed; later import uses changed root |
| TS-28 | T03/T11 | DONE | immutable identity/path on display rename |
| TS-29 | T02/T06/T09 | DONE | user root filesystem assertions contain Markdown only |
| TS-30 | T02/T10/T11 | DONE | server/MCP/CLI/runtime path consistency + packaged smoke |
| TS-31 | T06 | DONE | non-empty/conflicting knowledge target rejected |
| TS-32 | T06/T10 | DONE | import transaction stage failures reverse registry/Hook/metadata/dir |
| TS-33 | T06/T10/T12 | DONE | default preserve; explicit owned local delete only; team external never delete |
| TS-34 | T01/T02/T04 | DONE | migration retains AI key exactly and public API masks it |
| TS-35 | T04/T11 | DONE | legacy kbPath copied exactly, not recomputed |
| TS-36 | T02/T04/T09/T11 | DONE | fixed internal index migration/root-change assertions |
| TS-37 | T02/T04/T06 | DONE | fresh install/lazy requirements/recovery/runtime creation assertions |
| TS-38 | T05/T12 | DONE | six-level UI + light/dark Chromium visual QA |
| TS-39 | T05/T08/T10 | DONE | no-pending debug and state-change info log assertions |
| TS-40 | T05/T06/T10 | DONE | lifecycle operationId chain + UI flow |
| TS-41 | T05/T07–T10 | DONE | commit operation/project/run/SHA chain assertions |
| TS-42 | T05/T08–T10 | DONE | structured error/code/stack/phase/duration/cause + detail UI |
| TS-43 | T05/T10/T12 | DONE | logger EACCES/ENOSPC fallback and degraded health/UI |
| TS-44 | T02/T05/T09/T10 | DONE | valid JSONL after failure + unfinished operation/recovery tests |
| TS-45 | T04/T05/T10 | DONE | deleted snapshot + retained historical log query |
| TS-46 | T05/T10/T12 | DONE | default seven days/cursor multi-page/early stop tests |
| TS-47 | T05/T10 | DONE | retention 365/0 and max-size deterministic cleanup |
| TS-48 | T05/T12 | DONE | injectable segment rotation + cross-segment cursor/filter |
| TS-49 | T05/T06/T10 | DONE | offline Hook JSONL and real commits exit zero |
| TS-50 | T04/T05 | DONE | legacy log/config backup retained and v2 migration verified |
| TS-51 | T01/T05/T10/T11 | DONE | secrets absent from logs/stack/export/API/package audit |
| TS-52 | T12/T13 | DONE | single logging UI automated flow + actual Chromium visual QA |

## Source Plan Undefined IDs

| Test | Status | 说明 |
|---|---|---|
| TS-53 | UNDEFINED_IN_SOURCE_PLAN | 原始 Plan 未定义场景；未虚构验收。 |
| TS-54 | UNDEFINED_IN_SOURCE_PLAN | 原始 Plan 未定义场景；未虚构验收。 |
| TS-55 | UNDEFINED_IN_SOURCE_PLAN | 原始 Plan 未定义场景；未虚构验收。 |

## 最终结论

- T00–T13、R-*、BUG-*、TS-01–TS-52 全部 `DONE`；无 `TODO`、`IN_PROGRESS` 或 `BLOCKED`。
- TS-53–TS-55 仅因源 Plan 未定义而保持 `UNDEFINED_IN_SOURCE_PLAN`，不是实现阻塞。
- 未执行 commit、push、PR、release 或 tag。
