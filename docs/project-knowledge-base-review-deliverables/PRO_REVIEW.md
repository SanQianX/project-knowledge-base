# PRO_REVIEW.md

> **审查判定：READY_WITH_CHANGES**  
> **源码基线：`SanQianX/project-knowledge-base` / `main` / `ba505bb2ae031e8d06ec3032657482f40d57ecf8`**  
> **审查日期：2026-08-17（America/Los_Angeles）**

## 执行摘要

1. 远程 GitHub `main` 与上传的 Git 记录均指向 `ba505bb2ae031e8d06ec3032657482f40d57ecf8`，即 `release: v4.1.22`。
2. Plan 的产品方向成立，但不能按原“任务一到任务九”机械实施；判定为 **READY_WITH_CHANGES**。
3. 当前源码确有 5 个分析入口；目标只能保留 Git Hook 与程序启动补查，并统一进入 `reconcileProjectCommits()`。
4. 已确认生产 Hook 脚本路径错误、仓库移动后仍发送旧路径、Hook 失败仍导入成功三项高严重度缺陷。
5. `projects.json` 同时承担索引、配置和高频状态，多个项目并发完成时会发生 whole-file lost update。
6. 当前迁移以 `projects.json` 是否存在作为完成标记；中途失败可能永久留下混合布局。
7. Commit prompt 只有文件名和 `--stat`，没有用户需求，也没有实际 unified patch。
8. 会话 idle/exit 0 即判成功；`lastAnalyzedCommit` 在索引完成前推进，且关键保存错误被空 `catch` 吞掉。
9. 日志只是 v1 同步 JSONL 原型：只有 3 级、无真实 retention/rotation/capacity/cursor，UI 还保留两套实现。
10. 当前 API 用 wildcard CORS 原样返回 AI Profile（含明文 Key），并向客户端返回 stack，必须纳入本轮高严重度修复。
11. 目标架构仍保持单进程 Node.js + JSON/JSONL + 单一 LanceDB，不引入微服务、消息队列或额外数据库。
12. Plan 实际定义了 52 个测试场景；审查提示词中的“1–55”与附件不一致，不能虚构 53–55。

## 1. 审查基线

| 项目 | 结果 |
|---|---|
| 仓库 | `SanQianX/project-knowledge-base` |
| 分支 | `main` |
| 固定 HEAD | `ba505bb2ae031e8d06ec3032657482f40d57ecf8` |
| Commit / Tag | `release: v4.1.22` / `v4.1.22` |
| Commit 时间 | `2026-07-27T14:36:58Z` |
| 审查日期 | `2026-08-17`（America/Los_Angeles） |
| 远程状态 | GitHub 当前 main 与上传 Git refs 一致；该 SHA 没有返回 commit status 或 workflow run |
| 本地重建方式 | 从上传的 `.git.rar` 安全提取 Git 数据，检出固定 SHA；未混用后续源码 |
| Git 状态 | 重建工作树 `git status --short` 为空；index tree 与 HEAD tree 均为 `4dfa2b0ba5fae8699df36a165625391c464f8e3a` |
| 状态限制 | 只上传了 `.git`，能证明无暂存差异，不能证明原工作目录当时没有未暂存或 untracked 文件 |
| Git 完整性 | `git fsck --full --strict` 退出 0；存在 dangling 对象，但当前可达对象未损坏 |
| 规模 | 163 个 tracked 文件；`server.js` 3315 行；`ui/index.html` 5920 行；53 个测试文件，默认 runner 运行 52 个 |
| AGENTS.md | 仓库内不存在 |
| 修改行为 | 本轮未修改源码、未提交、未推送、未创建 PR |

### 1.1 审查资料

- 固定 SHA 的远程源码和 Git 历史。
- 上传的 `.git.rar`，用于 refs、tag、对象完整性和本地只读检出。
- `knowledge-base-trigger-refactor-plan(2).md`。
- `log-ui-comparison(2).html`：上半部分是旧实现对照，下半部分才是目标验收原型。
- `project-knowledge-base-pro-review-prompt(2).md`。

本报告的行号均是固定 SHA 下的 **1-based** 行号，并同时给出函数、路由或类名，避免后续行号漂移。

### 1.2 证据等级

- **源码已确认**：在固定 SHA 的 tracked source、Git objects 或已执行测试中直接观察到；Bug 总表默认均属于此类。
- **从证据推断**：例如并发时的 lost update、迁移中断后跳过等，触发条件由源码控制流可以确定，但本轮只读环境没有对用户真实数据执行破坏性复现；报告同时给出可自动化复现方法。
- **尚待验证**：依赖完整 npm 安装、Windows/Git for Windows、packaged Electron/LanceDB 或真实 AI 进程的行为；均在实施计划 G5 中列为必须验证，未被写成“已通过”。

### 1.3 外部主文档核对

本轮只用官方 Git/Node 文档核对与实现边界直接相关的语义：

- Git `post-commit` 在 Commit 完成后执行，属于通知类 Hook；因此目标设计应保证通知失败不改变已完成 Commit。
- Git 的 `core.hooksPath` 会改变 Hook 查找目录，worktree 也可能使用 `.git` 文件；Hook manager 应通过 Git 自身的 path resolution，而不是假设 `<repo>/.git/hooks`。
- `git rev-list --reverse` 只是反转选定顺序；为多 Commit 严格可解释处理，应显式选择拓扑顺序，并定义 merge 的 diff 语义。
- Node 文件 API 不会自动替业务提供多写者序列化；重复/并发 `writeFile` 及崩溃耐久性需要调用方等待、加锁、flush 和原子替换协议。

这些核对支持本报告的 Hook path、Commit ordering、AtomicFile 和 project lock 建议，不替代对仓库源码的直接证据。

## 2. 基线验证

当前容器没有 `node_modules`，且网络不可用于 `npm ci`。完整套件的依赖型失败被记录为**环境阻塞**，不伪装成源码失败。

| 命令 | 退出/状态 | 结果 |
|---|---:|---|
| `git rev-parse HEAD` / `git show-ref` | 0 | 本地 main、origin/main 与远程均为固定 SHA |
| `git diff --cached --quiet HEAD --` | 0 | 上传 index 与 HEAD 无差异 |
| `git fsck --full --strict` | 0 | 可达对象完整；仅报告不可达 dangling 对象 |
| 对所有 tracked `.js/.cjs` 执行 `node --check` | 0 | 全部语法检查通过 |
| `npm pack --dry-run --json` | 0 | 1,405,285 bytes packed；2,815,915 bytes unpacked；134 个发布文件 |
| `node _site/_test/run-all-tests.js --no-report` | 124（外层超时） | runner 发现 52 个测试；多项服务/UI/向量测试因缺少 `ws`、代理库、LanceDB 等依赖失败或等待，不判定为源码回归 |
| 18 个依赖较轻的测试逐个执行 | 17 通过 / 1 环境失败 | `integration-adapters-test.js` 仅因缺少 `cross-spawn` 失败 |
| `npm test --prefix desktop` | 0 | `desktop-runtime-test`、`app-updater-test` 通过 |
| GitHub status / workflow runs | 无记录 | “无记录”不等于 CI 通过 |

### 2.1 已通过的目标测试

`ai-vendor-presets-test.js`、`automation-queue-test.js`、`chat-claudecodeui-match-test.js`、`claude-executable-discovery-test.js`、`claude-session-lifecycle-sweep-test.js`、`claude-workbench-test.js`、`data-dir-migration-test.js`、`desktop-browser-compat-test.js`、`embedding-config-test.js`、`folder-picker-output-test.js`、`index-builder-test.js`、`kbpath-follow-test.js`、`model-context-windows-test.js`、`pending-sweep-test.js`、`post-commit-automation-test.js`、`runtime-endpoint-test.js`、`workspace-ui-contract-test.js`。

### 2.2 Codex 开始实施前必须重跑

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
```

Windows 发布路径还要按现有 workflow 运行 packaged application、LanceDB smoke 和 package audit。当前审查环境不具备依赖条件，不能声称这些通过。

## 3. 当前架构与关键调用链

### 3.1 当前实际分析入口

| # | 入口 | 稳定源码位置 | 当前结果 | 目标 |
|---:|---|---|---|---|
| 1 | 导入后初始化分析 | `_site/server.js:L1455-L1577 · importProjectFromLocalPath()` | 调用 `dispatchProjectInit()` | 删除 |
| 2 | Git post-commit Hook | `_site/server.js:L2662-L2679`; `post-commit-automation.js:L713-L744` | `handlePostCommitEvent()` | 保留 |
| 3 | 手动模拟 | `_site/server.js:L2703-L2722` | `dispatchAutomation()` | 删除 |
| 4 | 手动初始化 | `_site/server.js:L2724-L2738` | `dispatchProjectInit()` | 删除 |
| 5 | 启动补查 | `_site/server.js:L3280-L3315`; `post-commit-automation.js:L310-L324` | `dispatchPendingAutomations()` | 保留 |

`/context-pack` 只生成上下文，不是分析入口。`/analyze/initial` 当前实际是 Claude Workbench 会话启动器，不再执行旧自动初始化；名称容易误导，但不能误删用户工作台能力。

### 3.2 Hook 实时链路

```text
Git post-commit
  -> generated shell
  -> node _site/scripts/hook-trigger.js
  -> POST /api/hooks/post-commit
  -> handlePostCommitEvent(repoPath)
  -> findProjectForRepo(path comparison)
  -> reconcileProject(slug)
  -> scanProject(base..HEAD)
  -> commit-automation-state.json discover/claim
  -> in-memory per-slug queue
  -> Claude automation session
  -> onSessionEnded
  -> markCompleted + rewrite projects.json
  -> async indexMigratedProject
```

核心问题：脚本路径错误、路径身份不稳定、Git 之外又维护第二持久队列、AI 成功未验证、state 与 index 无一致提交点。

### 3.3 启动补查链路

```text
server.listen
  -> cleanupOrphanedRuns
  -> readProjects
  -> dispatchPendingAutomations
  -> for...of projects（当前串行）
  -> reconcileProject(..., 'startup-recovery')
```

目标 trigger 只允许 `startup`；不同项目应并行，同一 projectId 必须合并成一个 reconciliation。

### 3.4 项目导入链路

```text
validate path/team binding
  -> require usable AI profile
  -> inspect/init Git
  -> choose slug/kbPath
  -> initProjectDirs（写 TODO Markdown）
  -> write whole projects.json
  -> installHook（失败不回滚）
  -> dispatchProjectInit（失败不回滚）
  -> return ok:true
```

这不是事务。外部知识目录、内部状态、Hook 和 registry 在任何失败点都可能不一致。

### 3.5 项目删除链路

当前先尝试卸载 Hook，但失败只变成 warning；随后照常删除 registry、scope/override，并可递归删除外部知识目录。目标必须是：检查运行任务 → Hook 必须成功卸载（仓库已不存在例外）→ 删除内部登记/派生索引 → 默认保留外部 Markdown → 用户显式确认时才独立删除。

### 3.6 知识写入与索引链路

Claude 当前直接写最终 knowledgePath；会话 idle/exit 0 后先把 Commit 标记完成并推进 registry，再异步索引。Markdown 与 LanceDB 没有事务/dirty 关系。目标应把 Markdown 定义为事实源，LanceDB 定义为可重建派生数据，增加 staging、promotion journal、state advance 和 indexDirty。

### 3.7 日志链路

`server.logEvent()` 包装 `structuredLogger.appendLog()`；失败空 catch。`readLogs()` 同步读取所有 `.log`、全部解析排序后再截取。UI 主日志页外还有第二套日志列表，默认把当天同时作为 dateFrom/dateTo。

## 4. 当前文件、目录、状态所有权与路径来源

| 当前路径/资源 | 当前创建/读取者 | 当前内容 | 已确认问题 | 目标归属 |
|---|---|---|---|---|
| `~/.project-knowledge/projects.json` | server/runtime/CLI/automation | 配置、路径、HEAD、tracking、analysis 状态 | 高频 whole-file 覆盖；slug 充当身份 | ProjectRegistryStore，仅 projectId 顺序 |
| `ai-profiles.json` | server/llm-client | AI Profile 与明文 Key | GET 原样泄露 | `settings.json.ai`；落盘可明文，API 必须脱敏 |
| `knowledge-store.json` | server/runtime | 全局 root + git 选项 | 保存设置会影响 DB | `settings.json.knowledge.rootPath` |
| `embedding-config.json` | server/runtime | Embedding 设置 | 路径重复 | `settings.json.embedding` |
| `logging.json` | logger/server | root/levels/retention | root 可变；retention 无实现 | `settings.json.logging`，log path 固定 |
| `claude-prompts.json` | prompt-registry | prompt override | 多路径/旧 init prompt | 默认在代码，覆盖值入 settings |
| `github-team.json`、`team-git-providers.json` | team modules | integrations | 根目录常驻多文件 | `settings.json.integrations` 按需 |
| `knowledge-scopes.json` | scope registry/runtime | project bindings + global scope | 查询可触发写；slug 绑定 | 项目绑定入 config，全局设置入 settings |
| `removed-projects.json` | server | 删除恢复 | 根目录常驻 | `recovery/deleted-projects.json` 按需 |
| `team-stores-cache.json` | server | cache | 被当配置 | `cache/team-stores.json` |
| `embedding-model-state.json` | server | runtime state | 根目录常驻 | `runtime/embedding-model-state.json` |
| `.hook-trigger-errors.log` | hook-trigger | plaintext error | 无结构、空 catch | `logs/hooks/YYYY-MM-DD[.NNN].jsonl` |
| `_ai/<slug>/...` | ai-workspace/automation | runs/context/queue/workbench | slug 身份；空目录预建；第二队列 | `runtime/projects/<projectId>/...` 按需 |
| `models/` | embedding | model cache | 根目录散落 | `cache/models/` |
| `knowledge.lancedb`（旧） | CLI | index | 与 server 路径不一致 | `index/knowledge.lancedb` |
| `<knowledgeRoot>/.project-knowledge/...` | knowledge-storage-location | DB/maintenance/backups | 污染用户知识 root | 全部迁回内部 data dir |
| `<knowledgeRoot>/<slug>/README.md...` | kb-framework/AI | 实际知识 | 导入即写 TODO/空索引 | 固定 storageName 项目目录；可信知识按需创建 |

## 5. Plan 判定：READY_WITH_CHANGES

### 5.1 可以直接保留的产品决策

- 只有 Git Hook 与 startup 两个公开分析入口。
- 导入不分析历史项目，不做全项目推测初始化。
- Hook 随项目导入/删除自动安装/卸载，用户没有手动按钮或公开接口。
- 唯一 Commit prompt 同时使用用户需求与真实 Diff。
- 不同项目可并行；单项目串行，失败停止。
- stable projectId、registry index、per-project config/state/requirements。
- 全局知识根只决定新项目；已导入项目使用固定绝对 knowledgePath。
- 用户知识 root 与内部 `.project-knowledge` 严格分离。
- 单一内部 LanceDB、统一路径解析器。
- JSONL 六级诊断日志、长期保存、轮转、容量、cursor API、单一 UI。
- 保持轻量本地技术栈；AI Key 可明文落盘，但不得出现在 API 响应、日志或导出。

### 5.2 必须修正或补定义的 Plan 项

1. **测试编号不一致**：Plan 只有 1–52；审查提示词写 1–55。只映射 1–52；53–55 标记 `UNDEFINED_IN_SOURCE_PLAN`。
2. **知识骨架冲突**：导入仅创建/声明项目目录，不创建带 TODO 的 README/GOAL/ARCHITECTURE 或空索引；第一条经验证知识再按需创建。
3. **空仓库未定义**：无 HEAD 时 state 记录 `tracking.mode=empty-repo`；导入后的第一个 Commit 应分析。
4. **移动仓库身份未定义**：Hook 固定 projectId，同时发送运行时 REPO_ROOT；服务端校验后更新 repoPath，projectId 不变。
5. **requirements 跨进程并发未定义**：server/MCP/CLI 共享跨进程 lock + fsync append，不能只用内存 mutex。
6. **需求绑定算法未定义**：禁止“最近一次提问”；按 projectId、显式 requirementId、session/client/branch、headAtRecord ancestry 选择；歧义时不绑定。
7. **任务证据冻结未定义**：claim 时冻结 requirementIds、promptHash、patchHash、knowledgePath、配置版本；恢复不得重新选未来需求。
8. **Markdown/index/state 边界未定义**：staging → validation → journaled promotion → state advance/indexDirty → single-writer index。
9. **多文件原子性未定义**：使用 transaction journal + backups + startup recovery。
10. **单 LanceDB 并发未定义**：项目分析可并行，但共享 DB mutation/maintenance 必须由一个 IndexService 串行提交。
11. **历史改写未定义**：baseline 不是 HEAD 祖先时停止并记录 divergence，不能自动猜测重置。
12. **merge Commit 未定义**：不能继续 `--no-merges`；记录 merge Commit，first-parent patch 表示该 Commit 引入的变化。
13. **遗漏 Commit 的边界**：不保存 Hook spool 时，只能恢复当前 HEAD 可达的 baseline 后 Commits；被 rebase 丢弃的不可达 Commit 无法补回。
14. **外部目录归属未定义**：不在用户 root 放隐藏元数据；由内部 config + transaction journal + 创建前状态/hash 证明归属。
15. **日志容量算法未定义**：先删过期；容量阶段优先删最旧 low-level-only segment；保护活动文件和最近 error/fatal；仍超限时停止低等级写入并暴露 health。
16. **删除项目后的日志显示**：log 保存 display snapshot，删除后标记 `[已删除]`，不依赖当前 config。
17. **非回环 API 安全未定义**：当前已确认凭据泄露，必须同批修复。默认 same-origin/loopback；非回环需认证。
18. **通用项目写接口未列入删除**：`PUT /api/projects` 会绕过新生命周期，必须删除或改成不可变字段白名单 patch。
19. **导入与 AI Profile 耦合**：应解除；否则模型配置前不能建立 Hook/跟踪。
20. **Hook 绝对脚本路径升级**：managed Hook schemaVersion 与 state migrationVersion 驱动一次性修复。

### 5.3 与源码不匹配的名称或假设

- 目标名是 `reconcileProjectCommits()`；当前实际是 `reconcileProject()`，默认 source 为 `startup-recovery`。
- 当前所谓 Diff 只有 `git show --stat`，不是实际 patch。
- Plan 描述的 projects.json 并发覆盖在源码中已确认，不只是推测。
- `SITE_ROOT` 在 server 中实际指向 `ui`，不是 `_site`，这是 Hook path Bug 根因。
- 日志 UI 问题成立，且源码还有第二套重复列表。

## 6. 已确认 Bug


### 6.1 Bug 总表

| Bug ID | 严重度 | 位置/稳定符号 | 已确认影响 | 实施任务 |
|---|---|---|---|---|
| BUG-SEC-001 | Critical | `_site/server.js · send()`、`GET /api/ai-profiles`、顶层 catch | 任意可访问页面可跨源读取明文 API Key；500 响应泄露 stack | T01、T10 |
| BUG-SEC-002 | High | `_site/server.js · GET /api/raw` | `startsWith()` 边界检查可被同前缀路径绕过；读取根也不是项目 knowledgePath | T10 |
| BUG-HOOK-001 | Critical | `importProjectFromLocalPath()` → `installHook()` → `buildHookBody()` | 生产调用生成 `ui/scripts/hook-trigger.js`，该文件不存在，Commit 通知失效 | T06、T10 |
| BUG-HOOK-002 | High | `buildHookBody()` | 虽计算 `REPO_ROOT`，却发送导入时固化的 repoPath；仓库移动后失效 | T06 |
| BUG-HOOK-003 | High | `installHook()` / `uninstallHook()` | marker 识别过宽、直接覆盖写入、`overwrite` 可覆盖第三方 Hook，并顺带改 CLAUDE.md | T06 |
| BUG-HOOK-004 | Medium | `resolveGitHooksDir()` | 手工推导 hooks 目录，worktree、相对 `core.hooksPath` 和 Git 语义不完整 | T06 |
| BUG-LIFE-001 | Critical | `importProjectFromLocalPath()` | registry 先落盘；Hook/初始化失败仍返回 `ok:true`，留下半完成项目 | T06、T10 |
| BUG-LIFE-002 | High | 项目删除路由 | Hook 卸载失败只警告，仍删除登记；可递归删除外部知识目录 | T06、T10 |
| BUG-LIFE-003 | High | `PUT /api/projects` | 可绕过导入事务、稳定 projectId、路径固定和 Hook 生命周期 | T10 |
| BUG-LIFE-004 | Medium | `importProjectFromLocalPath()` | 导入被“必须已有可用 AI Profile”阻断，无法先建立跟踪 | T06、T10 |
| BUG-AUTO-001 | High | `dispatchProjectInit()` / `renderProjectInitPrompt()` | 导入后扫描项目并把推测性初始化内容写成事实 | T08、T10 |
| BUG-AUTO-002 | High | `collectCommitMetadata()` / `buildPromptVars()` | prompt 只有文件清单和 `--stat`，没有实际 patch 和用户需求 | T07、T08 |
| BUG-AUTO-003 | High | `onSessionEnded()` | Claude idle/exit 0 即被当作知识成功，未验证输出、写入或允许路径 | T08、T09 |
| BUG-AUTO-004 | High | `onSessionEnded()` → `indexMigratedProject()` | Commit pointer 在索引前推进；索引失败没有 `indexDirty` 或可靠重试 | T09 |
| BUG-AUTO-005 | High | automation state/registry 保存 catch | 关键状态保存异常被吞掉，可能重复分析或错误推进 | T03、T08 |
| BUG-AUTO-006 | Medium | persisted claim → later prompt render | 恢复时重新渲染 prompt，可把未来需求错误绑定到旧 Commit | T07、T08 |
| BUG-SCAN-001 | High | `_site/lib/scanner.js · scanProject()` | 未校验 baseline 祖先关系；rebase/reset 后 range 语义不可靠 | T08 |
| BUG-SCAN-002 | Medium | `scanProject()` | `maxCommits` 未生效、`--no-merges` 漏 merge、时间排序不足以表达拓扑 | T08 |
| BUG-STATE-001 | Critical | `readProjects()` / `writeJson(PROJECTS_PATH, projects)` | 多项目并发 whole-file read-modify-write，确定性 lost update | T03、T10 |
| BUG-STATE-002 | High | `commit-automation-store.js`、多个 JSON reader | 无效 JSON 被静默当成空状态，导致重放、配置丢失或项目消失 | T02、T03、T04 |
| BUG-STATE-003 | High | `writeJson()` 等 | temp+rename 无目录 fsync、锁和 Windows 替换重试；并发与崩溃耐受不足 | T02 |
| BUG-MIG-001 | Critical | `_site/lib/data-dir.js` | 以 `projects.json` 存在作为迁移完成标记；中途失败可永久跳过剩余迁移 | T04 |
| BUG-MIG-002 | High | `_site/lib/knowledge-store.js` | 源目录缺失仍切换 kbPath；覆盖迁移先删除目标，失败可丢数据 | T04 |
| BUG-PATH-001 | High | `knowledge-storage-location.js` | LanceDB 放到用户知识根并随设置移动，混淆真实知识与派生数据 | T02、T04、T11 |
| BUG-PATH-002 | High | server/runtime/CLI/MCP | 各自拼接 DB、settings、projects 路径，事实源不一致 | T02、T11 |
| BUG-PATH-003 | Medium | path normalization helpers | 在所有平台无条件小写路径，破坏大小写敏感文件系统语义 | T02、T03 |
| BUG-KNOW-001 | High | `kb-framework.js · initProjectDirs()` | 导入即生成 TODO/空知识文件，与真实性原则冲突 | T06、T09 |
| BUG-KNOW-002 | High | AI 直接写 final knowledgePath | 无 staging、文件白名单、promotion journal 或崩溃恢复 | T09 |
| BUG-INDEX-001 | High | `knowledge-db.js` / `markdown-knowledge-indexer.js` | 单一 LanceDB 被多个项目并发 mutation；maintenance state 也会竞态 | T09 |
| BUG-LOG-001 | High | `structured-logger.js` | 只有三级；retention 配置不执行；全量同步读取；写失败可静默 | T05 |
| BUG-LOG-002 | Medium | `ui/index.html` logging sections | 两套日志 UI；默认仅当天；错误链路不突出 | T12 |
| BUG-REQ-001 | High | Claude/MCP/Codex/OpenCode 接入层 | 没有需求持久化、项目/会话归属和 Commit 关联机制 | T07 |
| BUG-TOOL-001 | High | `automation-config.js` path/shell policy | 词法路径边界与命令字符串 allowlist 可被 symlink/组合命令绕过 | T08、T09 |
| BUG-CONFIG-001 | High | JSON 恢复/默认值逻辑 | 配置损坏时备份后直接使用默认值，可能把用户事实静默替换为空配置 | T02、T04 |

### 6.2 Hook 与项目生命周期 Bug 证据

#### BUG-HOOK-001 — 生产 Hook 指向不存在脚本

- **证据**：`_site/server.js:L50-L80` 中 `SITE_ROOT` 指向 `_site/ui`；`importProjectFromLocalPath():L1530-L1533` 把该值传给 `installHook()`；`_site/lib/hook-manager.js:L92-L96 · buildHookBody()` 再拼接 `scripts/hook-trigger.js`。
- **实际结果**：生成 `<repo>/post-commit` 中的 Node 路径为 `_site/ui/scripts/hook-trigger.js`，而真实文件是 `_site/scripts/hook-trigger.js`。
- **为什么现有测试没发现**：`_site/_test/hook-trigger-test.js` 自行把 `<repo>/_site` 作为 `siteRoot`，没有经过生产 `server.js` 调用。
- **触发条件**：通过 UI/HTTP 导入任意项目后提交 Commit。
- **影响**：唯一实时分析入口失效；用户只可能在下次启动补查时发现。
- **修复**：`installHook({ triggerScriptPath })` 接收已验证的真实绝对文件；导入事务在写 Hook 前 `stat`，写后读取并验证；失败回滚。
- **回归测试**：必须从真实 import service 调用开始，断言 Hook 文件里的脚本存在且可执行通知。

#### BUG-HOOK-002 — 仓库移动后仍发送旧路径

- **证据**：`buildHookBody():L110` 计算 `REPO_ROOT`，但 `L113` 发送的是被 `installHook():L151` 替换成导入时绝对路径的 `$REPO_PATH_PLACEHOLDER`。
- **影响**：移动/重命名项目目录后，服务端找不到项目或把通知错误归属。
- **修复**：Hook 发送 `projectId` 和运行时 `REPO_ROOT`；服务端用 projectId 定位，再用 Git identity/路径校验并更新 `config.repoPath`。不能只靠可变路径查项目。
- **测试**：导入、移动仓库、提交；仍命中原 projectId，且 metadata 目录不变。

#### BUG-HOOK-003 / BUG-HOOK-004 — Hook 安全与 Git 语义不完整

- **证据**：`installHook():L144-L152` 仅用 marker 子串识别并直接 `writeFileSync`；`overwrite:true` 可覆盖任意现有 Hook；`L154-L162`、`uninstallHook():L179-L185` 顺带管理 CLAUDE.md。hooks 目录由模块手工推导。
- **修复**：
  - 使用 Git 自身的 `git rev-parse --path-format=absolute --git-path hooks` 解析有效 hooks 目录。
  - managed Hook 首行包含严格 schema、product id、projectId；只更新完全匹配本系统 marker 的文件。
  - 第三方 Hook 一律 409 冲突，导入失败；本轮不自动链式拼接未知脚本。
  - 原子替换、可执行位验证；不读写 CLAUDE.md。
  - 一次性 migration 只修复旧 marker 且版本落后的 Hook。

#### BUG-LIFE-001 — 导入是非事务且虚假成功

- **证据**：`importProjectFromLocalPath():L1499-L1503` 先建知识骨架；`L1524-L1525` 写 registry；`L1530-L1542` Hook 错误只收集；`L1550-L1554` init 错误只收集；`L1566-L1577` 始终 `ok:true`。
- **影响**：用户看到导入成功，但没有实时 Hook；registry、外部目录和运行状态彼此不一致。
- **修复**：由 `ProjectLifecycleService.importProject()` 维护 transaction journal，顺序为校验 → 分配 ID/路径 → 创建最小内部状态和目录声明 → Git baseline → Hook 安装验证 → 最后写 registry index。任何失败按 journal 逆序回滚。

#### BUG-LIFE-002 — 删除可在 Hook 残留时继续并删除用户知识

- **证据**：项目删除路由捕获卸载失败后仍移除登记；外部知识目录可被递归删除。
- **修复**：仓库存在且 managed Hook 卸载失败时，删除操作失败并保留项目；仓库已不存在时记录例外。默认只删内部 metadata/derived index mapping，外部 Markdown 仅在独立显式确认且归属证明通过后删除。

### 6.3 Commit、状态和知识一致性 Bug 证据

#### BUG-AUTO-002 — “Diff”实际只有统计摘要

- **证据**：`post-commit-automation.js:L89-L102 · collectCommitMetadata()` 读取 `--name-only` 和 `git show --stat`；`buildPromptVars():L115-L141` 没有 `userRequirement` 或 unified patch。
- **影响**：模型不能可靠判断具体实现；容易把 commit subject 或文件名推测成业务事实。
- **修复**：固定 Commit 后读取 commit metadata、parents、`--format=fuller`、binary/rename metadata 和受大小限制的 unified patch；限制只影响可传输尺寸，不改变业务 prompt 内容。超限必须生成明确的 patch manifest，并记录“未提供全文”的证据边界。

#### BUG-AUTO-003 — 进程成功不等于知识成功

- **证据**：`post-commit-automation.js · onSessionEnded()` 主要依赖 Claude session idle/exit 0，随后把 run/Commit 标为完成；没有产物清单、schema 校验或 final knowledgePath 差异验证。
- **影响**：模型没有写文件、写错路径、输出半截或修改源码时，都可能推进 pointer。
- **修复**：AI 只能写 per-run staging；必须验证 manifest、Markdown schema、允许目录、禁止源码修改、每个 staged 文件可解析，再允许 promotion。

#### BUG-AUTO-004 — pointer 与索引没有明确提交边界

- **证据**：成功处理先更新 `lastAnalyzedCommit`，随后异步 `indexMigratedProject()`；索引失败不阻塞也没有 dirty 状态。
- **推荐语义**：
  1. Markdown 是事实源。
  2. promotion 成功后，原子更新 `lastAnalyzedCommit` 与 `indexDirty=true`。
  3. 单写者 IndexService 重建该 Commit 影响的 entries。
  4. 成功后清除 `indexDirty`；失败保持 dirty 并在启动时重试。
  5. 索引失败不应再次调用 AI，也不回退已验证 Markdown。

#### BUG-AUTO-005 / BUG-STATE-001 — 状态写入可丢失且错误被吞

- **证据**：automation 通过依赖回调重写整个 `projects.json`；多个 catch 只返回或忽略错误。`projects.json` 既含所有项目配置又含每个项目高频 pointer。
- **复现**：A、B 同时读取旧 registry，各自修改 pointer；后写者覆盖先写者。
- **修复**：ProjectStore 每项目独立 `state.json`；per-project mutex + cross-process lock；原子 durable replace。registry 只在 import/delete 时经 global lock 修改。

#### BUG-SCAN-001 / BUG-SCAN-002 — Git range 边界不完整

- **证据**：scanner 使用 `git log --reverse --no-merges <base>..HEAD`，不校验 base 是否为 HEAD 祖先；`maxCommits` 读取后未生效。
- **修复**：
  - `merge-base --is-ancestor base HEAD` 失败则进入 `history-diverged`，停止且要求显式修复。
  - 使用 `rev-list --reverse --topo-order base..HEAD`；包括 merge Commit。
  - merge Commit 的“本 Commit 引入变化”采用 first-parent diff，同时记录完整 parent 列表。
  - batch limit 必须能返回 continuation，绝不能截断后把 HEAD 当全部处理完成。

### 6.4 持久化、路径和迁移 Bug 证据

#### BUG-MIG-001 — 部分迁移可被误判为完成

- **证据**：`_site/lib/data-dir.js:L48-L50` 在目标 `projects.json` 已存在时跳过迁移；迁移把文件逐个写到 live target，任一步失败即返回。
- **复现**：先成功复制 projects.json，后续 AI/log/DB 迁移失败；下一次启动因 projects.json 已存在而不再迁移。
- **影响**：新旧 layout 混合，路径事实源不确定；后续保存可能覆盖旧资产。
- **修复**：版本化 `migration-state.json` 只作 journal，不作最终事实；全部数据写入 staging、验证、生成 manifest，最后一次原子切换并写 `schemaVersion` completion marker。失败继续读旧 layout。

#### BUG-MIG-002 — 知识迁移的 destructive overwrite

- **证据**：knowledge-store 迁移在源缺失时仍可改写项目 kbPath；overwrite 模式会先删除目标再复制，验证不足。
- **修复**：copy-to-new-temp → 文件/大小/hash manifest → 原子配置切换 → 原目录保留；删除旧目录只能是后续显式动作。任何失败不改 config。

#### BUG-PATH-001 / BUG-PATH-002 — 派生索引与用户知识路径混杂

- **证据**：`knowledge-storage-location.js` 在选定 knowledge root 下创建 `.project-knowledge/knowledge.lancedb`；CLI 又直接读 `~/.project-knowledge/knowledge.lancedb`；server/runtime 有第三套解析。
- **影响**：设置 root 会隐式移动 DB；CLI、MCP、server 查到不同库；用户 root 出现内部文件。
- **修复**：唯一 `StorageLayout`；DB 固定 `<dataDir>/index/knowledge.lancedb`，knowledge root 只放项目 Markdown。

#### BUG-STATE-003 / BUG-CONFIG-001 — 原子写与损坏处理不足

- **证据**：多个 `writeJson()` 只做同目录 temp+rename；无 lock、fsync、目录同步和 Windows retry。解析失败通常备份后返回默认空对象。
- **修复**：
  - `AtomicFile.writeJson()`：exclusive lock → write temp → fsync file → close → rename/Windows replace retry → fsync directory（平台支持时）→ unlock。
  - 关键 config/state 解析失败必须进入 degraded/read-only 或从可验证 backup 恢复，不能静默写默认空值。

### 6.5 日志、API 与接入层 Bug 证据

#### BUG-LOG-001 / BUG-LOG-002

- **证据**：`structured-logger.js` 只接受 info/warn/error；`retentionDays` 仅保存；同步 append/read-all-sort；写入错误可被 server 的空 catch 吞掉。`ui/index.html` 同时存在主日志页面与第二套列表，日期默认同一天。
- **修复**：Logger 与 LogRepository 分离；writer queue、六级 schema v2、递归脱敏、按日/50 MiB 分段、真实 retention/capacity、cursor scan、export；UI 只保留附件下半部分目标形态。

#### BUG-SEC-001 — API Key 可跨源读取

- **证据**：`server.js · send()` 对响应设置 `Access-Control-Allow-Origin: *`；`GET /api/ai-profiles` 返回完整 profile store；AI Key 明文存储符合产品决策，但绝不能经 GET 原样返回。顶层错误响应包含 stack。
- **影响**：本地服务运行时，恶意网页可从浏览器请求本机服务并窃取凭据；非回环 bind 时风险更大。
- **修复**：
  - GET 只返回 profile metadata、`hasApiKey` 和掩码，永不返回 secret。
  - 更新 API 使用 `preserve/replace/clear` 三态，避免前端读取旧 Key 才能保存其他字段。
  - 默认只允许 same-origin/loopback；非回环必须有显式认证 token、Origin 校验和安全告警。
  - 500 只返回 request/operation ID，完整 stack 仅入脱敏日志。

#### BUG-SEC-002 — raw file 边界检查错误

- **证据**：`GET /api/raw` 用 `abs.startsWith(KB_ROOT)` 判定，字符串前缀不能代表目录后代；并且读取的是包内 KB_ROOT，而非项目固定 knowledgePath。
- **修复**：优先删除该旧路由；确需保留时必须以 projectId 定位 knowledgePath，对 `realpath` 后结果使用 `path.relative()` 严格判断、拒绝 symlink escape，并限制可读扩展名。

#### BUG-REQ-001 — 用户需求没有事实来源

- **证据**：Claude input endpoint 只向会话写 stdin；OpenCode/Codex MCP 是纯只读；仓库没有 requirements store，也没有 requirementId。
- **修复**：
  - embedded Claude Workbench 在成功发送前追加 requirement。
  - MCP 增加单一 write-only metadata tool `project_knowledge_record_requirement`；它只记录需求，绝不分析知识。
  - skills/instructions 要求编码 Agent 在开始实现前调用该工具。
  - append 由本地服务统一执行；明确 projectId、client、sessionId、branch、headAtRecord、正文 hash。

#### BUG-TOOL-001 — 自动化边界可被路径/命令技巧绕过

- **证据**：automation config 对路径做词法归一/小写，对 shell command 做字符串 allowlist；symlink 和命令连接符不是该模型能可靠覆盖的。
- **修复**：Commit 分析不再给通用 Bash 写权限；所有 Git 读取由可信 Node 层预取，AI 只读证据包并写 staging knowledge 目录。路径授权基于 realpath + directory boundary。


### 6.6 逐 Bug 可执行规格

| Bug ID | 触发/复现 | 根因 | 修复合同 | 回归测试 | Task |
|---|---|---|---|---|---|
| BUG-SEC-001 | 本地服务运行时，从任意网页跨源请求 profiles；或制造 500 | wildcard CORS、secret model直接序列化、generic catch返回 stack | same-origin/loopback policy；public profile view；key preserve/replace/clear；stack只入脱敏日志 | malicious Origin、profile JSON secret scan、500 body scan | T01、T10 |
| BUG-SEC-002 | 请求与允许 root同字符串前缀的 sibling path或 symlink | 用 `startsWith()` 代替目录边界，且 route不按 project knowledgePath解析 | 删除 route；否则 projectId→realpath→`path.relative`，扩展名/符号链接限制 | prefix sibling、`..`、symlink、Windows case/path fixture | T10 |
| BUG-HOOK-001 | UI/API import 后检查 Hook内 Node路径并提交 | server把 `_site/ui` 作为 siteRoot，manager再拼 scripts | 传显式 `triggerScriptPath`，写前后验证文件 | production import service端到端 Hook path | T06、T10 |
| BUG-HOOK-002 | 导入后移动 repo再 commit | Hook忽略运行时 `REPO_ROOT`，发送固化路径 | payload包含 stable projectId+runtime root，server验证并更新 repoPath | move/rename repo Hook test | T06 |
| BUG-HOOK-003 | existing Hook含相似 marker；或调用 overwrite；install/delete观察 CLAUDE.md | marker模糊、direct overwrite、职责耦合 | strict version marker、第三方冲突拒绝、atomic replace、no CLAUDE.md | third-party/marker spoof/idempotent/no-CLAUDE fixtures | T06 |
| BUG-HOOK-004 | worktree、relative core.hooksPath、Git for Windows | 自行推导 `.git/hooks`，未完全服从 Git配置 | `git rev-parse --path-format=absolute --git-path hooks` | worktree/core.hooksPath/Windows path | T06 |
| BUG-LIFE-001 | 令 Hook写入失败或 trigger不存在后 import | 非事务；registry先提交；错误只附加返回 | lifecycle journal，Hook验证后registry最后提交，失败逆序回滚 | 每个 import stage fault injection | T06、T10 |
| BUG-LIFE-002 | 令 Hook卸载权限失败后 delete；或选择删知识 | 卸载 warning不阻断；external dir递归删除边界弱 | Hook失败停止；repo缺失明确例外；默认保留；显式删除需归属证明 | delete Hook permission/knowledge policy tests | T06、T10 |
| BUG-LIFE-003 | 对 `PUT /api/projects` 直接提交项目结构 | generic whole replace绕过所有 lifecycle invariant | 删除接口或仅保留 immutable-safe PATCH service | route absence/immutable patch tests | T10 |
| BUG-LIFE-004 | 未配置 AI profile时 import | import错误依赖分析运行条件 | import只建立项目/Hook/tracking；分析时再检查 profile | no-profile import succeeds/no analysis | T06、T10 |
| BUG-AUTO-001 | import新项目或调用 manual init | init prompt基于项目概览推测知识 | 删除 init template/render/dispatch/routes；保留历史文件不新产 | symbol/route absence；import no AI | T08、T10 |
| BUG-AUTO-002 | 查看生成 prompt，只有 file/stat，无真实 patch/requirement | metadata collector和vars缺字段 | trusted GitReader actual patch + RequirementBinder +唯一 template | prompt fixture/hash/evidence contents | T07、T08 |
| BUG-AUTO-003 | AI exit 0但不写文件、写错路径或半写 | session进程状态被误当知识成功 | staging manifest+validator+promotion proof后才能advance | no-output/invalid-output/source-write tests | T08、T09 |
| BUG-AUTO-004 | 模拟索引失败，检查 pointer和后续恢复 | pointer与异步索引无dirty generation | promotion后advance+indexDirty；single writer成功再clear | index failure/retry/generation race | T09 |
| BUG-AUTO-005 | 令 registry/state持久化失败 | catch吞错且whole registry保存 | ProjectStore strict atomic update；持久化失败阻断advance | EACCES/rename failure/no advance | T03、T08 |
| BUG-AUTO-006 | claim后追加新需求，重启恢复旧 run | prompt在执行/恢复时重新渲染，未冻结证据 | claim冻结 requirementIds、template/hash、patchHash | future requirement not bound on retry | T07、T08 |
| BUG-SCAN-001 | baseline被 rebase/reset成非祖先 | scanner未做 ancestry检查 | merge-base ancestry；diverged state；显式停止 | divergence fixture | T08 |
| BUG-SCAN-002 | merge Commit、超过batch、同时间 commits | `--no-merges`、unused max、排序/continuation不足 | rev-list reverse topo，include merges，first-parent patch，continuation | root/merge/batch/topology tests | T08 |
| BUG-STATE-001 | A/B并行各推进后读取 registry | 多 writer读取同旧 whole file后覆盖 | index-only registry + per-project state + locks | deterministic barrier lost-update test | T03、T10 |
| BUG-STATE-002 | 截断/破坏 automation state/config JSON后启动 | parse error被当空对象 | strict read、verified backup或degraded stop | corrupt JSON must not replay/default | T02、T03、T04 |
| BUG-STATE-003 | kill进程于写入/rename；Windows锁冲突 | temp+rename缺锁/fsync/retry/dir sync | AtomicFile durable protocol和cross-process lock | fault injection/Windows replace | T02 |
| BUG-MIG-001 | projects复制成功后让后续文件迁移失败，重启 | `projects.json`存在被误作完成标记 | staged manifest、activation/open verify、completion last | fail-after-each-stage restart | T04 |
| BUG-MIG-002 | source缺失或覆盖目标复制中失败 | 配置先切换/目标先删除、验证弱 | copy temp+hash/open validate；switch last；旧数据保留 | missing source/target conflict/copy failure | T04 |
| BUG-PATH-001 | 修改 knowledge root后观察 DB移动/用户目录内部文件 | index位置跟随用户 root | internal `index/knowledge.lancedb`固定；root只用于新Markdown | root change/index unchanged/filesystem assertions | T02、T04、T11 |
| BUG-PATH-002 | server、CLI、MCP对同一项目查询各自路径 | 各模块hardcode/path join | 所有 consumers调用 StorageLayout+ProjectStore | cross-consumer path consistency | T02、T11 |
| BUG-PATH-003 | POSIX上仅大小写不同的合法路径 | 所有平台统一 lower-case | Windows专用case folding；POSIX保真 | platform path fixtures | T02、T03 |
| BUG-KNOW-001 | import空项目后检查 knowledge dir | bootstrap直接写 TODO/空索引 | import只声明最小目录；可信知识首次promotion按需创建 | import filesystem snapshot | T06、T09 |
| BUG-KNOW-002 | AI写多个final文件中途崩溃/越界写 | 无staging、白名单、journal | internal staging、manifest、realpath validation、journaled promotion | stage crash/symlink/outside/source mutation | T09 |
| BUG-INDEX-001 | 两项目同时index或maintenance+index | 共享LanceDB/maintenance state无writer序列化 | process-global IndexService single writer、generation CAS | controlled concurrent writer test | T09 |
| BUG-LOG-001 | retention到期/50MiB/多年查询/日志目录只读 | v1仅保存设置、sync append/read-all、empty catch | Logger v2 queue、rotation/cleanup/cursor/redaction/fallback | levels/rotation/retention/capacity/cursor/ENOSPC | T05 |
| BUG-LOG-002 | 打开日志页检查DOM和默认请求 | 两套render/state；from=to今天 | 单一目标UI，默认7天、cursor/detail/health | logging UI DOM/request/theme tests | T12 |
| BUG-REQ-001 | 从任一AI客户端提出需求后查看项目数据 | 无需求schema/store/capture/binder | RequirementRecorder、write-only metadata tool、deterministic binder | three-client/cross-project/ambiguity tests | T07 |
| BUG-TOOL-001 | symlink逃逸或命令字符串连接符绕过allowlist | lexical path和字符串shell policy不是安全边界 | trusted Node预取Git；AI仅写staging；realpath boundary；移除通用Bash | symlink/command-policy/source-write tests | T08、T09 |
| BUG-CONFIG-001 | 截断关键config后重启并触发保存 | backup后返回默认空值，后续覆盖用户事实 | strict corruption状态、verified backup restore或read-only degraded | corrupt settings/projects no silent overwrite | T02、T04 |

## 7. 推荐目标架构

### 7.1 架构原则

1. **单一事实源**：
   - 项目身份：`projectId`。
   - 项目配置：`projects/<projectId>/config.json`。
   - 运行进度：`projects/<projectId>/state.json`。
   - 用户知识：固定 `knowledgePath` 下的 Markdown。
   - 派生检索：内部 LanceDB，可完整重建。
2. **路由不拥有业务状态**：`server.js` 只做 HTTP 协议、输入校验、service 调用和错误映射。
3. **Git 是待处理 Commit 的事实源**：不再维护一套长期 pending Commit 队列；只保存当前 claim/recovery transaction。
4. **每项目互斥、跨项目并行**：project lock 保证 reconciliation 唯一；IndexService 对共享 LanceDB 单写。
5. **所有关键写入可恢复**：原子单文件写；多文件操作有 journal、阶段和 startup recovery。
6. **不保留双路径**：迁移完成并验证后，业务模块不得继续同时写旧/新 schema。
7. **轻量实现**：保持 Node.js、JSON、JSONL、Markdown、当前 LanceDB；不引入消息队列、微服务或新的业务数据库。

### 7.2 目标模块图

```text
HTTP / Desktop / Hook / MCP / CLI
               │
               ▼
        server route adapters
               │
      ┌────────┼───────────┐
      ▼        ▼           ▼
ProjectLifecycle  RequirementRecorder  CommitReconciler
      │                 │              │
      │                 ▼              ├── CommitScanner / GitReader
      │             ProjectStore       ├── RequirementBinder
      │                                ├── CommitAnalyzer
      ├── HookManager                  └── KnowledgePromotion
      ├── StorageLayout                         │
      ├── ProjectRegistryStore                  ▼
      └── ProjectStore                     IndexService
               │                                │
               ├──────── AtomicFile / Lock ─────┤
               │                                ▼
               └──────── Logger ────────── internal LanceDB

MigrationService reads legacy layout and writes the same stores through their
public contracts. LogRepository reads Logger segments; UI never reads files.
```

### 7.3 建议模块职责与接口

| 模块 | 拥有的数据/行为 | 最小公开接口 | 依赖 | 主要调用者 | 为什么需要独立 |
|---|---|---|---|---|---|
| `StorageLayout` | 所有内部/外部路径计算 | `getDataDir()`、`getProjectMetadataDir(id)`、`resolveNewProjectKnowledgePath(name)`、`getIndexPath()`、`getLogPath()` | `os/path`、SettingsStore read-only | 所有存储模块 | 彻底消除每个入口各自 `path.join()` |
| `AtomicFile` | durable file replace、append、lock | `readJsonStrict()`、`writeJsonAtomic()`、`appendJsonlLocked()`、`withFileLock()` | `fs` | stores/logger/migration | 把 Windows、fsync、临时文件与锁集中测试 |
| `SettingsStore` | `settings.json` schema | `read()`、`updatePatch()`、`readPublicView()` | StorageLayout/AtomicFile | server/services | 明文 key 落盘与脱敏 API 必须分离 |
| `ProjectRegistryStore` | `projects.json` index/order | `listIds()`、`add(id)`、`remove(id)` | AtomicFile/global lock | lifecycle/migration | 高频 state 不再污染 registry |
| `ProjectStore` | config/state/requirements | `readConfig()`、`writeConfig()`、`readState()`、`updateState()`、`appendRequirement()`、`withProjectLock()` | StorageLayout/AtomicFile | lifecycle/reconciler/runtime | stable projectId 和并发边界的核心 |
| `MigrationService` | schema version、staging、backup、resume/rollback | `inspect()`、`migrateIfNeeded()`、`recoverInterrupted()` | all stores/layout/logger | startup | 迁移失败必须继续读旧布局且可重试 |
| `ProjectLifecycleService` | import/delete transaction | `importProject()`、`deleteProject()` | stores/layout/git/hook/logger | HTTP | 把 server 巨型流程和回滚统一 |
| `HookManager` | 仅 Git Hook | `install()`、`verify()`、`uninstall()`、`migrateManagedHook()`、`status()` | Git/AtomicFile | lifecycle/migration | 不再管理 CLAUDE.md 或知识分析 |
| `RequirementRecorder` | 用户需求写入与公共 schema | `record()` | ProjectStore/GitReader/logger | Claude input/MCP/tool adapters | 所有客户端采用同一归属规则 |
| `CommitScanner` | baseline、reachability、ordered commits | `scan(projectId)` | GitReader/ProjectStore | reconciler | 将 Git 语义与执行分离 |
| `RequirementBinder` | 确定性需求关联 | `bind(commitEvidence, requirements)` | ProjectStore/GitReader | analyzer/reconciler | 防止“其他会话最近一次提问”污染 |
| `CommitReconciler` | 单项目 state machine、去重、串行推进 | `reconcileProjectCommits(projectId, trigger)` | scanner/binder/analyzer/stores/logger | Hook/startup | 两个入口唯一汇合点 |
| `CommitAnalyzer` | 证据包、唯一 prompt、AI run、输出验证 | `analyzeClaim(claim)` | GitReader/AI runner/staging/logger | reconciler | 进程退出与知识成功解耦 |
| `KnowledgePromotion` | staging manifest、多文件 journaled promotion | `validate()`、`promote()`、`recover()` | AtomicFile/ProjectStore | analyzer/recovery | 多 Markdown 文件没有原生原子 rename，需要 journal |
| `IndexService` | 单一 LanceDB writer、dirty retry/rebuild | `enqueueProject()`、`flush()`、`rebuild()` | DB/indexer/ProjectStore | promotion/startup | 允许项目并行但 DB mutation 串行 |
| `Logger` | schema v2、writer queue、rotation/redaction/health | six level methods、`child()`、`flush()` | StorageLayout/AtomicFile | 全部业务模块 | 唯一正式日志实现 |
| `LogRepository` | cursor query、retention/capacity/export | `query()`、`cleanup()`、`export()` | Logger segments | API/UI/scheduler | 避免 Logger 同时承担查询与清理 |

这些模块可以按现有代码体量合并成较少文件；表中表示职责边界，不要求“一职责一个文件”。特别是 `AtomicFile` 与 locks 可放在同一基础设施文件，`RequirementBinder` 可先作为 reconciler 的纯函数模块。

### 7.4 应保留并简化的现有模块

- `_site/lib/git-runner.js`：保留 subprocess 封装，补结构化错误和 timeout/cancellation。
- Claude Code/AI vendor runner：保留模型启动与会话能力，但只接受冻结 claim，不能决定状态推进。
- `_site/lib/markdown-knowledge-indexer.js`、`knowledge-db.js`：保留解析/向量逻辑，所有 mutation 改由 IndexService 调用。
- team knowledge store：保留团队例外路径，但最终路径仍固化到 config。
- context pack、read-only query、MCP search/ask/get/history：保留，改用 ProjectStore/StorageLayout。
- 当前 Vue/单页 UI：保留技术栈，只删除重复页面和废弃按钮，不重写前端框架。

### 7.5 Commit 状态机与成功边界

```text
idle
  -> scanning
  -> claim.created
  -> requirement.bound
  -> evidence.prepared
  -> ai.running
  -> output.validated
  -> promotion.prepared
  -> markdown.promoted
  -> state.advanced(indexDirty=true)
  -> index.queued
  -> index.applied(indexDirty=false)
  -> idle / next commit
```

失败规则：

- `scanning` 前后失败：不创建 claim，不推进。
- claim 后、promotion 前失败：保留 claim 与失败阶段；下次从同一冻结证据重试，不绑定未来需求。
- promotion 中断：startup 根据 promotion journal 完成或恢复，不调用 AI。
- Markdown promoted 后、state 未推进：journal 记录目标 Commit；startup 验证 promoted hashes 后只补 state。
- state 已推进、index 失败：保持 `indexDirty=true`，不重跑 AI；IndexService 重试。
- 某 Commit 未达到 `state.advanced`：停止后续 Commit。
- 同一个 projectId 的 Hook/startup 请求进入同一个 in-flight Promise；后到请求只设置 `rescanRequested=true`。

### 7.6 目标核心 Schema

#### `projects.json`

```json
{
  "schemaVersion": 2,
  "projectOrder": ["01J..."],
  "projects": {
    "01J...": { "createdAt": "...", "displayNameSnapshot": "..." }
  }
}
```

这里只允许 index/order 与删除后显示所需的最小 snapshot；不得保存 repoPath、knowledgePath、Commit pointer 或运行状态。

#### `config.json`

```json
{
  "schemaVersion": 2,
  "projectId": "01J...",
  "displayName": "project-knowledge-base",
  "storageName": "project-knowledge-base-a1b2c3",
  "repoPath": "C:\\work\\project-knowledge-base",
  "knowledgePath": "D:\\knowledge\\project-knowledge-base-a1b2c3",
  "enabled": true,
  "createdAt": "...",
  "teamBinding": null,
  "aiProfileId": null
}
```

`projectId`、`storageName`、`createdAt` 不可变。`repoPath` 可在经过 Hook projectId/Git identity 校验后更新；`knowledgePath` 只能通过独立迁移事务更新。

#### `state.json`

```json
{
  "schemaVersion": 2,
  "trackingStartCommit": "<sha|null>",
  "lastAnalyzedCommit": "<sha|null>",
  "trackingMode": "normal",
  "analysis": {
    "status": "idle",
    "activeClaim": null,
    "lastError": null,
    "rescanRequested": false
  },
  "index": { "dirty": false, "sinceCommit": null, "lastError": null },
  "hook": { "managedVersion": 2, "migrationVersion": 2, "lastVerifiedAt": "..." },
  "updatedAt": "..."
}
```

#### `requirements.jsonl`

```json
{"schema":"requirement/v1","id":"req-...","ts":"...","projectId":"01J...","client":"codex","sessionId":"...","conversationId":"...","branch":"main","headAtRecord":"<sha|null>","requirement":"...","requirementHash":"sha256:...","explicitCommit":null}
```

不得写入系统 prompt、API Key 或完整工具调用日志。正文应有明确长度上限，超限内容拒绝或由客户端先存为受控附件引用，不能静默截断后当完整需求。

#### `activeClaim`

```json
{
  "schema":"commit-claim/v1",
  "commitSha":"...",
  "parents":["..."],
  "triggerFirstSeen":"git-hook",
  "requirementIds":["req-..."],
  "requirementBinding":"explicit|session-ancestry|unavailable",
  "promptTemplateVersion":2,
  "promptHash":"sha256:...",
  "patchHash":"sha256:...",
  "knowledgePath":"...",
  "runId":"run-...",
  "phase":"evidence.prepared",
  "attempt":1,
  "createdAt":"..."
}
```

Trigger 仅影响诊断字段，不允许改变 prompt 或任务内容。

## 8. 旧模块到新模块迁移映射

| 旧位置/职责 | 目标 | 处理方式 |
|---|---|---|
| `server.js · readProjects/writeJson` | ProjectRegistryStore + ProjectStore | 删除 direct whole-file mutation |
| `server.js · importProjectFromLocalPath` | ProjectLifecycleService | route 只调用 service；保留函数名可作薄 wrapper 后删除 |
| server 项目删除路由 | ProjectLifecycleService | 明确 Hook failure 和 external knowledge policy |
| `post-commit-automation.js · reconcileProject` | CommitReconciler.reconcileProjectCommits | 两个 public entrypoint 共用 |
| `dispatchProjectInit/renderProjectInitPrompt` | 无 | 删除，不提供兼容运行路径 |
| `commit-automation-store.js` pending/completed queue | Git range + activeClaim | 迁移未完成 claim；完成历史不继续作为第二队列 |
| `scanner.js` | CommitScanner | 加 ancestry、merge、batch continuation |
| `automation-config.js` hook/init prompts | one commitPromptTemplate | 兼容读旧 hookPromptTemplate；删除 init |
| `hook-manager.js` | HookManager v2 | triggerScriptPath、strict marker、no CLAUDE.md |
| `hook-trigger.js` plaintext error | Logger hook writer | 离线 JSONL，仍永远不阻止 Commit |
| `knowledge-store.js` | SettingsStore + ProjectLifecycle | root 只影响新 import |
| `knowledge-storage-location.js` | StorageLayout + MigrationService | 删除“设置 root 即迁移 DB”行为 |
| `kb-framework.initProjectDirs` | KnowledgePromotion/bootstrap helpers | 导入不写 TODO；知识按需创建 |
| `knowledge-scope-registry.js` project binding | config.json | global scope 迁 settings；查询不得写 |
| `structured-logger.js` | Logger + LogRepository | 迁移期读取 `.log`，新写只用 `.jsonl` |
| server `/api/logs` | LogRepository query | cursor API、recent 7 days default |
| 两套 UI log list | 单一目标组件 | 以附件下半部分为验收基准 |
| CLI/MCP/runtime path joins | StorageLayout/ProjectStore | read-only 查询不产生配置副作用 |
| `knowledge-db.js` direct writers | IndexService | DB adapter 内仍保留低层操作 |
| Claude stdin endpoint | + RequirementRecorder | 记录成功后才发送用户 input；记录失败需明确反馈 |
| MCP read-only integration | + write-only requirement tool | 不获得知识写权限，不触发分析 |

## 9. 数据迁移、备份、中断恢复与回滚

### 9.1 迁移版本

- `settingsSchemaVersion = 2`
- `projectRegistrySchemaVersion = 2`
- `projectConfigSchemaVersion = 2`
- `projectStateSchemaVersion = 2`
- `hookManagedVersion = 2`
- `logSchema = log/v2`
- 整体 layout migration id：`layout-v2`

版本号应定义在一个共享 schema 文件，由主 Agent 独占修改。

### 9.2 layout-v2 顺序

1. **只读发现**：枚举旧 data dirs、settings files、projects、DB、logs、hook marker；不写 live 数据。
2. **创建 migration journal**：写入 source paths、目标 paths、源文件 size/hash、阶段、开始版本。
3. **集中备份**：`recovery/layout-v2-<timestamp>/`；保存 manifest。不得在根目录散落 `.bak`。
4. **staging settings**：合并 knowledge root、AI profiles、embedding、logging、prompt overrides、enabled integrations。明文 API Key 原值保持不变。
5. **staging projects**：为每个旧项目沿用现有 projectId；没有时生成并写入 map。把 `kbPath` 原样迁为 `knowledgePath`；只有缺失时才用旧 root+slug 计算一次。
6. **staging state**：保留 `trackingStartCommit`、`lastAnalyzedCommit`；未设置两者的项目只建立 baseline，不做 init。
7. **迁移 requirement/claim**：旧版没有需求记录；未完成 automation run 若证据不足，保留诊断并回到可安全重扫的 Commit，不伪造需求。
8. **迁移 index**：从已知旧位置复制到 staging；可打开、表/schema 与记录数验证。失败时继续使用旧 index path，不能切换一半。
9. **迁移 logs**：旧 `.log` 与 `.hook-trigger-errors.log` 保持原文件；建立读取兼容索引或复制到归档，不删除源。
10. **生成 staging registry**：只列 projectId。
11. **完整验证**：每个 registry id 都有合法 config/state；所有 knowledgePath 保持；settings secrets hash 一致；DB 可打开；源资产仍存在。
12. **原子激活**：依次将 staged files rename 到 final；写 final completion marker 必须是最后一步。
13. **启动验证**：以新 stores 打开所有项目；失败立即切回旧 reader，不清理旧文件。
14. **延迟清理**：至少一次成功启动和用户可见验证后才允许按版本策略删除可重建 cache；用户知识、旧 logs、backup 不自动删除。

### 9.3 中断恢复矩阵

| 中断阶段 | 下次启动行为 | 禁止行为 |
|---|---|---|
| discovery/staging | 删除或复用可验证 staging，重新开始 | 把 staging 当 live |
| backup 部分完成 | 从 journal 继续，校验已复制 hash | 覆盖唯一源文件 |
| final rename 部分完成 | 根据 activation manifest 完成或回滚到 backup | 仅凭 `projects.json` 存在跳过 |
| completion marker 已写但验证失败 | 标记 migration failed、切旧 reader、保留新目录供诊断 | 静默默认空配置 |
| Hook migration 中断 | 每个项目按 strict marker 独立重试 | 更新第三方 Hook |
| promotion journal 中断 | 验证 staged/final hash 后完成或恢复 | 重新调用 AI 生成另一份结果 |
| index migration/indexing 中断 | Markdown 仍可用，index dirty 后重建 | 回滚真实 Markdown |

### 9.4 导入回滚资产规则

Transaction journal 必须记录每个动作是否由本事务创建：metadata dir、knowledge dir、Hook、Git init、registry id。回滚只能删除：

- 本事务新建；
- 尚未被其他进程修改；
- hash/empty 状态与 journal 一致；
- 明确不是导入前已存在用户目录。

若不能证明，保留资产并把路径写入结构化 rollback warning，不能“为了干净”递归删除。

## 10. 产品要求、源码现状和推荐实现差异

| 领域 | 产品要求 | 当前源码 | 推荐实现 |
|---|---|---|---|
| 分析入口 | Hook + startup | 5 个入口 | 只导出 `handlePostCommitEvent`、`dispatchPendingAutomations`；都进 reconciler |
| 导入 | baseline + Hook，无分析 | 写 TODO、init AI | transaction，不要求 AI profile，不生成知识 |
| Commit 证据 | requirement + real Diff | subject/name/stat | frozen requirement IDs + actual patch + existing relevant knowledge |
| Hook | lifecycle 自动、冲突安全 | 错路径、旧 path、CLAUDE.md | strict v2 managed Hook + runtime root + projectId |
| 项目身份 | stable projectId | slug/path | projectId 作为 lock/store/log/API 主键 |
| 并发 | 项目并行，单项目串行 | startup 串行、registry race | per-project in-flight dedupe + DB single writer |
| 状态 | per-project atomic | projects.json + second queue | state.json + activeClaim + Git range |
| knowledge root | 只保存真实知识 | DB/内部目录混入 | 仅项目 Markdown；StorageLayout 管内部数据 |
| index | 单一内部派生 | 三套 path，先推进后索引 | internal path + dirty state + IndexService |
| migration | all-or-nothing | existence marker | staged versioned migration + fallback reader |
| logs | v2 长期诊断 | v1 原型 | six levels、chain、rotation、cursor、redaction、health |
| UI | 一套目标页面 | 两套日志 UI | 删除对比上半部/旧列表，只实现目标形态 |
| secrets | 可明文落盘，不得泄露 | GET 原样 + wildcard CORS | public view masking + origin/auth + redaction |
| AI integrations | 记录需求，不触发分析 | 没有记录能力 | embedded capture + write-only metadata tool |

## 11. 真正阻塞实施的问题

### 11.1 当前没有产品级阻塞项

按已确认产品决策，可以采用上述最简单可靠方案直接实施，不需要用户再次选择架构路线。

### 11.2 环境阻塞，但不阻塞编写/开始实现

- 当前审查容器无法安装 npm dependencies，因此完整基线未跑完。Codex 实施环境必须先 `npm ci` 并记录真实完整基线。
- Windows Hook、worktree、packaged LanceDB、桌面安装升级需要 Windows runner 或真实 Windows 环境；Linux/macOS 单元测试不能替代。
- `.git.rar` 不包含原工作目录文件状态，因此实施开始时必须重新检查实际 checkout 的 dirty/untracked 状态。

### 11.3 需要在实现中显式接受的能力边界

产品决定 Hook 离线时不保存任务，因此 startup 只能恢复当前分支 HEAD 可达、baseline 之后的 Commit。若用户在服务离线期间提交后又 rebase/drop，已不可达 Commit 不可能从当前 Git 图恢复。实现应记录 divergence/边界，而不能宣称“所有曾存在的 Commit”均可找回。

## 12. 横向遗留清单（不应借本轮无限扩域）

以下项可以在本轮触达时修复，但不是“已确认必须重写整个产品”的理由：

- `server.js` 和 `ui/index.html` 体量过大；本轮只抽离与生命周期、存储、日志、reconciler 相关职责，不做无关页面全面重写。
- release workflow 当前无该 SHA 的运行记录；应补分支保护/required checks 属于发布治理，可单独跟进。
- dangling Git objects 是上传 Git 历史中的不可达对象，不是当前可达仓库损坏；不应在源码改造中清理用户 Git 对象。
- 现有 Claude/Codex/OpenCode integration installer 的全部 UX 不需重做；只增加 requirement record capability 并删除 Hook/CLAUDE.md 耦合。
- 向量模型质量、召回算法和产品运行时 Token 优化不在本轮范围。

## 13. 最终结论

原 Plan 的产品决策正确且必要，但技术实施必须先补齐事实源、状态机、迁移激活、Hook identity、需求绑定、知识 promotion、索引 dirty 和 API 安全边界。按原任务编号直接大改 `server.js` 会把当前多个隐式状态耦合一起打碎，风险不可接受。

推荐按 `CODEX_IMPLEMENTATION_PLAN.md` 的依赖顺序实施：先特征测试与共享契约，再完成 StorageLayout/AtomicFile/Stores/Migration/Logger 基础，随后实现 Hook 生命周期、RequirementRecorder、统一 CommitReconciler 和 KnowledgePromotion/IndexService，最后由主 Agent 集成 server、CLI/MCP 和唯一日志 UI，并执行完整迁移、Windows 与端到端验证。

该方案不改变已经确认的产品行为，不引入新的运行时 Token 功能，也不引入额外数据库或微服务；它只把当前隐式、重复、不可恢复的状态变成可测试的明确契约。
