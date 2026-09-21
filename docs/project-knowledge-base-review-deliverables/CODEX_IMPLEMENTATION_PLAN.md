# CODEX_IMPLEMENTATION_PLAN.md

> **审查基线**：`SanQianX/project-knowledge-base` / `main` / `ba505bb2ae031e8d06ec3032657482f40d57ecf8`  
> **Plan 状态**：`READY_WITH_CHANGES`  
> **实施原则**：同一个开发分支/PR 内闭环完成，但按依赖分阶段、逐阶段验证；不制造一次性巨型补丁。

## 0. 使用说明

本文件是 Codex 的执行合同，不是第二份抽象设计文档。执行时：

1. 先读原重构 Plan、`PRO_REVIEW.md` 和本文件的“共享事实与决策索引”。
2. 核对当前 HEAD 与审查 SHA。若已变化，按符号和调用链重新定位，不盲从旧行号。
3. 保护用户 dirty worktree，不覆盖或 stash 未经授权的修改。
4. 建立一份主任务清单，按 T00–T13 的依赖推进。
5. 子 Agent 只获得其 Context Packet；共享高冲突文件由主 Agent 独占。
6. 每个任务先写/更新针对性测试，再实施，再运行该任务命令。
7. 任一必要测试失败时不得宣称完成。

## 1. 共享事实与决策索引

### 1.1 固定事实（F）

| ID | 事实 |
|---|---|
| F-001 | 审查源码 SHA 是 `ba505bb2ae031e8d06ec3032657482f40d57ecf8`，tag `v4.1.22`。 |
| F-002 | 当前有 5 个知识分析入口：导入 init、Hook、simulate、manual init、startup。 |
| F-003 | `server.js` 的 `SITE_ROOT` 实际是 `_site/ui`；Hook manager 在其后拼 `scripts/hook-trigger.js`。 |
| F-004 | Hook 脚本计算 `REPO_ROOT` 但发送导入时固定 repoPath。 |
| F-005 | 导入先写知识骨架和 `projects.json`，Hook/init 失败后仍返回 `ok:true`。 |
| F-006 | `projects.json` 同时保存项目配置与高频分析状态，使用 whole-file read-modify-write。 |
| F-007 | Commit evidence 当前只有 name list + `git show --stat`，没有真实 patch 和 requirement。 |
| F-008 | Claude idle/exit 0 当前可推进 Commit；索引异步发生在 pointer 推进后。 |
| F-009 | 旧 migration 以 `projects.json` 存在作为完成信号，允许部分迁移。 |
| F-010 | server、CLI、MCP/runtime 对 knowledge/index/config 路径有重复且不一致的解析。 |
| F-011 | 当前 Logger 只有 info/warn/error；retention 不执行；查询会读全量文件。 |
| F-012 | UI 有两套日志实现，默认查询当天。 |
| F-013 | API wildcard CORS + GET AI Profiles 原样返回 secrets 是本轮必须修复的 Critical Bug。 |
| F-014 | 原 Plan 实际有 TS-01–TS-52；TS-53–TS-55 未在源 Plan 中定义。 |
| F-015 | 产品不要求、也不允许本轮新增运行时 Token 审计、缓存、计费或 prompt 削减。 |

### 1.2 不可变产品决策（P）

| ID | 决策 |
|---|---|
| P-01 | 公开知识分析入口只有 Git post-commit Hook 和程序 startup 补查。 |
| P-02 | 两个入口必须调用同一 `reconcileProjectCommits(projectId, trigger)`；trigger 只允许 `git-hook`、`startup`。 |
| P-03 | 导入不做项目初始化分析，不扫描整个项目推测需求。 |
| P-04 | 新项目从 `trackingStartCommit` 后的第一个新 Commit 开始；空仓库的第一个 Commit 要分析。 |
| P-05 | 同一项目严格串行；某 Commit 失败时停止后续；多个项目可以并行。 |
| P-06 | Hook 导入自动安装并验证、删除自动卸载；没有手动 install/reinstall/uninstall API/UI。 |
| P-07 | Hook 只通知、不分析；服务未运行时不影响 `git commit`；不维护离线任务 spool。 |
| P-08 | 第三方 Hook 不覆盖；旧 managed Hook 只自动修复一次；Hook manager 不管理 CLAUDE.md。 |
| P-09 | Commit 知识尽量由唯一固定 prompt、用户真实需求和该 Commit 真实 Diff 共同形成。 |
| P-10 | 需求不可靠时写“需求上下文未记录”，只陈述代码可证明事实。 |
| P-11 | `projectId` 稳定；`projects.json` 只保存 index；config/state/requirements 按项目分离。 |
| P-12 | JSON/state 原子写；registry 有 global lock；project state/requirements 有 project/cross-process lock。 |
| P-13 | 用户先配置全局 knowledge root，再导入；每项目最终 `knowledgePath` 固定。 |
| P-14 | 改全局 root 只影响未来项目；旧项目不迁移、不重算。 |
| P-15 | 用户 knowledge root 只保存真实 Markdown；内部数据都在 `~/.project-knowledge`。 |
| P-16 | 单一内部 LanceDB；服务、CLI、MCP、索引器共享 StorageLayout。 |
| P-17 | AI Key 允许明文存 settings，但 API、日志、导出和错误必须脱敏。 |
| P-18 | 日志使用轻量 JSONL，六级、可关联、长期保存、轮转、容量、cursor、导出和单一 UI。 |
| P-19 | 迁移失败不丢项目、知识、Commit pointer、logs、AI 配置；失败可重试。 |
| P-20 | 保持轻量 Node.js 单进程架构，不新增微服务、消息队列或业务数据库。 |

### 1.3 已确认 Bug 索引（B）

完整证据见 `PRO_REVIEW.md §6`。实施任务通过以下集合引用：

- **Security**：BUG-SEC-001、BUG-SEC-002、BUG-TOOL-001。
- **Hook/lifecycle**：BUG-HOOK-001..004、BUG-LIFE-001..004。
- **Automation/knowledge**：BUG-AUTO-001..006、BUG-SCAN-001..002、BUG-KNOW-001..002。
- **State/migration/path/index**：BUG-STATE-001..003、BUG-MIG-001..002、BUG-PATH-001..003、BUG-INDEX-001、BUG-CONFIG-001。
- **Logging/UI**：BUG-LOG-001..002。
- **Requirements**：BUG-REQ-001。

### 1.4 需求 ID（R）

| ID | 需求 |
|---|---|
| R-TRG-01 | 删除三个多余分析入口，只保留 Hook/startup。 |
| R-TRG-02 | 两入口进入同一 reconciler、同一 prompt。 |
| R-TRG-03 | tracking baseline、无 init、旧 pointer 兼容。 |
| R-TRG-04 | 单项目互斥、Commit 顺序、失败停止、重复通知幂等。 |
| R-REQ-01 | 各 AI 客户端只记录需求，不触发分析。 |
| R-REQ-02 | project/session/branch/ancestry 确定性绑定；歧义回退。 |
| R-HOOK-01 | import 自动安装并验证真实 trigger。 |
| R-HOOK-02 | delete 自动卸载 managed Hook。 |
| R-HOOK-03 | 删除手动 Hook API/UI。 |
| R-HOOK-04 | runtime repo、第三方冲突、worktree/core.hooksPath、no CLAUDE.md。 |
| R-HOOK-05 | versioned managed Hook 一次性 repair。 |
| R-DATA-01 | stable projectId、index-only registry、per-project metadata。 |
| R-DATA-02 | atomic file、global/project locks、requirements append。 |
| R-DATA-03 | versioned all-or-nothing migration 与兼容 fallback。 |
| R-PATH-01 | global root → immutable project knowledgePath。 |
| R-PATH-02 | user knowledge/internal data 隔离。 |
| R-PATH-03 | StorageLayout 与 internal LanceDB 单一路径。 |
| R-LIFE-01 | import transaction、回滚、目录冲突保护。 |
| R-LIFE-02 | safe delete、默认保留 external Markdown。 |
| R-KNOW-01 | real patch、staging、validation、journaled promotion。 |
| R-KNOW-02 | Markdown truth、index derived、single writer、dirty retry。 |
| R-LOG-01 | log/v2 六级、稳定 event、结构化 error。 |
| R-LOG-02 | operation/run/project/commit 全链路覆盖。 |
| R-LOG-03 | writer queue、rotation、retention、capacity、fallback、recovery。 |
| R-LOG-04 | cursor API、filters、export、recursive redaction。 |
| R-UI-01 | 单一目标日志 UI，最近 7 天、详情链路、主题/响应式。 |
| R-COMP-01 | 删除旧接口、prompt、配置和死代码，不留双路径。 |
| R-SEC-01 | secrets、origin/auth、path traversal、safe errors。 |

## 2. 目标模块图与依赖方向

```text
routes / desktop / hook / MCP / CLI
                   │
                   ▼
     ProjectLifecycle / RequirementRecorder / CommitReconciler
        │                    │                  │
        ├── HookManager      └── ProjectStore   ├── CommitScanner
        ├── GitReader                            ├── RequirementBinder
        └── Stores/Layout                        ├── CommitAnalyzer
                                                 └── KnowledgePromotion
                                                           │
                                                           ▼
                                                      IndexService

all stores/services ──> Logger child contexts
all path consumers ──> StorageLayout
all durable files ───> AtomicFile + Lock
MigrationService ─────> public Store APIs; never writes ad hoc live files
LogRepository ────────> immutable Logger segments
```

**依赖约束**：

- `StorageLayout` 不依赖业务 service。
- `AtomicFile/Lock` 不依赖 stores。
- stores 依赖 Layout/AtomicFile，不依赖 HTTP。
- lifecycle/reconciler 依赖 stores；routes 只能依赖 services。
- Logger core 不依赖业务模块；业务可创建 child logger。
- IndexService 依赖低层 DB/indexer，不反向调用 reconciler。
- MigrationService 可调用 stores 的 migration/import API，但正常 runtime 不依赖 migration implementation。
- UI 只调用稳定 API，不解析日志/项目文件。

## 3. 状态与数据流

### 3.1 Import transaction

```text
validate settings root and repo
  -> acquire registry lock
  -> detect duplicate Git identity/path
  -> allocate projectId + immutable storageName + knowledgePath
  -> assert target is empty/new or proven same project
  -> create transaction journal
  -> initialize/inspect Git
  -> create minimal project metadata config/state
  -> establish trackingStartCommit or empty-repo mode
  -> install + verify Hook v2
  -> add projectId to registry last
  -> commit journal
```

导入期间不创建 TODO knowledge files，不要求 AI Profile。失败按 journal 逆序回滚，只删除本事务可证明创建且未被修改的资产。

### 3.2 Hook/startup reconciliation

```text
Hook(projectId, runtimeRepoRoot) OR startup(projectId)
  -> per-project in-flight dedupe
  -> verify/update repoPath identity
  -> acquire project lock
  -> resolve baseline
  -> verify baseline is ancestor of HEAD
  -> list commits reverse/topological
  -> for each commit:
       freeze claim and evidence
       bind requirement or unavailable
       run single commit prompt into staging
       validate outputs
       journal + promote Markdown
       advance state + indexDirty
       enqueue IndexService
     stop on first pre-advance failure
  -> optional rescan if notification arrived while running
```

### 3.3 Requirement flow

```text
Claude/Codex/OpenCode user request
  -> RequirementRecorder.record(projectId, client, session/conversation, text)
  -> append requirements.jsonl under project lock
  -> return requirementId
  -> client continues normal coding
  -> no knowledge analysis is triggered
```

Bind priority:

1. explicit requirementId attached to session/commit workflow and same project;
2. same project + same client/session + same branch + `headAtRecord` ancestor of commit;
3. unique candidate within the session’s unclaimed sequence;
4. otherwise `unavailable`.

### 3.4 Knowledge/index success boundary

```text
AI output -> staging manifest -> validation -> promotion journal
-> final Markdown atomically replaced -> state.lastAnalyzedCommit advanced
+ state.index.dirty=true -> global IndexService serial mutation
-> dirty=false on success
```

Index failure never re-runs AI or removes truthful Markdown.

### 3.5 Logging flow

```text
logger.child({component, projectId, operationId, ...})
 -> recursive redaction + size bounds
 -> single async write queue
 -> app/hooks/projects daily segment
 -> rotate at 50 MiB
 -> flush on shutdown

LogRepository:
 newest matching segment -> reverse scan -> filters -> pageSize -> cursor
```

## 4. 共享 Schema 与错误合同

主 Agent在 T01 冻结以下文件/对象；后续任务不得独自改变字段语义：

- `settings/v2`
- `project-registry/v2`
- `project-config/v2`
- `project-state/v2`
- `requirement/v1`
- `commit-claim/v1`
- `promotion-journal/v1`
- `migration-journal/v1`
- `log/v2`
- API error envelope

### 4.1 API error envelope

```json
{
  "ok": false,
  "error": {
    "code": "HOOK_CONFLICT",
    "message": "A non-managed post-commit hook already exists.",
    "operationId": "op-...",
    "retryable": false,
    "details": {}
  }
}
```

- `details` 不得包含 stack、secrets、完整 prompt/diff/header。
- stack/cause 只写脱敏日志。
- route 负责 HTTP status 映射；service 抛 typed domain error。

### 4.2 Trigger contract

```js
reconcileProjectCommits(projectId, trigger)
// trigger: 'git-hook' | 'startup'
```

任何其他值在边界处拒绝。`trigger` 不参与 prompt 渲染。

### 4.3 Project identity contract

- public API 和 logs 主键使用 projectId；slug/displayName 仅显示。
- Hook v2 同时发送 projectId、runtime repoRoot、HEAD/branch（可选提示）；server 重新从 Git 验证。
- project rename/move 不生成第二个 metadata directory。

## 5. 任务依赖图

```text
T00 Baseline/characterization
  └─> T01 Shared contracts/security policy
       ├─> T02 StorageLayout/AtomicFile/SettingsStore
       │    └─> T03 RegistryStore/ProjectStore/locks
       │         └─> T04 MigrationService
       │         ├─> T07 RequirementRecorder
       │         └─> T08 Scanner/Reconciler
       ├─> T05 Logger/LogRepository
       │    ├─> T06 Lifecycle/Hook v2
       │    ├─> T08 Scanner/Reconciler
       │    └─> T12 Logging UI
       └─> T06 Lifecycle/Hook v2 (also needs T02/T03/T04)

T07 ─┐
T08 ─┼─> T09 KnowledgePromotion/IndexService
T02 ─┤
T03 ─┤
T05 ─┘

T06 + T08 + T09 -> T10 server/API integration and legacy deletion
T02 + T03 + T09 -> T11 CLI/MCP/runtime path unification
T05 + T10 API contract -> T12 single logging UI
T04 + T06 + T07 + T08 + T09 + T10 + T11 + T12 -> T13 final E2E/migration/Windows/docs
```

### 5.1 安全并行窗口

- T05 Logger 与 T07 RequirementRecorder 可在 T03 schema 冻结后并行，前提是文件不重叠。
- T08 scanner/reconciler 与 T06 Hook/lifecycle 可并行开发低层模块，但都不得同时编辑 `server.js`。
- T11 CLI/MCP 与 T12 UI 可在 T10 API contract 冻结后并行。
- T02、T03、T04、T10 共享面大，必须串行由主 Agent或同一集成 Agent完成。

## 6. 文件所有权表

| 文件/范围 | 独占者 | 允许协作者 | 规则 |
|---|---|---|---|
| `_site/server.js` | 主/集成 Agent | 只读所有 Agent | 仅 T10/T13 修改；其他任务输出 adapter diff 建议 |
| shared schema/constants | 主 Agent | 只读 | T01 冻结；变更需主 Agent更新所有 dependent facts |
| `StorageLayout` / SettingsStore | T02 原 Agent | T04/T11 只调用 | 不并发编辑 |
| `ProjectRegistryStore` / `ProjectStore` | T03 原 Agent | T04/T07/T08 只调用 | 后续缺陷优先复用该 Agent |
| migration entry/service | 主 Agent/T04 | 其他只读 | 只能一人改 activation/version |
| Logger core / LogRepository | T05 Agent | T12 只消费 API | server wrapper 由 T10 集成 |
| Hook manager/trigger tests | T06 Agent | T10 只集成 routes | 不改 server route |
| Requirement store/adapters | T07 Agent | T08 只读 binder contract | MCP UI wiring可由 T11/T10集成 |
| scanner/reconciler/prompt tests | T08 Agent | T09 消费 claim | 不改 promotion/index internals |
| promotion/index/DB writer tests | T09 Agent | T11 只消费 | 不改 server |
| CLI/MCP/runtime | T11 Agent | 主 Agent review | 不改 shared Layout contract |
| `ui/index.html` / UI tests | T12 Agent | T10 提供 API contract | 单一 owner，避免冲突 |
| 同一 `_test/*.js` | 对应 Task owner | 无并发编辑 | ownership 写入主清单 |
| package/lock/workflows | 主 Agent | T13 | 仅真实依赖变化才修改，不为审查“顺手”升级 |

## 7. 阶段门与测试层级

| Gate | 完成任务 | 必须通过 |
|---|---|---|
| G0 | T00 | 完整基线记录、syntax、package dry-run；已知失败分类 |
| G1 | T01–T04 | store/schema/migration/atomic/lock tests；旧数据只读 fallback |
| G2 | T05–T07 | Logger、Hook import/delete、requirement append/binding tests |
| G3 | T08–T09 | unified reconciler、staging/promotion/index dirty/concurrency tests |
| G4 | T10–T12 | API security、legacy route absence、CLI/MCP path、UI regression |
| G5 | T13 | full `npm test`、desktop、pack、migration fixtures、E2E、Windows/manual UI |

测试调度：

- 任务内只跑针对性测试。
- schema/path/migration 变更后扩大到相关 cross-module tests。
- G3、G4 才运行受影响范围回归。
- G5 运行一次全量，不在每个小 patch 重复全量。
- 已知基线失败由 T00 记录一次；责任 Task 修复后再复核，不让多个 Agent重复调查。

## 8. 开发上下文效率

### 8.1 单一共享事实

- 本文件 §1–§4 是唯一共享定义；任务通过 F/P/R/B/TS ID 引用。
- 不把完整原 Plan、完整 PRO_REVIEW 或完整聊天历史转发给每个 Agent。
- 共享事实只有在其 owner 修改对应合同后才失效；主 Agent更新受影响条目。

### 8.2 Context Packet 格式

每个 Agent只接收：

```text
Task ID / target
Required P/R/B/TS IDs
Prerequisite artifacts
Must-read files + symbols + tests
Allowed edit set
Forbidden edit set
Frozen contracts
Task-specific commands
Acceptance + handoff format
```

### 8.3 检索策略

- 先 `rg`/`rg --files` 定位符号，再打开相关函数邻近范围。
- 独立只读检索可并行；有因果依赖的调用链串行追踪。
- 大文件只读相关函数及共享 state 定义；确需全局理解时才全文。
- 文件未变时复用已确认事实；共享文件变更只使相关事实失效。
- 大量 deterministic 搜索、route inventory、path join inventory、test mapping 用脚本生成，不由多个 Agent重复总结。

### 8.4 交接格式

每个 Task 的 handoff 不超过以下内容：

1. 完成项与未完成项。
2. 修改文件/符号。
3. 新决策或 shared fact 变更。
4. 执行命令、exit code、失败摘要。
5. 剩余风险/阻塞。
6. 下一任务必须知道的 contract。

不得粘贴无关完整测试日志。

### 8.5 效率验收

- 每项需求在 §1 完整定义一次。
- 每个 Task 有最小充分 Context Packet。
- 不做第二次全仓库审查。
- 共享高冲突文件没有并发 owner。
- 全量测试仅 G0（基线）、必要 Gate、G5；任务内 targeted。
- 同模块返修优先回到原 Agent。
- 不省略源码证据、迁移、Windows、UI、最终 diff。
- 不声称无法测量的“Token 降低百分比”。可用 context packet 字节数、读取文件数、重复读取数作为估算。
- 不新增任何项目运行时 Token 功能。

## 9. 真实命令目录

以下命令已在仓库存在或由 Node/Git 提供；实施时不得编造脚本名。

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
node --check <changed-js-file>
node _site/_test/<specific-test>.js
git status --short
git diff --check
git diff --stat
git diff -- <path>
```

Windows stage 使用现有 GitHub workflow 中的真实 packaged app/LanceDB smoke 命令；如果 workflow 在当前 HEAD 后变化，先读 workflow 再执行。

## 10. 实施任务

### T00 — 基线、保护现场与特征测试

**目标与可观察结果**

- 在当前 checkout 建立可复现 baseline；保护用户修改。
- 为本轮将改变的隐式行为补 characterization tests，先证明现状，再改变预期。
- 输出 `BASELINE.md` 或主任务清单中的等价简洁记录，不创建重复长报告。

**前置依赖**：无。  
**负责角色**：主 Agent。  
**并行**：只读 inventory 可并行；任何代码修改暂不并行。

**Context Packet**

- F-001..F-015。
- P-01..P-20，仅作为后续测试目标。
- B 全部索引；本任务不修复。
- 仓库根、package scripts、workflows、所有 AGENTS（当前审查基线无 AGENTS，但必须重新查）。

**开始前必须读取**

- `package.json`、lockfile、`.github/workflows/*`。
- `_site/_test/run-all-tests.js`。
- `git status`、branch、HEAD、worktree/list。
- 与当前 dirty files 相关的 diff；不得只看 staged。

**允许修改**

- 新增/调整本轮相关 characterization tests。
- 主任务清单/基线记录。

**禁止修改**

- 生产源码、lockfile、package dependencies、用户已有修改。
- 不执行 reset/clean/stash/rebase/checkout 覆盖。

**具体步骤**

1. `git status --short --branch`、`git rev-parse HEAD`、`git worktree list --porcelain`。
2. 若 HEAD 不同于 F-001，生成 compare summary：改动文件、触及共享合同、测试变化；更新主清单，不重用旧行号。
3. 读取 AGENTS/README/package/workflows。
4. `npm ci`；依赖失败记录精确阻塞，不改 lock 绕过。
5. 执行完整 baseline 一次。
6. 生成 route inventory、config/path writer inventory、`console.*`/empty catch inventory。
7. 为以下行为写失败/characterization tests：
   - production import Hook path；
   - Hook failure import result；
   - two-project registry lost update；
   - init analysis current trigger；
   - AI profile GET secret exposure；
   - logging default today/read-all；
   - migration partial marker。
8. 将 baseline failures 标为 `SOURCE_BASELINE` 或 `ENVIRONMENT`，指定后续 owner。

**验证命令**

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
git diff --check
```

**验收**

- HEAD/dirty state 有记录且未被改变。
- 全量命令每条有 exit code；“未运行”不写“通过”。
- 特征测试能在旧实现上稳定证明关键缺陷，或用注释明确 expected-failure 机制；不能长期把失败测试提交到 main，后续 Task 必须转绿。

**失败/恢复**

- 依赖安装失败：保留日志，继续只读/纯 Node 特征测试，但 G5 必须在具备依赖的环境完成。
- 发现用户修改与目标文件冲突：不覆盖；主 Agent调整 patch strategy。

**最小交付**

- baseline command table。
- changed/dirty protection note。
- characterization test list 与 owner。

**映射**：F-001..015；所有 B；TS-01..52 的 baseline 前置。

---

### T01 — 冻结共享 Schema、状态机与 API 安全合同

**目标与可观察结果**

- 建立一个共享 schema/constants 模块和 contract tests。
- 冻结 project/settings/state/requirement/claim/log/error/trigger 语义。
- 修正 Plan 未定义边界，但暂不大规模接线。

**前置依赖**：T00。  
**负责角色**：主 Agent/架构 owner。  
**并行**：否；这是后续所有任务的串行 gate。

**Context Packet**

- P-01..P-20；R 全部。
- F-002、F-006..F-015。
- BUG-SEC-001、BUG-STATE-001、BUG-MIG-001、BUG-REQ-001。
- `PRO_REVIEW.md §7.5–§7.6`。

**必须读取**

- `_site/server.js` project normalization/API response helpers。
- `_site/lib/post-commit-automation.js` run/state fields。
- `_site/lib/structured-logger.js` schema。
- `_site/lib/data-dir.js` migration markers。
- `_site/lib/automation-config.js` prompt config。
- relevant tests: `baseline-schema-test.js`、`ai-profile-test.js`、`post-commit-automation-test.js`。

**允许修改**

- 新增一个轻量 shared contracts/schema module。
- 对应 contract tests。
- 必要的 pure validation helpers。

**禁止修改**

- `server.js` route wiring。
- Storage/Hook/Reconciler 实现。
- UI。

**具体修改**

1. 定义 schema versions 和 enum：trigger、analysis phase、log level、error code。
2. 定义 validators/normalizers；无效关键 state 必须返回 typed corruption error，不默认空。
3. 定义 `publicAiProfileView()`：无 secret，只含 `hasApiKey`/mask。
4. 定义 API error envelope 和 domain error base class。
5. 定义 immutable/mutable project fields。
6. 定义 claim freeze contract：requirementIds、promptVersion/hash、patchHash、knowledgePath、phase。
7. 定义 migration completion 的唯一条件：verified activation marker last。
8. 定义 history divergence 和 empty-repo 状态。
9. 定义 log redaction key patterns 与 max field lengths，供 T05 实现。
10. 将原 Plan TS-53–55 标为 source undefined，不新增虚构需求。

**错误行为**

- schema mismatch：`SCHEMA_UNSUPPORTED`。
- JSON corruption：`DATA_CORRUPT`，含 file category 和 operationId，不含敏感内容。
- invalid trigger：`INVALID_TRIGGER`。
- immutable patch：`IMMUTABLE_FIELD`。

**测试**

- schema valid/invalid fixtures。
- secrets public view。
- trigger only two values。
- state transition table。
- immutable config fields。
- error serialization removes stack/secrets。

**验证命令**

```bash
node _site/_test/baseline-schema-test.js
node _site/_test/ai-profile-test.js
node --check <new-contract-module>
```

**验收**

- 后续 Task 可以只引用 imports，不重复声明字段。
- shared schema 没有业务 I/O。
- contract tests 覆盖每个 enum/version/transition。

**失败/回滚**

- 若当前 consumers 太多，先提供 adapter validators；不得在 T01 同时重写所有调用者。
- contract 变更必须由主 Agent更新 §1 shared facts 和 dependent Context Packets。

**最小交付**

- schema module path、export list、contract test results。

**映射**：R-DATA-01..03、R-REQ-01..02、R-LOG-01、R-SEC-01；BUG-SEC-001、BUG-CONFIG-001。

---

### T02 — StorageLayout、AtomicFile、SettingsStore

**目标与可观察结果**

- 所有目标路径有唯一解析器。
- settings 合并到 `settings.json`，但此 Task 只建立新 store 和兼容 reader；激活由 T04。
- 提供可崩溃恢复的单文件写、JSONL append 和跨进程锁基础。

**前置依赖**：T01。  
**负责角色**：Storage Agent；后续返修继续使用同一 Agent。  
**并行**：否；T03/T04/T11 依赖其合同。

**Context Packet**

- P-12..P-17、P-19、P-20。
- R-DATA-02、R-PATH-01..03、R-SEC-01。
- BUG-STATE-002..003、BUG-PATH-001..003、BUG-CONFIG-001。
- F-009、F-010。

**必须读取**

- `_site/lib/data-dir.js`
- `_site/lib/knowledge-store.js`
- `_site/lib/knowledge-storage-location.js`
- `_site/lib/embedding-config.js`（或实际配置模块）
- `_site/lib/ai-profile-store.js`/实际 profile module
- `_site/lib/structured-logger.js` 的 path usage
- `bin/project-knowledge-kb.js`
- tests: `data-dir-migration-test.js`、`embedding-config-test.js`、`knowledge-store-*`、`knowledge-storage-location-test.js`、`kbpath-follow-test.js`。

**允许修改**

- 新增/重构 StorageLayout、AtomicFile/lock、SettingsStore。
- 上述模块的 compatibility read helpers。
- 对应新测试和 owned existing tests。

**禁止修改**

- `server.js`。
- migration activation/version（T04）。
- project stores（T03）。
- CLI/MCP consumers（T11）。

**具体修改**

1. `StorageLayout` 提供：
   - `getDataDir()`；
   - `getSettingsPath()`；
   - `getProjectRegistryPath()`；
   - `getProjectMetadataDir(projectId)`；
   - `getIndexPath()`；
   - `getCachePath()`；
   - `getRuntimePath()`；
   - `getLogPath(scope, projectId)`；
   - `getRecoveryPath()`；
   - `resolveNewProjectKnowledgePath(storageName)`；
   - `getProjectKnowledgePath(config)`。
2. 不在用户 knowledge root 创建 `.project-knowledge`、DB、logs、cache。
3. path equality 只在 Windows 使用 case-insensitive comparison；POSIX 保留大小写。
4. realpath boundary helper 使用 `path.relative()`，支持尚未创建路径的最近存在 ancestor。
5. knowledge root validation 做真实 write probe（创建随机空 temp 并删除），不创建业务文件。
6. AtomicFile：same-dir temp、exclusive create、fsync、rename、Windows retry/backoff、best-effort dir fsync、cleanup stale temp。
7. lock：带 owner pid/start time/nonce；stale lock 需验证 pid/age；timeout 返回 typed error。
8. `appendJsonlLocked()` 每条单次 append+flush，确保合法 JSON 行。
9. SettingsStore 支持 read strict、update patch、public view；unknown fields 在 migration compatibility 中保留到扩展区，不静默丢。
10. AI key at-rest 保持原值；public view 永不返回。
11. 程序启动不预建可选 cache/recovery/integration 目录。

**测试**

- Windows/POSIX path normalization fixtures。
- user root 不出现 internal subdir。
- old/new index path resolution consistency。
- write interruption: original remains valid。
- concurrent writers/lock timeout/stale lock。
- settings secret public view。
- root write probe failure。
- temp cleanup 不删非本系统文件。

**验证命令**

```bash
node _site/_test/data-dir-migration-test.js
node _site/_test/embedding-config-test.js
node _site/_test/knowledge-store-logs-supervision-test.js
node _site/_test/knowledge-storage-location-test.js
node _site/_test/kbpath-follow-test.js
node --check <changed-storage-files>
```

**验收**

- 新代码中所有新路径通过 StorageLayout。
- SettingsStore 读取失败不会返回空默认并覆盖 live file。
- AtomicFile fault-injection tests 证明原文件保持可解析。
- 不移动 DB、不改旧 project kbPath；迁移仍未激活。

**失败/恢复**

- Windows directory fsync 不支持可记录 debug，但 file flush/rename 必须完成。
- lock owner 不确定时宁可超时失败，不强删可能活跃 lock。

**最小交付**

- API exports、path table、fault-injection test summary。

**映射**：TS-21、24–30、34–37、43–44；BUG-STATE-003、BUG-PATH-001..003、BUG-CONFIG-001。

---

### T03 — ProjectRegistryStore、ProjectStore、stable projectId 与并发锁

**目标与可观察结果**

- `projects.json` 只保存 index/order。
- 每项目 config/state/requirements 独立。
- 同项目 state/requirements 写串行，不同项目写互不覆盖。

**前置依赖**：T02。  
**负责角色**：Project Store Agent。  
**并行**：否；T04/T07/T08 依赖。

**Context Packet**

- P-05、P-11、P-12、P-19。
- R-DATA-01..03、R-TRG-04。
- BUG-STATE-001..003、BUG-AUTO-005、BUG-STATE-002。
- project schema from T01；AtomicFile/Layout from T02。

**必须读取**

- `_site/server.js · normalizeProjectConfig/readProjects/writeJson/automationDeps`。
- `_site/lib/commit-automation-store.js`。
- `_site/lib/knowledge-scope-registry.js`。
- `_site/lib/post-commit-automation.js` state callbacks。
- tests: `baseline-schema-test.js`、`tracking-start-test.js`、`pending-sweep-test.js`、`project-remove-running-guard-test.js`。

**允许修改**

- 新 stores 与 lock coordinator。
- commit automation store compatibility adapter。
- owned store/state tests。

**禁止修改**

- `server.js` direct callers（T10）。
- migration activation（T04）。
- reconciler logic（T08）。
- UI/CLI/MCP。

**具体修改**

1. Registry store only `list/add/remove/reorder/readDisplaySnapshot` under global write lock。
2. ProjectStore validates projectId directory name and config.projectId equality。
3. Config updates use explicit mutable-field patch; knowledgePath only dedicated migration operation。
4. State update API accepts compare-and-set revision or executes callback under lock；store increments `revision`。
5. Requirements append under same project lock/cross-process file lock；no file until first record。
6. `withProjectLock(projectId, fn)` provides in-process Promise dedupe plus cross-process lock where mutation spans files。
7. Invalid JSON: surface typed corruption; optional verified backup recovery; never `{}` fallback。
8. Existing slug lookups become compatibility resolver returning projectId, read-only until T04 migration。
9. Scope bindings that are project-specific move into config schema adapter; global scope left for settings migration。
10. Add repository identity fields needed to detect duplicate import/move without making path primary identity。

**测试**

- simultaneous project A/B updates preserve both pointers。
- two writers same project serialize/revision conflict。
- state crash before rename leaves old valid。
- requirements concurrent append lines all parse and IDs unique。
- rename display/repo path leaves projectId/metadata dir/knowledgePath unchanged。
- registry add/delete lock and duplicate protection。
- corrupt state stops, does not replay from empty。

**验证命令**

```bash
node _site/_test/baseline-schema-test.js
node _site/_test/tracking-start-test.js
node _site/_test/pending-sweep-test.js
node _site/_test/project-remove-running-guard-test.js
node _site/_test/project-store-test.js
```

`project-store-test.js` 是本任务应新增的真实文件；若采用其他明确名称，同步主清单，不得引用不存在命令。

**验收**

- 新 store tests 无 direct whole-registry state update。
- projectId 是锁、目录、日志关联主键。
- requirements 文件 lazy-created。
- compatibility adapter 没有双写 live state。

**失败/恢复**

- lock timeout：返回 `PROJECT_BUSY`，不尝试无锁写。
- corrupt registry：进入 read-only/degraded，保留文件和 backup；不自动清空。

**最小交付**

- store API、concurrency test matrix、legacy adapter constraints。

**映射**：TS-19–23、26、28、37；BUG-STATE-001..003、BUG-AUTO-005。

---

### T04 — Versioned MigrationService 与旧布局兼容

**目标与可观察结果**

- 旧 settings/projects/kbPath/index/logs 可一次性迁到 v2；任一失败继续使用旧数据。
- completion marker 只在全部 staging、验证、激活和打开测试成功后写入。
- migration 可中断恢复、可重试，不产生混合事实源。

**前置依赖**：T03。  
**负责角色**：主 Agent/Migration owner。  
**并行**：否；高冲突共享入口。

**Context Packet**

- P-11..P-19。
- R-DATA-03、R-PATH-01..03、R-HOOK-05、R-LOG-03。
- BUG-MIG-001..002、BUG-PATH-001..002、BUG-CONFIG-001。
- T01 schema、T02 AtomicFile/Layout、T03 Stores。

**必须读取**

- `_site/lib/data-dir.js`
- `_site/lib/knowledge-store.js`
- `_site/lib/knowledge-storage-location.js`
- all old config readers/writers located by T00 inventory
- `_site/lib/commit-automation-store.js`
- existing migration tests: `data-dir-migration-test.js`、`knowledge-migration-test.js`、`knowledge-storage-startup-test.js`、`knowledge-storage-location-test.js`。

**允许修改**

- MigrationService、migration journal/manifest helpers。
- old readers as compatibility fallback。
- migration tests/fixtures。

**禁止修改**

- server startup wiring beyond a thin test harness; T10 integrates it。
- Hook implementation（T06）。
- Logger implementation（T05）；可用 injected stub。
- 删除任何旧数据/backup。

**具体修改**

1. discovery 阶段枚举所有 legacy paths，并记录 source hash/size/mtime。
2. 创建 `recovery/layout-v2-<id>/manifest.json` 与 staging dir；不覆盖 live target。
3. Settings merge：knowledge root、AI profiles、embedding、logging、prompt overrides、enabled integrations；secret bytes/hash 保持。
4. 为每个旧 project：
   - 沿用可用 projectId；无则生成 stable ID 并在 migration map 中固定；
   - `kbPath` 原值迁 `knowledgePath`；缺失才按旧 root+slug 解析一次；
   - config/state 分离，保留 tracking/last analyzed；
   - project-init 历史知识不删；只停止新生成。
5. old commit automation queue：
   - 已完成记录只归档诊断；
   - pending/current run 转为 activeClaim only if commit/evidence 完整；否则留 migration warning，由 Git scanner 从 safe baseline 重扫；
   - 不把 queue 当第二事实源。
6. index：探测所有已知旧位置；只复制，不移动；验证可以打开、表存在、记录计数/抽样；成功后 v2 settings/layout 指向 internal index。
7. logs：新 reader 兼容旧 `.log` 和 `.hook-trigger-errors.log`；保留原始文件。可复制到 recovery/archive，但不删。
8. Hook migration inventory 只写待处理 state；实际文件修复由 T06，完成后更新 hook migrationVersion。
9. activation：所有 staged files先关闭；按 manifest原子 rename；最后写 `layout-v2.completed.json`；再用 v2 stores重新打开验证。
10. 打开验证失败：标记 `activation-failed`，恢复旧 reader pointer；不自动删除新目录。
11. migration 不为未启用的 team/recovery/cache 功能创建空目录。
12. migration backup cleanup 不在本轮自动执行。

**迁移错误行为**

- source changed during migration：`MIGRATION_SOURCE_CHANGED`，停止激活。
- target conflict：`MIGRATION_TARGET_CONFLICT`，不 overwrite。
- index validation failure：保留旧 index reader，整体 migration 不标 complete。
- secret mismatch：Critical/fatal，停止。

**测试**

- fresh install no legacy data。
- full old fixture to v2。
- failure after each numbered stage and restart recovery。
- `projects.json` staged但后续失败，下次仍继续。
- old kbPath remains exact even if global root differs。
- old root missing/target conflict no config switch。
- index copy open/count failure rollback。
- API key exact preservation。
- old logs remain queryable。
- no optional empty dirs。
- idempotent second startup does not rerun completed migration。

**验证命令**

```bash
node _site/_test/data-dir-migration-test.js
node _site/_test/knowledge-migration-test.js
node _site/_test/knowledge-storage-startup-test.js
node _site/_test/knowledge-storage-location-test.js
node _site/_test/project-layout-v2-migration-test.js
```

**验收**

- 所有 fault-injection stage 都满足“旧数据可读、completion marker 未提前写”。
- v2 activation 后 registry/config/state paths 正确，Commit pointers 不变。
- migration 第二次运行只做验证，不重复写 Hook/项目文件。

**失败/恢复**

- 不删除 staging/backup；写清晰 operationId 和 resume stage。
- 若未知 legacy field 无法映射，保存在 `legacyExtensions` 或 backup manifest，不能丢弃后继续 complete。

**最小交付**

- migration stage table、fixtures、completion marker contract、test report。

**映射**：TS-17、22、34–37、45、50；BUG-MIG-001..002、BUG-CONFIG-001。

---

### T05 — Logger v2、LogRepository、保留/容量/导出

**目标与可观察结果**

- 唯一正式 Logger 提供 trace/debug/info/warn/error/fatal。
- 写入合法 JSONL，支持 rotation、retention、capacity、health fallback。
- LogRepository 按新到旧 cursor scan，不全量载入多年日志。
- 旧 `.log` 与 Hook error log 仍可读。

**前置依赖**：T01、T02；ProjectStore context 可在 T03 后接入。  
**负责角色**：Logging Agent。  
**并行**：可与 T07 并行；不得编辑 server/UI。

**Context Packet**

- P-17、P-18、P-19。
- R-LOG-01..04、R-SEC-01。
- BUG-LOG-001..002、BUG-SEC-001。
- log/v2/redaction contract from T01；Layout/AtomicFile from T02。

**必须读取**

- `_site/lib/structured-logger.js`
- `server.js · logEvent/readLogs/logging endpoints/startup console`
- `ui/index.html` logging API usage（只读）
- `_site/scripts/hook-trigger.js` fallback logging
- tests: `knowledge-store-logs-supervision-test.js`、`logging-api-test.js`/如不存在则确认、`ui-smoke-test.js`。

**允许修改**

- structured logger replacement/compat wrapper。
- LogRepository、redaction、rotation/cleanup/export helpers。
- owned backend logging tests。

**禁止修改**

- `server.js` routes（T10）。
- UI（T12）。
- project business modules；提供 child API 供后续接线。

**具体修改**

1. Logger methods、stable event names、child context merge；每条生成 id/UTC ts。
2. context field whitelist/normalization；`projectId`、`operationId`、`runId`、`commitSha`、`phase` 为顶层。
3. serialize Error 保留 name/code/message/stack/cause chain，执行路径/长度限制和 recursive redaction。
4. redaction覆盖 key names、Bearer/basic auth、URL credentials、known settings secret values、headers、query tokens；导出复用同一函数。
5. single writer queue；每条 JSON 单行；close flush；未捕获异常尽最大努力 flush。
6. paths：app/hooks/projects/<id>；daily segment；50 MiB 后 `.001`、`.002`。
7. Hook offline writer 使用最小同步/独立队列实现，失败 stderr，但始终 exit 0。
8. retention：默认 365，0 表示不按时间删除。
9. capacity deterministic algorithm：
   - 删除过期 closed segments；
   - 计算 total；接近阈值 warn；
   - 超限时按 oldest，优先没有 warn/error/fatal 的低等级 segment；
   - 保护 active segment、配置的 recent error/fatal window；
   - 仍无法释放时停止 trace/debug（必要时 info），保持 error/fatal+stderr，并暴露 health degraded。
10. cleanup 每次 startup 后和 daily scheduler；自身结果记录到 app log，避免无限递归。
11. query filters：from/to/levels/projectId/component/event/commitSha/operationId/q/pageSize/cursor。
12. cursor 包含 segment identity + byte offset/direction + filter fingerprint；篡改/过期返回可重启查询的 typed error。
13. reverse scan closed files；活动文件读取稳定 snapshot；达到 pageSize 即停。
14. export 对范围/项目应用同一 filter/redaction，使用 streaming output；不得导出 secrets/full prompts/diffs。
15. old reader adapter 支持 `.log` 和 legacy schema；不重写原始文件。
16. Logger write failure设置 process health，error/fatal fallback stderr；禁止空 catch。

**测试**

- six level threshold/filter。
- context inheritance and stable event names。
- error cause/stack + recursive redaction。
- API keys/tokens/headers never appear in line/export/stderr fixture。
- concurrent writes all lines valid。
- crash after complete append leaves valid lines。
- 50 MiB rotation（用低阈值 injectable test config）。
- 365/0 retention。
- capacity ordering and protected recent errors。
- write permission/disk full fallback + health。
- cursor page continuity/order/filter fingerprint。
- old `.log`/hook error query。
- orphan start detection (start without terminal event) helper。

**验证命令**

```bash
node _site/_test/structured-logger-test.js
node _site/_test/logging-api-test.js
node _site/_test/knowledge-store-logs-supervision-test.js
node _site/_test/log-redaction-test.js
```

若上述前三个中某文件在当前仓库不存在，T05 必须创建与 Plan 指定名称一致的测试，而不是跳过。

**验收**

- retention 配置被实际执行。
- query 不使用“读全部、排序全部”。
- logger 不允许业务传入任意 root path。
- fault tests 证明 write failure 可见。

**失败/恢复**

- cleanup 删除失败：记录 warn，继续运行；不重试到阻塞主功能。
- active segment损坏：隔离坏尾行、保留合法前缀，记录 error；不静默丢整文件。

**最小交付**

- Logger/LogRepository API、cleanup algorithm、cursor format/version、test summary。

**映射**：TS-38–52；BUG-LOG-001..002、BUG-SEC-001。

---

### T06 — ProjectLifecycleService 与 HookManager v2

**目标与可观察结果**

- Import/delete 变成可回滚 transaction。
- Hook 指向真实 trigger、使用运行时 repo root、strict managed marker。
- 第三方 Hook 冲突使 import 失败；旧 managed Hook 自动修复一次。
- Hook manager 不再读写 CLAUDE.md。

**前置依赖**：T02、T03、T04 contracts、T05 logger API。  
**负责角色**：Lifecycle/Hook Agent；`server.js` 只由 T10 集成。  
**并行**：可与 T08 的低层实现并行。

**Context Packet**

- P-03、P-04、P-06..P-08、P-11..P-16、P-19。
- R-HOOK-01..05、R-LIFE-01..02、R-PATH-01..02。
- BUG-HOOK-001..004、BUG-LIFE-001..004、BUG-KNOW-001。
- Stores/Layout/Migration/Logger contracts。

**必须读取**

- `_site/server.js · importProjectFromLocalPath()`、project delete、Hook routes、`PUT /api/projects`。
- `_site/lib/hook-manager.js`
- `_site/scripts/hook-trigger.js`
- `_site/lib/kb-framework.js · initProjectDirs()`
- `_site/lib/git-runner.js`
- `_site/lib/claude-md-manager.js` only to remove coupling safely。
- tests: `simple-import-test.js`、`hook-trigger-test.js`、`hook-runtime-endpoint-test.js`、`tracking-start-test.js`、`project-remove-running-guard-test.js`、`git-validation-test.js`。

**允许修改**

- ProjectLifecycleService new module。
- HookManager/trigger script。
- kb bootstrap helper needed for minimal directory claim。
- owned hook/lifecycle tests。

**禁止修改**

- `server.js` routes/UI。
- Reconciler/prompt。
- integration installer’s unrelated MCP/Skill behavior。

**具体修改**

1. Import input requires existing/writable global root from SettingsStore; backend revalidates。
2. detect same repo already imported using projectId config + Git common identity; worktree policy must be explicit：
   - same common repository and same worktree path is duplicate；
   - distinct worktree may be a separate project only if product chooses; recommended default reject ambiguous duplicate and require explicit existing-project relocation flow。
3. allocate cryptographically/random stable projectId and immutable storageName; collision append short id。
4. target knowledge dir must be absent/empty or proven same interrupted transaction；otherwise fail, never overwrite。
5. create minimal knowledge directory only when transaction needs it；no README/GOAL/ARCHITECTURE/TODO/empty indexes。
6. initialize Git if needed and establish state：
   - HEAD exists: trackingStartCommit=HEAD；
   - empty repo: trackingMode=empty-repo、trackingStartCommit=null。
7. `installHook({ repoPath, projectId, triggerScriptPath, endpointResolverPath/version })` validates trigger exists。
8. resolve hook path through Git command, honoring worktree/core.hooksPath。
9. generated Hook v2：strict marker JSON/comment、projectId、runtime `git rev-parse --show-toplevel`、nonblocking notification、always exit 0。
10. do not embed stale knowledge root/repo path；host/port read current runtime endpoint file with safe fallback。
11. existing third-party Hook => `HOOK_CONFLICT` and entire import rollback；no overwrite flag exposed。
12. managed old Hook => only migration service can upgrade; import idempotently verifies same project/version。
13. atomic Hook file replace, executable bit/readback/content verify；Windows Git Bash path quoting tests。
14. project delete：check active reconciliation/run；uninstall exact managed Hook；repo missing exception；failure stops deletion。
15. default preserve external Markdown；explicit delete uses ownership transaction and separate confirmation token。
16. registry add last; registry remove after Hook success。
17. transaction journal logs started/completed/failed/rollback with same operationId。
18. remove all CLAUDE.md calls from Hook manager；other AI integration modules remain owner of their own configs。
19. one-time startup Hook migration checks state.hook.migrationVersion and strict legacy marker；success updates state; failure leaves retryable warning，不重复改已成功项目。

**Hook payload/API contract**

```json
{
  "schema":"hook-event/v2",
  "projectId":"...",
  "repoRoot":"...runtime...",
  "head":"...optional...",
  "branch":"...optional..."
}
```

Server must verify repoRoot is Git worktree and corresponds to project; payload values are hints, not authority。

**测试**

- production import path writes existing `_site/scripts/hook-trigger.js`。
- Hook install failure rolls back registry/config/state/new dirs。
- third-party Hook conflict no overwrite。
- managed reinstall idempotent/no duplicate content。
- repo moved -> runtime path works/projectId stable。
- core.hooksPath absolute/relative；linked worktree `.git` file。
- path spaces/quotes/Windows separators。
- service unavailable Hook exits 0 and writes hook JSONL。
- delete uninstall failure leaves project registered。
- repo gone permits registration delete。
- no CLAUDE.md create/modify/delete。
- old wrong-path managed Hook repaired once。
- import no AI profile succeeds and does not analyze。
- target knowledge conflict fails/no overwrite。

**验证命令**

```bash
node _site/_test/simple-import-test.js
node _site/_test/hook-trigger-test.js
node _site/_test/hook-runtime-endpoint-test.js
node _site/_test/tracking-start-test.js
node _site/_test/project-remove-running-guard-test.js
node _site/_test/git-validation-test.js
node _site/_test/project-lifecycle-transaction-test.js
node _site/_test/hook-worktree-test.js
```

**验收**

- Hook path Bug 的 production-call regression 变绿。
- import success implies Hook verified and registry committed。
- import does not dispatch AI。
- delete default preserves external Markdown。
- Hook manager exports中没有 CLAUDE.md dependency。

**失败/恢复**

- rollback cannot prove ownership：保留 asset，记录 `ROLLBACK_ASSET_PRESERVED`；不得递归删除。
- Hook readback mismatch：卸载本次刚写 managed file，import fail。

**最小交付**

- lifecycle service API、transaction stage list、Hook v2 format、test results。

**映射**：TS-03、06、12–18、23–25、27–33、37、40、49；BUG-HOOK-001..004、BUG-LIFE-001..004、BUG-KNOW-001。

---

### T07 — RequirementRecorder、跨客户端采集与确定性绑定

**目标与可观察结果**

- Claude Code、Codex、OpenCode 的用户需求可写入正确 project 的 `requirements.jsonl`。
- 记录动作不触发知识分析。
- Commit claim 冻结可靠 requirementIds；无法可靠判断时明确 unavailable。

**前置依赖**：T03；T01 schema。  
**负责角色**：Requirement Agent。  
**并行**：可与 T05/T06/T08 的 scanner 部分并行；不编辑 server。

**Context Packet**

- P-09、P-10、P-11、P-12。
- R-REQ-01..02、R-TRG-02。
- BUG-REQ-001、BUG-AUTO-002、BUG-AUTO-006。
- requirement/claim contracts from T01；ProjectStore from T03。

**必须读取**

- `_site/server.js · /api/claude/sessions/:id/input` 及 session metadata。
- `_site/lib/claude-cli-runner.js`/workbench session model。
- `_site/lib/project-knowledge-mcp.js` 或实际 MCP server。
- `_site/lib/integration-installer.js`、plugins/project-knowledge Skill、OpenCode instruction files。
- project resolution in `knowledge-tool-runtime.js`。
- tests: `claude-workbench-test.js`、`mcp-server-test.js`、`integration-adapters-test.js`、`runtime-endpoint-test.js`。

**允许修改**

- RequirementRecorder/RequirementBinder pure module。
- MCP write-only metadata tool implementation/config/skill instructions。
- embedded session adapter helper（server wiring留 T10）。
- owned tests。

**禁止修改**

- knowledge analysis dispatch。
- Commit prompt/reconciler（T08）。
- `server.js` route body。
- 给 MCP 增加 Markdown 写权限或通用文件写工具。

**具体修改**

1. `recordRequirement()` validates projectId, non-empty text, max size, client/session metadata。
2. resolve project only from explicit project context/current Git root；no “last active project”。
3. capture `branch` and `headAtRecord` through trusted GitReader；Git failure允许 null但降低绑定置信度。
4. generate requirementId + sha256 body hash；append locked JSONL。
5. embedded Claude input：record成功后才发送输入；record失败返回明确 error，避免用户以为已被关联。是否允许“仍发送但标未记录”应遵循最安全显式 UX；推荐提供一次明确确认/重试，不静默继续。
6. MCP 增加 `project_knowledge_record_requirement`，只能 append metadata；返回 id；不得调用 reconciler。
7. Codex/Claude/OpenCode Skill/说明要求在开始实现用户任务前调用该 tool，并在同 session 复用 requirementId。
8. Binder priority按 §3.3；explicit ID 仍验证 projectId。
9. ancestry 使用 Git `merge-base --is-ancestor headAtRecord commit`；branch 变化/多个会话歧义不绑定。
10. claim 一旦创建冻结 IDs；retry不得读取未来 records。
11. requirement 不自动 mark consumed until state advances；promotion前失败可由同 claim重试。
12. privacy：不记录 system prompt、assistant response、API key、完整 tool transcript。

**测试**

- three clients produce same schema。
- record does not invoke dispatch/reconciler。
- different project/session cannot cross-bind。
- explicit ID wrong project rejected。
- same session+ancestry unique binds。
- multiple candidate sessions => unavailable。
- future requirement not attached to recovered old claim。
- concurrent append all lines parse。
- oversized/secret-like content policy behaves as contract（正文中的普通用户文本不能被擅自改写；secrets policy只针对系统凭据字段）。

**验证命令**

```bash
node _site/_test/claude-workbench-test.js
node _site/_test/mcp-server-test.js
node _site/_test/integration-adapters-test.js
node _site/_test/requirement-recorder-test.js
node _site/_test/requirement-binding-test.js
```

**验收**

- requirements file lazy-created。
- no adapter can directly trigger analysis。
- unavailable path is deterministic and testable。
- retry claim uses frozen requirementIds。

**失败/恢复**

- append fails：返回 typed error + operationId；不把内存记录当 durable success。
- Git metadata unavailable：record 可保存 null，但 Binder 不假装 high confidence。

**最小交付**

- tool schema、record API、binding decision table、tests。

**映射**：TS-10、41、51；BUG-REQ-001、BUG-AUTO-002、BUG-AUTO-006。

---

### T08 — CommitScanner、统一 CommitReconciler 与唯一 Prompt

**目标与可观察结果**

- Hook/startup 两入口对同一 Commit 生成相同 claim、证据和 prompt。
- Git 是待处理 Commit 的事实源；单项目互斥、按拓扑/时间方向串行。
- 删除 init/simulate 可触发逻辑和第二 pending queue 的业务权威。

**前置依赖**：T03、T05 logger API、T07 requirement contracts。  
**负责角色**：Automation Agent。  
**并行**：可与 T06 开发，不能编辑 `server.js`。

**Context Packet**

- P-01..P-05、P-09、P-10、P-19。
- R-TRG-01..04、R-REQ-02、R-KNOW-01。
- BUG-AUTO-001..006、BUG-SCAN-001..002、BUG-TOOL-001。
- ProjectStore/claim/Logger/RequirementBinder contracts。

**必须读取**

- `_site/lib/post-commit-automation.js` 全部公共 exports 与 session callbacks。
- `_site/lib/scanner.js`
- `_site/lib/commit-automation-store.js`
- `_site/lib/automation-config.js`
- `_site/lib/git-runner.js`
- `_site/lib/claude-cli-runner.js` session lifecycle。
- tests: `post-commit-automation-test.js`、`pending-sweep-test.js`、`scanner-test.js`、`tracking-start-test.js`、`automation-queue-test.js`、`automation-ui-test.js`。

**允许修改**

- scanner/reconciler/automation config/claim compatibility。
- prompt renderer and evidence preparation。
- automation tests owned by T08。

**禁止修改**

- `server.js` routes。
- Hook manager/trigger。
- Knowledge promotion/index internals（T09）；使用 injected interface。
- UI。

**具体修改**

1. 导出唯一业务入口 `reconcileProjectCommits(projectId, trigger, deps)`；trigger validator只接受两个值。
2. `handlePostCommitEvent()` 只验证/定位 project，调用 reconciler；`dispatchPendingAutomations()` 对 enabled projects 使用 bounded concurrency（例如 2–4 configurable），每项目调用同一函数。
3. per-project in-flight Map keyed projectId：
   - first caller owns Promise；
   - second caller sets `rescanRequested` and awaits same Promise；
   - owner结束前如设置，再 scan一次；
   - cross-process ProjectStore lock是最终写保护。
4. baseline rules：
   - no last/tracking + HEAD：原子写 trackingStart=HEAD，不分析；
   - no HEAD：empty-repo mode；
   - empty-repo first HEAD：pending list含 first Commit；
   - last exists优先；否则 trackingStart。
5. ancestry：`merge-base --is-ancestor`；失败 state=`history-diverged`、error event，停止，不猜 reset。
6. list：`git rev-list --reverse --topo-order <base>..HEAD`；包含 merge；对每个 SHA独立收集 metadata/evidence。
7. batch limit如果保留，返回 continuation，并循环直至无 pending；绝不把未处理 HEAD 当成功。
8. evidence：
   - full SHA、parents、author/date/subject、branch at scan；
   - name-status/renames/binaries；
   - merge 使用 first-parent unified patch；root commit用 empty tree；
   - actual patch有安全 size policy和 manifest，hash完整证据；
   - existing relevant knowledge由可信 reader预取，AI 不用通用 Bash。
9. claim create在 AI 前：freeze requirementIds/binding、patchHash、prompt version/hash、knowledgePath、runId、phase。
10. 唯一 `commitPromptTemplate` 包含：userRequirement、commit metadata、actual changes、existing knowledge、requirement-vs-implementation、add/update/delete knowledge、evidence limits。
11. 兼容读取旧 `hookPromptTemplate` 作为一次性 override；新保存只写 `commitPromptTemplate`。
12. 删除 `DEFAULT_INIT_PROMPT_TEMPLATE`、`initPromptTemplate`、`renderProjectInitPrompt()`、`dispatchProjectInit()` 和 project file overview logic。
13. `dispatchAutomation()` 变 private/internal，HTTP 不可直接调用；最好重命名为 analyzer internal function。
14. old commit-automation queue：运行时不再 discover pending；仅 migration/recovery adapter使用 active claim，随后删除权威状态。
15. session completion只把 output交给 T09 validator；不得自行 advance pointer。
16. failure：写 activeClaim phase/error/attempt；停止 later commits；下次同 claim retry。
17. success：T09返回 `stateAdvanced=true` 才处理 next commit。
18. no pending logs为 debug；有实际处理/状态变化才 info。
19. 日志全链路共用 project operationId；每 Commit独立 runId，可共享 sweep operationId。
20. prompt/patch不写日志，只写 version/hash/length/file count。

**错误行为**

- divergence：non-retryable until user/repo state resolved；不改变 pointers。
- evidence too large：使用 manifest/explicit omitted sections；不能 silent truncate。
- requirement unavailable：prompt固定文本，不是错误。
- AI profile missing：Commit失败/等待配置，pointer不推进；项目本身仍可导入。

**测试**

- Hook/startup same commit prompt hash/claim equality。
- no baseline establishes tracking only。
- empty repo first commit analyzed。
- multiple commits ordered，逐个 state advance；second failure stops third。
- simultaneous Hook/startup one analysis。
- notification during run causes rescan but no duplicate。
- merge/root commits evidence。
- rebase divergence stops。
- batch continuation。
- requirement/unavailable/frozen retry。
- old last/tracking compatibility。
- no init exports/template/source values。
- no generic shell execution path。
- no pending logs debug。

**验证命令**

```bash
node _site/_test/post-commit-automation-test.js
node _site/_test/pending-sweep-test.js
node _site/_test/scanner-test.js
node _site/_test/tracking-start-test.js
node _site/_test/automation-queue-test.js
node _site/_test/automation-ui-test.js
node _site/_test/commit-reconciler-concurrency-test.js
node _site/_test/commit-evidence-test.js
```

**验收**

- public exports中不存在 init dispatch。
- source/trigger记录只出现 `git-hook|startup`。
- 同 SHA 两 trigger 的 prompt hash完全一致。
- scanner不漏 merge、不自动处理 divergence。
- 每次 state advance有明确 T09 proof。

**失败/恢复**

- active claim corrupt：停止该项目并记录 DATA_CORRUPT；不从空状态重放。
- process crash：下次读取 claim，验证 commit/evidence hash后从安全 phase继续。

**最小交付**

- reconciler API、state transition implementation、prompt version、scanner semantics、tests。

**映射**：TS-01–11、19–20、39、41–42；BUG-AUTO-001..006、BUG-SCAN-001..002、BUG-TOOL-001。

---

### T09 — Knowledge staging/promotion 与单写者 IndexService

**目标与可观察结果**

- AI 不直接写 final knowledgePath；所有产物可验证、可恢复地 promotion。
- Markdown 成为事实源；state advance 与 index dirty 有明确语义。
- 多项目可并行分析，但 LanceDB mutation 严格单写。

**前置依赖**：T02、T03、T05、T08 claim/analyzer interface；T07 requirement evidence。  
**负责角色**：Knowledge/Index Agent。  
**并行**：否；其接口是 T10/T11 前置。

**Context Packet**

- P-05、P-09、P-15、P-16、P-19、P-20。
- R-KNOW-01..02、R-PATH-02..03、R-TRG-04。
- BUG-AUTO-003..005、BUG-KNOW-001..002、BUG-INDEX-001、BUG-TOOL-001。
- activeClaim/state/AtomicFile/Logger contracts。

**必须读取**

- `_site/lib/kb-framework.js`
- `_site/lib/markdown-knowledge-indexer.js`
- `_site/lib/knowledge-db.js`
- `_site/lib/index-builder.js`/实际 index entry points
- AI workspace/run directory helpers
- `post-commit-automation.js · onSessionEnded/indexMigratedProject`
- tests: `kb-framework-test.js`、`index-builder-test.js`、`knowledge-db-test.js`、`markdown-maintenance-*`、`knowledge-maintenance-test.js`、`knowledge-query-test.js`。

**允许修改**

- KnowledgePromotion/validator/staging helpers。
- IndexService and low-level DB writer coordination。
- knowledge/index tests。

**禁止修改**

- `server.js`。
- prompt/scanner contract（T08）。
- CLI/MCP wiring（T11）。
- UI。

**具体修改**

1. 为每 run 创建 internal runtime staging，不放在用户 knowledge root或源码 repo。
2. AI tool权限只允许 staging；禁止写 source tree/final knowledgePath。
3. staging output包含 manifest：relative path、operation (`create|replace|delete`)、sha256、reason/evidence references。
4. path validation：
   - allowed `.md` and explicit project knowledge files/directories；
   - realpath/relative boundary；
   - no symlink escape、absolute path、`..`、ADS/Windows reserved path；
   - delete only existing knowledge file owned by project，不删除目录外/unknown binary。
5. content validation：UTF-8、frontmatter/schema（若项目约定）、no placeholder/TODO-as-fact、size limit、links/path consistency。
6. compare staged output with claim Commit evidence；至少记录 validation outcome，不能仅因 AI exit 0通过。
7. promotion journal列出 original hash/backup path/new hash/action；所有 final writes用 AtomicFile。
8. multi-file promotion顺序与 crash recovery：
   - prepare backups/temps；
   - mark phase prepared；
   - apply deterministic order；
   - mark each applied；
   - verify final hashes；
   - mark promoted。
9. recovery只完成/回滚同一 journal，不调用 AI。
10. promotion成功后在同 project lock内 compare active claim and atomically update：lastAnalyzedCommit、clear claim/record completed summary、index.dirty=true/sinceCommit。
11. 如果 state write失败但 Markdown已promotion，journal保持 `awaiting-state-advance`；startup验证 hashes后补推进。
12. IndexService process-global FIFO/single writer；project enqueue去重/coalesce，保留最早 dirty commit。
13. DB adapter不再被 server/CLI/maintenance直接并发 mutation；read queries可按库支持并发，但 writer有统一 barrier。
14. indexing成功后 compare dirty generation再 clear；运行期间新 promotion不得被旧 completion错误清除。
15. indexing失败：state dirty+error、warn/error logs；startup/daily/after next promotion重试；不回滚 Markdown。
16. full rebuild可从所有 project knowledge paths生成全新 temp DB，验证后原子切换；不在 live DB destructive rebuild。
17. maintenance state也通过 IndexService/AtomicFile，不独立 read-modify-write。
18. `initProjectDirs` 改为按需 framework creation；第一条 knowledge 可创建 README/index，但内容必须来自验证产物，不是 TODO模板。
19. source code tree在 run前后可选检查 Git status；发现未经允许源码改动 => validation failure，不推进。

**测试**

- AI exit 0 no files => fail no advance。
- invalid/outside/symlink path rejected。
- valid multi-file promotion。
- crash after each promotion stage and startup recovery。
- state write failure after promotion repaired without AI rerun。
- index failure leaves pointer advanced+dirty，query fallback可读 Markdown；retry clears dirty。
- simultaneous projects produce serialized DB writes，both indexed。
- new dirty generation during old index not cleared。
- delete operation ownership protection。
- no TODO skeleton on import。
- full rebuild atomic swap/old DB retained on validation fail。

**验证命令**

```bash
node _site/_test/kb-framework-test.js
node _site/_test/index-builder-test.js
node _site/_test/knowledge-db-test.js
node _site/_test/knowledge-maintenance-test.js
node _site/_test/markdown-maintenance-test.js
node _site/_test/markdown-maintenance-api-test.js
node _site/_test/knowledge-query-test.js
node _site/_test/knowledge-promotion-recovery-test.js
node _site/_test/index-writer-concurrency-test.js
```

**验收**

- 没有 automation code直接把 AI workspace当 final knowledgePath。
- lastAnalyzedCommit只在 verified promotion后推进。
- index failure状态可见且可恢复；不重复 AI。
- 所有 DB mutation可追踪到 IndexService。

**失败/恢复**

- final file被用户在 promotion前修改：hash conflict，停止并保留 staging/journal，不覆盖用户改动。
- backup失败：不开始 apply。
- DB无法打开：Markdown功能仍可用，health显示 degraded。

**最小交付**

- promotion manifest/journal schema、IndexService API、fault-injection matrix。

**映射**：TS-09–10、19–21、29–30、36、41–44；BUG-AUTO-003..005、BUG-KNOW-001..002、BUG-INDEX-001。

---

### T10 — `server.js` 集成、API 安全与旧路径删除

**目标与可观察结果**

- HTTP server只调用新 services/stores；没有 direct whole-file/path/analysis bypass。
- 删除所有废弃公开入口和 Hook UI API。
- 修复 secrets/CORS/raw/stack 高严重度缺陷。
- startup/shutdown/migration/logger/index/reconciler 形成闭环。

**前置依赖**：T04、T05、T06、T07、T08、T09。  
**负责角色**：主/集成 Agent；独占 `server.js`。  
**并行**：否。

**Context Packet**

- P 全部，R 全部。
- BUG-SEC-001..002、BUG-LIFE-001..004、BUG-AUTO-001、BUG-STATE-001、BUG-PATH-002、BUG-LOG-001。
- 所有 service/store API handoff；不重新审查其内部。

**必须读取**

- `_site/server.js` 全部共享 state/route startup/shutdown sections。
- T00 route inventory。
- all new public APIs。
- UI API consumers inventory（只读；T12改 UI）。
- tests: `simple-import`、hook runtime、post commit、pending sweep、ai profile、runtime endpoint、package startup、sessions stream、project guard、baseline schema。

**允许修改**

- `_site/server.js`。
- thin route/controller modules（若抽离可降低 server体积）。
- server integration tests。
- 旧 wrappers/dead code exports removal。

**禁止修改**

- 已冻结 shared schema/layout/store semantics；发现缺陷回到原 owner或主 Agent显式更新合同。
- UI（T12）。
- CLI/MCP（T11）。

**具体修改**

1. startup顺序：
   - initialize minimal Logger/fallback；
   - inspect/recover migration；
   - open Settings/Registry/Projects；
   - recover promotion journals/index dirty/orphan operations；
   - migrate managed Hooks once；
   - listen；
   - dispatch startup reconciliation；
   - schedule logger cleanup/index retry。
2. startup reconciliation trigger必须 `startup`，0 pending只 debug。
3. install uncaughtException/unhandledRejection/SIGINT/SIGTERM handlers：fatal/error logs、flush Logger/IndexService、graceful stop；禁止把 recoverable domain error变 fatal。
4. import route调用 LifecycleService；success只在 transaction commit后返回。
5. delete route要求明确 knowledge deletion option/confirmation；Hook fail映射 409/503，不移除 project。
6. Hook endpoint验证 `hook-event/v2`，调用 `handlePostCommitEvent`；quick response与后台 task contract明确，但必须记录 accepted operation；避免 unhandled Promise。
7. Claude input route调用 RequirementRecorder后再发送 input；保持 session UX与错误可见。
8. MCP requirement tool endpoint/runtime plumbing按 T07 contract接入。
9. 删除：
   - import后的 `dispatchProjectInit()`；
   - `/automation/simulate`；
   - `/automation/init`；
   - manual `/hook-install`、`/hook-uninstall`；
   - 可触发的 `dispatchAutomation` route；
   - project-init prompt/config；
   - `PUT /api/projects` generic replacement。必要项目设置使用白名单 PATCH。
10. `/api/projects/:slug/init` 若仅创建知识骨架，也应删除或改为不产生推测知识的明确 maintenance API；优先删除旧入口并更新 consumers。
11. project APIs主键转 projectId；迁移期只读 slug resolver可保留一版，但所有 mutation必须 projectId。
12. AI profiles GET返回 public view；update key三态 preserve/replace/clear。
13. CORS/origin：
   - 默认同源；不发送 wildcard；
   - loopback desktop/browser仅允许 configured local origins；
   - 非回环 bind要求 auth token并拒绝未授权；
   - preflight按白名单响应。
14. 删除或严格重构 `/api/raw`；推荐删除。所有文件读取通过 projectId + knowledgePath + realpath boundary。
15. generic error handler不返回 stack；返回 operationId；日志保留脱敏错误。
16. 所有 console.*逐步改 Logger；只允许 Logger自身最终 stderr fallback和必要 CLI stdout。
17. direct paths/JSON writes改 stores/Layout；server不再整体读取/写 projects.json。
18. Index mutations只入队 IndexService。
19. settings root保存不迁移旧 projects、不移动 DB。
20. route/API文档和 UI consumers列出 breaking removals；生产不保留两套运行路径。

**安全测试**

- malicious Origin无法读取 AI profiles。
- GET profiles response无 key/token。
- preserve/replace/clear semantics。
- non-loopback无 auth拒绝。
- 500无 stack/secret。
- raw route absent或 traversal/symlink rejected。
- removed routes 404/405。

**业务集成测试**

- import→Hook verified→no AI run。
- Hook/startup both call same reconciler mock。
- delete Hook fail preserves project。
- startup migration failure continues old reader safely。
- graceful shutdown flushes logs/index。
- no direct projects.json state mutation。

**验证命令**

```bash
node _site/_test/simple-import-test.js
node _site/_test/hook-runtime-endpoint-test.js
node _site/_test/post-commit-automation-test.js
node _site/_test/pending-sweep-test.js
node _site/_test/ai-profile-test.js
node _site/_test/runtime-endpoint-test.js
node _site/_test/package-startup-test.js
node _site/_test/sessions-stream-test.js
node _site/_test/project-remove-running-guard-test.js
node _site/_test/server-security-test.js
node _site/_test/legacy-routes-removed-test.js
```

**验收**

- route inventory只找到两个分析触发入口。
- `rg` 不再找到 removed route strings/DEFAULT_INIT_PROMPT_TEMPLATE/renderProjectInitPrompt/dispatchProjectInit。
- server不直接拼 internal project/index/log paths。
- security tests全部通过。

**失败/恢复**

- 某新 service合同不够：暂停集成该点，回到 owner补 contract/test；不在 server复制一套临时逻辑。
- migration/startup fatal：保留旧数据，提供 operationId和明确 degraded/fail-fast，不默认空配置启动写入。

**最小交付**

- route change list、startup sequence、security test report、deleted symbol inventory。

**映射**：TS-01–18、24–25、30、32–36、39–44、49–52；所有高严重度 B，尤其 BUG-SEC-001..002。

---

### T11 — CLI、MCP、runtime、索引器路径统一

**目标与可观察结果**

- server、CLI、MCP、query/index maintenance 对 project/config/knowledge/index 使用同一 StorageLayout/Stores。
- read-only query 不产生配置写入或隐式 scope synchronization。
- MCP 继续只读知识；唯一写能力只是 T07 的 requirement metadata tool。

**前置依赖**：T02、T03、T07、T09；T10 API/security contract已冻结。  
**负责角色**：CLI/MCP Agent。  
**并行**：可与 T12 并行；不改 server/UI。

**Context Packet**

- P-09、P-11、P-13..P-17、P-20。
- R-PATH-01..03、R-REQ-01、R-KNOW-02、R-SEC-01。
- BUG-PATH-001..003、BUG-INDEX-001、BUG-REQ-001、BUG-TOOL-001。
- Layout/Stores/Index/Requirement contracts。

**必须读取**

- `_site/lib/knowledge-tool-runtime.js`
- `bin/project-knowledge-kb.js`
- actual MCP server files and plugin manifests。
- `_site/lib/knowledge-scope-registry.js`
- query/index/maintenance modules。
- `_site/lib/integration-installer.js`
- tests: `bin-cli-test.js`、`mcp-server-test.js`、`knowledge-query-test.js`、`knowledge-scopes-test.js`、`integration-adapters-test.js`、`pr-consumer-contract-test.js`。

**允许修改**

- CLI/MCP/runtime/scope adapters。
- package/plugin config needed for requirement tool。
- owned tests。

**禁止修改**

- StorageLayout/Stores semantics。
- server routes。
- UI。
- 通用 Markdown write tool。

**具体修改**

1. 删除 CLI 的 `~/.project-knowledge/knowledge.lancedb` hardcode；使用 `StorageLayout.getIndexPath()`。
2. runtime project resolution从 RegistryStore list + ProjectStore config读取；slug只作 display/compat query。
3. 已导入 project knowledgePath只读 config；不从当前 global root+slug重算。
4. scope：project binding移 config；global settings移 SettingsStore；read query不得调用 synchronize/write。
5. MCP resolve current project：运行 Git root，匹配 stable project identity/projectId；move更新只能由受控 service，不在 read query中写。
6. query优先 internal index；index unavailable/dirty时保留现有 safe Markdown keyword fallback，并明确 source/health。
7. maintenance/rebuild调用 IndexService；不能直接并发打开 writer。
8. requirement tool按 T07 schema；其他 tools仍 read-only。
9. plugin/Skill instructions不再依赖 Hook manager生成 CLAUDE.md；保留正常 integration installer职责。
10. CLI error不输出 secret/full settings；JSON errors遵守 envelope或CLI等价结构。
11. path consistency contract test从同一 fixture分别调用 server adapter、runtime、CLI、MCP，断言完全相同 knowledge/index paths。
12. package bin/manifest保持兼容；不无关升级 dependencies。

**测试**

- two projects with fixed distinct knowledgePath。
- global root changed: old project unchanged/new project uses new root。
- CLI/MCP/server same path/index path。
- project rename/move stable projectId。
- read query creates no files/writes。
- index dirty fallback。
- requirement tool append only/no analysis。
- scope migration/read-only behavior。
- secrets absent in CLI error。

**验证命令**

```bash
node _site/_test/bin-cli-test.js
node _site/_test/mcp-server-test.js
node _site/_test/knowledge-query-test.js
node _site/_test/knowledge-scopes-test.js
node _site/_test/integration-adapters-test.js
node _site/_test/pr-consumer-contract-test.js
node _site/_test/path-consistency-test.js
```

**验收**

- `rg` 不再发现业务模块直接 hardcode `knowledge.lancedb` 或 data-dir project paths（StorageLayout/legacy migration fixtures除外）。
- query path无写副作用。
- MCP没有新增知识写权限。

**失败/恢复**

- index unavailable：return degraded result with Markdown fallback，不在查询时创建/迁移 DB。
- current repo匹配多个 project：返回 ambiguous error，不任意选择最近项目。

**最小交付**

- consumer path table、MCP tool inventory、path consistency tests。

**映射**：TS-26–30、35–37、51；BUG-PATH-001..003、BUG-INDEX-001、BUG-REQ-001。

---

### T12 — 单一日志 UI、设置与废弃控制清理

**目标与可观察结果**

- 生产 UI 只保留附件原型下半部分所表达的目标日志页面。
- 支持最近 7 天、六级筛选、项目/组件/event/operation/commit 搜索、cursor 翻页、自动刷新暂停、详情链路、导出。
- 删除 manual Hook 与 manual analysis controls/calls。

**前置依赖**：T05 Log API、T10 routes/security contract。  
**负责角色**：UI Agent；独占 `ui/index.html` 和对应 UI tests。  
**并行**：可与 T11 并行。

**Context Packet**

- P-01、P-06、P-18。
- R-LOG-01..04、R-UI-01、R-HOOK-03、R-TRG-01、R-COMP-01。
- BUG-LOG-002、BUG-HOOK-003、BUG-AUTO-001。
- Uploaded `log-ui-comparison`：上半部不是 production；下半部是验收意图。

**必须读取**

- `ui/index.html` 两套 log sections、logging settings、Hook/manual automation handlers。
- current design tokens/theme/components/lucide usage。
- T10 API spec。
- tests: `automation-ui-test.js`、`workspace-ui-contract-test.js`、`ui-smoke-test.js`、`desktop-browser-compat-test.js`、`task15-20-ui-flow-test.js`、`project-control-panel-task14-test.js`。

**允许修改**

- UI log page/settings/project status read-only Hook display。
- owned UI tests/fixtures。

**禁止修改**

- backend API implementation。
- 引入新前端 framework/build chain。
- 把上传“当前 vs proposed”整个对比 prototype嵌入 production。

**具体修改**

1. 删除第二套/旧日志列表，只保留一个 state/render path。
2. 默认 from=local today-6 days、to=today；文件仍存 UTC，UI本地显示并可查看 raw UTC。
3. six level badges文字+icon+theme tokens；不只靠颜色；error/fatal readable background/left border。
4. level counters可点击筛选，aria-pressed，键盘可用。
5. filters：date range、projectId（显示 name）、component、event/operation/commit/full text。
6. API cursor state：next/previous策略；filter变化重置 cursor；pageSize default 100。
7. auto-refresh：默认 on或遵循产品现有习惯；pause button明确状态；刷新不打乱用户已打开详情。
8. row：time、level、project、component/event、phase、message、duration、operation/commit摘要。
9. detail：operation flow chronological、runId、commit、phase/attempt、duration、structured error/stack，然后 raw JSON；copy log/copy operationId。
10. export：选择当前 filters/date/project，显示成功/错误；不允许导出 unrestricted secrets。
11. health：Logger degraded/retention/capacity summary可见；不要允许用户更改日志 root。
12. logging settings只包括 level enable、retentionDays、maxTotalSizeMB及必要保护参数；validations与 backend一致。
13. Hook project panel只读 status/error；删除 install/reinstall/uninstall按钮与 fetch calls。
14. 删除 simulate/init analysis按钮与 calls；状态只能查询，不触发。
15. empty/loading/error/partial/invalid cursor状态完整。
16. responsive：小屏 filters堆叠、表横向滚动或可读 card；详情不溢出。
17. light/dark theme检查所有六级对比度和 focus ring。
18. 使用安全 text rendering，不把 log message/error当 HTML插入。

**自动化测试**

- DOM中 removed routes/buttons不存在。
- one log implementation/root state。
- default 7-day request params。
- six levels/icon/text/filter。
- cursor next/filter reset。
- operation flow/detail/error stack/raw JSON。
- pause/resume、auto refresh。
- empty/error/logger health。
- escaping XSS fixture。
- responsive/theme token assertions。

**手动/视觉验收**

- 实际打开/渲染 desktop web page。
- light/dark、宽屏/620px以下。
- error/fatal、long stack、long Windows path、deleted project snapshot。
- no-data、one page、multiple pages、cursor expired。
- export and logger degraded state。

**验证命令**

```bash
node _site/_test/automation-ui-test.js
node _site/_test/workspace-ui-contract-test.js
node _site/_test/ui-smoke-test.js
node _site/_test/desktop-browser-compat-test.js
node _site/_test/task15-20-ui-flow-test.js
node _site/_test/project-control-panel-task14-test.js
node _site/_test/logging-ui-test.js
```

若仓库采用 Playwright：按现有 `ui-test.js` 的真实启动方式执行；不编造 npm script。

**验收**

- 搜索源码只剩一个 production log render path。
- 无 manual Hook/analysis call strings。
- 下半部原型的核心信息架构均有测试。
- raw JSON是次级 details，不是唯一详情。

**失败/恢复**

- backend cursor contract变化：主 Agent更新 API fixture后再继续，不在 UI猜 offset。
- 浏览器 API clipboard/download不可用：提供可访问 fallback，不隐藏错误。

**最小交付**

- screenshot/visual QA record、UI states matrix、test results。

**映射**：TS-07、15、38–39、46、48、52；BUG-LOG-002、BUG-HOOK-003、BUG-AUTO-001。

---

### T13 — 全量整合、迁移/E2E/Windows、死代码与最终审查

**目标与可观察结果**

- 在一个分支中完成所有范围，所有 Gate 通过。
- 新安装、旧升级、中断恢复、Hook实时、startup补查、UI、CLI/MCP形成闭环。
- 删除双路径/死代码/调试产物；最终 diff无未经授权行为。

**前置依赖**：T04、T06–T12 全部。  
**负责角色**：主 Agent；可调用原 Task Agent修复其模块。  
**并行**：测试矩阵可分环境并行；最终 diff/共享修复串行。

**Context Packet**

- 全部 P/R/B/TS IDs。
- 每个 Task 最小 handoff。
- shared facts/schema latest revision。
- baseline failures from T00。

**必须读取**

- 完整 Git diff。
- package/workflows/release scripts。
- migration fixtures。
- all modified tests。
- changed server/CLI/MCP/UI integration points。

**允许修改**

- 集成修复、docs/changelog、tests/workflows必要更新。
- 原 owner模块的 bugfix应尽量交回原 Agent；主 Agent负责最终 merge。

**禁止修改**

- 未经用户授权 push、PR、release、tag、publish。
- 为“顺便优化”升级技术栈或新增运行时 Token features。
- 删除 external knowledge、历史 logs、legacy backups、未知归属数据。

**具体步骤**

1. 更新主任务清单，所有 R/B/TS有 owner/status/evidence。
2. `rg` 证明旧入口、prompt、manual Hook calls、duplicate log UI、direct projects state writes、hardcoded index paths已清理。
3. fresh install E2E：
   - set root；
   - import existing Git project；
   - no AI run；
   - Hook verified；
   - record requirement；
   - commit；
   - one analysis/promotion/state/index；
   - logs operation chain；
   - query knowledge。
4. offline E2E：stop server → multiple commits（Hook exit 0）→ restart → ordered catch-up。
5. concurrency E2E：two projects parallel；same project Hook+startup overlap；DB writer serialized。
6. failure E2E：AI timeout、promotion crash、state crash、index failure、logger disk full、Hook conflict、migration interruption。
7. old upgrade fixtures：settings/projects/kbPath/DB/logs/old Hook；verify secrets/pointers/path/history preserved。
8. project move/rename/worktree/core.hooksPath/empty repo/root commit/merge/rebase divergence。
9. delete：default preserve knowledge；explicit owned delete；Hook failure behavior；repo missing exception。
10. API security：Origin/auth/profile secret/raw path/error stack/export redaction。
11. actual UI visual checks per T12。
12. Windows runner：Git for Windows Hook、path spaces/non-ASCII、atomic replace lock behavior、desktop package、LanceDB packaged smoke。
13. run all tests/build/package once after integration；repair by owner。
14. inspect `git diff --check`、full diff、new files、package tarball list。
15. search debug/TODO/temporary bypass/empty catch/console；exceptions must be documented Logger fallback/CLI output only。
16. review permissions and generated files；no secrets/test fixtures accidentally packaged。
17. update README/CHANGELOG accurately；do not claim tests unavailable as passed。
18. final status report includes files, architecture, migration behavior, commands/exit codes, limitations/uncompleted items。

**最终命令**

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
git diff --check
git status --short
git diff --stat
git diff
```

还要运行现有 workflows 中的真实 Windows/package commands；CI success不能替代本地明确失败的必要测试。

**Definition of Done**

- 所有 Requirement IDs 状态 `DONE` 或有用户批准的明确 exception；本计划不预期 exception。
- BUG-SEC-001/002 与所有 Critical/High scope Bug有 regression test。
- TS-01–TS-52有自动或明确手动证据；TS-53–55标源未定义。
- 两个分析入口、一个 reconciler、一个 prompt、一个 Logger、一个 log UI、一个 StorageLayout、一个 index path。
- migration fault matrix通过；旧资产保留。
- full tests/build/package/Windows关键验证通过。
- 必需测试失败时状态不是完成。

**失败/恢复**

- 集成回归优先定位 owner/contract；不在 server复制 workaround。
- Windows-only failure必须修复或明确阻塞，不以 POSIX pass替代。
- 无权限运行某环境时，最终状态标 `BLOCKED` 并提供精确命令/证据，不能写 `DONE`。

**最小交付**

- final traceability matrix、test table、migration report、visual QA、diff review、remaining limitations。

**映射**：R 全部；B 全部；TS-01–52。

## 11. 需求追踪矩阵

### 11.1 Requirement → Task → Verification

| Requirement | 实施任务 | 主要自动化验证 | 手动/环境验证 |
|---|---|---|---|
| R-TRG-01 | T08、T10、T12 | post-commit、pending-sweep、legacy-routes-removed、automation-ui | route/source inventory |
| R-TRG-02 | T08、T10 | prompt hash equality、trigger enum、integration | Hook/startup operation logs |
| R-TRG-03 | T06、T08 | tracking-start、scanner、simple-import | fresh/empty repo E2E |
| R-TRG-04 | T03、T08、T09 | concurrency、ordered failure、state advance | two-project E2E |
| R-REQ-01 | T07、T10、T11 | requirement-recorder、MCP/adapters | real Claude/Codex/OpenCode session |
| R-REQ-02 | T07、T08 | requirement-binding、claim retry | ambiguous session scenario |
| R-HOOK-01 | T06、T10 | simple-import、hook-trigger、transaction | Git for Windows Hook |
| R-HOOK-02 | T06、T10 | project-remove guard/lifecycle | repo missing/permission error |
| R-HOOK-03 | T10、T12 | removed routes/UI string tests | project page inspection |
| R-HOOK-04 | T06 | worktree/core.hooksPath/move/no CLAUDE | Windows/path spaces |
| R-HOOK-05 | T04、T06 | old Hook fixture/idempotency | upgrade E2E |
| R-DATA-01 | T03、T04 | project-store、migration | inspect v2 layout |
| R-DATA-02 | T02、T03 | fault injection/concurrency/append | Windows replace/lock |
| R-DATA-03 | T04、T13 | migration stage failures | real legacy copy |
| R-PATH-01 | T02、T06、T11 | root/import/path consistency | settings/import UI |
| R-PATH-02 | T02、T06、T09 | layout/no internal files | filesystem inspection |
| R-PATH-03 | T02、T09、T11 | path consistency/index writer | packaged LanceDB smoke |
| R-LIFE-01 | T06、T10 | lifecycle transaction/fail stages | permissions/conflicts |
| R-LIFE-02 | T06、T10 | delete tests | explicit destructive confirmation |
| R-KNOW-01 | T08、T09 | commit evidence/promotion recovery | inspect generated knowledge |
| R-KNOW-02 | T09、T11 | index writer/dirty fallback | concurrent index E2E |
| R-LOG-01 | T05、T10 | structured logger/levels | visual level semantics |
| R-LOG-02 | T05、T06、T08–T10 | operation chain assertions | import/commit/delete chain |
| R-LOG-03 | T05、T13 | rotation/retention/capacity/fallback | disk permission/full simulation |
| R-LOG-04 | T05、T10、T12 | cursor/filter/export/redaction | download exported bundle |
| R-UI-01 | T12、T13 | logging-ui/ui-smoke | light/dark/responsive render |
| R-COMP-01 | T08、T10–T13 | symbol/route/UI absence | final diff review |
| R-SEC-01 | T01、T02、T05、T10、T11 | server-security/redaction/path tests | malicious origin/non-loopback |

### 11.2 当前证据代码

| 代码 | 固定 SHA 下的当前事实 |
|---|---|
| CE-TRG | 5 个入口，import/simulate/manual init 仍可触发；Hook/startup 尚未共用目标 API。 |
| CE-HOOK | production trigger path错误、stale repo path、Hook failure不阻止 import、CLAUDE.md耦合。 |
| CE-REG | projects.json含高频 state并整体覆盖；slug/path是身份。 |
| CE-REQ | 无 requirements store；prompt无 userRequirement。 |
| CE-KNOW | import写 TODO；AI写 final；exit 0推进；index异步且无 dirty。 |
| CE-PATH | global/project/index paths由多个模块各自拼接；DB可在用户 root。 |
| CE-MIG | projects.json存在即跳过；迁移可部分完成/先删目标。 |
| CE-LOG | v1三级、无真实 retention/rotation/cursor/fallback；业务有空 catch/console。 |
| CE-UI | 两套 log UI、默认当天；有 manual Hook/analysis calls。 |
| CE-SEC | wildcard CORS、AI profiles secrets、stack/raw path边界。 |

### 11.3 原 Plan 测试场景 TS-01–TS-52

状态初始为 `PLANNED`；Codex 在主任务清单中只能在对应测试/验收有证据后改为 `DONE`。

| Test ID | 验收场景 | 当前证据 | Task | 自动化测试/修改目标 | 手动/迁移验收 | 状态 |
|---|---|---|---|---|---|---|
| TS-01 | 程序运行时 Commit，Hook立即触发一次分析 | CE-TRG、CE-HOOK | T06、T08、T10、T13 | hook-runtime-endpoint、post-commit、E2E | real Git Hook | PLANNED |
| TS-02 | 程序关闭时多个 Commit 不报错；启动后全部补上 | CE-HOOK、CE-TRG | T05、T06、T08、T13 | hook-trigger offline、pending-sweep、ordered scanner | stop/start E2E | PLANNED |
| TS-03 | 新导入/首次启动不 init，只建 trackingStart | CE-TRG、CE-KNOW | T06、T08、T10 | simple-import、tracking-start、pending-sweep | fresh import | PLANNED |
| TS-04 | 无新 Commit 重启不重复分析 | CE-TRG | T08、T13 | pending-sweep/idempotency | repeated restart | PLANNED |
| TS-05 | 同 Commit 被 Hook/startup 同时发现只分析一次 | CE-REG、CE-TRG | T03、T08、T13 | reconciler concurrency | overlap E2E | PLANNED |
| TS-06 | import完成后不立即分析 | CE-TRG | T06、T10 | simple-import dispatch spy | import UI | PLANNED |
| TS-07 | 两个手动分析接口不可用 | CE-TRG、CE-UI | T10、T12 | legacy-routes-removed、automation-ui | network inspection | PLANNED |
| TS-08 | Hook/startup同 Commit使用同一 prompt | CE-TRG、CE-REQ | T08 | prompt hash equality | operation detail | PLANNED |
| TS-09 | 多个遗漏 Commit严格顺序且逐个更新 pointer | CE-KNOW、CE-REG | T08、T09 | ordered scanner/state advance | offline commits | PLANNED |
| TS-10 | 有需求记录需求+实现；无需求不推测 | CE-REQ、CE-KNOW | T07、T08、T09 | recorder/binding/prompt/promotion | inspect Markdown | PLANNED |
| TS-11 | 不存在 init prompt/render/dispatch | CE-TRG | T08、T10、T13 | symbol absence test/rg | final diff | PLANNED |
| TS-12 | import自动安装 Hook且指向真实 trigger | CE-HOOK | T06、T10 | production import Hook path | inspect Hook | PLANNED |
| TS-13 | Hook失败则 import失败，无半完成 | CE-HOOK | T06、T10 | lifecycle fault injection | permission conflict | PLANNED |
| TS-14 | delete自动卸载 Hook | CE-HOOK | T06、T10 | lifecycle delete | real repo delete | PLANNED |
| TS-15 | manual Hook API/buttons不存在 | CE-UI、CE-HOOK | T10、T12 | route/UI absence | UI inspection | PLANNED |
| TS-16 | 项目移动后 Hook runtime path正确 | CE-HOOK、CE-REG | T06、T11 | hook move/projectId | filesystem move | PLANNED |
| TS-17 | 旧错误 Hook升级后只修复一次 | CE-HOOK、CE-MIG | T04、T06 | legacy Hook fixture/idempotency | upgrade E2E | PLANNED |
| TS-18 | Hook install/uninstall不改 CLAUDE.md | CE-HOOK | T06 | no-CLAUDE fixture | repo diff | PLANNED |
| TS-19 | 两项目同时完成各自 pointer不互相覆盖 | CE-REG | T03、T08、T09 | project store concurrency | parallel projects | PLANNED |
| TS-20 | 同项目 Hook/startup只运行一个 reconcile | CE-REG、CE-TRG | T03、T08 | in-flight dedupe/project lock | overlap E2E | PLANNED |
| TS-21 | state写入中断原文件仍完整 | CE-REG | T02、T03 | AtomicFile fault injection | process kill | PLANNED |
| TS-22 | 旧 projects迁为 index+单项目文件，pointer不丢 | CE-MIG、CE-REG | T04 | layout-v2 fixtures | real backup compare | PLANNED |
| TS-23 | 改名/移动仍沿用 projectId，无第二份状态 | CE-REG | T03、T06、T11 | identity/move tests | rename/move | PLANNED |
| TS-24 | root未设/不可写，前后端拒绝 import | CE-PATH | T02、T06、T10、T12 | write-probe/import API/UI | permission test | PLANNED |
| TS-25 | 先设 root再 import，固定子目录，无第二选择 | CE-PATH | T02、T06、T10、T12 | lifecycle/path/UI contract | UI flow | PLANNED |
| TS-26 | 两项目有不同子目录且各 config保存绝对路径 | CE-PATH、CE-REG | T03、T06、T11 | path consistency | inspect config | PLANNED |
| TS-27 | 改 global root旧项目不变，新项目用新 root | CE-PATH | T02、T06、T11 | root change fixture | settings/import | PLANNED |
| TS-28 | 改显示名不改 projectId/storageName/knowledgePath | CE-REG、CE-PATH | T03、T11 | immutable fields test | UI rename | PLANNED |
| TS-29 | 用户 root只出现知识 Markdown，无内部文件 | CE-PATH | T02、T06、T09 | layout filesystem assertions | directory inspection | PLANNED |
| TS-30 | server/MCP/runtime/CLI路径完全一致 | CE-PATH | T02、T10、T11 | path-consistency-test | packaged CLI/MCP | PLANNED |
| TS-31 | knowledge目标与其他项目冲突时明确失败 | CE-PATH | T06 | lifecycle conflict test | conflict fixture | PLANNED |
| TS-32 | import中途失败按事务回滚 index/config/Hook/dir | CE-HOOK、CE-REG | T06、T10 | every-stage fault injection | permission/process interruption | PLANNED |
| TS-33 | delete默认保留知识；明确选择才删除 | CE-KNOW | T06、T10、T12 | delete policy tests | confirmation UX | PLANNED |
| TS-34 | 旧配置合并 settings，AI key不变 | CE-MIG、CE-SEC | T01、T02、T04 | migration secret hash | compare backup | PLANNED |
| TS-35 | 旧 kbPath原样迁 knowledgePath，不按当前 root重算 | CE-MIG、CE-PATH | T04、T11 | migration fixture | path compare | PLANNED |
| TS-36 | DB迁 internal index后，改 root不移动它 | CE-PATH、CE-MIG | T02、T04、T09、T11 | index path/migration | filesystem inspect | PLANNED |
| TS-37 | 未用功能不生成空配置/目录 | CE-PATH | T02、T04、T06 | lazy creation tests | fresh data dir | PLANNED |
| TS-38 | 六级过滤及浅/深主题颜色文字图标 | CE-LOG、CE-UI | T05、T12 | logger levels/logging-ui | visual themes | PLANNED |
| TS-39 | no pending为debug；状态变化才info | CE-LOG、CE-TRG | T05、T08、T10 | log level assertions | startup logs | PLANNED |
| TS-40 | import成功/失败同operationId还原全阶段 | CE-LOG、CE-HOOK | T05、T06、T10 | lifecycle log chain | UI operation flow | PLANNED |
| TS-41 | Commit各阶段共享 project/run/commit/operation IDs | CE-LOG、CE-KNOW | T05、T07–T10 | commit chain assertions | UI flow | PLANNED |
| TS-42 | failure log有类型/code/stack/phase/duration/cause | CE-LOG | T05、T08–T10 | structured error tests | error detail UI | PLANNED |
| TS-43 | 日志不可写/磁盘满不静默，stderr+health | CE-LOG | T05、T10、T12 | permission/ENOSPC injection | UI health | PLANNED |
| TS-44 | 异常退出日志仍合法；识别未结束操作 | CE-LOG、CE-KNOW | T02、T05、T09、T10 | crash/orphan tests | kill/restart | PLANNED |
| TS-45 | 重启/升级/delete后历史日志按策略可查 | CE-LOG、CE-MIG | T04、T05、T10 | legacy/deleted project logs | upgrade/delete | PLANNED |
| TS-46 | 默认7天、cursor多页、不全量读多年 | CE-LOG、CE-UI | T05、T10、T12 | cursor performance/params | large log corpus | PLANNED |
| TS-47 | 365、retention=0、max size策略真实工作 | CE-LOG | T05、T10 | cleanup policy tests | scheduled cleanup | PLANNED |
| TS-48 | 日志>50MiB分段，跨段顺序/过滤正确 | CE-LOG | T05、T12 | injectable rotation/cursor | large segment | PLANNED |
| TS-49 | server离线 Hook写 hooks log且不影响 Commit | CE-HOOK、CE-LOG | T05、T06、T10 | offline hook writer | real commit | PLANNED |
| TS-50 | 旧 log/hook error/logging config迁移可读且保源 | CE-MIG、CE-LOG | T04、T05 | legacy log fixtures | backup inspection | PLANNED |
| TS-51 | keys/tokens/secrets不出现在日志/stack/export | CE-SEC、CE-LOG | T01、T05、T10、T11 | redaction/security tests | export audit | PLANNED |
| TS-52 | 日志页单实现，颜色/筛选/刷新/链路/错误详情回归 | CE-UI | T12、T13 | logging-ui/UI smoke | visual QA | PLANNED |

### 11.4 TS-53–TS-55

原 `knowledge-base-trigger-refactor-plan` 在测试场景 52 结束。审查提示词要求映射“1–55”，但没有提供 53–55 的内容。实施不得虚构产品要求；主任务清单应记录：

| Test ID | 状态 | 说明 |
|---|---|---|
| TS-53 | UNDEFINED_IN_SOURCE_PLAN | 没有源场景文本。 |
| TS-54 | UNDEFINED_IN_SOURCE_PLAN | 没有源场景文本。 |
| TS-55 | UNDEFINED_IN_SOURCE_PLAN | 没有源场景文本。 |

## 12. 删除与兼容清单

### 12.1 必须删除的运行入口/符号

- `POST /api/projects/:slug/automation/simulate`
- `POST /api/projects/:slug/automation/init`
- `POST /api/projects/:slug/hook-install`
- `POST /api/projects/:slug/hook-uninstall`
- import path中的 `dispatchProjectInit()` 调用
- `DEFAULT_INIT_PROMPT_TEMPLATE`
- `initPromptTemplate` 新写入路径
- `renderProjectInitPrompt()`
- 可公开触发的 `dispatchProjectInit()`
- generic `PUT /api/projects` whole replacement
- 前端对应 buttons/fetch calls
- Hook manager里的 CLAUDE.md side effects
- 第二套日志 UI和旧 read-all client state

### 12.2 可短期读取、不可双写的兼容项

- old `hookPromptTemplate`：migration/read compatibility，保存时转 `commitPromptTemplate`。
- old `kbPath`：migration read only，写入后只存在 `knowledgePath`。
- slug route/project lookup：仅迁移期 GET/redirect兼容；mutation必须 projectId。
- old `.log`：LogRepository read only。
- old config files：MigrationService read only；migration complete后正常业务不再读取。
- old managed Hook marker：Hook migration read/update once。

### 12.3 永久保留但不再产生的历史资产

- 旧 `project-init` 生成的 Markdown：不自动删除。
- old logs/backups：按明确 retention/backup policy处理，不因代码删除而消失。
- Git history/old dangling objects：本任务不操作。

## 13. 风险登记与缓解

| Risk | 概率/影响 | 缓解 | Owner/Gate |
|---|---|---|---|
| 巨型 `server.js` 集成冲突 | 高/高 | T10独占、前置 service contract、small integration commits | 主 Agent/G4 |
| migration激活后旧 reader不可用 | 中/极高 | staged activation、open verification、completion last、backup | T04/G1 |
| Windows rename/locks与POSIX不同 | 高/高 | injectable AtomicFile、Windows CI、path/permission fixtures | T02/T13/G5 |
| Hook与第三方工具冲突 | 中/高 | strict refusal，不自动 chain/overwrite | T06/G2 |
| Rebase导致 baseline不可达 | 中/高 | divergence state，不猜 reset | T08/G3 |
| AI输出非确定/半写 | 高/高 | staging manifest、validation、promotion journal | T09/G3 |
| Index dirty长期积累 | 中/中 | startup/daily retry、health/UI、full rebuild | T09/T12 |
| requirement误绑定 | 中/高 | explicit/session/ancestry priority，ambiguity unavailable | T07/T08 |
| Logger自身故障递归 | 中/高 | non-recursive health/stderr fallback、cleanup logging guard | T05 |
| capacity清理误删关键错误 | 低/高 | deterministic order、protected recent error/fatal、tests | T05/G2 |
| secrets进入旧 stack/log | 中/极高 | recursive redaction、public profile view、origin tests | T01/T05/T10 |
| 子 Agent重复读取/冲突 | 中/中 | file ownership、Context Packets、原 Agent返修 | 主 Agent |

## 14. Agent 交接模板

```text
Task: Txx
Status: DONE | BLOCKED | PARTIAL
Requirements/Bugs/Tests: R-... / BUG-... / TS-...
Changed files/symbols:
- path :: symbol — change
Contracts changed:
- none | exact shared contract update requiring main-agent approval
Commands:
- command -> exit code -> concise result
Remaining risks/blockers:
- ...
Next task must know:
- exact API/schema/invariant
```

## 15. 最终完成检查表

### Architecture

- [ ] 两个且仅两个公开 analysis entrypoints。
- [ ] 两入口调用同一 reconciler和唯一 prompt。
- [ ] `projects.json` 无高频 state。
- [ ] stable projectId贯穿 store/lock/log/API/Hook。
- [ ] StorageLayout是唯一 path source。
- [ ] Markdown事实源、LanceDB派生单写。
- [ ] Logger/LogRepository和日志 UI各只有一个正式实现。

### Data safety

- [ ] 所有关键 JSON使用 AtomicFile；registry/project locks有并发测试。
- [ ] migration completion marker最后写，所有 fault stage可恢复。
- [ ] knowledge promotion crash可恢复，不重复 AI。
- [ ] delete默认保留外部知识。
- [ ] old logs/config backups/knowledge未被静默删除。

### Security

- [ ] AI profile GET无 secrets。
- [ ] wildcard CORS消失；非回环认证。
- [ ] stack/prompts/diffs/headers/tokens不经 API/log/export泄露。
- [ ] raw file path安全或 route删除。
- [ ] AI无 source/final knowledge通用写权限。

### Product behavior

- [ ] import不要求 AI profile、不分析、不写 TODO knowledge。
- [ ] Hook import/delete lifecycle闭环，第三方冲突明确。
- [ ] requirement recording不触发 analysis。
- [ ] startup恢复当前 Git可达 pending commits，history divergence明确停止。
- [ ] manual Hook/analysis buttons/routes不存在。

### Verification

- [ ] T00 baseline与最终结果有可比较记录。
- [ ] G1–G5全部通过。
- [ ] TS-01–TS-52逐项有证据。
- [ ] Windows Hook/path/desktop/LanceDB smoke通过。
- [ ] 实际渲染日志 UI并检查主题/响应式/错误/分页。
- [ ] `npm test`、desktop test、pack dry-run、diff check均通过。
- [ ] 完整 Git diff无调试代码、空 catch、重复实现、未授权 TODO、secret。

完成上述检查前，不得把本次实施标记为完成。
