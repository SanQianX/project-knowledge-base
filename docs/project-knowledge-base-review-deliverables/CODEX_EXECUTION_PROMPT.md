# CODEX_EXECUTION_PROMPT.md

你现在负责在 `SanQianX/project-knowledge-base` 仓库中真正完成知识库触发、项目存储、路径、Git Hook、用户需求、日志、迁移、CLI/MCP 和 UI 的整体重构。

这不是再次规划任务。你必须在当前源码上实施、测试、整合和审查，最终交付可运行的软件。除非遇到本提示词定义的真正阻塞条件，不要频繁停下来询问。

## 1. 必读输入与优先级

开始前按顺序完整读取：

1. 原始重构 Plan：`knowledge-base-trigger-refactor-plan.md`，或用户提供的同内容附件。
2. `PRO_REVIEW.md`。
3. `CODEX_IMPLEMENTATION_PLAN.md`。
4. 仓库中所有适用的 `AGENTS.md`、README、package/workflow 说明。

优先级：

1. 用户已确认的产品决策。
2. `PRO_REVIEW.md` 中有源码证据的 Bug 和技术修正。
3. `CODEX_IMPLEMENTATION_PLAN.md` 的共享合同、任务依赖、文件所有权和测试门。
4. 当前源码实际结构。

原 Plan 表达产品意图，但其中未定义或与源码冲突的技术细节，按 `PRO_REVIEW.md` 和实施计划的修正执行。不要静默改变产品行为。

## 2. 固定审查基线与现场保护

审查使用的源码基线是：

```text
repository: SanQianX/project-knowledge-base
branch: main
commit: ba505bb2ae031e8d06ec3032657482f40d57ecf8
message: release: v4.1.22
```

立即执行并记录：

```bash
git status --short --branch
git rev-parse HEAD
git worktree list --porcelain
git log -1 --oneline
```

规则：

- 若当前 HEAD 不是上述 SHA，先比较差异影响：触及哪些共享 schema、入口、routes、stores、Hook、logger、UI 和 tests。按稳定符号重新定位，不盲目套用旧行号。
- 保护用户已有修改。不得未经授权执行 `git reset --hard`、`git clean`、强制 checkout、rebase、丢弃、覆盖或自动 stash。
- 不提交、推送、创建 PR、发布、打 tag 或运行破坏性 Git 操作，除非用户另行明确授权。
- 不修改用户外部知识库、历史日志、旧配置备份或无法确认归属的数据。

## 3. 建立唯一主任务清单

创建或维护一份主任务清单，使用实施计划中的：

- Requirement IDs：`R-*`
- Bug IDs：`BUG-*`
- Task IDs：`T00`–`T13`
- Test IDs：`TS-01`–`TS-52`

每项状态只使用：

```text
TODO | IN_PROGRESS | BLOCKED | DONE
```

不要为每个阶段创建内容重复的计划文档。只在重大阶段完成、依赖变化或发现会改变计划的问题时更新。

原 Plan 实际只定义 TS-01–TS-52。TS-53–TS-55 标记为 `UNDEFINED_IN_SOURCE_PLAN`，不要虚构场景。

## 4. 不可静默推翻的产品决策

必须全部落实：

1. 知识分析公开入口只有：
   - Git post-commit Hook；
   - 程序 startup 补查。
2. 两入口最终调用同一：

```js
reconcileProjectCommits(projectId, trigger)
// trigger only: 'git-hook' | 'startup'
```

3. 导入项目不做初始化分析，不扫描整个项目推测需求，不生成带 TODO 的知识事实。
4. 新项目从 tracking baseline 后的新 Commit 开始；空仓库的第一个 Commit要分析。
5. 同项目只有一个 reconciliation，Commit 严格串行；某 Commit失败后停止后续。不同项目可并行。
6. Hook：
   - import自动安装并验证；
   - delete自动卸载；
   - 没有手动安装/重装/卸载 API或按钮；
   - 只通知主程序，不分析；
   - 主程序未运行不影响 `git commit`；
   - 不维护离线任务 spool；
   - 第三方 Hook不覆盖；
   - 旧 managed Hook只迁移修复一次；
   - 不管理 CLAUDE.md。
7. Commit 知识尽量来自：唯一 prompt、用户真实需求、该 Commit真实 Diff。
8. 无可靠需求时，prompt明确“需求上下文未记录”，只陈述代码可证明事实。
9. stable projectId；`projects.json`只存 index；每项目 `config.json`、`state.json`、按需 `requirements.jsonl`。
10. JSON/state原子写；registry global lock；project state/requirements project/cross-process lock。
11. 用户先设置 global knowledge root，再 import；每项目 knowledgePath导入时固定。修改 global root只影响未来项目。
12. 用户 knowledge root只保存真实 Markdown；内部 settings/metadata/index/cache/runtime/logs/recovery都在 `.project-knowledge`。
13. server、CLI、MCP、indexer统一使用 StorageLayout；LanceDB固定内部唯一路径。
14. Markdown是真实知识事实源；LanceDB是可重建派生索引，由单一 writer串行修改。
15. AI API Key允许明文保存在 settings，但 API、logs、errors、exports不得泄露。
16. Logger保持轻量 JSONL，必须六级、全链路、长期保存、轮转、容量、cursor、导出、脱敏和健康状态。
17. production只保留一套目标日志 UI。
18. migration失败不得丢 project、knowledge、Commit pointer、logs、AI config；必须可恢复重试。
19. 保持轻量单进程 Node.js 架构；JSON/JSONL/Markdown/LanceDB足够时，不引入微服务、消息队列或新数据库。

## 5. 开发过程 Token 与上下文规则

这里的 Token 优化只约束开发 Agent 的上下文、分工、检索、交接和测试调度。

严禁据此新增或改变项目运行时功能：

- 不新增 Claude/Codex/OpenCode runtime Token Flow Audit。
- 不新增 runtime Token统计、计费面板、prompt缓存、Diff分段产品功能或模型调用日志。
- 不为了“省 Token”删改 Commit prompt业务内容。
- 不为了减少 Agent上下文跳过源码证据、迁移、测试、UI验收或最终 diff审查。

主 Agent掌握全局事实。子 Agent只获得实施计划定义的最小 Context Packet：Task ID、P/R/B/TS、前置产物、必须读取符号、允许/禁止文件、合同、测试和验收。

不要把完整对话、完整 Plan、完整 PRO_REVIEW 和整个仓库内容转发给每个子 Agent。

同一模块连续修复优先复用原 Agent，不反复创建新 Agent重读上下文。

## 6. 子 Agent 与文件所有权

只有实施计划标记为安全且确有收益时才使用子 Agent。

主 Agent独占：

- 共享 schema/constants及版本；
- StorageLayout最终合同；
- migration activation/entry；
- `_site/server.js` 最终整合；
- shared API error/security policy；
- 最终完整 diff和回归。

不得让多个 Agent同时修改：

- `_site/server.js`；
- shared settings/project/log schema；
- StorageLayout；
- ProjectRegistryStore；
- migration入口；
- 同一个测试文件；
- 实施计划文件所有权表列出的其他共享高冲突文件。

每个 Agent交接只保留：完成项、修改文件/符号、新决策、测试命令/exit code、风险/阻塞、下一任务所需合同。不要输出重复长报告或无关完整日志。

## 7. 执行顺序

严格按依赖完成：

```text
T00 baseline/characterization
T01 shared contracts/security policy
T02 StorageLayout/AtomicFile/SettingsStore
T03 ProjectRegistryStore/ProjectStore/locks
T04 MigrationService
T05 Logger/LogRepository
T06 ProjectLifecycle/Hook v2
T07 RequirementRecorder/binding
T08 CommitScanner/unified Reconciler/prompt
T09 KnowledgePromotion/IndexService
T10 server/API integration/legacy deletion/security
T11 CLI/MCP/runtime path unification
T12 single logging UI/old controls deletion
T13 full integration/E2E/Windows/final review
```

只在 `CODEX_IMPLEMENTATION_PLAN.md` 明确允许时并行。共享模块必须串行。

## 8. 基线与测试调度

首先运行仓库真实命令：

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
```

- 记录每条命令和 exit code。
- 区分原有源码失败、环境阻塞和本次回归。
- 不为通过测试修改 lockfile或跳过必要依赖。
- 完整 baseline只执行一次；任务内运行针对性 tests。
- shared schema/path/migration整合后运行相应跨模块 Gate。
- 所有任务整合后再运行一次完整 suite/build/package/E2E。
- 必要测试失败时不得宣称完成。

使用 `rg`、`rg --files`、符号检索先定位调用点；大型文件先读相关函数及共享 state，再决定是否全文读取。

## 9. 实施中的关键技术合同

### 9.1 Storage 与项目身份

- projectId是 store目录、锁、Hook payload、API、logs的主键。
- displayName/slug仅展示；rename/move不创建第二份状态。
- `projects.json`只保存 projectId index/order和最小 display snapshot。
- config保存固定 knowledgePath；只能由独立迁移事务修改。
- state保存 tracking/pointer/activeClaim/index dirty/hook migration。
- requirements按需创建，locked JSONL append。
- path equality只在 Windows case-insensitive；POSIX不得无条件小写。

### 9.2 AtomicFile 与迁移

单文件写至少：同目录 temp → flush/fsync → close → atomic replace/Windows retry → best-effort directory sync。

多文件操作必须用 journal。migration：discovery → backup → staging → validation → activation → open verification → completion marker last。

任何迁移失败继续读旧数据，不以“projects.json已存在”当完成标记，不先删除唯一目标/源。

### 9.3 Hook

- `installHook()`接收明确 `triggerScriptPath`并验证存在。
- hooks目录通过 Git权威命令解析，支持 core.hooksPath/worktree。
- strict versioned marker；只能更新/删除本系统精确 managed Hook。
- third-party Hook冲突导致 import失败，不能覆盖或偷偷链式拼接。
- Hook发送 projectId和运行时 `git rev-parse --show-toplevel`。
- Hook离线写结构化 hook JSONL，始终 exit 0。

### 9.4 Requirement

- embedded Claude input在发送前持久化 requirement。
- MCP只增加 write-only metadata tool `project_knowledge_record_requirement`；不能写知识或触发分析。
- Codex/OpenCode/Claude integrations记录 project/client/session/branch/headAtRecord/body/hash。
- binder按 explicit ID、same session+branch+ancestry、unique candidate；歧义即 unavailable。
- active claim冻结 requirementIds；retry不能绑定未来需求。

### 9.5 Scanner/Reconciler

- baseline祖先关系必须验证；divergence停止，不自动重置。
- Commit列表 reverse/topological，包含 merge；merge patch用 first-parent并记录 parents。
- actual unified patch进入证据包；size policy必须显式 manifest，不能静默用 `--stat`冒充 Diff。
- Hook/startup同 SHA必须生成相同 prompt hash。
- import/init/simulate/manual Hook routes全部删除。
- `dispatchAutomation()`不可公开直接调用。

### 9.6 Knowledge 与 index

- AI只能写 per-run staging，不能直接写源码或 final knowledgePath。
- 输出必须有 manifest并验证允许路径、内容、hash、操作。
- multi-file promotion用 journal和backups；崩溃后完成或恢复同一结果，不重调 AI。
- verified Markdown promotion后才推进 lastAnalyzedCommit并设置 indexDirty。
- IndexService是共享 LanceDB唯一 writer；index失败保留 dirty，不回退 Markdown、不重跑 AI。

### 9.7 Logger/UI

- log/v2：trace/debug/info/warn/error/fatal；稳定 event name；operation/project/run/commit/phase/duration/error。
- recursive redaction同时用于普通日志、stack、stderr fallback和export。
- daily + 50 MiB segments；默认365天；0表示不按时间删；max total size有确定性清理和保护。
- query newest-first cursor scan，达到 pageSize即停，不读全量多年日志。
- UI默认最近7天；六级文字+图标+颜色；operation flow、error detail、cursor、pause/export、light/dark/responsive。
- 上传的对比原型上半部不是 production；只实现下半部目标信息架构。

### 9.8 API 安全

必须同批修复 `PRO_REVIEW.md` 的 Critical/High security Bugs：

- GET AI profiles永不返回 API Key/token；只返回 masked metadata/hasApiKey。
- update key使用 preserve/replace/clear三态。
- 删除 wildcard CORS；默认 same-origin/loopback；非回环需要明确认证和 Origin校验。
- generic 500不返回 stack；只返回 operationId。
- 删除 `/api/raw`，或用 projectId + realpath + `path.relative`严格限制，拒绝 symlink escape。
- logs/errors/exports不记录完整 prompt、Diff、headers或 secrets。

## 10. 普通问题与真正阻塞

遇到普通代码问题时自行定位、修复、加测试并继续，不要频繁询问。

只有以下情况才暂停询问用户：

- 缺少必要仓库/附件/权限且无法继续。
- 两个不可兼容选项会明显改变产品行为。
- 旧数据无法在不丢失的情况下迁移，必须由用户取舍。
- 技术路线必须超出当前 Node.js/JSON/JSONL/Markdown/LanceDB栈。
- 必须改变已确认产品决策、数据兼容或安全策略。

命名、文件拆分、低风险兼容、内部 helper等由你依据源码选择最简单可靠方案。

## 11. 阶段 Gate

每个 Gate 完成后更新主清单并运行实施计划指定测试：

- G0：baseline与特征测试。
- G1：schema/layout/AtomicFile/stores/migration。
- G2：Logger/Hook lifecycle/requirements。
- G3：reconciler/promotion/index。
- G4：server/security/CLI/MCP/UI。
- G5：完整 suite、migration/E2E/Windows/package/visual/final diff。

Gate失败时修复后再推进。不要靠跳过测试或保留旧实现绕过。

## 12. 最终验证

完成所有实现后至少执行：

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

还必须：

1. 运行现有 workflow定义的 Windows packaged app、Git for Windows Hook、LanceDB smoke和package audit。
2. 覆盖 fresh install、legacy upgrade、migration每阶段中断、Hook conflict、repo move/worktree/core.hooksPath、empty/root/merge/divergence、two-project concurrency、same-project overlap。
3. 覆盖 AI timeout/no output、promotion crash、state write crash、index failure、Logger不可写/磁盘满。
4. 检查 API Origin/auth、profile secrets、error stack、raw traversal、export redaction。
5. 实际打开/渲染日志页面，检查筛选、六级样式、operation flow、error detail、pagination、pause、export、empty/error/degraded、responsive、light/dark。
6. 使用 `rg` 确认不存在：
   - removed automation/hook routes；
   - `DEFAULT_INIT_PROMPT_TEMPLATE`；
   - `renderProjectInitPrompt()`；
   - 可触发的 `dispatchProjectInit()`；
   - UI manual Hook/analysis calls；
   - duplicate log UI；
   - direct high-frequency projects.json state writes；
   - consumer hardcoded LanceDB paths；
   - 非必要 empty catch/console/debug bypass。
7. 审查完整 Git diff，确认无调试代码、重复实现、静默异常、无用模块、未处理 TODO、临时 migration bypass、密钥或用户数据。

## 13. 最终报告格式

最终报告必须准确包含：

1. 审查基线与实际实施 HEAD/branch。
2. 完成的 R/B/TS IDs；未完成项与原因。
3. 修改文件和关键符号。
4. 最终架构与数据事实源。
5. migration/backup/rollback行为。
6. Hook、requirement、reconciler、promotion/index、Logger/UI行为。
7. 每条测试/构建/pack/E2E/Windows命令、exit code和摘要。
8. 视觉 QA 结果。
9. 仍存在的限制、环境阻塞或遗留项。
10. 明确说明未执行 push/PR/release（除非用户另行授权）。

任何必需测试失败、migration无法证明安全、Critical/High范围 Bug未修复、UI未实际验证时，不得宣称任务完成。
