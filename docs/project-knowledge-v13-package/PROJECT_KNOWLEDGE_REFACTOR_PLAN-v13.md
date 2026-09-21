# PROJECT_KNOWLEDGE_REFACTOR_PLAN-v13.md

> **唯一 Source of Truth**：本文件是本轮 `project-knowledge-base` 重构的唯一产品、架构、实现、测试与 Agent 执行规范。  
> **审查/执行基线（2026-08-18）**：`SanQianX/project-knowledge-base` / `main@88e795df55eca26ce301e0e3c7615e894e7d0de8` / release `v4.1.23`；`SanQianX/DevTask-Radar` / `main@33ab03a1de4fccb9b1b27610e6ff9e32d9b5e0d4` / package `0.1.4`。任何 Agent 开始执行前仍必须重新读取远端 HEAD；若已前进，按 T00 做 drift audit 后移植本计划，禁止静默沿用旧行号。  
> **UI 结构参考（只读）**：`ba505bb2ae031e8d06ec3032657482f40d57ecf8` / `v4.1.22`，仅用于恢复完整 Control Center 的结构与交互，不得作为 backend/storage/logging/security 回滚基线。  
> **Plan 状态**：`PRO_REVIEWED / HIGH_ASSURANCE_EXECUTION_READY`。v13 已根据当前会话、两个仓库真实 HEAD、发布工作流与当前客户端 Hook 实现完成二次审计；本版关闭 v12 中仍含糊的 Bridge 原子边界、late-assistant freeze、Codex 多会话归属、公共包发布顺序、delete 事务与非发布 CI 风险。没有开放设计 Gate；Agent 只能按本版合同机械实施。  
> **实施原则**：按 `COMMIT_SEQUENCE.md` 拆成多个可独立验证、可回滚、可 push 的小 Commit。每个 Commit 的本地 Test Gate 和远端 CI Gate 都通过后才可进入下一步；开发阶段所有仓库禁止 tag。公共 Bridge 与 Project Knowledge 的正式 tag 只允许出现在最终发布波次。

## 0. 使用说明与规范优先级

本文件同时承担产品 Plan 与 Codex/Agent Implementation Plan 的职责，**不再维护第二份 Plan**。执行时：

1. **只把本文件作为规范输入。** `PROJECT_KNOWLEDGE_REFACTOR_PLAN-v12.md`、`PROJECT_KNOWLEDGE_REFACTOR_PLAN-v11.md`、`PROJECT_KNOWLEDGE_REFACTOR_PLAN-v10.md`、`PROJECT_KNOWLEDGE_REFACTOR_PLAN-v9.md`、`PROJECT_KNOWLEDGE_REFACTOR_PLAN-v8.md` 及更早 Plan、`knowledge-base-trigger-refactor-plan-v5.md`、`CODEX_IMPLEMENTATION_PLAN-v5.md`、`PRO_REVIEW.md` 均已被本文件取代，只可在需要追溯历史证据时按需读取，不能覆盖本文件的决策。
2. 审查基线为 Project Knowledge `88e795df...` 与 DevTask-Radar `33ab03a...`；执行前必须重新解析两个 default branch/HEAD；`ba505bb...` 只允许做 UI 结构参考。若实际工作分支已前进，T00 必须先记录 HEAD 与 `88e795df...` 的差异，再按符号/调用链移植本计划，不得静默把 `ba505bb...` 或其他提交替换成执行基线。
3. 保护用户 dirty worktree，不覆盖、清理或 stash 未经授权的修改。
4. 建立一份主任务清单，按 T00–T13 的依赖推进。
5. 子 Agent 只获得其 Context Packet；共享高冲突文件由主 Agent 独占。
6. 每个任务先写/更新针对性测试，再实施，再运行该任务命令。
7. 任一必要测试失败时不得宣称完成。
8. 本计划中的 P/R/T/TS 编号均为冻结合同；测试场景总数固定为 **TS-01～TS-52**，后续需求必须合并进现有场景或在用户明确批准后再改变编号。

## 1. 共享事实与决策索引

### 1.1 固定事实（F）

| ID | 事实 |
|---|---|
| F-001 | **本次执行基线**是当前 `main@88e795df55eca26ce301e0e3c7615e894e7d0de8`（release `v4.1.23`）；其父提交 `ba505bb...` / v4.1.22 仅作为完整旧 UI 结构和历史问题证据，禁止整文件回滚。 |
| F-002 | **v4.1.23 当前代码已基本收敛到 Hook + startup 两个公开触发路径**；v13 仍要求 T00 inventory 证明不存在可公开调用的 simulate/manual-init/init 分析入口，并删除残留 legacy symbol/test/comment，禁止按旧历史事实重新制造这些接口。 |
| F-003 | `server.js` 的 `SITE_ROOT` 实际是 `_site/ui`；Hook manager 在其后拼 `scripts/hook-trigger.js`。 |
| F-004 | Hook 脚本计算 `REPO_ROOT` 但发送导入时固定 repoPath。 |
| F-005 | 导入先写知识骨架和 `projects.json`，Hook/init 失败后仍返回 `ok:true`。 |
| F-006 | `projects.json` 同时保存项目配置与高频分析状态，使用 whole-file read-modify-write。 |
| F-007 | Commit evidence 当前只有 name list + `git show --stat`，没有真实 patch 和 requirement。 |
| F-008 | Claude idle/exit 0 当前可推进 Commit；索引异步发生在 pointer 推进后。 |
| F-009 | 旧 migration 以 `projects.json` 存在作为完成信号，允许部分迁移。 |
| F-010 | server、CLI、MCP/runtime 对 knowledge/index/config 路径有重复且不一致的解析。 |
| F-011 | v4.1.23 已有六级 `log/v2`、redaction、项目目录和 cursor 基础，但 `logger.child()` 仍创建独立 queue/health，仍有 retention/capacity cleanup 与 size segment，查询仍存在整文件读取；更重要的是关键业务模块的阶段日志覆盖明显不足。 |
| F-012 | v4.1.23 production UI 退化成日志控制台；完整 v4.1.22 Control Center/Workbench/Import/Settings Shell 需要按新 API 合同恢复，日志只能回到 Settings 内。 |
| F-013 | **v4.1.23 当前实现已修复历史 wildcard CORS 与 AI Profile GET secret 暴露**：server 使用 origin allow policy，`GET /api/ai-profiles` 使用 public view。它们在 v13 中是必须保留的 Security Regression Gate，不再作为待实现 Critical Bug。 |
| F-014 | 测试合同固定为 **TS-01～TS-52**。后续新增的“全链路日志覆盖 / 故障可追踪 / 200 条成熟 UI 密度”要求分别合并进 TS-39～TS-42 与 TS-52，**不新增第 53 个及以后的测试编号**。 |
| F-015 | 产品不要求、也不允许本轮新增运行时 Token 审计、缓存、计费或 prompt 削减。 |
| F-016 | 当前外部 Claude Code/OpenCode/Codex 的 Requirement 捕获依赖 Skill/MCP cooperative call；用户已在当前电脑验证未产生任何 `requirements.jsonl`，因此该机制不能继续承担“用户真实需求必达”的主捕获责任。 |
| F-017 | `SanQianX/DevTask-Radar@33ab03a...` 已有 Claude Code/Codex/OpenCode connectors、事件归一化与 user/assistant turn 聚合能力，但 connector endpoint、安装状态与 DevTask-Radar 业务目前仍有耦合；必须抽成独立可复用 package，而不是复制代码或让 Project Knowledge 依赖整个 DevTask-Radar 产品。 |

| F-018 | 当前 `structured-logger.js` 仍具有 50 MiB segment、retention/capacity cleanup、可配置 levels、`logs/app`/`logs/hooks` 路径、whole-file reverse query；这些与最终永久 project/day/system/day 单文件合同冲突，属于真实待改 backend + migration 工作。 |
| F-019 | 当前 `server-app.js` 的 `activeTasks` 仍是 `Map<projectId,{operationId,promise}>`，同项目后任务会覆盖前任务；Reconciler 又在 owner 内创建新的 operationId，导致请求入口与 Commit 链端到端 correlation 断裂。 |
| F-020 | 当前 `scanner.js` 在 patch >2 MiB 时仍返回 `patch:null`；`requirement-binder.js` 仍使用 same-session + `isAncestor(headAtRecord, commitSha)`；`commit-prompt.js` 仍 filename-order / maxFiles=24 / 256 KiB。三者都是 v13 必须真正替换的现状。 |
| F-021 | 当前用户 Search/Ask 已使用 LanceDB vector + FTS hybrid；knowledge schema 已含 `source_paths/tags/routes/symbols/document_hash/source_commit`，因此 Commit Retrieval 应复用这些现有索引能力，而非另造目录扫描器。 |
| F-022 | DevTask-Radar Claude Code connector 已使用 `UserPromptSubmit` 与 `Stop`；但 shared hook client 默认 HTTP POST `127.0.0.1:8787`，错误静默吞掉，尚无 durable journal。 |
| F-023 | DevTask-Radar Codex notify 当前扫描 `~/.codex/sessions` 中 mtime 最新 JSONL、整文件读取并用非原子 state 去重；并发多个 Codex session/project 时存在把错误 session 当作当前 turn 的 P0 风险。 |
| F-024 | DevTask-Radar EventNormalizer 在 session 缺失时写固定 `unknown-session`，TurnAggregator 在无 prompt 时合成 `(No captured user prompt for this turn)`；二者都不能进入新的 Requirement Truth。缺失身份/Prompt 必须显式 unavailable/partial，禁止伪造。 |
| F-025 | DevTask-Radar 当前 package 要求 Node >=24；Project Knowledge 支持 Node >=18。公共 Bridge 必须以消费者公共下限 Node >=18 为 core 运行时基线，除非未来用户明确提高 Project Knowledge engine。 |
| F-026 | Project Knowledge 当前只在 `v*` tag 上运行 npm publish workflow；同一 `v*` tag 还触发 Windows Desktop Release，并校验 root/desktop version 与 tag 一致。当前缺普通 push/PR 的 non-release CI。 |
| F-027 | DevTask-Radar 当前仓库是 private，Project Knowledge 是 public；Project Knowledge 的生产安装不能依赖 private Git URL。Bridge 必须有独立 public distribution boundary。 |
| F-028 | 当前 ProjectLifecycle import 已较 v12 历史版本更事务化，但 delete 仍是 Hook remove → registry remove → metadata rm → optional knowledge rm，缺 delete journal；中途失败可能形成部分删除状态。 |
| F-029 | 当前 Git post-commit shell 实际同步运行 Node trigger，HTTP 最长约 2s；虽然最终 `exit 0` 不会回滚已生成 Commit，但“non-blocking”注释与真实延迟不一致。v13 只允许极短本地 durable boundary append 位于同步路径，server 通知不得承担 durable truth。 |
| F-030 | 当前 Claude Workbench session persistence 使用直接 `writeFileSync` + best-effort silent catch。实时 Claude 会话不能因持久化失败中断，但关键 resume/history persistence failure 必须结构化记录，并优先改为 AtomicFile。 |
| F-031 | 两个宿主各自依赖同一个 npm package **不会自动形成单 Hook owner**：若 installer 直接把各自 `node_modules` 路径写入 Claude/Codex/OpenCode 配置，仍会产生双 managed path 与卸载冲突。Bridge 必须物化 per-user stable runtime/shim，并由 consumer registry 决定 Hook 生命周期。 |

### 1.2 不可变产品决策（P）

| ID | 决策 |
|---|---|
| P-01 | 公开知识分析入口只有 Git post-commit Hook 和程序 startup 补查。 |
| P-02 | 两个入口必须调用同一 `reconcileProjectCommits(projectId, trigger)`；trigger 只允许 `git-hook`、`startup`。 |
| P-03 | 导入不做项目初始化分析，不扫描整个项目推测需求。 |
| P-04 | 新项目从 `trackingStartCommit` 后的第一个新 Commit 开始；空仓库的第一个 Commit 要分析。 |
| P-05 | 同一项目严格串行；某 Commit 失败时停止后续；多个项目可以并行。 |
| P-06 | Hook 导入自动安装并验证、删除自动卸载；没有手动 install/reinstall/uninstall API/UI。 |
| P-07 | Project Knowledge Git Hook 只记录 commit boundary/通知，不分析；服务未运行时不影响 `git commit`；不维护离线**分析任务** spool。v8 Bridge durable journal 只保存原始 AI 对话事件/Git boundary 事实，不是待执行分析任务队列。 |
| P-08 | 第三方 Hook 不覆盖；旧 managed Hook 只自动修复一次；Hook manager 不管理 CLAUDE.md。 |
| P-09 | Commit 知识由唯一固定 prompt、用户真实需求、该 Commit 真实 Diff 与**检索得到的相关 Existing Knowledge**共同形成；Existing Knowledge 不得再按文件名顺序/固定前 N 个文件选择。用户主动知识搜索与 Commit 自动上下文检索必须复用统一 `KnowledgeRetrievalService`。 |
| P-10 | 需求不可靠时写“需求上下文未记录”，只陈述代码可证明事实。 |
| P-11 | `projectId` 稳定；`projects.json` 只保存 index；config/state/requirements 按项目分离。 |
| P-12 | JSON/state 原子写；registry 有 global lock；project state/requirements 有 project/cross-process lock。 |
| P-13 | 用户先配置全局 knowledge root，再导入；每项目最终 `knowledgePath` 固定。 |
| P-14 | 改全局 root 只影响未来项目；旧项目不迁移、不重算。 |
| P-15 | 用户 knowledge root 只保存真实 Markdown；内部数据都在 `~/.project-knowledge`。 |
| P-16 | 单一内部 LanceDB；服务、CLI、MCP、索引器共享 StorageLayout。LanceDB 是 derived retrieval index，不是知识事实源；Markdown 永远 authoritative。Index dirty 时 Commit Retrieval 不等待索引完成，而使用“索引候选 + 当前 Markdown Delta Overlay”保证刚生成/修改的知识可被下一 Commit 看见。 |
| P-17 | AI Key 允许明文存 settings，但 API、日志、导出和错误必须脱敏。 |
| P-18 | 日志使用轻量 JSONL、六级、强关联；有 projectId 的日志按 `logs/projects/<projectId>/<YYYY-MM-DD>.jsonl` 保存，无项目日志按 `logs/system/<YYYY-MM-DD>.jsonl` 保存；永久保留、无自动删除；今天通过 SSE 事件驱动刷新。前端默认是成熟“运行记录”视图：不显示“实时”、Level 列、`INFO:`/`DEBUG:` 或 severity 小点/图标；正常记录中性，warn 整行文字明黄/琥珀、error/fatal 整行文字红色。正文/meta 与固定时间列必须严格隔离且永不重叠；真实 Level 只在详情/更多筛选中出现。 |
| P-19 | 迁移失败不丢项目、知识、Commit pointer、logs、AI 配置；失败可重试。 |
| P-20 | 保持轻量 Node.js 单进程架构，不新增微服务、外部消息队列或业务数据库；v8 新增的 Bridge durable journal 是本地 append-only 捕获日志，不是独立服务/消息队列。 |
| P-21 | 从 DevTask-Radar 抽出独立公共模块 `@sanqianx/ai-coding-event-bridge`。Claude Code/Codex/OpenCode 的 AI 编辑器 Hook 安装、事件捕获、归一化、session/turn identity、durable journal 与多 consumer cursor 由 Bridge 统一拥有；DevTask-Radar 与 Project Knowledge 都作为 consumer 使用，禁止复制 connector 实现。 |
| P-22 | Bridge 是 AI 对话捕获事实源：用户每次 prompt 与 AI 每次 terminal response 均形成标准事件；用户 prompt 是 Requirement Truth，assistant response 只作为 Conversation Evidence。Project Knowledge 可以保存完整 user/assistant 对话，但不得把 assistant 自述当成用户需求。 |
| P-23 | Requirement/Conversation → Commit 的**用户 Turn membership**必须在 Git Commit 创建当场冻结。Git Hook 调用 Bridge 的 `appendCommitBoundary()`：在与 user/assistant event 相同的跨进程 journal lock / writer 序列中，原子取得 high-watermark/openTurnIds、分配 sequence、append+fsync boundary。禁止“先读 cursor、释放锁、再写另一个文件”的竞态；绑定顺序只认 durable journal sequence，不认 wall-clock timestamp。 |
| P-24 | Commit 与对话是可解释的多对多关系。Boundary 冻结 user Turn membership；**Claim 创建时再冻结本次 Analyzer 实际可见的 Conversation Evidence**（assistant replies available at claim time）。Commit 后迟到的 assistant tail 仍可归原 Turn并显示在审计 UI，但 Claim 已冻结后不得改变 analyzer input/retry hash，也不得自动重跑旧 Commit。对话窗口起点取同 repo durable journal 中上一条 commit boundary sequence，不按 merge parent 任意选择。 |
| P-25 | `@sanqianx/ai-coding-event-bridge` 提供跨宿主 Headless Conversation Query；`@sanqianx/ai-coding-event-bridge-ui` 的**默认成熟 Conversation Explorer**只暴露项目 + 日期。DevTask-Radar 如仍需 source/session/tool/raw-event 调试 Feed，只能使用独立 admin/debug host view 或可选 admin export，不能把这些筛选污染 Project Knowledge 默认 Explorer。 |

| P-26 | 公共代码放入独立 public repo `SanQianX/ai-coding-event-bridge`，采用一个 npm workspace/monorepo 发布两个包：`@sanqianx/ai-coding-event-bridge` 与 `@sanqianx/ai-coding-event-bridge-ui`。Core engine `>=18`，CommonJS 主实现 + conditional ESM/browser exports；UI 不引入 React 等新框架，仅提供 framework-neutral browser component/CSS/adapter。 |
| P-27 | Bridge journal 使用单一 append sequence（带 repoIdentity）和跨进程锁；同一 repo 的 commit window 起点来自上一条 durable boundary。Boundary 记录是 Bridge 捕获事实的一部分；Project Knowledge 可镜像/索引，但不得独立制造另一个先后顺序事实源。 |
| P-28 | Bridge 不允许 fake identity/fake prompt：缺 session/turn/repo context 使用 `null + identityConfidence/captureStatus`；不能写 `unknown-session` 共享 ID，也不能合成伪用户文本。 |
| P-29 | Codex connector 必须从“全局最新 session file”升级为 per-session incremental cursor。只有能用 notify/runtime fixture 确定 session/turn/cwd 的事件才标 high-confidence；无法唯一定位时记录 capture gap/unavailable，绝不通过 mtime 猜成别的项目需求。 |
| P-30 | Bridge journal 不按时间自动丢事件。Compaction 只能删除 `<= minAck` 的 durable prefix，并要求所有已注册 durable consumer 明确 ack；consumer 必须显式 unregister 才能退出 minAck，单纯长时间离线不能被自动遗忘。 |
| P-31 | Project delete 必须有 delete transaction journal/tombstone，Hook uninstall/registry/metadata/optional knowledge 每一步可恢复/可重试；删除默认外部 Markdown，任何部分失败都不得让 registry 与 metadata 静默分叉。 |
| P-32 | operationId 在真正入口生成一次并向下传。Hook HTTP/server request/startup task/reconciler 不得在层间重新生成 operationId；每 Commit 可新增 runId，但整个事务可端到端关联。 |
| P-33 | 在任何大规模重构前新增 non-release CI：普通 push/PR 运行 Linux Node 18/24 core test+pack，Windows 运行 core + desktop + packaged/LanceDB smoke（不发布、不 tag、不建 GitHub Release）。CI 建立后，每个中间 push 必须等待/验证远端 required checks 绿灯才进入下一 Commit。 |
| P-34 | 开发阶段所有仓库零 tag、零 npm publish。全部功能先通过 pre-publication full gate；随后 Bridge 从已验证 release commit 通过 **GitHub Actions `workflow_dispatch` 发布 core+ui（无 tag、无 GitHub Release）**，并记录 source SHA/provenance。验证 npm registry 后，消费者才锁定 exact version并 clean install/full test。 |
| P-35 | **本轮整个开发/发布过程只有一枚 Git tag**：最后一个 Project Knowledge release commit push、远端 CI 与最终 clean gate 全绿后创建 `v<project-knowledge-version>`。Bridge 本轮发布不打 tag；DevTask-Radar 只 push、不打 tag。禁止任何临时/测试 `v*` tag。 |
| P-36 | `@sanqianx` scope/name/权限在 Bridge publication 前用 `npm whoami`/`npm view`/scope access 实测。若 scope 不属于当前 npm identity 或包名已被他人占用，发布 Gate 阻塞并请求用户决策，Agent 不得自行改包名。Bridge workflow_dispatch 必须校验输入 expected SHA 与当前 release commit，并启用 npm provenance；发布后保留 package version ↔ source SHA manifest。 |
| P-37 | UI v10 是布局/视觉验收基线，不是所有 Demo 文案的强制产品文案。`Backend-driven...`、`统一对话事件流` 等实现型说明不得因为出现在 preview 而进入最终成熟产品；生产默认文案保持简短、面向用户。 |
| P-38 | Bridge 安装器必须使用 per-user `Bridge Runtime Home`（默认 `~/.ai-coding-event-bridge/`）：稳定 shim/launcher、active runtime、journal、consumer registry 均位于该目录。Claude/Codex/OpenCode 配置只指向 stable shim，**永不指向 Project Knowledge 或 DevTask-Radar 私有 `node_modules` 路径**。两个宿主 register/unregister consumer；只有最后一个 active consumer 注销时才允许移除 Bridge managed Hook。 |
| P-39 | Bridge runtime 激活/升级在全局 install lock 下原子完成；禁止宿主自动降级 active runtime。相同 major 的更高兼容版本可升级；major 不兼容必须报告 conflict 并停止改 Hook，不能互相覆盖。Runtime Home 的正文事件文件使用当前用户可读写权限（POSIX 0600/0700 best effort；Windows 用户目录 ACL），不对 LAN 暴露。 |
| P-40 | 所有开发 Commit 默认推送专用远程工作分支。最终发布前，若 `main` 未发生未审查前进，则以 non-force fast-forward 将已验证 release commit 推到 `main`，再创建 tag；若 main 已前进，必须停止、做 drift integration 并重跑受影响 gate，禁止 tag 一个未集成的旁支状态。 |

### 1.3 已确认 Bug 索引（B）

以下 Bug ID 仅作为历史问题标签保留；**修复要求与验收以本文件为准**，Agent 不需要默认读取 `PRO_REVIEW.md`。实施任务通过以下集合引用：

- **Security**：BUG-SEC-001、BUG-SEC-002、BUG-TOOL-001。
- **Hook/lifecycle**：BUG-HOOK-001..004、BUG-LIFE-001..004。
- **Automation/knowledge**：BUG-AUTO-001..006、BUG-SCAN-001..002、BUG-KNOW-001..002。
- **State/migration/path/index**：BUG-STATE-001..003、BUG-MIG-001..002、BUG-PATH-001..003、BUG-INDEX-001、BUG-CONFIG-001。
- **Logging/UI**：BUG-LOG-001..002；本次当前代码审查新增 **BUG-LOG-003（关键业务阶段日志覆盖不足/部分模块完全未接统一 Logger）**。
- **Requirements**：BUG-REQ-001。

### 1.3A v13 Repository-wide Defect Audit（真实 HEAD）

下表是 v13 审查后仍需实施/保留回归的缺陷。`FIXED-REGRESSION` 表示当前 v4.1.23 已修，Agent 只保留测试，禁止重复重写。

| ID | Severity | 状态 | Root cause / Failure scenario | Owner / Release block |
|---|---|---|---|---|
| AUD-BRIDGE-001 | P0 | OPEN | Commit Hook 若“读取 cursor/openTurnIds”与“写 boundary”不是同一 journal lock 内的单原子操作，Prompt event 可夹在中间，C1/R2 边界错误。 | BR02 + PK05；BLOCK |
| AUD-CODEX-001 | P0 | OPEN | Codex notify 当前通过全局 mtime 最新 session file 找 turn，并发 session/project 会串 Prompt/Reply。 | BR05；BLOCK |
| AUD-BIND-001 | P0 | OPEN | 当前 Requirement Binder 仍使用 same-session ancestry，C1 后 R2 可被 C1 consume。 | PK06；BLOCK |
| AUD-DIFF-001 | P0 | OPEN | >2 MiB patch 仍 `patch:null`；Analyzer 可在完整实现证据缺失时成功。 | PK07；BLOCK |
| AUD-KCTX-001 | P1 | OPEN | Commit Existing Knowledge 仍 filename-first 24 files，项目变大后漏掉真正相关知识。 | PK08/PK09；BLOCK |
| AUD-LOG-001 | P1 | OPEN | Logger child 独立 queue/health + size segment + cleanup + app/hooks 路径 + whole-file read，与最终产品合同冲突。 | PK02；BLOCK |
| AUD-TASK-001 | P1 | OPEN | server activeTasks 每项目只有一个 entry；后 task 覆盖前 task，shutdown/busy 错误。 | PK03；BLOCK |
| AUD-CORR-001 | P1 | OPEN | server/reconciler分别生成 operationId，端到端日志链断裂。 | PK03/PK10；BLOCK |
| AUD-DELETE-001 | P1 | OPEN | delete 无事务 journal，registry 已删后 metadata/knowledge 删除失败会留下部分状态。 | PK11；BLOCK |
| AUD-RELEASE-001 | P1 | OPEN | Project Knowledge 无普通 push/PR CI；最终 tag 同时是第一次完整远程发布验证。 | PK01；BLOCK |
| AUD-PKG-001 | P1 | OPEN | DevTask private、Project Knowledge public；独立 Bridge 若不先公开发布，消费者 package-lock 无法形成可安装最终态。 | BR01/BR10/PK20；BLOCK |
| AUD-CAPTURE-001 | P1 | OPEN | DevTask hook HTTP失败静默吞事件，无 durable capture truth。 | BR02；BLOCK |
| AUD-BRIDGE-002 | P0 | OPEN | 若两个宿主 installer 把各自 package 安装路径写进 AI client config，会形成两个 physical Hook owner；某宿主升级/卸载可破坏另一个。 | BR02/BR04/BR05/BR06；BLOCK |
| AUD-ID-001 | P1 | OPEN | `unknown-session` 会把不相关事件聚合；synthetic user prompt 会伪造 Requirement Truth。 | BR03；BLOCK |
| AUD-CODEX-002 | P1 | OPEN | Codex session/state整文件读写且非原子，长 session 性能差且并发可能丢 cursor。 | BR05；BLOCK |
| AUD-MIG-LOG-001 | P1 | OPEN | 当前 migration 会把 retention/max size/levels 迁成可编辑 logging settings，和永久日志合同冲突。 | PK02/PK11；BLOCK |
| AUD-HOOK-001 | P2 | OPEN | 当前 post-commit Node notifier同步等待 HTTP 最长约2s；commit不失败但可产生明显延迟。 | PK05；Release must verify latency |
| AUD-CLAUDE-001 | P2 | OPEN | Workbench session JSON 直接 writeFileSync 且持久化失败 silent；crash/部分写会降低 resume 可靠性。 | PK18；BLOCK if resume tests fail |
| AUD-UI-001 | P1 | OPEN | 当前 production UI 是独立日志控制台而非完整 Control Center。 | PK14–PK16；BLOCK |
| AUD-SEC-001 | P0 | FIXED-REGRESSION | wildcard CORS / AI profile secret exposure 在当前 server 已修；保留 regression，禁止再按旧事实重构。 | PK01/PK12 test only |
| AUD-TRG-001 | P1 | FIXED-REGRESSION | 当前 public server 未发现 simulate/manual-init route；T00 必须 inventory 后只删除残留死符号/旧测试。 | PK01/PK17 test only |

**Release blocker 定义**：所有 OPEN P0/P1 必须在 final release gate 前关闭；P2 若对应 final gate/Windows/UI test 失败同样阻塞。任何 Agent 不得把 “Plan 已覆盖” 当作 “Bug 已修”。

### 1.4 需求 ID（R）

| ID | 需求 |
|---|---|
| R-TRG-01 | 删除三个多余分析入口，只保留 Hook/startup。 |
| R-TRG-02 | 两入口进入同一 reconciler、同一 prompt。 |
| R-TRG-03 | tracking baseline、无 init、旧 pointer 兼容。 |
| R-TRG-04 | 单项目互斥、Commit 顺序、失败停止、重复通知幂等；server 后台任务登记不得以单 entry 覆盖同项目其他仍在运行的 operation。 |
| R-REQ-01 | Claude Code/Codex/OpenCode 的用户 prompt 与 assistant response 由 `@sanqianx/ai-coding-event-bridge` 强捕获并标准化；捕获本身不触发知识分析。原 Skill/MCP RequirementRecorder 降级为显式补充/兼容入口，不再是主捕获真相。 |
| R-REQ-02 | Requirement/Conversation 绑定必须确定、可解释、可冻结：Bridge 在同一 journal lock 内原子 append commit boundary；user Turn membership 由 durable sequence window 冻结。Claim 创建时冻结 analyzer 实际可见的 assistant evidence 与 `analysisConversationSnapshotHash`；Claim 后迟到 assistant 只更新 ConversationStore/UI 审计，不改变旧 Claim/retry。post-commit 新 user prompt 永不回绑旧 Commit；merge/branch 不用任意 parent boundary，窗口只用同 repo 上一 durable boundary；缺口显式 unavailable。 |
| R-REQ-03 | Bridge 必须提供稳定 Headless Conversation Query contract；底层 normalized model 保留 project/repo、source、session、turn、date/time、cursor 等真实字段，完整 user/assistant 正文只通过受控业务查询返回，不进入日志。共享成熟 Conversation Explorer 的默认产品界面只消费“单项目 + 日期”查询，不读取宿主私有数据库/JSONL，也不把 source/session/turnId 等内部字段做成常驻筛选。 |
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
| R-KNOW-01 | real patch、staging、validation、journaled promotion；大 Diff 必须保持真实证据，通过可校验的精确 Patch 分块提供，禁止以 `patch=null`/仅统计信息作为成功分析路径。Existing Knowledge 统一通过 `KnowledgeRetrievalService.retrieveForCommit()` 检索：复用 LanceDB semantic+FTS hybrid search，并加入 frozen user prompt、commit subject、changed paths、可用 symbols/tags/routes 等 Commit-aware 信号；先召回候选、再 rerank、最后按 chunk/section context budget 组装，禁止 filename-first/fixed-N-file。 |
| R-KNOW-02 | Markdown truth、index derived、single writer、dirty retry。索引 clean 时直接用于 Retrieval；索引 dirty 时旧索引只可作为候选召回来源，必须叠加当前 Markdown Delta Overlay，并在进入 Prompt 前从 authoritative Markdown 重新读取/校验 selected chunks，禁止把 stale/deleted index content 直接喂给 AI。不得为了等待索引而阻塞下一 Commit。索引完全不可用时退化到当前 Markdown 的安全检索，不回退为“前 24 个文件”。本轮按用户确认采用单写者产品约束，不新增 Prompt-time optimistic-concurrency；保留 project lock、promotion journal、apply-time hash verification。 |
| R-LOG-01 | log/v2 六级、稳定 event、结构化 error。 |
| R-LOG-02 | operation/run/project/commit 全链路覆盖。 |
| R-LOG-03 | shared writer core、按项目/按日单文件、永久保留、无自动 cleanup、write fallback、crash recovery、SSE publish。 |
| R-LOG-04 | cursor API、filters、export、recursive redaction。 |
| R-LOG-05 | 全链路可观测：关键业务模块必须有 started/stage/completed/failed，并覆盖 retry/degraded/rollback/skipped；operation/project/run/commit 关联必须贯穿，禁止关键 silent catch。 |
| R-UI-01 | 恢复完整产品 Shell；日志仅位于设置中，默认页面使用成熟“运行记录”形态：今天/项目/记录范围/数量/搜索/导出，默认 500 条；不显示“实时”、Level 列、`INFO:`/`DEBUG:`、severity 小点/图标或 autoscroll 开关；warn 整行文字明黄/琥珀、error/fatal 整行文字红色。正文/meta 与固定时间列在长文本和窄窗口下不得重叠；结构化工程字段点开后查看。 |
| R-UI-02 | 完整 Shell 在 **Settings 内新增独立“开发对话”设置页，并与“日志”同级**；不得出现在左侧主导航、移动端主导航或“桌面客户端”子页。该页复用 `@sanqianx/ai-coding-event-bridge-ui` 的成熟 Conversation Explorer：页面标题只使用“开发对话”，不再出现“跨项目对话记录”、Bridge 技术说明 badge 或大段解释文案；顶部**恰好只保留项目与日期两个控件**，项目一次选择一个且默认当前项目，不提供“全部项目”；所有 AI 来源默认合并，不提供来源、Session、搜索、时间线/Commit 视角筛选。默认列表只呈现真实 user prompt + assistant reply，并用克制的“已提交/关联提交/未提交 + short SHA”表达 Commit 归属；不得显示 `direct/shared-spanning/no-new-user-prompt`、turnId/sessionId 等 debug 术语。绑定数据仍必须与 Knowledge Analyzer 消费的 `CommitConversationSnapshot` 同源。 |
| R-COMP-01 | 删除旧接口、prompt、配置和死代码，不留双路径。 |
| R-SEC-01 | secrets、origin/auth、path traversal、safe errors。 |

## 2. 目标模块图与依赖方向

```text
Claude Code / Codex / OpenCode
            │
            ▼
@sanqianx/ai-coding-event-bridge
  ├─ client hook installers / repair / uninstall
  ├─ event normalizer + repo/session/turn identity
  ├─ local durable event journal
  ├─ multi-consumer cursor API
  └─ headless conversation query contract
            │
            └──────────────> @sanqianx/ai-coding-event-bridge-ui
                               └─ reusable Conversation Explorer
            │
            ├──────────────> DevTask-Radar consumer
            │
            └──────────────> Project Knowledge ConversationCapture
                                   │
routes / desktop / Git hook / MCP / CLI
                   │               │
                   ▼               ▼
     ProjectLifecycle / ConversationStore / CommitReconciler
        │                    │                  │
        ├── GitHookManager   └── ProjectStore   ├── CommitScanner
        ├── GitReader                            ├── CommitConversationBinder
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
- AI editor hooks 的唯一 owner 是 `@sanqianx/ai-coding-event-bridge`；Project Knowledge 不再单独向 Claude/Codex/OpenCode 安装第二套 prompt/response hooks。
- Project Knowledge 的 Git post-commit Hook 仍由本项目管理，但只记录 Git commit boundary / 唤醒 reconcile；它可以调用 Bridge 的本地 append API/CLI 写 boundary，不把 Bridge 变成分析服务。
- Bridge 不依赖 Project Knowledge、DevTask-Radar、LanceDB、知识 Markdown 或任务日历；两个宿主只通过标准 event/cursor API消费。
- `@sanqianx/ai-coding-event-bridge-ui` 只依赖 Bridge Headless Query contract 与宿主提供的轻量 Adapter，不读取 DevTask-Radar SQLite、Project Knowledge JSONL/ProjectStore；Commit annotations 通过可选 host adapter 注入。
- DevTask-Radar 与 Project Knowledge 的 Conversation Explorer 必须来自同一 UI 实现源；允许主题 token/宿主导航不同，禁止复制组件后分叉维护。

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

### 3.3 AI Conversation Capture 与 Commit 绑定流（v8 冻结）

外部 AI 客户端不再依赖 Agent “记得调用 Requirement MCP”。统一流如下：

```text
user presses Send in Claude Code / Codex / OpenCode
  -> Bridge client hook/plugin receives native event
  -> normalize to ai-coding-event/v1
  -> resolve repo identity + branch + HEAD at capture
  -> append durable Bridge event journal first
  -> Project Knowledge consumer imports event into per-project ConversationStore
  -> user_prompt starts/identifies a ConversationTurn
  -> assistant_response closes/updates the same Turn
  -> no knowledge analysis is triggered by conversation capture

later: git commit C
  -> Project Knowledge post-commit hook
  -> append git_commit_boundary(C, parent(C), bridgeHighWatermark, openTurnIds)
  -> freeze the conversation boundary for C
  -> reconcile may run now or later
  -> CommitAnalyzer reads only C's frozen CommitConversationSnapshot
```

#### 3.3.1 标准事件合同

Bridge 最低输出字段：

```text
ai-coding-event/v1
- eventId
- sequence                  # per durable journal monotonic sequence/cursor
- source                    # claude-code | codex | opencode
- eventType                 # user_prompt | assistant_response | session_start | session_end | ...
- role                      # user | assistant | null
- content                   # full user/assistant text for those roles
- sessionId
- turnId
- projectPath
- repoIdentity
- branch
- headAtCapture
- capturedAt
- rawEventType
```

Project Knowledge 可以读取/保存完整 `user_prompt` 与 `assistant_response`，但这些正文**不是日志字段**，不得进入 Logger/SSE/export。Tool payload 默认不复制进 Project Knowledge；Git Diff 继续是“实现了什么”的权威证据。

#### 3.3.2 Turn 是绑定原子，不按单条消息乱配

- 一个 `user_prompt` 创建一个 Turn；随后属于该 Turn 的 assistant response / lifecycle evidence 共享同一 `turnId`。
- Turn 记录 `startSequence/startHead` 与可选 `endSequence/endHead`。
- 如果 AI 在一个 Turn 内先产生 Commit、最后才输出 Stop/assistant response，最终回复仍属于原 Turn，不能因为它的 `headAtCapture` 已经变成新 Commit 就被错配给下一个 Commit。
- 一个 Turn 可以包含多次 assistant intermediate/terminal feedback；Project Knowledge 保存事件顺序，不用 AI 回复重新定义用户需求。

#### 3.3.3 Commit boundary 在 Commit 创建当场冻结

Project Knowledge 的 Git post-commit Hook 对 Commit `C` 写入：

```text
git_commit_boundary/v1
- projectId
- repoIdentity
- commitSha = C
- parentSha(s)
- branch
- committedAt
- bridgeCursorAtCommit
- openTurnIdsAtCommit
- operationId
```

第一条被跟踪 Commit 的窗口起点来自 import 时保存的 `conversationBaselineCursor`；后续 Commit 的窗口起点优先来自其 parent Commit 已记录的 boundary cursor。这样即使 Project Knowledge server 当时离线，后续 startup 仍能从 durable Bridge journal + boundary 重建，不按“分析发生时间”猜。

#### 3.3.4 `CommitConversationSnapshot` 绑定规则（必须实现）

对目标 Commit `C`：

1. **direct turns**：其 `user_prompt.startSequence` 位于 `(startBoundaryCursor, C.bridgeCursorAtCommit]`，且 repoIdentity/project 匹配。
2. **post-commit user prompt hard exclusion**：任何 `user_prompt.startSequence > C.bridgeCursorAtCommit` 永远不能成为 C 的 direct Requirement，即使 C 还没开始知识分析。
3. **assistant tail**：若 Turn 在 C boundary 前已开始且 `turnId` 属于 C 的 direct/open Turn，则其 terminal assistant response 可以在 boundary 后到达并作为同 Turn 的 tail evidence；不得因此吸收 boundary 后新开始的另一个 user Turn。
4. **shared-spanning turn**：同一个 Turn 若真实跨越多个 Git boundary，可同时被多个 Commit snapshot 引用，但必须使用同一 `turnId` 并标记 `bindingKind=shared-spanning`；不得复制成多个独立“新需求”。
5. **multiple prompts before one commit**：同一窗口内多个 user Turns 全部属于该 Commit 的 direct conversation，按 sequence 保存原始顺序。
6. **no new prompt**：窗口内没有 direct user Turn 且没有 spanning Turn 时，`requirementContextStatus=no-new-user-prompt`。可以把父 Commit 的上下文作为 `priorContext` 供人工追溯，但不得升级成当前 Commit 的“用户真实需求”。
7. **explicit override**：显式 requirementId/commit association 仍可作为最高优先级补充，但必须验证 project/repo identity，并在 snapshot 中记录 rationale。
8. **ambiguity**：rebase/non-linear history、丢失 boundary、turn identity 不可靠等无法确定时，标记 `unavailable/ambiguous`，不得靠时间近似、session 猜测或裸 ancestry 自动成功。
9. **freeze**：Claim 创建后 snapshot 的 eventIds/turnIds/bindingKind/contentHash 全部冻结；retry 使用同一 snapshot，不吸收后来事件。

最低 snapshot：

```text
commit-conversation-snapshot/v1
- projectId / repoIdentity / commitSha / parentSha
- boundaryStartCursor / boundaryEndCursor
- status
- turns[]
  - turnId
  - source / sessionId
  - bindingKind: direct | shared-spanning | explicit
  - userEvents[] { eventId, sequence, content, contentHash, capturedAt }
  - assistantEvents[] { eventId, sequence, content, contentHash, capturedAt }
- excludedFuturePromptCount
- snapshotHash
- finalizedAt
```

知识 Prompt 必须明确区分：

```text
User Requirement Truth      = snapshot.turns[].userEvents
AI Conversation Evidence    = snapshot.turns[].assistantEvents
Implementation Truth        = exact Git Diff evidence
Existing Knowledge Evidence = KnowledgeRetrievalService.retrieveForCommit() frozen output
```

assistant response 可以解释 AI 当时如何理解/执行需求，但出现冲突时优先级为：**用户原文 > Git 实际代码事实 > AI 自述**（“需求意图”不得由 Git/AI 自述反推覆盖用户原文）。

#### 3.3.5 Bridge/Project Knowledge 持久化职责

- Bridge 维护自己的 append-only capture journal + consumer cursors；先落盘再通知 consumer。单个 consumer 离线不能导致事件丢失，也不能阻塞其他 consumer。
- Project Knowledge consumer 将本项目需要的 user/assistant normalized events 追加到内部 `ConversationStore`，用于长期项目开发流程审计；用户 knowledge root 仍不得出现这些内部文件。
- 每个 Commit 另外保存冻结 `CommitConversationSnapshot`；知识分析不直接扫描“当前最新聊天”，只读取 snapshot。
- Bridge journal 可按其多 consumer retention/ack 规则做实现级 compaction；Project Knowledge 的已冻结 snapshot 不依赖 Bridge 永久保留原始事件。
- 原 `requirements.jsonl` 作为 legacy/compatibility 输入迁移；新主流程的 Requirement 是 ConversationStore 中的 user-role event/turn。MCP `project_knowledge_record_requirement` 改为显式补充 adapter，写入同一 Conversation capture contract，禁止形成第二套真相。

### 3.4 Knowledge/index success boundary

```text
AI output -> staging manifest -> validation -> promotion journal
-> final Markdown atomically replaced -> state.lastAnalyzedCommit advanced
+ state.index.dirty=true -> global IndexService serial mutation
-> dirty=false on success
```

Index failure never re-runs AI or removes truthful Markdown.

### 3.5 新开发部分：Commit→Knowledge 可靠性强化（v7 起，v8 扩展 Conversation Capture）

这一部分是在 v6 起冻结范围之上的可靠性强化。**v13 没有开放设计项**；下列合同均可机械实施，Agent 不允许把历史 “OPEN” 语义重新解释成自行选型。

| 项目 | 状态 | 本版决定 |
|---|---|---|
| 大于 2 MiB 的 Commit Diff | **APPROVED / IMPLEMENT** | 不再 `patch=null` 后继续要求 AI 产出知识；改为真实、完整、可校验的 Patch chunk evidence。 |
| AI 分析期间其他 AI 修改同一知识 Markdown | **ACCEPTED PRODUCT ASSUMPTION / NO NEW WORK** | 用户确认同一 Markdown 在该分析期间只有本分析链路写；本轮不新增 pre-analysis optimistic concurrency。 |
| server 后台任务 bookkeeping | **APPROVED / IMPLEMENT** | 同项目允许登记多个 operation；后来的任务不得覆盖/清除仍运行的前一个任务。 |
| Requirement / Conversation → Commit 绑定 | **APPROVED / IMPLEMENT (v8)** | Bridge 强捕获 + Git commit boundary + frozen CommitConversationSnapshot；禁止 post-commit 新 prompt 回绑旧 Commit。 |
| 大型知识库 existing-knowledge context | **APPROVED / IMPLEMENT (v12)** | 统一 `KnowledgeRetrievalService`；Commit 使用多信号 hybrid recall → rerank → chunk/section budget；index dirty 使用 Markdown Delta Overlay，不再 filename-order/fixed-N-file。 |

#### 3.5.1 已批准：大 Diff 使用精确只读 Evidence Bundle

目标不是“把 2 MiB 上限调大”，而是在不让自动化 AI 读取源码工作树的前提下，仍能访问该 Commit 的**真实完整 Diff**。

推荐运行目录合同：

```text
runRoot/<projectId>/<runId>/
├─ input/                         # server-owned, AI read-only
│  └─ evidence/
│     ├─ commit.json              # commit metadata / files / full patch hash
│     ├─ patch-manifest.json      # chunk order / path / hunk refs / sha256 / bytes
│     └─ patches/
│        ├─ 000001.patch
│        ├─ 000002.patch
│        └─ ...
└─ output/                        # AI writable
   ├─ files/
   └─ manifest.json
```

强制合同：

1. `patchHash` 始终对完整真实 Git Diff 计算；超过 inline 阈值也不能丢失完整 hash/byte count。
2. 小 Diff 可以直接内联 Prompt；大 Diff 必须按 file/hunk/line-safe boundary 生成**有序精确 chunks**，每个 chunk 记录 `sha256`、bytes、source path、序号与必要 hunk metadata。
3. `patch-manifest.json` 必须可证明 chunk 集合覆盖完整 Diff；Evidence Bundle 构建后逐 chunk 校验 hash。
4. Automation tool policy 分离 read/write roots：`Read` 只允许 `input/evidence` 与必要的 `output`；`Write/Edit/MultiEdit` 只能进入 `output`。禁止通过 Bash 或源码路径补读当前工作树。
5. Prompt 对大 Diff 只内联 commit/file summary + full patch hash + chunk manifest 使用说明；模型按需 `Read` 精确 chunk。
6. 不允许“patch omitted 但仍成功产出知识”的路径。Evidence Bundle 无法完整生成/验证时，Commit 以 typed evidence failure 停止，`lastAnalyzedCommit` 不推进。
7. chunk 内容、完整 Diff、完整 Prompt 不写日志；日志只记录 full hash、chunkCount、totalBytes、单 chunk size summary 与读取阶段。
8. frozen claim 必须包含 full patch hash + evidence-manifest hash；retry 使用同一冻结证据，不能重新读取已经变化的工作树来拼证据。

#### 3.5.2 已批准：后台任务登记改为多 operation registry

当前 `activeTasks.set(projectId, entry)` 允许后来的后台操作覆盖前一个 entry。v7 起要求 server 的任务登记只负责 busy/observability/shutdown，不得破坏 Reconciler 自己的 in-flight dedupe。

目标合同：

```text
activeTasks:
Map<projectId, Map<operationId, TaskEntry>>

TaskEntry = { operationId, kind, startedAt, promise }
```

1. `registerProjectTask(projectId, operationId, task)` 只新增自己的 operation。
2. `finally` 只能按**同一个 operationId**删除自己的 entry；一个短任务失败/结束不能把另一个仍运行任务从 busy registry 中清掉。
3. project map 为空后才删除 project key。
4. `isProjectBusy()` 检查：任一 registered background operation **或** active claim **或** active Claude session。
5. graceful shutdown/drain 必须等待 registry 中所有实际仍运行 Promise，而不是只等待每项目“最后一次 set”的 Promise。
6. Reconciler 的 `inFlightProjects` / project lock 仍是分析幂等和串行的事实源；`activeTasks` 不再承担去重职责。
7. 日志应能从 projectId + operationId 看见 register/start/terminal；不得把 Promise 本身持久化。

#### 3.5.3 本轮接受的单写者假设

用户已确认：在一次 Commit 知识分析期间，同一最终知识 Markdown 不会被其他 AI 并发修改。因此：

- **不新增**“Claim/Prompt 读取 Markdown 时记录 expectedOldHash，并在数分钟后 Promotion 前再次 compare”的额外机制；
- **继续保留** per-project reconciliation lock、staging 隔离、promotion journal、backup、apply-time original hash check、atomic write 与 crash recovery；
- 若未来产品允许其他 AI/外部编辑器同时修改同一知识文件，再重新打开该并发合同；本轮不为未支持场景增加复杂度。

#### 3.5.4 已批准：公共 AI Coding Event Bridge + CommitConversationBinder

`REQ-BIND-v1` 在 v8 **关闭**。最终产品合同以 §3.3 为准：AI editor native hooks/plugin 强捕获、durable event sequence、Git commit boundary 当场冻结、Turn 级绑定与 `CommitConversationSnapshot`。当前 `isAncestor(headAtRecord, commitSha)` 只保留为 legacy characterization，不得继续作为新 Binder 的主要规则。

Bridge 必须作为独立公共 package/repo 维护，DevTask-Radar 和 Project Knowledge 共享同一个实现源；两个宿主不复制 connector 代码，也不各装一套 Claude/Codex/OpenCode hooks。

#### 3.5.5 已批准：统一 `KnowledgeRetrievalService` 解决大型知识库 Existing Knowledge Context

该开放项在 v12 **正式关闭**。根因不是“24 太小”，而是当前 Commit 分析与用户主动搜索走了两套不同的知识选择逻辑：用户搜索已经使用 LanceDB semantic + FTS hybrid search，而 Commit Prompt 仍可能按 filename order 读取固定数量 Markdown。v13 继承并强化这一已冻结决定：两者统一为同一个 Retrieval 层。

目标结构：

```text
                         KnowledgeRetrievalService
                         /                       \
        user search / ask                        retrieveForCommit
               |                                      |
      query + project scope            frozen conversation + commit evidence
               |                                      |
               +-------------------+------------------+
                                   v
                     semantic + keyword + metadata recall
                                   |
                              candidate union
                                   |
                                rerank
                                   |
                       authoritative Markdown verify
                                   |
                         chunk/section context budget
```

**A. 统一 API/职责**

1. 新增 headless `KnowledgeRetrievalService`，至少提供：
   - `search({ projectId, query, limit, scopes })`：供现有 Search/Ask/CLI/MCP/UI 使用；
   - `retrieveForCommit({ projectId, conversationSnapshot, commitEvidence, contextBudget })`：供 T08 Commit Analyzer 使用。
2. 两个入口必须共享同一 index adapter、embedding service、hybrid retrieval、scope weighting、Markdown truth verification 与 degraded/fallback 机制；禁止在 T08 再实现另一套“扫描知识目录挑文件”。
3. `KnowledgeEvidenceReader` 的 filename-order + `maxFiles=24` 逻辑退役；如保留类名只能作为 compatibility wrapper，内部必须委托 Retrieval Service。

**B. Commit-aware 查询信号**

`retrieveForCommit()` 至少使用以下信号，且保持用户原文事实优先级：

- **Primary semantic signal**：`CommitConversationSnapshot` 中 direct/shared-spanning 的真实 `userEvents[].content`；
- **Implementation signal**：commit subject、changed paths（full path + basename + module/path segments）、change manifest；
- **Structured metadata signal**：索引中已有的 `source_paths`、`symbols`、`tags`、`routes`；只有 evidence 能可靠提取/已有 metadata 时使用，缺失不得猜测；
- **Secondary hint**：assistant response 可参与 recall/rerank hint，但不能覆盖 user prompt，也不能作为“需求真相”；
- **Scope signal**：primary project 权重最高；显式 related projects 可按现有 scope contract 降权参与；其他项目禁止隐式进入。

不得把完整 Diff 直接拼成超大 embedding query；Diff 的职责是 implementation truth，Retrieval 只抽取稳定、可校验的 changed path/module/可用 symbol 等检索信号。

**C. 两阶段 Recall → Rerank**

1. **Candidate Recall**：
   - 对用户需求/commit subject/module terms 执行现有 vector semantic + FTS keyword hybrid search；
   - exact `source_paths` / `symbols` / `tags` / `routes` 命中必须能够进入候选集合，即使其纯 semantic rank 不高；
   - 候选池必须大于最终 Prompt 集合（默认实现可使用约 30–50 chunks，属于内部常量，不做用户设置）；去重按 `spaceId + entryId + chunkId`。
2. **Rerank**：按可解释信号排序，不允许只依赖单一 vector score。排序至少考虑：
   - exact changed-path / exact symbol match；
   - user-requirement semantic/keyword relevance；
   - tag/route/module relationship；
   - base hybrid score；
   - primary/related-project scope weight。
3. scorer 的具体数值可作为内部常量迭代，但必须有 deterministic fixture，证明 path/symbol 强关联知识不会被无关高语义文本压到 Context Budget 之外。不得暴露为普通用户设置。

**D. Context Assembly：以 chunk/section 相关性为中心，不再以文件数为中心**

1. Retrieval 首先选择相关 **chunks/heading sections**，而不是整篇 Markdown；同一文档多个相邻高相关 chunk 可合并/扩展为 section。
2. 只有当理解该 section 必须依赖全文时才在 budget 内扩展到完整 document；不得默认把命中文件全文全部塞入 Prompt。
3. 保留总 context safety budget（v13 初始实现可沿用现有约 `256 KiB` 作为初始 aggregate 上限），但 **删除 `maxFiles=24` 作为 selection contract**。最终选择由 relevance + budget 决定。
4. Context manifest 必须记录：selected entry/chunk/heading、source project、current content/document hash、selection signals、retrieval backend/health、index generation、是否来自 delta overlay、总 bytes/tokens estimate。Claim 冻结 `retrievalManifestHash`；retry 不静默换一批旧知识。
5. Prompt 只接收 selected current Markdown content；未选知识不需要以巨大 omitted-file 列表塞进 Prompt，可在 manifest/log 中只记录计数/摘要。

**E. Index dirty：Index + Markdown Delta Overlay，不等待索引**

Markdown 继续是 authoritative truth；LanceDB 只是 derived index。典型连续 Commit：

```text
C1 promotion -> Markdown K1 updated -> index.dirty=true
                                  |
                                  +--> C2 retrieval 立即开始
                                       不能漏掉 K1
```

因此：

1. IndexService 每次成功索引维护 internal derived `index source manifest`（至少 `projectId / generation / entryId / documentHash / sourceCommit`），用于识别自上次成功索引以来的 new/changed/deleted Markdown；该 manifest 位于 internal data dir，不进入用户 knowledge root。
2. 当 `index.dirty=false`：正常使用当前 LanceDB hybrid retrieval，再从 Markdown truth 读取/校验最终 selected chunks。
3. 当 `index.dirty=true`：
   - 当前 LanceDB 可以作为**stale candidate recall**，不能作为最终内容事实；
   - 根据 index source manifest 与当前 Markdown hash 生成 `MarkdownDeltaOverlay`；new/changed docs 用与正式 index 相同 chunking 规则在内存构建临时 chunks，并执行 keyword + 可用 embedding/metadata scoring；deleted docs 从候选中剔除；
   - overlay candidates 与 stale-index candidates 合并后统一 rerank；
   - Prompt 前必须重新读取当前 Markdown 并验证 hash，确保不会把 stale index chunk 直接交给 AI。
4. C2 **不得等待** C1 的 IndexService enqueue 完成；Index failure 也不得导致 Commit knowledge 重跑。
5. Index 完全 missing/unavailable 时：使用当前 Markdown 的 safe fallback retriever（keyword/path/module metadata，embedding 可用时可做 ephemeral semantic scoring）；仍按 relevance + budget 选取，禁止退回 filename-first/fixed-N。
6. dirty/overlay/fallback 状态必须进入 structured retrieval health/log，但日志不得包含完整 knowledge content、user prompt、Diff。

**F. 与现有用户 Search/Ask 的统一**

- `KnowledgeToolRuntime.search()/ask()` 改为委托 `KnowledgeRetrievalService.search()`，保持现有 API 结果兼容；
- 当前 LanceDB `semantic 0.65 + keyword 0.35` 可作为普通 Search 的初始 hybrid 基线，不强迫 Commit rerank 只沿用这两个分数；Commit 需要额外 metadata signals；
- 用户 Search 与 Commit Retrieval 必须使用相同 `space_id`/related-project scope、安全路径、index health 和 Markdown truth 规则；修复一处检索 bug 应同时惠及两条路径。

**禁止行为**

- 禁止按 filename lexical order 取前 N 个知识文件；
- 禁止简单把 24 改成 100/500 作为“修复”；
- 禁止全知识库全文直接塞 Prompt；
- 禁止在 index dirty 时把 stale LanceDB chunk 当成最终 truth；
- 禁止为了 freshness 强制每个 Commit 等索引完成，从而把 IndexService 变成知识成功边界；
- 禁止 Commit Retrieval 绕过统一 service 自行打开/写 LanceDB。

#### 3.5.6 `@sanqianx/ai-coding-event-bridge` 公共模块边界

公共模块至少拆出：

```text
@sanqianx/ai-coding-event-bridge
├─ connectors/
│  ├─ claude-code
│  ├─ codex
│  └─ opencode
├─ installers/
│  ├─ claude-code
│  ├─ codex
│  └─ opencode
├─ core/
│  ├─ event-schema
│  ├─ normalizer
│  ├─ repo-context
│  ├─ turn-identity
│  ├─ durable-journal
│  ├─ consumer-registry
│  └─ dispatcher
├─ query/
│  ├─ conversation-project-provider
│  ├─ session-query
│  ├─ turn-query
│  └─ cursor-pagination
└─ public API/CLI
   ├─ install/status/repair/uninstall(client)
   ├─ appendEvent(...)
   ├─ appendCheckpoint(...)
   ├─ readEvents(cursor, filter)
   ├─ listConversationProjects(...)
   ├─ listConversationSessions(...)
   ├─ listConversationTurns(...)
   ├─ searchConversations(...)
   ├─ registerConsumer(...)
   └─ ackConsumerCursor(...)

可视化层单独发布/导出：

```text
@sanqianx/ai-coding-event-bridge-ui
├─ ConversationExplorer
├─ ProjectDateToolbar              # 默认仅 project + date
├─ VirtualTurnList
├─ TurnCard
├─ conversation-explorer.css
└─ host adapters
   ├─ ConversationDataProvider
   └─ optional CommitAnnotationProvider

# 可选高级调试能力若 DevTask-Radar 仍需要，必须与默认成熟 Explorer 分离：
@sanqianx/ai-coding-event-bridge-ui/admin   # optional export, not Project Knowledge default UI
└─ source/session/tool/raw-event diagnostics
```
```

强制边界：

1. 不包含 DevTask-Radar 的 SQLite task schema、calendar/task analysis、AI analysis worker。
2. 不包含 Project Knowledge 的 project registry、Knowledge Markdown、CommitReconciler、LanceDB、Promotion。
3. endpoint/port 不得硬编码 `127.0.0.1:8787`；Hook 首选本地 durable append，HTTP/IPC 只能作为可配置通知通道。
4. AI client settings merge/uninstall 必须保留第三方已有配置，且一个 Bridge 安装可服务多个 consumer。
5. Bridge 自身不理解“这个 Commit 的知识”；只负责真实事件与 checkpoint 的可靠捕获。
6. Hook failure 不得阻断 AI client 正常工作；若 durable append 失败必须有本地可诊断 fallback，但禁止静默宣称已捕获。
7. Bridge Core 不依赖 UI；UI 包不得反向成为 Hook/daemon/CLI 的依赖。
8. Conversation Explorer 只展示 normalized project/session/turn 模型；Project Knowledge 的 commit binding overlay 必须来自宿主 `CommitAnnotationProvider`，不能写回或改变 Bridge 原始事件。
9. Headless query 与 UI 都必须支持 cursor/pagination/virtualization-friendly 数据窗口，禁止一次性将全部历史对话装入浏览器 DOM。

#### 3.5.7 Project Knowledge ConversationStore

推荐内部布局（最终字段以 T01 schema 为准）：

```text
~/.project-knowledge/projects/<projectId>/
├─ conversation-events.jsonl
├─ commit-conversations/
│  └─ <commitSha>.json
├─ config.json
└─ state.json
```

- `conversation-events.jsonl` 保存 Project Knowledge 实际消费的 user/assistant normalized events 与必要 lifecycle metadata；正文可完整保存。
- `commit-conversations/<sha>.json` 保存 frozen snapshot，不因未来对话追加而变化。
- 完整 prompt/assistant response **禁止进入日志**，但允许进入上述业务数据文件，因为这是用户明确要求保留的开发过程证据。
- 完整 conversation timeline 已成为 v11 产品合同：Project Knowledge 必须在 **Settings 中提供与“日志”同级的“开发对话”入口**，并通过共享 Conversation Explorer 展示；该入口不得出现在主侧栏、移动端主导航或“桌面客户端”子页。Knowledge Analyzer 与 UI 对 Commit 归属必须读取同一 `CommitConversationSnapshot`/annotation projection，禁止各自重新计算。

#### 3.5.8 共享 Conversation Explorer 与 Project Knowledge 成熟产品视图（v11 冻结）

公共 UI 的职责是“让用户自然地回看某个项目某一天的开发对话”。它不是调试器、事件浏览器、Session inspector 或 Commit 分析控制台。

```text
Settings → 开发对话
├─ 项目：单选一个项目
├─ 日期：选择一天
└─ 对话列表
   ├─ 时间
   ├─ 用户需求原文
   ├─ AI 回复原文
   └─ 克制的提交归属
      ├─ 已提交 · <shortSha>
      ├─ 关联提交 · <shortSha> · <shortSha>   # 同一 Turn 跨多个 Commit 时
      └─ 未提交
```

冻结规则：

1. Project Knowledge 的“开发对话”是 **Settings 内独立一级设置页**，与“日志”同级；不得出现在主侧栏、移动端主导航或“桌面客户端”页。
2. Settings Drawer 自身标题使用 **“开发对话”**。页面内部不得再叠加“跨项目对话记录”“共享 Conversation Explorer”“CommitAnnotationProvider”等实现型标题、badge 或大段技术说明；允许一条非常短的产品说明，例如“查看项目开发过程中的需求与 AI 回复。”。
3. 顶部控件**恰好两个**：
   - `项目`：单项目 selector；默认当前主界面选中的项目，若当前项目不可用则选首个已注册项目；**没有“全部项目”**。
   - `日期`：单日选择；默认今天。
4. 不提供可见的 `来源`、`全部来源`、Claude Code/Codex/OpenCode source filter；三个来源自动汇入所选项目当天的对话流。来源可作为轻量消息 metadata/AI 名称展示，但不是筛选器。
5. 不提供 Session 左栏、Session selector、sessionId/turnId；Session/Turn identity 只保留在 Bridge 与 binding 内部用于去重、归属、审计。
6. 不提供搜索框；当前产品需求只按项目和日期浏览。未来若真实产品需求再出现，必须另行评审，不因底层 API 有 query 能力就自动暴露。
7. 不提供“时间线 / Commit 视角”切换。页面天然按事件时间顺序展示当天对话；Commit binding 仅作为每个 Turn 的轻量归属 metadata，不建立第二套浏览模式。
8. 默认视觉只显示 `用户需求 → AI 回复`。tool/result/raw hook event 不进入成熟产品默认视图；DevTask-Radar 如需 Admin/Debug feed，可在其宿主产品独立提供，不污染共享成熟 Conversation Explorer。
9. UI 不显示 `direct`、`shared-spanning`、`no-new-user-prompt`、`unavailable` 等内部 binding 枚举。产品化映射仅为：
   - 一个 Commit：`已提交 · <shortSha>`；
   - 同一 Turn 跨多个 Commit：`关联提交 · <shortSha> · <shortSha>`；
   - 尚无 Commit：`未提交`。
10. “关联提交”的 short SHA 集合必须来自 frozen `CommitConversationSnapshot`；“未提交”必须是真实 boundary 之后尚未被冻结的 Turn。UI 不得依据时间自行猜测。
11. `assistant_response` 是 Conversation Evidence；可以完整展示，但不得被标成用户需求，也不得覆盖用户 Prompt 的语义。
12. 共享 UI 不拥有 Project Knowledge binding 算法；它消费宿主提供的 annotation projection。DevTask-Radar 不提供 commit annotation 时仍可显示项目/日期/用户/AI 对话。
13. UI 与 Knowledge Analyzer 对“本 Commit 使用了哪些 Prompt/Reply”必须可通过内部 eventId/turnId 审计一致；这些内部 ID 默认不暴露给普通用户。
14. 对话正文属于敏感业务数据：不进入运行日志、日志导出或日志 SSE；Conversation API 遵循本地认证/origin 规则并纯文本安全渲染。
15. 长对话使用 cursor pagination + windowed/virtualized rendering 或等效机制；切换项目/日期不得一次加载全部历史。
16. light/dark/mobile 必须保持成熟产品布局：无 debug 表头、无技术 badge 堆叠、无二级 Session sidebar、无多余空状态说明。

### 3.6 Logging flow

```text
logger.child({component, projectId, operationId, ...})
 -> recursive redaction + size bounds
 -> single async write queue
 -> projectId ? projects/<projectId>/<local-day>.jsonl : system/<local-day>.jsonl
 -> append one JSON object per line; no automatic deletion
 -> durable append -> publish log-appended event -> SSE subscribers
 -> flush on shutdown

LogRepository:
 selected date/source files -> reverse chunk iterators -> timestamp merge -> filters -> pageSize(default 500) -> cursor
```

## 4. 共享 Schema 与错误合同

主 Agent在 T01 冻结以下文件/对象；后续任务不得独自改变字段语义：

- `settings/v2`
- `project-registry/v2`
- `project-config/v2`
- `project-state/v2`
- `requirement/v1`（legacy/compatibility）
- `ai-coding-event/v1`
- `git-commit-boundary/v1`
- `commit-conversation-snapshot/v1`
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

### 5.0 设计 Gate 状态

- **DG-REQ（closed）**：T07/T08 按 §3.3 的 Bridge event + commit boundary + CommitConversationSnapshot 合同直接实施；禁止回退到 analysis-time ancestry guessing。
- **DG-KCTX（closed）**：T08/T09/T11 按 §3.5.5 的统一 `KnowledgeRetrievalService`、Commit-aware recall/rerank、chunk/section budget 与 Markdown Delta Overlay 合同实施；禁止回退 filename-first/fixed-N。
- 当前没有开放设计 Gate；T13 可以在所有实现/测试证据满足后按本版 DoD 判定完成。后续新增产品 Phase 由用户另行批准并继续扩展本唯一 Plan。

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

### 8.1 单一共享事实源

- 所有 Agent 的产品/架构/验收事实均来自本文件；历史文档只按需用于追溯证据。
- 本文件 §1–§4 是唯一共享定义；任务通过 F/P/R/B/TS ID 引用。
- 不把历史 Plan、PRO_REVIEW 或完整聊天历史转发给每个 Agent；默认只发本文件中该任务需要的 Context Packet。
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

### 10.0 v13 审查后的机械实施收紧（所有 T00–T13 的覆盖规则）

以下规则优先于 v12 遗留措辞；对应 Commit 的精确顺序见 `COMMIT_SEQUENCE.md`。

1. **先 CI 后大改**：第一个 Project Knowledge 功能 Commit 必须建立 non-release CI；该 workflow 不能 publish/release/tag。CI 建立后每个 push 必须远端绿灯才进入下一 Commit。
2. **Bridge 先在独立 public repo 开发**：不把 DevTask connector 源码复制进 Project Knowledge。Bridge core/ui 的 package tarball 在开发期通过 `npm pack` 做 cross-repo contract test；消费者正式 package.json/lockfile 只在 Bridge final package 已发布并可 `npm view` 验证后锁定。
3. **Atomic boundary API**：T07/Bridge 必须提供 `appendCommitBoundary()`，内部与 `appendEvent()` 共用 journal writer/lock/sequence。T06 Git Hook 只调用这一个原子操作，不自己拼 cursor/openTurnIds。
3A. **Stable Hook Runtime**：AI client managed config 只能指向 `~/.ai-coding-event-bridge/bin/<stable-shim>`；Project Knowledge/DevTask 的 `node_modules` 只提供 installer API，不能成为最终 Hook command path。consumer registry + install lock 决定升级/卸载。
4. **双 freeze**：boundary freeze = user-turn membership；claim freeze = analyzer conversation evidence snapshot。二者 hash 分开保存。Claim 后迟到 assistant 不改变该 Claim。
5. **Codex 不猜 latest session**：任何 mtime-global-latest 算法不得进入 Bridge 正式路径。per-session byte cursor + stable identity/fixture；无法唯一定位即 capture gap。
6. **无 fake evidence**：禁止 `unknown-session`、synthetic user prompt、按时间邻近“补齐”缺失 Requirement。
7. **同 repo conversation stream**：merge/rebase 情况按 Bridge durable repo sequence 的上一 boundary 开窗；Git parents 只用于 implementation evidence。
8. **Delete 事务化**：delete 与 import 同级对待；每阶段 journal + idempotent resume，不能把 destructive steps 当普通 cleanup。
9. **日志历史兼容**：新 writer 切换为 system/projects day-file 后，旧 app/hooks/.001/.log 仍 read-only 可查；任何 migration 不自动删除旧日志。
10. **UI 文案**：v10 只作为布局/视觉合同；实现型说明、技术 badge、debug 导航不得复制到 production。
11. **Checkpoint**：`.agent-state/current.json` 是本机 transient 文件，加入 `.gitignore`，不得为更新 checkpoint 单独制造 Commit。远端恢复以 `COMMIT_SEQUENCE` ID + Git history/remote SHA 为准。
12. **No broken intermediate tree**：对尚未发布的 Bridge，消费者只能使用 injection/optional adapter/local tarball 测试，不允许把 `package-lock` 锁到不存在的 registry version。

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
10. 冻结测试编号为 TS-01～TS-52：新增日志覆盖要求并入 TS-39～TS-42，200 条成熟 UI / full-height / no-overlap 要求并入 TS-52；**禁止擅自新增第 53 个及以后的测试编号**。

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
3. Settings merge：knowledge root、AI profiles、embedding、prompt overrides、enabled integrations；secret bytes/hash 保持。旧 `logging.json` 只作为历史日志发现/兼容输入，不把 retention/capacity/root 迁入新可编辑设置。
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

### T05 — Logger v3、按项目/按日永久日志、全链路可观测合同、LogRepository 与 SSE 发布

**目标与可观察结果**

- 唯一正式 Logger 提供 trace/debug/info/warn/error/fatal，所有业务模块最终只写这一套。
- 有 `projectId` -> `logs/projects/<projectId>/<YYYY-MM-DD>.jsonl`；无项目归属 -> `logs/system/<YYYY-MM-DD>.jsonl`。
- 同一 source/项目同一天一个目标文件；永久保存，无 retention/capacity cleanup，无 size `.001/.002` segment。
- LogRepository 对大单日日志反向分块读取，默认 500、最大 5000；全部项目按时间 k-way merge，不整文件读入。
- 成功落盘后 publish `log-appended`，T10 通过 SSE 推送；无轮询。
- **关键新增 Gate：Logger 基础完成不算可观测性完成。T06–T11 每个业务 owner 必须按本节覆盖矩阵给自己模块补齐详细阶段日志；T13 做最终 repo-wide audit。**

**前置依赖**：T01、T02；ProjectStore context 在 T03 后接入。  
**负责角色**：Logging Agent 负责 logger/repository/coverage contract/test helpers；各业务 Agent 负责自己模块 instrumentation。  
**并行**：可与 T07 并行；Logging Agent 不跨任务大面积编辑业务模块，避免 ownership 冲突。

**Context Packet**

- P-17、P-18、P-19。
- R-LOG-01..05、R-SEC-01。
- BUG-LOG-001..003、BUG-SEC-001。
- 当前 HEAD v4.1.23 代码审查：`structured-logger.js`、`commit-reconciler.js`、`knowledge-promotion.js`、`index-service.js`、`project-lifecycle-service.js`、`requirement-recorder.js`、`migration-service.js`、`knowledge-tool-runtime.js`、`claude-cli-runner.js`、`integration-installer.js`、`server-app.js`。

**当前代码审查必须保留为实施依据**

- `CommitReconciler` 已有 claim prepared / commit completed / failure，但缺 owner/scan/selection/processor/sweep 等过程日志。
- `KnowledgePromotionService` 主要只有最终 promotion completed/failed，缺 staging/analyzer/manifest/backup/apply/verify/state/index 阶段。
- `IndexService` 主要只有最终 project applied/failed，缺 enqueue/start/adapter/state/retry/full rebuild stage。
- `ProjectLifecycleService` Import 主要 started/completed/failed，Delete 基本只有 completed；rollback/Hook/path/Git 等过程不足。
- `RequirementRecorder` 成功会记，失败/resolve/Git context 缺少链路。
- `MigrationService` 几乎只有 migration.failed。
- `KnowledgeToolRuntime` 搜索/Ask/Get/History 和 index->Markdown fallback 没有完整结构化日志。
- `claude-cli-runner.js`、`integration-installer.js` 当前没有统一结构化 Logger 接入。
- `server-app.js` 有 startup/request failed/SSE helper，但正常业务 request completed/duration 和多数业务状态变更入口没有统一 request chain。

**允许修改（Logging Agent）**

- `_site/lib/structured-logger.js`、LogRepository、redaction、reverse reader、cursor、export、event bus。
- StorageLayout 的固定 log scope 命名（与 T02 协调）。
- logging test helpers，例如 `assertOperationChain()`、`captureLogs()`、coverage fixture/schema。
- owned backend logging tests。

**禁止修改（Logging Agent）**

- 为了“加日志”直接横跨 T06–T11 改完所有业务文件；由各 owner 按矩阵实施。
- server routes/UI。
- 引入日志数据库、队列或第三方 daemon。
- retention/capacity 自动删除。

**Logger/core 具体修改**

1. stable `log/v2`：id、ISO ts、level、component、event、message、projectId/projectDisplayName、operationId、runId、commitSha、phase、attempt、durationMs、error、context。
2. stable event naming：`<component>.<noun>.<state>` 或现有约定，started/completed/failed/retry/degraded/skipped 必须可搜索。
3. recursive error serialization/redaction；日志/SSE/export 使用完全相同的 sanitizer。
4. shared core：所有 `logger.child()` 共享 writer queue、health、event bus/sequencer；child 只追加 immutable context。
5. projectId path -> `logs/projects/<projectId>`；否则 -> `logs/system`。旧 app/hooks 只兼容读。
6. local date `YYYY-MM-DD.jsonl`，不 size rotate；一天一个文件。
7. durable append：完整单行 JSON 写入+flush 成功之后才 publish。
8. Hook offline append 使用安全 cross-process append；任何日志失败都不影响 Git commit。
9. 永久保存：删除 cleanup/retention/max size production 删除路径；ENOSPC 只 degraded + stderr。
10. query filter 保留 date/from/to/projectId/levels/component/event/commit/operation/q/pageSize/cursor；default pageSize 500、hard max 5000。
11. 反向 byte-chunk reader；禁止读取整日日志后 split。
12. all-project reverse iterators + heap/k-way merge，拿够 N 即停。
13. cursor fingerprint + source continuation；文件被手动删时 typed expired/restart。
14. export 流式、按当前范围、统一脱敏。
15. event bus subscriber 异常不得阻塞 writer；payload 为已脱敏 public record。
16. Logger 自身不得递归记录“写了一条日志”；health transition 使用 non-recursive fallback。
17. orphan detection 使用受限范围/watermark，禁止多年历史全扫。

**全链路 instrumentation 强制合同（所有后续业务 Task 继承）**

每个“长事务/关键操作”必须具备：

```text
<operation>.started
<operation>.<stage>            # 可以很多条，trace/debug/info
<operation>.retry/degraded     # 如发生
<operation>.completed
<operation>.failed             # 与 completed 互斥
<operation>.rollback_*         # 如发生
```

统一要求：

1. operationId 在入口生成一次并向下传；禁止每层自己新建导致链路断裂。
2. Commit 链继续强制 projectId + operationId + runId + commitSha。
3. 外部调用（Git/Claude SDK/CLI/DB/关键 FS）必须记录 started/result/duration/attempt，不记录 raw secret payload。
4. 状态更新必须记录安全 before/after 摘要，例如 generation、tracking mode、lastAnalyzedCommit、dirty、counts。
5. retry 必须含 attempt、delayMs、reason；fallback 必须含 fromBackend/toBackend/reason。
6. failure 必须含 error name/code/message/stack/cause、phase、duration、retryable。
7. `trace/debug` 日志可以多：路径、文件数、字节数、scan count、lock wait、cache decision 等都可以记录；**不要为了“少日志”删掉调试上下文**。
8. 禁止在日志里写 API Key/Token/Header、完整 Requirement、完整 Prompt/Diff/assistant/tool output；写 hash/len/count/model/profile/tool name。
9. critical `catch {}` 必须改成 log + 明确行为；只有真正 best-effort 且不会影响诊断的路径可保留，并在代码注释中说明。

**业务模块日志覆盖矩阵与 owner**

| Owner Task | 模块 | 最低必须覆盖的事件 |
|---|---|---|
| T10 | server/runtime | startup/migration/store/listen/shutdown；business request started/completed/failed + method/path/status/duration |
| T06 | lifecycle | import validate/git/path/metadata/hook/registry/rollback/completed；delete started/busy/hook/metadata/knowledge/completed/failed |
| T06 | hook | invoked/repo resolved/project resolved/endpoint resolved/accepted/offline/fallback |
| T08 | reconciler | owner/lock、scan started/result、pending count、commit selected、claim new/recovered、processor start/end、rescan、sweep end |
| T07 | requirement | record started/resolve/git context/append/completed/failed；binder decision/ambiguity/unavailable |
| T10/T08 | Claude runner | session create/restore、profile/model、SDK attempt/retry/end、permission、input hash/length、abort、persist failure、session terminal |
| T09 | promotion | staging、analyzer、manifest validation、backup、per-file apply(trace)、verify、state advance、index enqueue、rollback/recovery |
| T09 | index | enqueue/dedupe/rerun、index start/adapter/state、dirty retry、full rebuild build/validate/swap/rollback |
| T11/T10 | knowledge runtime | search/ask/get/history start/end、project/scopes、backend、index->Markdown fallback、result count/duration |
| T04 | migration | discovery/source count、backup、staging、validation、activation、completion、rollback each step |
| T11 | integrations | client detect、status/install/update/uninstall、CLI command start/end/status/duration with redacted args |
| T02/T03 | Atomic/stores | slow lock wait、stale recovery、atomic retry/failure；普通成功 read 不需要 info，可 trace |

**测试**

Logger infra tests：
- six level write/filter、shared child queue/event ordering。
- project/system local-day paths，单日单文件，无 `.001`。
- concurrent/cross-process append合法 JSONL。
- redaction覆盖 error cause/stack/SSE/export。
- permanent retention；production 无 cleanup path。
- reverse reader：chunk boundary、超长行、CRLF、坏尾行。
- all-project merge、default 500、5000 hard max、cursor/file deletion。
- ENOSPC/permission fallback + health。
- durable append before event。

Instrumentation contract tests/helpers：
- `assertOperationChain(logs, { operationId, expectedStages })`。
- 至少对 import、one commit success、one commit AI retry/fail、promotion rollback、index fallback/full rebuild、migration rollback、requirement append failure、integration CLI failure 建链路 fixture。
- 任一 expected critical operation 缺 started/terminal/stage 时测试失败，而不是只断言“至少有一条日志”。

**验证命令**

```bash
node _site/_test/structured-logger-test.js
node _site/_test/logging-api-test.js
node _site/_test/log-redaction-test.js
node _site/_test/log-stream-test.js
node _site/_test/log-operation-chain-test.js
```

**验收**

- Logger core、存储、查询和 publish 合同冻结。
- 新代码无自动删除历史日志 path。
- query 不整文件读入；default 500/hard max 5000。
- 写入完成后只 publish 一次。
- coverage matrix 已转换成后续 task 的必做验收项，不能被当成“可选日志优化”。

**失败/恢复**

- 用户手动删日志：reader restart，writer下次按需创建。
- active file 坏尾行：保留合法前缀并可见警告。
- subscriber failure只隔离 subscriber。
- Logger health degraded 时业务继续按各自合同运行，error/fatal stderr fallback。

**最小交付**

- Logger shared core、fixed paths、reverse reader/cursor、publish API、coverage matrix/test helper、test summary。

**映射**：TS-38–51；BUG-LOG-001..003、BUG-SEC-001。

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
   - empty repo: trackingMode=empty-repo、trackingStartCommit=null；
   - 同时从 Bridge durable journal 记录 `conversationBaselineCursor`，确保导入前历史对话不会绑定到首个被跟踪 Commit。
7. `installHook({ repoPath, projectId, triggerScriptPath, endpointResolverPath/version })` validates trigger exists。
8. resolve hook path through Git command, honoring worktree/core.hooksPath。
9. generated Hook v2：strict marker JSON/comment、projectId、runtime `git rev-parse --show-toplevel`；Commit 成功后先通过 T07 Bridge append/checkpoint API 写 `git-commit-boundary/v1`（commitSha/parent/repo identity/cursor/openTurnIds），再做 nonblocking server notification；任何知识分析失败都不能影响已完成 Commit，Hook 最终 exit 0。
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
- service unavailable Hook exits 0；Bridge durable journal 中仍存在 commit boundary，startup 可恢复对话窗口；诊断日志仍按 Hook logging contract 写入。
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

**映射**：TS-03、06、10、12–18、23–25、27–33、37、40、49；BUG-HOOK-001..004、BUG-LIFE-001..004、BUG-KNOW-001。

---

### T07 — AI Coding Event Bridge、共享 Conversation Explorer 数据层、ConversationStore 与 Commit 绑定

**目标与可观察结果**

- `@sanqianx/ai-coding-event-bridge` 从 DevTask-Radar connector 能力中独立抽出，并可被 DevTask-Radar / Project Knowledge 共同复用。
- Claude Code、Codex、OpenCode 的 user prompt 与 assistant response 可被强捕获、持久化到正确 project 的 ConversationStore；捕获动作不触发知识分析。
- Git Commit 创建时冻结 Bridge cursor/open turns；Commit claim 使用 `CommitConversationSnapshot`，不按未来分析时间猜 Requirement。
- Bridge 同时提供跨宿主 Headless Conversation Query contract；`@sanqianx/ai-coding-event-bridge-ui` 作为独立可选 UI 层复用，不与 DevTask-Radar/Project Knowledge 业务数据库耦合。

**前置依赖**：T03；T01 schema。  
**负责角色**：Conversation Capture / Bridge Agent。  
**并行**：可与 T05/T06/T08 的 scanner 部分并行；不编辑 server。

**Context Packet**

- P-09、P-10、P-11、P-12、P-21～P-25。
- R-REQ-01..03、R-TRG-02、R-UI-02。
- BUG-REQ-001、BUG-AUTO-002、BUG-AUTO-006。
- requirement/claim contracts from T01；ProjectStore from T03。

**必须读取**

- `_site/server.js · /api/claude/sessions/:id/input` 及 session metadata。
- `_site/lib/claude-cli-runner.js`/workbench session model。
- `_site/lib/project-knowledge-mcp.js` 或实际 MCP server。
- `_site/lib/integration-installer.js`、plugins/project-knowledge Skill、OpenCode instruction files。
- `SanQianX/DevTask-Radar`: `connectors/{claude-code,codex,opencode,shared}`、`EventNormalizer.js`、`TurnAggregator.js`、Claude/Codex integration services；只抽公共捕获能力，不搬 DevTask-Radar 业务。
- project resolution in `knowledge-tool-runtime.js`。
- tests: `claude-workbench-test.js`、`mcp-server-test.js`、`integration-adapters-test.js`、`runtime-endpoint-test.js`。

**允许修改**

- **不得在 Project Knowledge 仓库内实现 Bridge package 源码。** Bridge connectors/installers/core/query contracts 由独立 public repo `SanQianX/ai-coding-event-bridge` 的 BR01–BR09 owner 实施；本任务在 Project Knowledge 侧只实现 consumer/adapter/ConversationStore，并通过 injection 或 Bridge `npm pack` tarball 做开发期 contract test。
- 独立可选 UI package/export `@sanqianx/ai-coding-event-bridge-ui` 的 Conversation Explorer 模型/渲染层与 host adapter contracts；Project Knowledge 页面接线仍由 T12 独占。
- Project Knowledge `ConversationStore` / `CommitConversationBinder` / legacy Requirement adapter。
- MCP explicit requirement adapter implementation/config/skill instructions。
- embedded session adapter helper（server wiring留 T10）。
- owned tests。

**禁止修改**

- knowledge analysis dispatch。
- Commit prompt/reconciler（T08）。
- `server.js` route body。
- 给 MCP 增加 Markdown 写权限或通用文件写工具。

**具体修改**

1. 从 DevTask-Radar 提炼 Claude Code/Codex/OpenCode connector + normalizer + installer 的公共能力到 `@sanqianx/ai-coding-event-bridge`；不得复制后各自演化。
2. Bridge 先 durable append `ai-coding-event/v1`，再通知 consumer；实现 monotonic cursor、eventId 去重与 consumer ack/cursor。
3. capture 时解析可信 Git repo identity、branch、HEAD；失败允许 null，但在 Project Knowledge binding 时不得伪装成高置信 direct mapping。
4. user prompt 建 Turn；assistant response 归同 turn；实现 commit-before-assistant-stop 的 tail 归属。
5. Project Knowledge consumer 只接受已注册项目 repo identity，追加 `conversation-events.jsonl`；跨项目事件拒绝/忽略并记录安全 metadata 日志。
6. import 保存 `conversationBaselineCursor`，避免导入前历史对话绑定到首个新 Commit。
7. Git post-commit 写 `git-commit-boundary/v1`，至少含 commit/parent/bridge cursor/openTurnIds；server 离线也必须能在本地持久化 boundary 或由 startup 明确检测缺口。
8. `CommitConversationBinder` 严格实现 §3.3.4 direct/post-commit exclusion/assistant tail/shared-spanning/no-new-prompt/explicit/ambiguous decision table。
9. 生成 `commit-conversation-snapshot/v1` 并计算 snapshotHash；claim 冻结 eventIds/turnIds/contentHash，retry 不吸收未来事件。
10. Knowledge prompt 明确分区 User Requirement Truth / AI Conversation Evidence / Git Implementation Truth；assistant response 不得覆盖/改写 user prompt 的需求语义。
11. MCP `project_knowledge_record_requirement` 降级为 explicit adapter，写入同一 ConversationStore contract；Skill 不再承担必达捕获。legacy `requirements.jsonl` 迁移/兼容但不再是新主路径的第二真相。
12. Project Knowledge 不直接安装第二套 AI editor hooks；后端 integrations/status 可读取 Bridge install status 供诊断/自动修复，但 **Settings → 桌面客户端及主 UI 不新增 Bridge 状态卡片/重复入口**。
13. privacy：业务 ConversationStore 可以保存完整 user/assistant 文本；Logger、error、SSE logs、export logs 禁止输出完整正文，只写 eventId/hash/len/source/session/turn。
14. 提供 Headless Conversation Query：底层允许按 project/repo、source、session、date/time、cursor/limit 等真实字段查询 normalized turns，禁止公共 UI 读取宿主私有 SQLite/JSONL。
15. 提供共享成熟 Conversation Explorer UI 层：默认产品界面只暴露 **项目 + 日期** 两个控件；来源自动合并，不提供 source filter、Session 导航/筛选、搜索、时间线/Commit 模式或“全部项目”。Commit annotation 仅映射为“已提交/关联提交/未提交 + short SHA”，不显示内部 binding 枚举。
16. 公共 UI 必须是可独立复用实现源；DevTask-Radar 与 Project Knowledge 只做 provider/navigation/theme adapter，不复制 Turn renderer；DevTask-Radar 自己的 Admin/Debug Activity Feed 如需 source/session/tool/raw event 能力，应与成熟 Conversation Explorer 分离。

**测试**

- Claude Code/Codex/OpenCode fixtures 归一成同一 event schema，user/assistant 内容不串 source/session/turn。
- Bridge consumer offline 后恢复，从 cursor 补读且不丢/不重复事件。
- `R1(head=C0) -> commit C1 -> R2(head=C1) -> later analyze C1`：C1 snapshot 只含 R1，R2 hard excluded。
- 多个 user turns 在 C1 boundary 前发生：按 sequence 全部进入 C1。
- AI 在 Turn T1 中创建 C1 后才输出最终 assistant response：该 response 作为 T1 tail 进入 C1，不进入 C2 的新需求。
- Turn T1 真实跨 C1/C2：两个 snapshot 均引用相同 turnId，bindingKind=`shared-spanning`，不生成两个独立 requirement。
- C1 后没有新 user prompt 且不存在 spanning turn：C2=`no-new-user-prompt`，不得自动把 C1 prompt 伪装成 C2 direct requirement。
- post-commit 后的新 user prompt 永远不能回绑旧 Commit，即使旧 Commit 的 reconcile 尚未启动。
- explicit association wrong project/repo rejected；rebase/boundary gap/identity ambiguous => unavailable。
- snapshot frozen 后 retry 不吸收未来 user/assistant events。
- Project Knowledge 与 DevTask-Radar 同时作为 Bridge consumer 时各自 cursor 独立；卸载其中一个 consumer 不移除另一个仍需要的唯一 Bridge hook。
- Bridge Headless Query fixture 在两个宿主 adapter 下返回相同 normalized turn semantics；共享 Conversation Explorer 在无 CommitAnnotationProvider 时正常工作。
- Project Knowledge CommitAnnotationProvider 只投影 frozen snapshot/boundary；C1 后新对话在 UI 中显示“尚未归属 Commit”，不得被 UI 挂回 C1。
- 同一 `shared-spanning` turn 在 Commit view 的 C1/C2 中引用相同 turnId；UI 不复制成两个 Requirement。
- 完整 prompt/assistant text 存在 ConversationStore，但不出现在 structured logs/SSE log export。
- legacy requirements fixture 可迁移/兼容读取，且不会与 Bridge user event 重复绑定。

**验证命令**

```bash
node _site/_test/claude-workbench-test.js
node _site/_test/mcp-server-test.js
node _site/_test/integration-adapters-test.js
node _site/_test/requirement-recorder-test.js
node _site/_test/requirement-binding-test.js
node _site/_test/ai-coding-event-bridge-test.js
node _site/_test/commit-conversation-binding-test.js
```

**验收**

- Bridge/ConversationStore 均按首次真实事件 lazy-create，不因安装插件生成空业务数据。
- no conversation adapter can directly trigger knowledge analysis。
- post-commit future prompt exclusion、shared-spanning、no-new-user-prompt、ambiguous path 都是 deterministic/testable。
- retry claim uses frozen `CommitConversationSnapshot` eventIds/turnIds/content hashes。

**失败/恢复**

- Bridge durable append fails：不得把内存事件当 durable success；AI client 本身继续工作，但 Bridge health/本地 fallback 明确可诊断，Project Knowledge 将该窗口标记 capture gap。
- Project Knowledge consumer 离线：Bridge cursor 不前移，恢复后补读。
- Git/repo metadata unavailable：事件可保存低置信 metadata，但 Binder 不假装 direct high confidence；boundary 缺失时 explicit ambiguous/unavailable。

**最小交付**

- reusable Bridge package boundary、three client connectors/installers、durable journal/cursor、Headless Conversation Query、shared Conversation Explorer UI package/export、Project Knowledge ConversationStore、git commit boundary、CommitConversationBinder/snapshot、legacy explicit adapter、tests。

**映射**：TS-10、41、51、52；BUG-REQ-001、BUG-AUTO-002、BUG-AUTO-006。

---

### T08 — CommitScanner、统一 CommitReconciler 与唯一 Prompt

**目标与可观察结果**

- Hook/startup 两入口对同一 Commit 使用同一个 frozen `CommitConversationSnapshot`、Git evidence，生成相同 claim 和 prompt。
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
   - full patch 始终计算完整 hash；小 Diff 可 inline，大于阈值按 §3.5.1 生成 exact chunk evidence bundle，禁止 `patch=null`/stats-only 成功路径；
   - claim 冻结 full patch hash + evidence-manifest hash，retry复用同一证据；
   - existing knowledge 只通过统一 `KnowledgeRetrievalService.retrieveForCommit()`；按 §3.5.5 使用 frozen user prompts + commit subject + changed paths + 可用 symbols/tags/routes 做 hybrid candidate recall → rerank → chunk/section budget；禁止 filename-first/fixed-N；
   - AI 不用通用 Bash，也不直接读源码工作树。
9. claim create在 AI 前：freeze requirementIds/binding、patchHash、`retrievalManifestHash`、prompt version/hash、knowledgePath、runId、phase；retry 复用同一 frozen conversation/patch/retrieval manifest，不静默吸收后来知识或聊天。
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
- evidence too large：按 §3.5.1 精确分块并允许 AI 只读 evidence bundle；不能 silent truncate，也不能 `patch=null` 后继续成功分析。若完整 bundle 无法生成/校验，typed failure 且 pointer 不推进。
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
- >2 MiB fixture：full patch hash稳定、chunk 顺序/sha256/覆盖完整、AI 可 Read evidence 但不能 Write input 或读源码；禁止 stats-only/patch-null success。
- corrupted/missing chunk => evidence failure、no AI promotion/no state advance。
- 大型知识库 retrieval fixture：构造至少 100–200 个 Markdown/chunks，真正相关文档在 filename 排序后部；必须被 hybrid+metadata retrieval 选中，无关前 24 个不得因文件名顺序占满 context。
- changed path/source_path exact match、可用 symbol/tag/route match 能进入候选并在 deterministic rerank 中获得可解释优势；assistant response 只能作为辅助 hint。
- clean index 与 dirty-index+delta-overlay 对同一 frozen Commit 的关键相关知识集合保持等价；C1 刚 Promotion 且 index 尚未完成时，C2 retrieval 必须能看到 C1 新知识。
- stale index 中已删除/已修改 chunk 不能以旧内容进入 Prompt；missing index 走 Markdown relevance fallback，不得退回固定前 N 文件。
- `retrievalManifestHash` 在 retry 中稳定；selected chunk 在 Prompt 前从当前 authoritative Markdown 读取并校验 hash。
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

- reconciler API、state transition implementation、prompt version、scanner semantics、CommitConversationSnapshot consumption、exact large-patch evidence bundle、统一 Commit-aware Knowledge Retrieval/manifest、tests；Requirement/Conversation binding 与 Existing Knowledge Retrieval 均已冻结。

**映射**：TS-01–11、19–20、39、41–42；BUG-AUTO-001..006、BUG-SCAN-001..002、BUG-TOOL-001。

---

### T09 — Knowledge staging/promotion 与单写者 IndexService

**目标与可观察结果**

- AI 不直接写 final knowledgePath；所有产物可验证、可恢复地 promotion。
- Markdown 成为事实源；state advance 与 index dirty 有明确语义。
- 多项目可并行分析，但 LanceDB mutation 严格单写。
- **T09 是 `KnowledgeRetrievalService` core owner**：实现统一 hybrid/metadata recall、rerank、authoritative Markdown verify、chunk/section context assembly、index source manifest 与 Markdown Delta Overlay；T08 只消费 injected interface，T11 只做 Search/Ask/CLI/MCP adapter。

**前置依赖**：T02、T03、T05、T08 claim/analyzer interface；T07 requirement evidence。  
**负责角色**：Knowledge/Index Agent。  
**并行**：否；其接口是 T10/T11 前置。

**Context Packet**

- P-05、P-09、P-15、P-16、P-19、P-20。
- R-KNOW-01..02、R-PATH-02..03、R-TRG-04；§3.5.5 Retrieval/index source manifest/Delta Overlay contract。
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
- `KnowledgeRetrievalService` core、retrieval manifest、Markdown Delta Overlay helpers。
- IndexService and low-level DB writer coordination。
- knowledge/index/retrieval tests。

**禁止修改**

- `server.js`。
- prompt/scanner contract（T08）。
- CLI/MCP wiring（T11）。
- UI。

**具体修改**

1. 为每 run 创建 internal `runRoot`，不放在用户 knowledge root或源码 repo；至少逻辑区分 server-owned read-only `input/evidence` 与 AI-writable `output`。
2. AI tool policy 必须区分 read roots / write root：`Read` 可访问冻结 evidence input 与 output，`Write/Edit/MultiEdit` 只能写 output；禁止写 source tree/final knowledgePath，也禁止通过通用 Bash绕过。
3. 大 Diff evidence bundle 由 T08/server 在 AI 启动前写入 input 并校验；AI output manifest 只位于 output，包含 relative path、operation (`create|replace|delete`)、sha256、reason/evidence references。
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
12. 实现 `KnowledgeRetrievalService` core：`search()` 与 `retrieveForCommit()` 共享 embedding/index/scope/Markdown truth；Commit 路径按 §3.5.5 做 multi-signal candidate recall → deterministic rerank → chunk/section context budget，并输出 frozen retrieval manifest。
13. IndexService process-global FIFO/single writer；project enqueue去重/coalesce，保留最早 dirty commit；每次 successful apply 同步更新 internal `index source manifest`（entry/document hash/sourceCommit/generation），供 Retrieval 判断 Markdown delta，manifest 与 DB generation 必须一致。
14. DB adapter不再被 server/CLI/maintenance直接并发 mutation；read queries可按库支持并发，但 writer有统一 barrier。
15. indexing成功后 compare dirty generation再 clear；运行期间新 promotion不得被旧 completion错误清除。
16. indexing失败：state dirty+error、warn/error logs；startup/daily/after next promotion重试；不回滚 Markdown。dirty 期间 Retrieval 必须可读取上次成功 index generation + Markdown Delta Overlay，不能把 index failure 变成下一 Commit 的知识盲区。
17. full rebuild可从所有 project knowledge paths生成全新 temp DB，验证后原子切换；不在 live DB destructive rebuild。
18. maintenance state 与 index source manifest 都通过 IndexService/AtomicFile，不独立 read-modify-write；full rebuild 成功 swap 时对应 manifest 一起原子激活，失败保留旧 index+manifest。
19. `initProjectDirs` 改为按需 framework creation；第一条 knowledge 可创建 README/index，但内容必须来自验证产物，不是 TODO模板。
20. source code tree在 run前后可选检查 Git status；发现未经允许源码改动 => validation failure，不推进。

**测试**

- AI exit 0 no files => fail no advance。
- evidence input 对 AI read-only：尝试 Write/Edit input 必须被 policy deny；output 正常可写。
- invalid/outside/symlink path rejected。
- valid multi-file promotion。
- crash after each promotion stage and startup recovery。
- state write failure after promotion repaired without AI rerun。
- index failure leaves pointer advanced+dirty；普通 query 与 Commit Retrieval 均可读 Markdown truth，Commit Retrieval 用 stale-index candidates + Markdown Delta Overlay；retry clears dirty。
- simultaneous projects produce serialized DB writes，both indexed。
- new dirty generation during old index not cleared；index source manifest 不得被旧 generation completion 覆盖。
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
node _site/_test/knowledge-retrieval-test.js
node _site/_test/knowledge-retrieval-delta-test.js
node _site/_test/knowledge-promotion-recovery-test.js
node _site/_test/index-writer-concurrency-test.js
```

**验收**

- 没有 automation code直接把 AI workspace当 final knowledgePath。
- lastAnalyzedCommit只在 verified promotion后推进。
- index failure状态可见且可恢复；不重复 AI；dirty 期间下一 Commit Retrieval 仍能看到最新 Markdown。
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
   - schedule index retry；不再调度任何日志 cleanup。
2. startup reconciliation trigger必须 `startup`，0 pending只 debug。
3. install uncaughtException/unhandledRejection/SIGINT/SIGTERM handlers：fatal/error logs、flush Logger/IndexService、graceful stop；禁止把 recoverable domain error变 fatal。
4. import route调用 LifecycleService；success只在 transaction commit后返回。
5. delete route要求明确 knowledge deletion option/confirmation；Hook fail映射 409/503，不移除 project。
6. Hook endpoint验证 `hook-event/v2`，调用 `handlePostCommitEvent`；quick response与后台 task contract明确，但必须记录 accepted operation；避免 unhandled Promise。
7. 重构 server `activeTasks` bookkeeping：使用 `Map<projectId, Map<operationId, TaskEntry>>`（或等价不会覆盖的结构）；register/unregister 以 operationId 精确配对，后来的短任务不得覆盖/清除前一个仍运行任务；`isProjectBusy` 与 graceful shutdown/drain 必须看到全部真实 active operations。Reconciler in-flight/project lock仍是分析去重事实源。
8. Workbench Claude input route 在发送 input 前通过 T07 Conversation Capture adapter 追加 user turn/event，并在 terminal response 时追加 assistant event；保持 session UX 与错误可见。legacy RequirementRecorder/MCP 只作为 explicit compatibility adapter，不再是 Workbench/外部客户端的主捕获真相。
9. MCP requirement tool endpoint/runtime plumbing按 T07 contract接入。
10. 删除：
   - import后的 `dispatchProjectInit()`；
   - `/automation/simulate`；
   - `/automation/init`；
   - manual `/hook-install`、`/hook-uninstall`；
   - 可触发的 `dispatchAutomation` route；
   - project-init prompt/config；
   - `PUT /api/projects` generic replacement。必要项目设置使用白名单 PATCH。
11. `/api/projects/:slug/init` 若仅创建知识骨架，也应删除或改为不产生推测知识的明确 maintenance API；优先删除旧入口并更新 consumers。
12. project APIs主键转 projectId；迁移期只读 slug resolver可保留一版，但所有 mutation必须 projectId。
13. AI profiles GET返回 public view；update key三态 preserve/replace/clear。
14. CORS/origin：
   - 默认同源；不发送 wildcard；
   - loopback desktop/browser仅允许 configured local origins；
   - 非回环 bind要求 auth token并拒绝未授权；
   - preflight按白名单响应。
15. 删除或严格重构 `/api/raw`；推荐删除。所有文件读取通过 projectId + knowledgePath + realpath boundary。
16. generic error handler不返回 stack；返回 operationId；日志保留脱敏错误。
17. 所有 console.*逐步改 Logger；只允许 Logger自身最终 stderr fallback和必要 CLI stdout。
18. direct paths/JSON writes改 stores/Layout；server不再整体读取/写 projects.json。
19. Index mutations只入队 IndexService。
20. settings root保存不迁移旧 projects、不移动 DB。
21. 暴露 Project Knowledge 的只读 Conversation Explorer host API，底层只调用 T07 Headless Query/annotation provider，不直接读取 JSONL；当前产品 UI 只需要：
   - `GET /api/conversations/projects`
   - `GET /api/conversations/turns?projectId=&date=&cursor=&limit=`
   `projectId` 必填且一次只查询一个项目；不为当前产品页新增 source/session/search/view-mode 专用 routes。Turn 返回可携带内部 stable turnId/eventId/source/session 与 commit annotation，但普通 UI 只渲染时间、用户 Prompt、AI Reply 与“已提交/关联提交/未提交 + short SHA”。Commit annotation 必须投影 frozen `CommitConversationSnapshot`，不得在 route/UI 重新 binding。
22. Conversation API 遵守与其它本地业务 API 相同的 origin/auth；完整 user/assistant 正文只返回给该受控业务查询，不写入日志/error/log SSE；项目/repo scope 必须验证。
23. route/API文档和 UI consumers列出 breaking removals；生产不保留两套运行路径。

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
- 同项目两个 background operations 同时登记时，后启动/先结束（含快速失败）的 operation 不会让早先仍运行 operation 从 busy registry 消失；shutdown等待两者真实 terminal。
- no direct projects.json state mutation。
- Conversation projects/sessions/turns/commits API 的 project/source/session/date/q/cursor filter 与 T07 provider 语义一致；C1 frozen annotation 不吸收 C1 boundary 后的 turn。

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
node _site/_test/conversation-api-test.js
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

**映射**：TS-01–18、24–25、30、32–36、39–44、49–52；其中 TS-10/TS-52 同时覆盖 Conversation API/Explorer；所有高严重度 B，尤其 BUG-SEC-001..002。

---

### T11 — CLI、MCP、runtime、索引器路径统一

**目标与可观察结果**

- server、CLI、MCP、query/index maintenance 对 project/config/knowledge/index 使用同一 StorageLayout/Stores；用户 Search/Ask 与 Commit Existing-Knowledge Retrieval 共享同一 `KnowledgeRetrievalService`。
- read-only query 不产生配置写入或隐式 scope synchronization。
- MCP 继续只读知识；唯一写能力只是 T07 的 explicit requirement adapter，它写入统一 Conversation capture contract，不形成第二套 Requirement store。

**前置依赖**：T02、T03、T07、T09；T10 API/security contract已冻结。  
**负责角色**：CLI/MCP Agent。  
**并行**：可与 T12 并行；不改 server/UI。

**Context Packet**

- P-09、P-11、P-13..P-17、P-20。
- R-PATH-01..03、R-REQ-01、R-KNOW-01..02、R-SEC-01。
- BUG-PATH-001..003、BUG-INDEX-001、BUG-REQ-001、BUG-TOOL-001。
- Layout/Stores/Index/Conversation/Bridge contracts。

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
- package/plugin config needed for explicit requirement adapter and Bridge integration status。
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
6. `KnowledgeToolRuntime.search()/ask()` 不再自行实现 index/Markdown 两套 ranking，统一委托 `KnowledgeRetrievalService.search()`；index clean 使用 LanceDB hybrid，dirty 使用相同 health contract 并叠加 current Markdown delta/fallback；用户 Search 与 Commit Retrieval 共用 scope、安全路径、embedding/index adapters。
7. Commit Existing Knowledge 由 `KnowledgeRetrievalService.retrieveForCommit()` 提供；**core implementation 归 T09**，T11 只把 `KnowledgeToolRuntime.search()/ask()`、CLI/MCP adapter 接到同一 service，T08 只消费 frozen retrieval result/manifest。maintenance/rebuild调用 IndexService；任何 Retrieval 路径不能直接并发打开 writer。
8. requirement tool按 T07 explicit adapter schema 写入 ConversationStore；其他 tools仍 read-only。
9. plugin/Skill instructions不再依赖 Hook manager生成 CLAUDE.md；AI editor prompt/response hook install/status/repair/uninstall 统一委托 `@sanqianx/ai-coding-event-bridge`，Project Knowledge IntegrationManager 不再维护第二套 Claude/Codex/OpenCode hook commands。
10. CLI error不输出 secret/full settings；JSON errors遵守 envelope或CLI等价结构。
11. path consistency contract test从同一 fixture分别调用 server adapter、runtime、CLI、MCP，断言完全相同 knowledge/index paths。
12. package bin/manifest保持兼容；不无关升级 dependencies。

**测试**

- two projects with fixed distinct knowledgePath。
- global root changed: old project unchanged/new project uses new root。
- CLI/MCP/server same path/index path。
- project rename/move stable projectId。
- read query creates no files/writes。
- clean/dirty/missing index retrieval：用户 Search 与 Commit Retrieval 使用统一 service；dirty delta 能检索到刚 Promotion 的 Markdown，deleted/stale index content 不返回。
- explicit requirement adapter writes ConversationStore only/no analysis；Bridge status 可读取且不会重复安装 hooks。
- scope migration/read-only behavior。
- secrets absent in CLI error。

**验证命令**

```bash
node _site/_test/bin-cli-test.js
node _site/_test/mcp-server-test.js
node _site/_test/knowledge-query-test.js
node _site/_test/knowledge-retrieval-runtime-adapter-test.js
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

- index unavailable：return degraded result with Markdown relevance fallback，不在查询时创建/迁移 DB；Commit Retrieval 不得 fallback 到 filename-first/fixed-N。
- current repo匹配多个 project：返回 ambiguous error，不任意选择最近项目。

**最小交付**

- consumer path table、MCP tool inventory、path consistency tests。

**映射**：TS-09、26–30、35–37、41–42、51；BUG-PATH-001..003、BUG-INDEX-001、BUG-REQ-001。

---

### T12 — 恢复完整应用 Shell、在 Settings 集成共享“开发对话”页，并把日志做成成熟“运行记录”设置页

**目标与可观察结果**

- 以 v4.1.22 的真实 Control Center / 项目侧栏 / Claude Workbench / Import / Settings Drawer 为非日志 UI 结构基线，按 v4.1.23+ 新 API 合同适配；绝不整文件回滚。
- 在 **Settings 左侧设置导航新增“开发对话”**，与“日志”同级，集成 `@sanqianx/ai-coding-event-bridge-ui` 的成熟 Conversation Explorer；进入后一次选择一个项目，并按日期查看该项目来自全部 AI 客户端的真实 user prompt / assistant reply。主侧栏、移动端主导航和“桌面客户端”页不得再提供重复入口；页面不得做成 Session/debug/event inspector。
- 日志只在 **设置 → 日志**，不进入左侧主导航。
- 页面标题/主视觉使用“运行记录”产品语言，而不是调试器/observability console。
- 默认列表不显示“实时”、Level 列、`INFO:` / `DEBUG:` / `TRACE:`，也**禁止 severity 小点、圆点、感叹号、叉号或左侧色条**；正常记录中性，`warn` 整行文字明黄/琥珀，`error/fatal` 整行文字红色并可轻微加粗。
- 默认今天、全部项目、全部记录、500 条；可选 1000/2000/5000、日期、项目、记录范围、搜索、导出。
- 今天的新记录由 SSE 事件驱动安静追加；无轮询、无可见“自动滚动/暂停/实时”开关。
- 至少用 200 条混合模拟数据做视觉/性能验收，保证错误在高密度记录中一眼可见但页面仍像成熟产品。

**前置依赖**：T05 API/publish/record presentation contract、T10 routes/security。  
**负责角色**：UI Agent；独占 `ui/index.html` 与对应 UI tests。  
**并行**：可与 T11 并行。

**Context Packet**

- P-01、P-06、P-18、P-21～P-25。
- R-LOG-01..05、R-UI-01..02、R-REQ-03、R-HOOK-03、R-TRG-01、R-COMP-01。
- BUG-LOG-002..003、BUG-HOOK-003、BUG-AUTO-001。
- v4.1.22 UI 结构证据 + v4.1.23 当前 API/状态合同。
- 用户确认：不要 debug 风格 `TIME/LEVEL/PROJECT/MESSAGE` 控制台，不要“实时”badge，不要 Level 当主视觉；**不要日志行前等级小点/图标**。异常直接通过整行文字颜色表达：warn 明黄/琥珀、error/fatal 红色；同时必须修复正文与时间重叠问题。 开发对话同样按成熟产品风格处理：不展示内部 source/session/turn/binding schema 导航，不用“跨项目对话记录 + 技术副标题 + badge”堆叠信息，默认只给用户必要的项目、日期、对话正文与克制的提交状态。

**必须读取**

- v4.1.22 与当前 HEAD `ui/index.html` 的 Shell/Workbench/Import/Settings 差异。
- T05 `/api/logs` + `/api/logs/stream` + public log record contract。
- T10 API spec。
- T07 Bridge Headless Conversation Query + shared Conversation Explorer UI/provider contracts + CommitAnnotationProvider contract。
- current UI tests + logging tests。

**允许修改**

- 完整产品 Shell 修复、Settings 内与“日志”同级的“开发对话”视图、Settings 内唯一“运行记录”视图、只读项目/Hook状态。
- UI fixtures/tests；删除确认无效的 legacy UI test。

**禁止修改**

- backend API implementation。
- 新前端框架/build chain。
- 恢复 Schedule & Run / Run now / manual initial/incremental / manual Hook buttons。
- 把日志做成主导航、Dashboard、诊断中心、terminal 或可配置存储页。

**具体修改**

1. 恢复完整 Shell：左侧项目列表/项目选择 -> Claude Workbench；Import 工作区；Settings 右抽屉；保留仍受支持的主题/语言/Git account/desktop controls，并恢复 responsive/mobile navigation。
2. **恢复完整 Settings 产品能力，不得只恢复日志页**：
   - AI Profile / 模型配置 UI：读取与保存 `/api/ai-profiles` 的公开安全视图，支持默认 Profile 和项目分配；不得把 secret 原样回显。若旧版存在独立 AI 配置页与 Settings AI 的重复实现，优先合并为 Settings 内唯一配置实现，避免双份状态/DOM。
   - Knowledge Root：提供全局 `knowledgeRootPath` 配置与可写性反馈；Import 页面只消费该全局设置，不再次选择知识路径。
   - 项目/关系或仍受支持的 integrations 配置入口按当前 API 恢复；删除已经废弃的 automation/Hook 手工控制，而不是删除整个 Settings 区域。
   - **开发对话**、日志、desktop/client controls、主题/语言以及当前 backend 仍支持的 Git account 能力必须保持可达；开发对话与日志均为 Settings 左侧导航的独立同级项。
3. 在 **Settings 设置导航**新增 **开发对话**，与 **日志** 同级；禁止放到主侧栏、移动端主导航或桌面客户端子页；必须复用共享成熟 Conversation Explorer 实现源：
   - Settings Drawer 标题就是“开发对话”；页面内部不再重复“跨项目对话记录”等标题，不显示 Bridge/Provider/Schema 技术说明或 debug badge；帮助文案最多一条短句。
   - 顶部只允许两个控件：`项目` + `日期`。
   - `项目` 一次只选择一个已注册项目，默认当前主界面项目；没有“全部项目”。
   - `日期` 默认今天，选择某一天只显示该项目当天对话。
   - Claude Code/Codex/OpenCode **全部来源自动合并**；不得出现“全部来源”或各来源筛选控件。
   - 不得出现 Session 左栏、Session selector、sessionId/turnId、搜索框、“时间线 / Commit 视角”切换。
   - 默认正文只呈现“你”的真实 Prompt 与 AI 的真实 Reply；source 可作为轻量 AI 名称/metadata，但不作为导航结构。
   - Commit binding 只做轻量产品化映射：一个 Commit 显示 `已提交 · shortSha`；跨多个 Commit 显示 `关联提交 · sha1 · sha2`；尚未冻结显示 `未提交`。默认 UI 不显示 `direct/shared-spanning/no-new-user-prompt/unavailable` 等内部枚举。
   - 上述 short SHA/未提交状态必须来自 T07/T08 frozen `CommitConversationSnapshot`/boundary truth，同一 Turn 跨多个 Commit 只引用同一内部 turnId，不制造第二份 Requirement。
   - 对话正文纯文本安全渲染；历史列表使用 cursor/windowed rendering，禁止一次性渲染全量历史。
   - light/dark/mobile 均可用；移动端仍只保留项目+日期，不因为空间变窄新增 Session drawer 或技术筛选。
4. Logs 不加入主 nav；Settings 唯一 `logs` section，section label 可仍叫“日志”，内容标题使用“运行记录”。
5. 删除 production 中第二套 logging DOM/state/render path。
6. 默认 toolbar：`date`、`project`、`recordScope`、`displayLimit`、`q`、`export`。
7. `recordScope` 使用产品语言而非 Level：
   - `全部记录` = all levels；
   - `重要记录` = info/warn/error/fatal（隐藏纯 trace/debug 噪声）；
   - `仅异常` = warn/error/fatal。
   若产品仍需逐 Level，放进“更多筛选”popover，不做常驻字段。
8. default today/all projects/all records/500；limit 500/1000/2000/5000。
9. 初始 GET newest 500；UI 以时间升序显示最新在底部。
10. 每条默认记录采用**紧凑 activity row**，而不是 debug table：
   - **不渲染任何 severity indicator / dot / icon / 左侧 accent**；
   - 主体 message；
   - 次级 metadata 只显示 project display name + 可选短 category/duration；
   - time 靠右并使用独立固定宽度列；
   - 默认不显示 Level/component/event/operationId。
11. row 布局必须使用稳定的两列 Grid（推荐 `grid-template-columns: minmax(0, 1fr) 88px`，column-gap 至少 14px）：
   - message/meta 容器必须 `min-width: 0; overflow: hidden`；
   - message 可 ellipsis，metadata 必须截断或按窄屏策略换行；
   - time 必须 `white-space: nowrap`、独立列、不可被正文覆盖；
   - 长 message、长 project displayName、长 component、200+ records、窄 viewport 下都不得发生正文/时间重叠。
12. normal trace/debug/info 不用三种不同鲜艳颜色；主要文本统一中性色，降低 200–500 条时的视觉噪声。
13. `warn` 通过**整条 row 文字**使用高对比明黄/琥珀色表达；`error/fatal` 通过**整条 row 文字**使用红色并可轻微加粗表达。metadata 和 time 同步采用该 severity 文字色；禁止额外小点/icon/左 accent，禁止整行高饱和背景。
14. 点击 row 展开 detail：level、component、event、operationId、runId、commitSha、phase、attempt、duration、error stack/raw JSON/copy。
15. 今天建立 SSE；历史日期不建立。
16. normal connection **无任何“实时”文案/dot**。只有持续断连时出现一条轻量同步异常提示，恢复后自动消失。
17. 无 polling；禁止 `setInterval(loadLogs...)`。
18. 自动跟随行为：
    - 用户在列表底部附近 -> 新记录追加后自动滚到底；
    - 用户主动向上滚 -> 不抢滚动位置，继续缓存/插入记录并显示轻量“有 N 条新记录”按钮；点击/回到底部后恢复 follow；
    - 不提供 autoscroll toggle。
19. DOM 只保持当前 displayLimit；超限移除最旧记录。
20. filter/date/limit 切换关闭旧 stream -> GET -> 如今天则用 watermark建新 stream；log id 去重。
21. 全部项目选项显示 system + projects，具体 option 用显示名，request 使用稳定 projectId；已删除项目使用 snapshot/`已删除项目`。
22. 删除 rootPath/retentionDays/maxTotalSizeMB/levels enable/save/cleanup UI 和 PATCH logging settings calls。
23. 所有 log message/detail 纯文本安全渲染。
24. responsive：窄屏必须保留 message 和独立 time 列；project metadata 可截断/换行，warn/error 仍只通过整行文字颜色表达，detail 不横向溢出。
25. **日志高度合同（强制）**：日志页必须占满 Settings Drawer 除 header/padding 之外的全部可用高度，禁止 `record-list`/logs card 使用 `height` 或 `max-height: 500px/520px` 等固定像素上限。实现必须形成连续高度链：`drawer(height:100vh/100dvh,min-height:0)` → `settings-content(display:flex,flex-direction:column,min-height:0,overflow:hidden)` → `#settings-logs.active(flex:1,min-height:0,overflow:hidden)` → logs card(`display:flex;flex-direction:column;flex:1;min-height:0`) → `record-shell(flex:1;min-height:0)` → `record-list(flex:1;min-height:0;overflow-y:auto;max-height:none)`。标题/说明/toolbar/footer 不滚，**只允许 record-list 纵向滚动**；禁止 Settings content 与 record-list 双滚动。

**200 条高密度视觉 fixture（必须）**

生成 deterministic mock fixture 至少 200 条，建议分布：

- trace/debug: 80–100 条（scan/path/lock/cache/stage details）
- info: 80–100 条（normal lifecycle/analysis/promotion/index state changes）
- warn: 10–15 条（retry/degraded/fallback）
- error: 4–8 条（AI/index/Git/integration/requirement failures）
- fatal: 0–1 条（仅用于视觉测试，不暗示常态）

至少 3 个项目 + system；消息长短混合；包含 operation/commit metadata；不要所有记录重复一套文案。

**旧前端测试清理清单（冻结，禁止重复调查后擅自改结论）**

- **KEEP + 更新断言**：
  - `_site/_test/automation-ui-test.js`：保留，改为完整产品 Shell / 无手动 automation+Hook 控件 / Settings 日志合同。
  - 新增或从 Bridge UI package 测试接入 `_site/_test/conversation-explorer-ui-test.js`：覆盖单项目切换、日期切换、三种 AI 来源自动混合、user/assistant turn render、已提交/关联提交/未提交映射与移动端；断言 UI 不存在来源筛选、Session 导航/筛选、搜索、时间线/Commit 视角、“全部项目”及实现型 debug 文案。
  - `_site/_test/ui-smoke-test.js`：保留，覆盖完整 Shell、Settings、主题、响应式、运行记录和 removed controls。
  - `_site/_test/logging-ui-test.js`：保留，覆盖日志查询/筛选/导出/不可变日志存储策略与成熟“运行记录”UI。
- **KEEP，但重命名或重写为当前合同**：
  - `_site/_test/workspace-ui-contract-test.js`。
  - `_site/_test/project-control-panel-task14-test.js`。
  - `_site/_test/task15-20-ui-flow-test.js`。
  这些测试不得继续断言已删除的 Schedule & Run / Run now / 手工 Hook/analysis 控件。
- **DELETE**：`_site/_test/ui-test.js`，因为它依赖已废弃的 `View tree`、`+ Add`、`Schedule & Run`、`Run now`、旧 Projects/Remove 流程。
- **runner 清理**：`_site/_test/run-all-tests.js` 删除为已废弃 `ui-test.js` 保留的 legacy `--include-ui` 特殊分支；正常 smoke/UI tests 进入标准测试路径。
- **拆分/重命名**：`_site/_test/chat-claudecodeui-match-test.js`，保留有价值的 Claude backend/session 与 logging 断言，删除“旧 UI 必须逐像素/逐结构匹配”的陈旧合同。
- **KEEP backend 能力，清理陈旧注释/断言**：`_site/_test/claude-workbench-test.js`。
- **新增/强化回归**：必须证明主界面不是 log-only product；Settings → AI Profile、Knowledge Root、开发对话、Logs 均可达；开发对话/Logs 均不在主导航；removed manual Hook/automation controls 不存在；200 条密度、SSE、full-height、no-overlap 均通过。

**自动化测试**

- 完整 shell/项目选择/Workbench/Import/Settings/mobile navigation 存在；日志非唯一 root/非主 nav。
- Settings 中 AI Profile/模型配置、Knowledge Root、开发对话、Logs、仍受支持的 integrations/desktop-client controls 可达；开发对话与 Logs 为同级独立 section；不存在重复的第二套 AI 配置 DOM/state。
- Settings 恰好一个 logs section。
- default request today/all/500；limit options。
- default UI **不存在可见 `INFO:`、`DEBUG:`、`TRACE:`、`LEVEL` header、`实时` badge、severity dot/icon/left accent、autoscroll/pause**。
- scope filter 映射正确；detail 中仍能看到真实 level。
- 200-row fixture 渲染后：warn row 的 message/meta/time 都使用 warn text color，error/fatal row 的 message/meta/time 都使用 error text color；DOM 中不存在 record severity dot/icon；normal rows 不带高饱和 level class。
- no polling；today one stream；historical no stream。
- SSE event append/dedupe/trim；bottom auto-follow。
- scroll-up 时不强制跳底，新记录计数提示；回到底部后清零。
- reconnect/watermark dedupe。
- XSS/light/dark/narrow viewport；加入超长 message / project / component fixture，断言 time 列 bounding box 与正文 bounding box 不相交。
- full-height layout test：以至少 768px 与 1080px 两种 viewport 高度打开 Settings → Logs，断言 `record-shell` 高度随 viewport 增长、`record-list` computed `max-height` 为 none、Settings content 不产生纵向滚动，且 record-list 承担 overflow。

**手动/视觉验收**

- 浏览 200 条 fixture：第一眼仍是干净的产品记录页，不像 terminal/devtools。
- 在不读每一行的情况下，仅依靠整行文字颜色就能快速扫到 warn/error，不依赖小点/icon/左色条。
- 正常记录密集时不“彩虹化”。
- 点击异常可获取足够工程上下文做真实排障。
- Workbench/Import/Settings 其他页面未因日志改造退化；AI Profile/模型配置与 Knowledge Root 可正常读取/保存，Import 不重复选择 knowledgePath。
- 打开 Settings → Logs 时，日志 card/record shell 底边应接近 Settings 内容区底边（仅保留设计 padding），不得出现由固定 500/520px 高度造成的大块无意义空白；窗口增高/降低时日志列表高度应同步伸缩。
- Settings 内容本身不得出现第二条纵向滚动条；200+ rows 时只看到 record-list 的纵向滚动条。

**验证命令**

```bash
node _site/_test/automation-ui-test.js
node _site/_test/workspace-ui-contract-test.js
node _site/_test/ui-smoke-test.js
node _site/_test/logging-ui-test.js
node _site/_test/log-stream-ui-test.js
node _site/_test/logging-ui-density-test.js
```

**验收**

- 生产 UI 是完整 Control Center。
- Settings 内只有一套成熟“运行记录”视图。
- 默认500，可切日期/项目/范围/数量/搜索。
- today event-driven，无 polling、无 visible live/autoscroll controls。
- 200条密集记录下仍然视觉克制，异常明显。
- raw/Level/engineering fields 是次级详情。

**失败/恢复**

- SSE 断开：仅在持续异常时显示轻量恢复提示，不切回轮询。
- 历史文件被用户手动删除：显示“该日期没有记录/已被删除”，不视为应用数据损坏。

**最小交付**

- 完整 UI 修复、“运行记录”UI、SSE client、200-row density fixture、updated tests、视觉验收记录。

**映射**：TS-07、10、15、24–25、33、38–52；BUG-LOG-002..003、BUG-HOOK-003、BUG-AUTO-001。

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
5. concurrency E2E：two projects parallel；same project Hook+startup overlap；DB writer serialized；同项目多个 server background operations 的 registry 不相互覆盖，短任务 terminal 后长任务仍保持 busy，shutdown/drain 等待全部 operation。
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
- TS-01～TS-52 都有自动或明确手动证据；全链路日志覆盖/故障可追踪并入 TS-39～TS-42，200 条成熟 UI 密度/full-height/no-overlap 并入 TS-52。
- 两个分析入口、一个 reconciler、一个 prompt、一个 Logger、一个 log UI、一个 StorageLayout、一个 index path。
- migration fault matrix通过；旧资产保留。
- full tests/build/package/Windows关键验证通过。
- Requirement/Conversation → Commit 与 Existing Knowledge Retrieval 两个设计 Gate 均已关闭；Agent 必须分别按 §3.3 与 §3.5.5 实施，不得回退到 ancestry guessing 或 filename-first/fixed-N knowledge context。
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
| R-REQ-01 | T07、T10、T11 | Bridge connectors/journal/cursors、ConversationStore、explicit adapter | real Claude/Codex/OpenCode session |
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
| R-KNOW-01 | T08、T09、T11 | exact patch/chunk evidence + unified KnowledgeRetrievalService + commit-aware recall/rerank + retrieval manifest | inspect generated knowledge/evidence/retrieval bundle |
| R-KNOW-02 | T09、T11 | index writer/source manifest、dirty retry、stale-index + Markdown Delta Overlay、authoritative Markdown verification | sequential commits + concurrent index E2E |
| R-LOG-01 | T05、T10 | structured logger/levels | backend level/event semantics |
| R-LOG-02 | T05、T06–T11 | operation chain assertions | import/commit/delete/search/AI/integration chains |
| R-LOG-03 | T05、T10、T13 | project/day single-file + permanent/no-cleanup + fallback + SSE publish | disk permission/full + manual deletion simulation |
| R-LOG-04 | T05、T10、T12 | cursor/filter/export/redaction | download exported bundle |
| R-LOG-05 | T04、T06–T11、T13 | module coverage matrix + operation-chain fixtures | fault injection across every critical subsystem |
| R-UI-01 | T12、T13 | full-shell/record-list/log-stream/density UI smoke | 200-row light/dark/responsive + event append render |
| R-UI-02 | T07、T10、T12、T13 | shared Conversation Explorer + Project Knowledge CommitAnnotationProvider | project/date-only mature conversation + commit-summary/mobile visual audit |
| R-COMP-01 | T08、T10–T13 | symbol/route/UI absence | final diff review |
| R-SEC-01 | T01、T02、T05、T10、T11 | server-security/redaction/path tests | malicious origin/non-loopback |

### 11.2 当前证据代码

| 代码 | 固定 SHA 下的当前事实 |
|---|---|
| CE-TRG | v4.1.23 当前公开 server 入口已基本是 Hook/startup；T00 需 inventory 证明 simulate/manual-init/init 已不可达，并删除残留 dead code/tests/comments。 |
| CE-HOOK | v4.1.23 Hook v2 已使用 runtime repo root/strict managed marker；剩余关键工作是 Bridge boundary durable atomic append、同步通知延迟、capture-gap 与旧 Hook 迁移回归。 |
| CE-REG | v4.1.23 已有 v2 registry/config/state/store；剩余风险是 activeTasks 单 entry、operationId correlation、delete partial transaction 与迁移兼容。 |
| CE-REQ | 旧外部捕获依赖 cooperative Skill/MCP，用户本机未产生 requirements 文件；v8 改为 Bridge 强捕获 + ConversationStore + commit-boundary snapshot。 |
| CE-KNOW | v4.1.23 已有 staging/journal/promotion/index.dirty；仍存在 >2 MiB patch omission、filename-first Existing Knowledge、索引无 source-manifest/delta overlay。 |
| CE-PATH | v4.1.23 已有 StorageLayout/internal index；需把最终 log system/projects 布局、conversation/boundary/source-manifest 纳入单一路径合同，并做旧日志兼容。 |
| CE-MIG | v4.1.23 MigrationService 已有 staging/backup/activation；仍需修 logging setting 迁移、conversation/Bridge schema、delete journal 与完整故障恢复验收。 |
| CE-LOG | v4.1.23 已有六级结构化日志基础，但业务阶段覆盖不足：Promotion/Index/Lifecycle/Migration 多为终态日志，Requirement failure/Knowledge fallback不足，Claude Runner/Integration Manager未接统一 Logger；本轮合同增加全链路 coverage matrix，同时改为 project/day 单文件、永久保留、reverse cursor、SSE event-driven、成熟运行记录 UI。 |
| CE-UI | v4.1.23 production UI 仍退化为 debug-style 系统日志页；完整 Control Center、Settings 开发对话与成熟运行记录尚未恢复。 |
| CE-SEC | wildcard CORS 与 AI profile GET secret 已在 v4.1.23 修复；v13 只做 regression。仍需确保 Bridge/Conversation API、日志/export/SSE/错误统一安全边界。 |

### 11.3 冻结测试矩阵 TS-01～TS-52

状态初始为 `PLANNED`；Codex 在主任务清单中只能在对应测试/验收有证据后改为 `DONE`。`TS-10` 按 CommitConversationSnapshot + Conversation Explorer audit 合同冻结；Existing Knowledge Retrieval 的规模/相关性/dirty-overlay 验收已并入 TS-09、TS-41、TS-42；测试矩阵仍固定为 52 个 canonical IDs，不得扩号。

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
| TS-09 | 多个遗漏 Commit严格顺序且逐个更新 pointer；C1 Promotion 后 index 尚 dirty/未完成时立即分析 C2，C2 的 Existing Knowledge Retrieval 必须通过 stale-index candidate + Markdown Delta Overlay 看见 C1 刚生成/修改的知识，不等待 index、不漏知识 | CE-KNOW、CE-REG | T08、T09、T11 | ordered scanner/state advance + sequential-commit retrieval freshness | offline/rapid commits | PLANNED |
| TS-10 | Bridge 强捕获真实 user/assistant；**同一 journal lock 内**顺序验证 `R1 -> boundary(C1) -> R2`，C1 只含 R1。Commit boundary 冻结 user-turn membership；Claim 冻结当时可见 assistant evidence。commit 后、Claim 前到达的原 Turn assistant tail 可进入该 Claim；Claim 后迟到 tail 仅更新审计 UI，不改变 frozen analyzer input/retry hash。跨 Commit Turn 共用 turnId；merge commit 的 conversation start 使用同 repo 前一 durable boundary，不使用任意 Git parent；boundary/capture gap 显式 unavailable；UI 已提交/关联提交/未提交与 frozen annotation 同源。 | CE-REQ、CE-KNOW、CE-UI | T06、T07、T08、T09、T12 | atomic journal ordering + late-tail-before/after-claim + merge boundary + capture-gap + snapshot/prompt/UI audit | real Claude/OpenCode/Codex commit flow | PLANNED |
| TS-11 | 不存在 init prompt/render/dispatch | CE-TRG | T08、T10、T13 | symbol absence test/rg | final diff | PLANNED |
| TS-12 | import自动安装 Hook且指向真实 trigger | CE-HOOK | T06、T10 | production import Hook path | inspect Hook | PLANNED |
| TS-13 | Hook失败则 import失败，无半完成 | CE-HOOK | T06、T10 | lifecycle fault injection | permission conflict | PLANNED |
| TS-14 | delete自动卸载 Hook | CE-HOOK | T06、T10 | lifecycle delete | real repo delete | PLANNED |
| TS-15 | manual Hook API/buttons不存在 | CE-UI、CE-HOOK | T10、T12 | route/UI absence | UI inspection | PLANNED |
| TS-16 | 项目移动后 Hook runtime path正确 | CE-HOOK、CE-REG | T06、T11 | hook move/projectId | filesystem move | PLANNED |
| TS-17 | 旧错误 Hook升级后只修复一次 | CE-HOOK、CE-MIG | T04、T06 | legacy Hook fixture/idempotency | upgrade E2E | PLANNED |
| TS-18 | Hook install/uninstall不改 CLAUDE.md | CE-HOOK | T06 | no-CLAUDE fixture | repo diff | PLANNED |
| TS-19 | 两项目同时完成各自 pointer不互相覆盖 | CE-REG | T03、T08、T09 | project store concurrency | parallel projects | PLANNED |
| TS-20 | 同项目 Hook/startup只运行一个 reconcile；server 同项目多个 background operation 不覆盖/误清；shutdown等待全部；入口创建的同一 operationId 必须贯穿 server→task→reconciler→commit run，reconciler 不得无故新建根 operationId。 | CE-REG、CE-TRG | T03、T08、T10、T13 | in-flight dedupe + multi-operation registry + correlation assertions | overlap/fast-fail/shutdown E2E | PLANNED |
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
| TS-33 | delete默认保留知识；明确确认才删除；delete transaction 在 Hook/registry/metadata/optional knowledge 任一步 fault 后可恢复/重试，不出现 registry 已删但 metadata 静默残留的不可解释状态。 | CE-KNOW、CE-REG | T06、T10、T13 | delete journal every-stage fault injection | confirmation UX + process interruption | PLANNED |
| TS-34 | 旧配置合并 settings，AI key不变 | CE-MIG、CE-SEC | T01、T02、T04 | migration secret hash | compare backup | PLANNED |
| TS-35 | 旧 kbPath原样迁 knowledgePath，不按当前 root重算 | CE-MIG、CE-PATH | T04、T11 | migration fixture | path compare | PLANNED |
| TS-36 | DB迁 internal index后，改 root不移动它 | CE-PATH、CE-MIG | T02、T04、T09、T11 | index path/migration | filesystem inspect | PLANNED |
| TS-37 | 未用功能不生成空配置/目录 | CE-PATH | T02、T04、T06 | lazy creation tests | fresh data dir | PLANNED |
| TS-38 | 六级日志后端语义完整；默认 UI 不显示 Level 列/INFO DEBUG TRACE，详情可查看真实 level | CE-LOG、CE-UI | T05、T12 | logger levels/record UI | light/dark visual | PLANNED |
| TS-39 | 全仓关键路径日志覆盖：Server/Lifecycle/Hook/Reconciler/ConversationCapture/Claude/Promotion/Index/Knowledge Runtime/Migration/Integration/Atomic+locks 均满足 started/stage/terminal，并按需覆盖 retry/degraded/rollback/skipped；trace/debug 可高密度记录路径/scan/cache/no-pending，关键阶段 info，不因怕日志多而丢上下文 | CE-LOG、CE-TRG | T04、T05、T06–T11、T13 | log-operation-chain + coverage manifest | repo-wide source/log audit | PLANNED |
| TS-40 | import同operationId覆盖validate/git/path/metadata/hook/registry/rollback/terminal | CE-LOG、CE-HOOK | T05、T06、T10 | lifecycle chain | fault stages | PLANNED |
| TS-41 | Commit从scan/claim/requirement/retrieval/AI/promotion/state/index共享 project/run/commit/operation IDs；Bridge snapshot、Git evidence、Knowledge retrieval manifest 同一 claim 冻结。>2 MiB Diff 仍有完整 fullPatchHash + 精确 chunks；大型知识库（>=100–200 docs/chunks）中相关知识即使文件名排序靠后也必须被 hybrid+metadata recall/rerank 选中，changed source path/symbol/tag/route 强关联可解释，Prompt 只接收 authoritative Markdown 验证后的 selected chunks/sections，retry 的 retrievalManifestHash 稳定 | CE-LOG、CE-KNOW | T05、T07–T11 | commit full-chain + large-patch + retrieval relevance/manifest assertions | real large commit + large KB fixture | PLANNED |
| TS-42 | failure 有安全结构化 error；故障注入覆盖 Git、large-patch chunk、AI、promotion、index dirty/missing/stale、delta overlay、retrieval hash、integration CLI、migration/delete rollback、Bridge append/fsync/consumer cursor/boundary gap、Codex multi-session/reordered/duplicate event、late assistant、legacy requirement、background fast-fail。任何 capture/evidence/retrieval integrity failure 均不得猜需求或推进 pointer；日志可仅靠 correlation IDs 定位降级与恢复。 | CE-LOG、CE-KNOW、CE-REQ | T04、T05、T06–T11、T13 | structured-error + bridge/codex/delete/retrieval fault-chain suite | end-to-end failure replay | PLANNED |
| TS-43 | 日志不可写/磁盘满 -> stderr+health，不删旧日志 | CE-LOG | T05、T10 | permission/ENOSPC | manual disk fault | PLANNED |
| TS-44 | crash后JSONL合法；识别started无terminal的orphan operation | CE-LOG、CE-KNOW | T02、T05、T09、T10 | crash/orphan | kill/restart | PLANNED |
| TS-45 | restart/upgrade/delete后历史永久可查，直到用户手动删文件 | CE-LOG、CE-MIG | T04、T05、T10 | retention absence | manual delete | PLANNED |
| TS-46 | today latest500；1000/2000/5000/date/project；reverse chunk/cursor不整文件读 | CE-LOG、CE-UI | T05、T10、T12 | cursor/chunk/merge | large logs | PLANNED |
| TS-47 | 无retention/capacity/cleanup设置/任务 | CE-LOG | T05、T10、T12 | absence tests | inspect runtime | PLANNED |
| TS-48 | project/day/system/day严格单文件 | CE-LOG | T05 | path/chunk | large daily file | PLANNED |
| TS-49 | offline Hook已知projectId写项目日志且不影响commit | CE-HOOK、CE-LOG | T05、T06、T10 | offline hook writer | real commit | PLANNED |
| TS-50 | legacy log/hook/jsonl/config兼容且保源 | CE-MIG、CE-LOG | T04、T05 | legacy fixtures | backup inspection | PLANNED |
| TS-51 | secrets/raw requirement/prompt/diff/model response不进入日志/stack/log-export/SSE；用户/assistant 正文仅允许进入受控 ConversationStore/CommitConversationSnapshot 业务数据 | CE-SEC、CE-LOG | T01、T05、T07–T11 | redaction/security | export/stream audit | PLANNED |
| TS-52 | 完整 Shell + 项目选择/Workbench/Import/完整 Settings（AI Profile/模型、Knowledge Root、**开发对话**、Logs、仍支持 integrations/client controls）可达；**开发对话必须只存在于 Settings，且与“日志”同级，主侧栏/移动端主导航/桌面客户端均无重复入口**；开发对话复用共享成熟 Conversation Explorer，顶部恰好只有“项目 + 日期”：项目单选、默认当前项目、无“全部项目”，日期默认今天；Claude/Codex/OpenCode 自动混合，无来源筛选、Session 左栏/筛选、搜索、时间线/Commit 视角、Bridge/debug 技术标题或长说明；默认只显示真实 user+assistant，对 Commit 仅显示已提交/关联提交/未提交 + short SHA，且与 frozen snapshot 同源、不混绑。Settings 仅一套成熟运行记录，默认 500；至少 200 条混合记录下 normal 安静、warn 整行明黄/琥珀、error/fatal 整行红色；无 visible live/Level/severity-dot/autoscroll/storage UI；长正文/meta 与固定时间列绝不重叠；full-height 且只有 record-list 滚动；scroll-up 不被强拉底，新记录提示可回底 | CE-UI、CE-LOG、CE-REQ | T07、T12、T13 | full-shell + conversation-explorer-ui + logging-ui-density + stream | conversation Settings navigation + project/date-only mature conversation visual QA + 200-row light/dark/narrow visual QA | PLANNED |


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
- old logs/backups：日志永久保留且只允许用户手动删除；迁移/代码删除不得清理历史。
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
| 大 Diff 被省略导致知识证据不足 | 中/极高 | exact chunk evidence bundle、full hash/manifest校验、read-only input；构建失败则不推进 | T08/T09/G3 |
| knowledge context 随规模增长失真 | 高/高 | 已冻结统一 KnowledgeRetrievalService：hybrid+metadata recall、deterministic rerank、chunk/section budget、dirty index + Markdown Delta Overlay；filename-first/fixed-N 禁止 | T08/T09/T11/DG-KCTX |
| Index dirty长期积累 | 中/中 | startup/daily retry、health/UI、full rebuild | T09/T12 |
| conversation/requirement 误绑定 | 高/极高 | v8 `REQ-BIND-v1` 已冻结：Bridge monotonic event cursor + git commit boundary + Turn identity + frozen snapshot；post-commit future prompt hard exclusion；跨 Commit Turn shared-spanning；gap/歧义 unavailable | T06/T07/T08/DG-REQ |
| Logger自身故障递归 | 中/高 | non-recursive health/stderr fallback；publish subscriber不得反向阻塞writer | T05 |
| 永久日志导致磁盘空间由用户负责 | 中/中 | 不自动删除；ENOSPC可见、stderr fallback、文档说明可手动按日期/项目删除 | T05/T13 |
| secrets进入旧 stack/log | 中/极高 | recursive redaction、public profile view、origin tests | T01/T05/T10 |
| 子 Agent重复读取/冲突 | 中/中 | file ownership、Context Packets、原 Agent返修 | 主 Agent |
| Bridge boundary非原子导致错绑 | 中/极高 | event/boundary同一 journal lock + monotonic sequence；race fixture | BR02/PK05/TS-10 |
| 两宿主形成双物理 Hook owner | 高/极高 | per-user stable Bridge runtime/shim + consumer registry；Hook command不指向宿主 node_modules | BR02/BR04–06/TS-10/42 |
| Codex并发 session 串线 | 高/极高 | per-session incremental cursor；identity不足即 unavailable，不猜 mtime | BR05/TS-10/42 |
| 独立 Bridge 未发布造成消费者 lockfile 不可安装 | 高/极高 | development local pack；final Wave A先 publish Bridge，再 exact pin | Release Gate |
| delete部分成功 | 中/高 | delete transaction journal + every-stage recovery | PK11/TS-33 |
| 最终 tag 才第一次远程 Windows 验证 | 高/高 | early non-release CI + 每次 push 必须远端绿 | PK01/G0+ |
| Bridge consumer 长期离线导致 compaction 丢事件 | 中/高 | minAck + explicit unregister；无 time-only eviction | BR02/TS-42 |

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

## 14A. v13 Cross-repo Package / CI / Release 合同

### 14A.1 公共 repo 与 package

- 新建/使用 public repo：`SanQianX/ai-coding-event-bridge`。
- 一个 npm workspace 发布：
  - `@sanqianx/ai-coding-event-bridge`
  - `@sanqianx/ai-coding-event-bridge-ui`
- Bridge package 不依赖 private DevTask-Radar；反向也不依赖 Project Knowledge。
- Core Node engine `>=18`；必须在 Node 18 与 24、Windows/Linux CI 验证。
- UI 为 framework-neutral browser build；Project Knowledge 不为此引入 React/bundler。
- npm release 前必须验证 `npm whoami` 与 `@sanqianx` scope 权限。包名/权限异常即 BLOCK，不自行改名。

### 14A.2 开发期依赖窗口

```text
Bridge main commits（无 tag）
  -> npm pack tarball / fixtures
  -> Project Knowledge 使用 dependency injection / local tarball 做 contract tests
  -> DevTask-Radar 保持旧 connector 可运行，先加 characterization tests
  -> 两个宿主均不得在 package-lock 写入尚未发布版本
```

### 14A.3 最终发布波次

```text
Wave A: Bridge publication (NO TAG)
  clean checkout -> full CI -> npm pack/audit -> release metadata commit -> push
  -> workflow_dispatch(expected SHA/version) -> publish core + ui with provenance -> verify npm registry/install

Wave B: Consumers
  Project Knowledge exact-pin 已发布 Bridge version -> npm ci -> full TS/UI/Desktop/pack
  DevTask-Radar exact-pin 同一 Bridge version -> smoke/integration tests -> push（本轮默认不 tag）

Wave C: Project Knowledge final release
  root/desktop version一致 -> release metadata-only commit -> push -> remote CI green
  -> create final v<version> tag -> tag workflows -> verify npm + Windows release
```

整个本轮在最后一步之前不存在任何 Git tag。Bridge publication 不创建 tag/GitHub Release；Project Knowledge 的最终 `v*` 是本轮唯一 tag。

## 15. 最终完成检查表

### Architecture

- [ ] 两个且仅两个公开 analysis entrypoints。
- [ ] 两入口调用同一 reconciler和唯一 prompt。
- [ ] `projects.json` 无高频 state。
- [ ] stable projectId贯穿 store/lock/log/API/Hook。
- [ ] StorageLayout是唯一 path source。
- [ ] Markdown事实源、LanceDB派生单写。
- [ ] >2 MiB Commit Diff 通过 exact chunk evidence bundle 保持完整真实证据；不存在 patch-null/stats-only success。
- [ ] server background task registry 可同时追踪同项目多个 operation，任何 task terminal 只注销自己，shutdown 等待全部 active tasks。
- [ ] Bridge `appendEvent()` 与 `appendCommitBoundary()` 共用同一跨进程 journal writer/sequence；race fixture 证明 boundary 不会被并发 Prompt 穿透。
- [ ] Claude/Codex/OpenCode managed Hook 命令全部指向 per-user Bridge stable shim；两个宿主同时安装/升级/卸载 fixture 证明永远只有一个 managed owner，最后 consumer 之前 Hook 不移除。
- [ ] Boundary user-membership freeze 与 Claim analysis-evidence freeze 分离；Claim 后 late assistant 不改变 retry hash，也不自动重分析。
- [ ] Codex connector 不再使用全局最新 mtime session 猜归属；并发 Codex session/project fixture 全绿。
- [ ] `REQ-BIND-v1` 按 §3.3 实现：Bridge 强捕获、conversationBaselineCursor、git commit boundary、CommitConversationSnapshot、future-prompt exclusion、assistant tail、shared-spanning 与 TS-10 fixture 全部通过。
- [ ] `KNOWLEDGE-RETRIEVAL-v1` 按 §3.5.5 实现：Search/Ask/Commit 共用 KnowledgeRetrievalService；大型知识库相关 chunk 召回、metadata rerank、chunk/section budget、retrieval manifest、dirty-index Markdown Delta Overlay、stale/deleted content exclusion 与 TS-09/41/42 全部通过。
- [ ] `@sanqianx/ai-coding-event-bridge` 是独立可复用 package/仓库边界；DevTask-Radar 与 Project Knowledge 使用同一实现源，无复制 connector、无双 Hook owner。
- [ ] `@sanqianx/ai-coding-event-bridge-ui`/等价独立 UI export 是单一 Conversation Explorer 实现源；DevTask-Radar 与 Project Knowledge 仅提供 data/theme/navigation adapter。
- [ ] Project Knowledge **Settings → 开发对话**与“日志”同级；顶部仅有项目+日期，项目单选且无“全部项目”，全部 AI 来源自动混合；无 source/session/search/view-mode/debug 技术 UI。真实 user/assistant 对话的已提交/关联提交/未提交状态以 frozen CommitConversationSnapshot 为唯一数据源；主侧栏/移动端主导航/桌面客户端无重复入口。
- [ ] Project Knowledge 普通用户按“项目 + 日期”查看完整 user prompt + assistant feedback 顺序；source/session/turn/eventId/commit binding 保留为内部审计字段，知识分析只读当前 Commit frozen snapshot，不扫描未来聊天。
- [ ] `DG-KCTX` 已关闭：`KNOWLEDGE-RETRIEVAL-v1` 的统一 Search/Commit Retrieval、hybrid+metadata rerank、chunk/section budget、dirty-index Markdown Delta Overlay 与对应验收已同步。
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
- [ ] TS-01～TS-52逐项有证据；测试总数保持 52，不擅自扩号。
- [ ] Windows Hook/path/desktop/LanceDB smoke通过。
- [ ] 实际渲染“运行记录”UI并检查主题/响应式/200条密度/异常整行文字颜色/无等级小点或图标/长文本与时间列无重叠/full-height 单滚动布局/scroll-up follow 行为/分页。
- [ ] non-release CI 已存在且每个中间 push 的 required checks 均通过；CI 本身从未 publish/tag/release。
- [ ] Bridge public npm package 已通过无-tag `workflow_dispatch` 从已验证 SHA 发布并验证 provenance/source manifest；Project Knowledge lockfile 只引用真实 registry version。
- [ ] `npm test`、desktop test、pack dry-run、diff check均通过。
- [ ] 完整 Git diff无调试代码、空 catch、重复实现、未授权 TODO、secret。

完成上述检查前，不得把本次实施标记为完成。
## 16. v13 审查证据与结论

**Repository baselines**

- Project Knowledge: `main@88e795df55eca26ce301e0e3c7615e894e7d0de8`, release `v4.1.23`.
- DevTask-Radar: `main@33ab03a1de4fccb9b1b27610e6ff9e32d9b5e0d4`, package `0.1.4`, private repo at audit time.
- UI acceptance reference: `project-knowledge-base-faithful-repair-ui-v10.html` supplied by user.

**Audit conclusion**

v12 的产品方向可保留，但不能原样交给无人值守 Agent。v13 纠正了 stale facts，并将新 P0/P1 缺陷纳入实施与 Gate：Bridge boundary 原子性、Codex session mis-association、late assistant 双 freeze、delete transaction、operationId continuity、non-release CI、public package release order、Bridge compaction/identity semantics。所有 OPEN P0/P1 是 release blockers。

执行细节、Commit DAG、测试映射与发布步骤分别以同目录的 `COMMIT_SEQUENCE.md`、`TEST_GATE_MATRIX.md`、`OVERNIGHT_AGENT_RUNBOOK.md`、`RELEASE_RUNBOOK.md` 为机械执行规范；它们与本 Plan 同版本，冲突时以本 Plan 的 P/R/TS 产品合同为上位约束，以 Commit Sequence 的步骤顺序为执行约束。
