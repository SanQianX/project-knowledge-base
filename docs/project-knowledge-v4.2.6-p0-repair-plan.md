# Project Knowledge Base v4.2.6 P0 修复执行计划包

> Repository: `SanQianX/project-knowledge-base`  
> Baseline: Git tag `v4.2.6`  
> Purpose: 供 Codex 在本地仓库中机械执行  
> Scope:  
> **P0-A — 删除 `startup -> Knowledge Analysis` 及隐含 Git History Catch-up**  
> **P0-B — 调查并修复升级后 Projects / AI Profiles / 模型配置 / Knowledge Root 全部消失的问题**  
> **P0-C — 完整单元、集成、E2E、升级与 Windows Desktop 回归测试**
>
> 本计划是实现计划，不是建议清单。除“明确标记为待调查分支”的步骤外，Codex 应按顺序执行、逐阶段验证、逐 Commit 提交。

---

# 0. 最终目标

本轮完成后，系统必须符合两个核心 Contract。

## Contract A — Knowledge Analysis 只有一个业务触发入口

```text
AI Coding
   |
   +--> Conversation -> AI Coding Event Bridge
   |
   +--> Git Commit
             |
             v
       post-commit Hook
             |
             | explicit commitSha
             v
       Commit Event Processor
             |
             +--> Conversation Snapshot
             +--> Exact Git Evidence
             +--> Existing Knowledge
             |
             v
       Knowledge Analysis
             |
             v
       Markdown Knowledge
             |
             v
       Derived Index
```

禁止：

```text
Application Startup
    -> scan Git history
    -> detect pending commits
    -> catch up missed commits
    -> Knowledge Analysis
```

## Contract B — Upgrade / Migration 永远不能把用户数据静默变成 Fresh Install

当旧数据存在但迁移无法确定或失败时：

```text
Legacy User Data Exists
        +
Migration Failed / Ambiguous
        |
        v
STARTUP FAILS CLOSED
        |
        v
明确错误 + Recovery 信息
```

禁止：

```text
Migration Failed
        |
        v
SettingsStore.initialize(default)
ProjectRegistryStore.initialize(empty)
        |
        v
UI 看起来像全新安装
```

---

# 1. 本轮明确不做的事情

不要借本轮 P0 顺手重构整个项目。

本轮不做：

- 不重写 `ai-coding-event-bridge` 内部实现。
- 不改变 Markdown = Source of Truth 的架构。
- 不重写 LanceDB / Embedding 算法。
- 不改 Workbench UI 业务功能。
- 不改 MCP Query 语义，除非测试受 P0 修复直接影响。
- 不大规模重命名 `CommitReconciler`；行为稳定后再考虑。
- 不自动删除用户旧数据。
- 不自动覆盖两个都非空的数据源。
- 不把诊断输出中的 API Key / Token / Secret 写入日志或报告。
- 不 Push，不创建 PR，除非用户另行明确要求。
- 不用 `git reset --hard`、`git clean -fd` 等破坏性操作。
- 不修改与 P0 无关的本地未提交修改。

---

# 2. Codex 开始执行前的仓库保护

Codex 第一个动作必须检查：

```bash
git status --short
git branch --show-current
git describe --tags --always --dirty
git rev-parse v4.2.6
git rev-parse HEAD
```

要求：

1. 记录当前 HEAD。
2. 确认 `v4.2.6` tag 可解析。
3. 阅读本计划列出的关键源码。
4. 如果 worktree 有用户未提交修改：
   - 不覆盖；
   - 不 reset；
   - 在最终报告列出；
   - 修改文件发生冲突时优先保留用户修改。
5. 推荐在现有安全分支工作；如果当前是默认分支且用户未建分支，可创建：
   `fix/p0-startup-analysis-and-data-migration`
6. 每一阶段独立 Commit。
7. 每个 Commit 前运行该阶段目标测试。
8. 最后运行全量回归。

---

# 3. v4.2.6 已确认的源码事实

Codex 不需要重新猜这些事实，但应在本地源码中再验证一次。

## 3.1 Startup 仍然是 Knowledge Analysis Trigger

`_site/lib/contracts.js`：

```js
const TRIGGERS = Object.freeze(['git-hook', 'startup']);
```

目标：

```js
const TRIGGERS = Object.freeze(['git-hook']);
```

---

## 3.2 Server Startup 当前会执行 Knowledge Reconciliation

`_site/lib/server-app.js` 当前 Startup 在 Bridge startup drain 后遍历 Project：

```text
BridgeConsumer.start()
    |
    v
for each project
    |
    v
reconcileProjectCommits(projectId, "startup")
```

这条业务链必须删除。

---

## 3.3 仅删除 Startup Reconcile 仍然不够

当前：

`_site/lib/commit-reconciler.js`
+
`_site/lib/scanner.js`

会：

```text
baseline =
    lastAnalyzedCommit
    ||
    trackingStartCommit

git rev-list baseline..HEAD
```

所以即使 Startup 不分析：

```text
A = last analyzed

Backend Offline:
B
C

Backend Online:
D -> Hook D

current scanner:
A..D
= B C D
```

仍然会补分析 B/C。

所以本轮必须同时：

> 把 Knowledge Analysis 从 **Repository State / History Driven** 改成 **Explicit Commit Event Driven**。

---

## 3.4 Hook 已经携带需要的 explicit commitSha

`_site/scripts/hook-trigger.js` 已产生：

```js
{
    schema: 'hook-event/v2',
    projectId,
    repoRoot,
    head: git(['rev-parse', 'HEAD']),
    branch: ...
}
```

所以 Knowledge Base 不需要重新扫描 Git 历史来决定“该分析谁”。

---

## 3.5 Hook Offline 日志仍依赖旧 startup contract

当前：

```text
Knowledge service is unavailable;
startup reconciliation will catch up.
```

这是错误的新架构语义。

修复后必须改成类似：

```text
Knowledge service is unavailable;
this commit was not submitted for knowledge analysis.
```

注意：

- Hook 仍保持 exit 0；
- 不阻塞用户 Git Commit；
- Bridge Boundary 若能写成功仍可写；
- 但不承诺将来补分析。

---

# 4. 数据事故：已确认的源码风险

当前实际用户现象：

```text
Projects         全部消失
AI Profiles      全部消失
AI / 模型配置     全部消失
Knowledge Root   全部消失

v4.2.6 看起来像 Fresh Install
```

这比“Project Registry 单独坏了”更像：

> **整套旧 runtime data 没有被正确读取 / 迁移，或者 Migration 失败后系统继续初始化了 defaults。**

以下是当前源码中的高价值风险点。

---

# 5. Risk R1 — `hasMigrated()` 判断过弱

`_site/lib/data-dir.js`：

```js
function hasMigrated() {
  return fs.existsSync(path.join(getDataDir(), 'projects.json'));
}
```

然后：

```js
if (hasMigrated()) {
    return {
        ok: true,
        migrated: false,
        reason: 'already migrated'
    };
}
```

这意味着：

```text
target/projects.json 存在
```

被错误当成：

```text
整个用户 runtime data 都已经迁移成功
```

但用户资产并不只有 `projects.json`：

```text
projects
AI profiles
Knowledge Root
embedding config
model cache
integrations
prompts
logs
...
```

这是本轮必须修的设计错误。

---

# 6. Risk R2 — 第一层 Legacy Relocation 的资产清单不完整

`data-dir.js` 当前第一层只列出：

```text
projects.json
ai-profiles.json
knowledge-store.json
logging.json
.jobs-log.json
claude-prompts.json
.hook-trigger-errors.log

projects/
logs/
_site/_ai/
```

但 Layout-v2 Migration 自己还认识：

```text
embedding-config.json
github-team.json
team-git-providers.json
knowledge-scopes.json
...
```

所以存在：

```text
旧 package root 有 embedding-config.json
        |
第一层 relocation 没复制
        |
第二层 migration 根本看不见
```

的问题。

必须建立唯一 Legacy Asset Manifest，避免两套名单继续漂移。

---

# 7. Risk R3 — Migration Completion Marker 信任过度

`MigrationService.migrateIfNeeded()` 当前：

```text
如果 completion marker 存在
    -> 直接 return completed
```

另外：

```text
如果 projects.json 已经是 v2
+
settings.json 存在
    -> validate schema
    -> 直接写 completion marker
```

风险：

```text
empty v2 registry
+
default settings
```

也是合法 schema。

因此一次错误的空迁移可能被永久锁定为：

```text
migration completed
```

需要增加内容级 invariant 验证和 provenance。

---

# 8. Risk R4 — Migration 失败后 Startup 仍可能继续初始化空 Store

这是本轮最高优先级之一。

`MigrationService.migrateIfNeeded()` 失败时会：

```js
return {
    ok: false,
    migrated: false,
    completed: false,
    ...
}
```

而 `initializeRuntime()` 当前：

```js
const migration = await runtime.migrationService.migrateIfNeeded();

await runtime.settingsStore.initialize();
await runtime.registryStore.initialize();
```

没有：

```js
if (!migration.ok) throw ...
```

因此存在：

```text
Migration 失败
      |
      v
仍然初始化 Settings
      |
      v
仍然初始化 Registry
      |
      v
默认空系统
```

的可能。

必须修改为：

```js
const migration = await migrationService.migrateIfNeeded();

if (!migration.ok) {
    throw MIGRATION_FAILED;
}

只有之后才允许 initialize stores。
```

---

# 9. Risk R5 — v4.1.22 与 v4.2.6 模型缓存目录发生变化

已确认：

v4.1.22：

```text
<dataDir>/models
```

v4.2.6：

```text
<dataDir>/cache/models
```

当前必须检查是否存在自动迁移。

如果没有：

```text
旧模型仍在 models/
```

但新版只查：

```text
cache/models/
```

用户就会认为“模型丢了”。

本轮必须支持：

```text
models/
  ->
cache/models/
```

的安全迁移或兼容读取策略。

优先选择：

> **Migration 一次性搬迁 / copy + verify。**

不要长期保留双路径业务读取。

---

# 10. P0-B Phase 0 — 本机事故只读调查

**此阶段禁止修改用户 Runtime Data。**

Codex 应先调查真实机器，而不是直接套用猜想。

---

## 10.1 必须收集的 Runtime 信息

输出一个红acted report，例如：

```text
artifacts/p0-data-incident-report.json
```

报告可以写到源码工作区或临时目录。

必须记录：

```text
packageVersion
gitHead
process.execPath
process.cwd
os.homedir
USERPROFILE
HOME

KB_DATA_DIR       // 仅值本身不是 secret
KB_SKIP_MIGRATION
KB_RUNTIME_MODE

effectiveDataDir

desktopCoreRoot
desktopExecutable
```

不得调用可能为了“探测”而新建候选数据目录的逻辑。

如果需要纯读取路径：

- 直接根据环境变量和 `os.homedir()` 计算；
- 或先重构出 pure `resolveDataDirPath()`，但 Phase 0 本身不能写用户目录。

---

## 10.2 必须扫描的候选位置

至少检查：

```text
1. 当前 effective KB_DATA_DIR

2. %USERPROFILE%/.project-knowledge

3. 当前 development checkout / package root

4. 当前 npm global package root

5. 当前 Electron bundled core package root

6. 旧版本 Electron / Squirrel 安装目录

7. 旧 npm global package version directory（若存在）

8. recovery/*/backup

9. 用户机器上能从旧配置、日志、快捷方式、安装目录推导出的历史 KB_DATA_DIR
```

不要对整个磁盘做无界全文扫描。

只扫描合理的已知/推导位置。

---

## 10.3 每个 Candidate 只读采集

对于每一个候选目录，只记录：

```text
path
exists
mtime
totalApproxBytes

projects.json:
    exists
    schema
    projectCount
    hash

settings.json:
    exists
    schema
    knowledgeRootPresent
    aiProfileCount
    embeddingConfigured
    hash

ai-profiles.json:
    exists
    profileCount
    hasAnyApiKey
    hash

knowledge-store.json:
    exists
    rootPath
    hash

embedding-config.json:
    exists
    modelId
    localModelPathPresent
    hash

models/:
    exists
    fileCount
    totalBytes

cache/models/:
    exists
    fileCount
    totalBytes

runtime/layout-v2.completed.json:
    exists
    projectCount
    runId
    completedAt

recovery:
    runs
    journal phases
    backup assets
```

Secret 处理：

```text
apiKey:
    永远不输出原文

只输出:
    hasApiKey: true/false
```

---

# 11. P0-B Root Cause Guess Matrix

Codex 应逐条验证以下假设，并给出：

```text
CONFIRMED
REJECTED
POSSIBLE
```

以及证据。

---

## H1 — v4.2.6 使用了新的 / 错误 Data Directory

判断：

```text
当前 effectiveDataDir:
    empty v2/default settings

另一个候选目录:
    old projects
    old AI profiles
    old knowledge root
```

则 H1 高概率成立。

---

## H2 — target 先存在空 `projects.json`，导致第一层 relocation 被错误跳过

判断：

```text
current projects.json:
    created recently
    empty / v2 empty

legacy source:
    old non-empty projects.json
    ai-profiles.json
    knowledge-store.json
```

且：

```text
data-dir.hasMigrated()
    仅因为 target/projects.json exists
```

则 H2 成立。

---

## H3 — layout-v2 曾经完成一次 projectCount=0 的错误迁移

判断：

```text
runtime/layout-v2.completed.json:
    projectCount = 0

recovery or old source:
    projects > 0
```

则 H3 成立。

---

## H4 — 空 v2 + default settings 被 completion shortcut 锁死

判断：

```text
projects.json:
    project-registry/v2
    projectOrder = []

settings.json:
    settings/v2
    knowledge.rootPath = ""
    ai.profiles = []

completion marker:
    exists
```

而其它源有旧数据。

则 H4 成立。

---

## H5 — 第一层 relocation 漏掉 embedding / integrations / model assets

判断旧 package root 是否存在：

```text
embedding-config.json
github-team.json
team-git-providers.json
knowledge-scopes.json
models/
```

但 target 没有。

若存在，则 H5 成立。

---

## H6 — 旧模型仍在 `<dataDir>/models`

如果：

```text
models/       non-empty
cache/models/ empty
```

则 H6 成立。

---

## H7 — 数据留在旧安装目录

如果当前 data dir 与旧 package root 都为空，但：

```text
old version app/package root
```

仍有完整旧配置，则 H7 成立。

---

## H8 — 环境变量改变了 Data Directory / 跳过 Migration

检查：

```text
KB_DATA_DIR
KB_SKIP_MIGRATION
```

特别是：

```text
KB_SKIP_MIGRATION=1
```

---

## H9 — Migration 真实失败，但 initializeRuntime 继续初始化 defaults

检查：

```text
recovery/<run>/journal.json
    phase = failed

settings.json / projects.json
    createdAt / mtime 在 failure 后

server logs
    migration.failed
```

如果成立，这是非常关键的 Root Cause。

---

# 12. Phase 0 完成条件

Codex 在进入代码修复之前，必须输出：

```text
Data Incident Root Cause Summary

Confirmed:
- H?

Likely:
- H?

Rejected:
- H?

Old data found:
YES / PARTIAL / NO

Recommended recovery source:
<path or none>

Current data directory:
<path>

Potential destructive conflicts:
<none / description>
```

如果本机无法找到用户真实旧数据：

> 仍然继续修代码层的 Migration Safety，但不能伪造用户数据恢复结果。

---

# 13. P0-B Phase 1 — 建立统一 Legacy Data Manifest

建议新增：

```text
_site/lib/legacy-data-manifest.js
```

目标：

> 所有 Legacy Runtime Asset 只在一个地方定义。

例如概念：

```js
const LEGACY_ASSETS = [
    { source: 'projects.json', kind: 'file', target: 'projects.json', authority: 'user' },
    { source: 'ai-profiles.json', kind: 'file', target: 'legacy/ai-profiles.json', authority: 'user' },
    { source: 'knowledge-store.json', kind: 'file', target: 'legacy/knowledge-store.json', authority: 'user' },
    { source: 'embedding-config.json', kind: 'file', target: 'legacy/embedding-config.json', authority: 'user' },

    ...

    { source: 'models', kind: 'dir', target: 'cache/models', authority: 'cache-but-expensive' },

    ...
];
```

具体 target 不强制照示例。

要求：

1. `data-dir.js` 和 `migration-service.js` 不再维护两份不同名单。
2. Manifest 至少覆盖 v4.1.22 实际使用资产。
3. 区分：
   - authoritative user config；
   - expensive cache；
   - derived/rebuildable data；
   - logs/history。
4. Index 可重建；AI/Profile/Knowledge Root/Project Config 不可猜。

---

# 14. Phase 2 — 重构 Data Directory Resolution

当前 `getDataDir()` 同时：

```text
resolve path
+
mkdir
```

建议拆为：

```text
resolveDataDirPath()
    -> pure, no filesystem mutation

ensureDataDir()
    -> mkdir if needed

getDataDir()
    -> compatibility wrapper if needed
```

目的：

- Diagnostic 可以纯读取；
- Startup 可以先判断 Fresh / Legacy / Conflict；
- 避免“探测一个路径”本身就创建空目录，干扰 migration 判断。

测试必须覆盖：

```text
resolve does not mkdir
ensure creates
KB_DATA_DIR precedence
default homedir path
Windows path normalization
```

---

# 15. Phase 3 — 删除 `hasMigrated() = projects.json exists` 全局短路

不要再用：

```text
projects.json exists
=> runtime relocation completed
```

改成基于资产 / manifest 的迁移决策。

最低要求：

```text
source asset exists
+
target asset missing
    -> eligible for relocation

source asset missing
    -> skip asset

source + target both exist
    -> compare/classify
    -> do not blindly overwrite
```

对于 authoritative config：

```text
source non-empty
+
target non-empty
+
not identical
    -> conflict
```

对于 derived cache：

可以采用可验证 merge/copy，但不要覆盖未知内容。

---

# 16. Phase 4 — Data State Classifier

建议增加：

```text
_site/lib/data-state-classifier.js
```

或等价职责。

至少分类：

```text
FRESH
LEGACY
V2_VALID
MIGRATION_INCOMPLETE
CONFLICT
CORRUPT
```

### FRESH 必须非常严格

只有：

```text
没有 v2 user data
没有 legacy projects
没有 legacy AI profiles
没有 legacy knowledge root
没有 migration recovery indicating prior data
```

才允许 Fresh。

---

# 17. Phase 5 — Migration Completion Marker 升级

当前：

```text
layout-migration-completion/v1
```

内容太少。

建议升级为 v2 或在现有 marker 上增加强验证字段：

```json
{
  "schema": "layout-migration-completion/v2",
  "migrationId": "layout-v2",
  "runId": "...",
  "sourceRoot": "...",
  "sourceManifestHash": "...",
  "projectCount": 5,
  "aiProfileCount": 3,
  "knowledgeRootConfigured": true,
  "embeddingConfigured": true,
  "modelsMigrated": true,
  "completedAt": "...",
  "verified": true
}
```

旧 v1 marker 处理：

```text
read
↓
do not blindly trust
↓
validate actual v2 store
↓
validate no contradictory legacy evidence
↓
upgrade marker or fail closed
```

---

# 18. Phase 6 — `initializeRuntime()` 必须 Fail Closed

这是必改项。

当前：

```js
const migration = await migrateIfNeeded();
await settingsStore.initialize();
await registryStore.initialize();
```

目标：

```js
const migration = await migrateIfNeeded();

if (!migration.ok) {
    throw new DomainError(
        'MIGRATION_FAILED',
        ...
    );
}

if (migration.requiresManualRecovery) {
    throw ...
}

await settingsStore.initialize(...);
await registryStore.initialize(...);
```

另外：

Fresh Install 才允许：

```text
initialize default settings
initialize empty registry
```

如果 classifier = LEGACY：

```text
必须先成功 migrate
```

如果 classifier = CONFLICT/CORRUPT：

```text
启动失败
```

---

# 19. Phase 7 — Model Cache Migration

已确认：

```text
v4.1.22:
<dataDir>/models

v4.2.6:
<dataDir>/cache/models
```

目标：

```text
old models/
    |
    +-- backup/verify
    |
    v
cache/models/
```

规则：

1. target 不存在：
   - copy to staging；
   - count files + total bytes；
   - activate；
   - 验证。
2. source/target 都有：
   - 不整体覆盖；
   - 若完全等价，可标记完成；
   - 不等价则保留 target，记录 conflict 或安全 merge strategy。
3. 不删除 source，直到整个 migration 成功。
4. Migration 完成后可以选择保留旧 source 作为 recovery，后续清理由独立版本处理。
5. 本轮不要求节省磁盘而冒数据风险。

---

# 20. Phase 8 — 本机用户数据恢复

这一阶段只在 Phase 0 找到可信旧数据后执行。

顺序：

```text
1. 停止 Project Knowledge / Desktop backend
2. 备份 current effective dataDir
3. 备份 selected legacy source
4. 运行 migration dry-run / staging
5. 输出 validation report
6. 确认 project count
7. 确认 AI profile count
8. 确认 Knowledge Root
9. 确认 embedding config
10. 确认 model cache
11. 原子 activate
12. 启动 backend
13. 调 /api/state
14. 调 /api/ai-profiles
15. 检查 Project config/state
16. 检查 Knowledge Markdown 路径存在
17. 检查 MCP resolve/search
```

API Key 验证只允许：

```text
hasApiKey = true
```

禁止打印实际 secret。

---

# 21. P0-A Phase 1 — 删除 Startup Analysis Trigger

修改：

```text
_site/lib/contracts.js
```

从：

```js
['git-hook', 'startup']
```

到：

```js
['git-hook']
```

同步：

```text
validateTrigger()
错误信息
shared contract tests
README / docs
```

要求：

```text
startup
```

仍可作为日志/Bridge drain reason，不代表 Analysis Trigger。

---

# 22. P0-A Phase 2 — 删除 Server Startup Reconciliation

修改：

```text
_site/lib/server-app.js
```

保留：

```text
BridgeConsumer.start()
IndexService.retryDirtyProjects()
Promotion recovery
Hook migration / repair
Storage migration
```

删除：

```text
for project:
    reconcileProjectCommits(projectId, 'startup')
```

删除/重命名：

```text
reconcile.startup_failed
```

如果只剩 Index / Bridge recovery，应使用各自日志事件，不要保留假概念。

---

# 23. P0-A Phase 3 — 删除 Startup Pending Dispatcher

修改：

```text
_site/lib/post-commit-automation.js
```

删除：

```text
dispatchPendingAutomations()
```

如果：

```text
getQueueSize
drainQueue
listAutomationRuns
```

只为旧架构 compatibility 存在，先搜索所有调用者。

无真实调用者：

```text
删除
```

有 UI / test caller：

```text
修改 caller
```

不要保留“永远返回空”的无意义接口，只为了旧测试过。

---

# 24. P0-A Phase 4 — 修改 Hook Offline 语义

修改：

```text
_site/scripts/hook-trigger.js
```

当前：

```text
startup reconciliation will catch up
```

删除。

新日志：

```text
Knowledge service is unavailable;
the current commit was not submitted for knowledge analysis.
```

或等价。

要求：

- Hook exit code 仍为 0。
- 不阻塞 Git。
- 不 retry 到 startup。
- 不写 pending queue。
- 不新增补偿文件。

---

# 25. P0-A Phase 5 — Explicit Commit Event Processor

这是本轮最大代码改动。

不要再：

```text
Hook
 -> reconcile repository
 -> scanner decides commits
```

改成：

```text
Hook(event.head)
 -> validate explicit commit
 -> process exactly event.head
```

建议 API：

```js
commitReconciler.processCommitEvent({
    projectId,
    commitSha: event.head,
    branch: event.branch,
    operationId,
    boundary: event.boundary
})
```

或者保持 class method 参数风格。

关键不是名字，关键是：

> **不能扫描 baseline..HEAD 决定本次处理集合。**

---

# 26. Explicit Commit Validation

对 `event.head`：

1. 必须是完整 Commit SHA。
2. `git cat-file -e <sha>^{commit}` 成功。
3. Project repo identity 校验通过。
4. 不要求：
   ```text
   event.head == current HEAD
   ```
   因为快速连续 Commit 时：
   ```text
   Hook D 到达处理时，HEAD 可能已经是 E。
   ```
5. Git Evidence 必须严格针对：
   ```text
   event.head
   ```
6. Branch 优先使用 Hook 捕获的 branch snapshot，不用处理时的 current branch 推翻事件事实。

---

# 27. Scanner 的新定位

保留：

```text
TrustedGitReader
collectEvidence(commitSha)
verifyEvidence()
```

Knowledge Analysis 主路径不再使用：

```text
listCommits(baseline, head)
scan pending commits
```

是否彻底删除 `CommitScanner.scan()`：

Codex 必须先搜索调用方。

如果还有：

```text
UI diagnostics
Git status
tests
```

需要它：

```text
保留为 read-only diagnostic API
```

但禁止 Commit Analysis 依赖它决定处理列表。

---

# 28. `lastAnalyzedCommit` 语义修改

事件驱动允许：

```text
A analyzed
B missed
C missed
D analyzed
```

此时：

```text
lastAnalyzedCommit = D
```

只能表示：

> 最近一次成功完成 Analysis 的 Commit。

绝不表示：

> A..D 全部分析完成。

所有代码中：

```text
lastAnalyzedCommit
```

如果被用作“coverage watermark”，必须修改。

`trackingStartCommit` 同理：

- 可保留 migration / legacy compatibility；
- 不再作为 Analysis Catch-up 起点。

---

# 29. Exactly-Once / Idempotency

旧架构靠线性 `lastAnalyzedCommit` 辅助去重已经不够。

必须提供：

```text
projectId + commitSha
```

级别幂等。

建议新增：

```text
_site/lib/commit-processing-ledger.js
```

数据：

```text
<dataDir>/runtime/processed-commits/<projectId>/<commitSha>.json
```

建议状态：

```json
{
  "schema": "commit-processing-record/v1",
  "projectId": "...",
  "commitSha": "...",
  "status": "completed",
  "claimFingerprint": "...",
  "completedAt": "..."
}
```

规则：

```text
completed:
    duplicate Hook -> return already-completed

processing:
    same-process duplicate -> join same Promise

failed:
    later explicit Hook -> retry allowed
```

注意：

现有 Commit Claim / Promotion Journal 已有 crash recovery 价值。

不要重复造一个复杂状态机。

Ledger 只承担：

> “这个明确 commit 是否已经完成”的幂等事实。

---

# 30. Per-Project Explicit Queue

当前 `inFlightProjects + rescanRequested` 的模型：

```text
第二个事件到达
    -> rescanRequested = true
    -> 之后重新扫描 Git
```

与新架构不兼容。

必须改成：

```text
Project P:
queue = [commit D, commit E]
```

需求：

```text
同项目:
    串行

不同项目:
    可以并行

相同 project + same SHA:
    join / dedupe

相同 project + different SHA:
    保留两个 explicit events
```

不要让 E 变成一句：

```text
rescan later
```

---

# 31. Offline Conversation Boundary 必须一起修正确性

删除 History Catch-up 后，必须避免：

```text
离线 B/C 的 Conversation
```

污染：

```text
在线 D
```

当前 Bridge Consumer 只处理：

```text
ai-coding-event/v1
```

而：

```text
git-commit-boundary/v1
```

会被当成 skipped transport。

建议本轮修改：

```text
BridgeConsumerService
```

使其也投影 Commit Boundary：

```text
Bridge Journal
    |
    +--> ai-coding-event/v1
    |       -> ConversationStore.appendBridgeEvent()
    |
    +--> git-commit-boundary/v1
            -> ConversationStore.writeBoundary()
```

这样：

```text
Backend Offline

Prompt B
Boundary B

Prompt C
Boundary C

Backend Online
    |
Bridge startup drain
    |
    +--> Conversation B/C
    +--> Boundary B/C
```

**但不触发 Knowledge Analysis。**

然后：

```text
Prompt D
Boundary D
Hook D
```

Binder 能看到：

```text
Previous Boundary = C
Current Boundary  = D
```

因此只绑定：

```text
(C, D]
```

而不是：

```text
(A, D]
```

这不是 Startup Analysis。

这是：

> **Development Conversation 事实同步 / 边界完整性。**

---

# 32. Boundary 写入必须幂等

因为当前 Hook 路径：

```text
append boundary to Bridge
↓
drainThrough(boundary sequence)
↓
handlePostCommitEvent currently writeBoundary again
```

如果 Bridge Consumer 也开始写 boundary：

必须调整。

推荐：

```text
ConversationStore.writeBoundary()
```

支持：

```text
same commitSha
+
same sequence / same content
    -> idempotent success

same commitSha
+
conflicting content
    -> DATA_CORRUPT / conflict
```

然后 Hook：

```text
drainThrough()
↓
verify boundary exists
```

不再无条件重复写。

如果为了兼容暂时仍调用 `writeBoundary()`：

也必须靠 idempotency 安全。

---

# 33. 不允许的 Offline 设计

本轮明确不要创建：

```text
pending-commits.json
offline-analysis-queue.json
startup-missed-commit-scan
retry-on-startup
manual missed commit warning
```

因为这会重新把被删除的架构绕回来。

---

# 34. 代码修改建议分 Commit

建议 Codex 按以下 Commit 顺序执行。

---

## Commit 1 — `test: add P0 data-loss characterization`

只增加失败测试 / fixtures / diagnostic helper。

不改生产行为。

新增/扩展测试应先证明：

```text
empty target projects.json
+
non-empty legacy source
```

当前会错误 skip。

证明：

```text
migration ok:false
```

当前 startup 仍可能初始化 defaults。

证明：

```text
v4.1.22 models/
```

当前不会进入 v4.2.6 cache/models。

Commit message 建议：

```text
test: characterize v4.2.6 data migration regressions
```

---

## Commit 2 — `fix: harden runtime data migration`

实现：

```text
统一 Legacy Asset Manifest
pure data-dir resolve
data-state classification
删除 hasMigrated global short circuit
fail-closed migration
completion marker validation
model cache migration
```

不碰 Startup Commit Analysis。

Commit message：

```text
fix: make runtime migration fail closed and preserve legacy data
```

---

## Commit 3 — `test/fix: recover v4.1.22 upgrade contract`

完善：

```text
legacy-project-upgrade-e2e
project-layout-v2-migration
data-dir-migration
desktop/package data tests
```

确保：

```text
Projects
AI Profile
API key presence
Knowledge Root
Embedding config
Model cache
```

全部保留。

Commit message：

```text
test: lock v4.1.22 upgrade data compatibility
```

如果生产修复和测试应合并到 Commit 2，也可以，但不能跳过测试。

---

## Commit 4 — `refactor: remove startup knowledge analysis`

实现：

```text
TRIGGERS only git-hook
server startup no reconcile
remove dispatchPendingAutomations
hook offline log
rewrite/remove old startup tests
```

此 Commit 先只删除显式 startup analysis。

Commit message：

```text
refactor: make post-commit the only knowledge analysis trigger
```

---

## Commit 5 — `refactor: process explicit hook commits only`

实现：

```text
event.head -> exact commit processor
remove history catch-up from analysis path
commit ledger
per-project explicit queue
lastAnalyzedCommit semantics
```

Commit message：

```text
refactor: process explicit post-commit events without git catch-up
```

---

## Commit 6 — `fix: preserve offline commit boundaries without analysis`

实现：

```text
BridgeConsumer persists git-commit-boundary/v1
Boundary write idempotency
Binder uses true previous boundary
offline conversation isolation
```

Commit message：

```text
fix: preserve conversation boundaries across offline periods
```

---

## Commit 7 — `test: lock P0 runtime contracts`

更新全 E2E：

```text
offline commits ignored
restart does not analyze
next online commit only
duplicate Hook once
rapid commits both processed
migration upgrade full preservation
```

并清理旧测试名字/断言。

Commit message：

```text
test: lock post-commit-only and upgrade safety contracts
```

---

# 35. 必须修改 / 审查的生产源码

### Trigger / Analysis

```text
_site/lib/contracts.js
_site/lib/server-app.js
_site/lib/post-commit-automation.js
_site/lib/commit-reconciler.js
_site/lib/scanner.js
_site/scripts/hook-trigger.js
```

### Conversation Boundary

```text
_site/lib/bridge-consumer-service.js
_site/lib/bridge-adapter.js
_site/lib/conversation-store.js
_site/lib/commit-conversation-binder.js
```

### Migration / Storage

```text
_site/lib/data-dir.js
_site/lib/migration-service.js
_site/lib/storage-layout.js
_site/lib/settings-store.js
_site/lib/project-registry-store.js
_site/lib/project-store.js
desktop/main.cjs
desktop/lib/backend-runtime.cjs
```

### Documentation

```text
README.md
docs/README.zh-CN.md
CHANGELOG.md
docs/testing-strategy.md
```

不要为了“完整”去修改与行为无关的文件。

---

# 36. 必须删除 / 重写的旧测试 Contract

当前以下测试显式锁定了旧架构，需要修改。

## `startup-reconciliation-independent-test.js`

当前测试要求：

```text
Backend Offline
Commit B/C
Restart
-> B/C automatically analyzed
```

新 Contract 完全相反。

建议：

重命名为：

```text
startup-does-not-analyze-offline-commits-test.js
```

新断言：

```text
B/C not analyzed
lastAnalyzedCommit unchanged
no changes/<B>.md
no changes/<C>.md
```

---

## `full-integration-e2e-test.js`

当前 Offline 部分要求：

```text
offline-one
offline-two
restart
-> startup ordered catch-up
```

改为：

```text
offline-one
offline-two
restart
-> neither analyzed

new online commit D
-> only D analyzed
```

---

## `pending-sweep-test.js`

当前专门验证：

```text
dispatchPendingAutomations()
```

新架构应删除整个 startup pending sweep 测试。

其中“moved repo Hook identity”部分仍有价值：

拆到：

```text
post-commit-explicit-event-test.js
```

---

## `commit-reconciler-concurrency-test.js`

从：

```text
concurrent request -> rescan
```

改为：

```text
same project:
explicit commit D
explicit commit E
-> serialized D, E

duplicate D:
-> joined / once

different projects:
-> parallel allowed
```

---

## `scanner-test.js`

保留：

```text
TrustedGitReader exact commit evidence
history divergence diagnostics if仍有 caller
```

删除 Knowledge Analysis 必须 catch-up 的 contract。

---

# 37. Migration Unit Test Plan

必须新增以下测试。

---

## M01 — Fresh Install

```text
no legacy
no v2
```

预期：

```text
classifier = FRESH
defaults allowed
```

---

## M02 — v4.1.22 complete fixture

Fixture：

```text
projects.json = 3 projects

ai-profiles.json:
    2 profiles
    1 with API key

knowledge-store.json:
    rootPath = exact old path

embedding-config.json:
    modelId
    localFilesOnly
    localModelPath

models/:
    fake nested model files

knowledge-scopes.json
claude-prompts.json
logging.json
```

预期 migration 后：

```text
projectCount = 3
aiProfileCount = 2
hasApiKey = true
knowledgeRoot exact
embedding exact
cache/models contains exact files
```

---

## M03 — Empty target `projects.json` must not suppress non-empty legacy source

这是当前高风险 regression test。

```text
target/projects.json = {}
or empty v2

legacy source/projects.json = projects
legacy source/ai-profiles.json = profiles
```

预期：

```text
NOT "already migrated"
```

如果可安全迁移：

```text
migrate
```

如果 source/target 冲突：

```text
fail closed
```

绝不能：

```text
continue as fresh install
```

---

## M04 — Existing empty v2 + legacy user data

```text
target:
    settings/v2 defaults
    project-registry/v2 empty

legacy:
    projects > 0
```

预期：

```text
CONFLICT / MIGRATION_REQUIRED
```

不能写 completion marker。

---

## M05 — v1 completion marker with contradictory legacy evidence

```text
completion:
    projectCount=0

legacy:
    projects > 0
```

预期：

```text
marker not blindly trusted
startup fails closed or repairs through controlled migration
```

---

## M06 — Migration failure before activation

Fault：

```text
backup
staging
validation
```

预期：

```text
no defaults
no completion
legacy intact
startup refuses to become fresh
```

---

## M07 — Migration failure during activation

预期：

```text
rollback exact
no completion
old data intact
```

---

## M08 — Migration returns `ok:false`

直接 stub：

```js
migrationService.migrateIfNeeded()
    -> {ok:false}
```

调用：

```text
initializeRuntime()
```

断言：

```text
throws MIGRATION_FAILED

settingsStore.initialize not called
registryStore.initialize not called
```

这是必须新增的测试。

---

## M09 — API key preservation and redaction

迁移输入：

```text
apiKey = known test secret
```

迁移后内部文件：

```text
secret preserved
```

Public API：

```text
hasApiKey=true
masked
```

日志/diagnostic：

```text
secret text not present
```

---

## M10 — Knowledge Root exact preservation

旧：

```text
knowledge-store.rootPath = X
project.kbPath = Y
```

预期：

```text
settings.knowledge.rootPath == X
project.config.knowledgePath == Y
```

不能重新计算覆盖 Y。

---

## M11 — Model cache migration

```text
models/A/B/model.onnx
```

预期：

```text
cache/models/A/B/model.onnx
```

内容 hash 相同。

---

## M12 — Both old/new model cache non-empty

不能整体覆盖。

预期按实现策略：

```text
safe merge or explicit conflict
```

必须测试。

---

## M13 — Idempotency

Migration 成功后运行第二次：

```text
no changes
no duplicate projects
no duplicate profiles
no model copy duplication
```

---

# 38. Trigger / Event Unit Test Plan

## T01 — `validateTrigger('startup')` fails

```text
INVALID_TRIGGER
```

---

## T02 — Server startup analyzer count = 0

注入 fake analyzer / reconciler counter。

启动一个有 pending Git history 的 Project。

预期：

```text
startup:
analysis count = 0
```

---

## T03 — Offline Hook failure does not enqueue work

模拟 backend unreachable。

预期：

```text
Hook exits 0
no pending analysis queue
log does not contain "startup reconciliation will catch up"
```

---

## T04 — Explicit D processes only D

Git：

```text
A baseline
B offline
C offline
D explicit Hook
```

直接向 Handler 提交：

```text
event.head = D
```

预期：

```text
collectEvidence called only D
analyzer called only D
no B/C knowledge
```

---

## T05 — Current HEAD advanced beyond event SHA

Git：

```text
D committed
Hook event D delayed
E committed
current HEAD = E
```

处理 Hook D。

预期：

```text
D still processes successfully
evidence is D
E not processed until its own Hook
```

---

## T06 — Duplicate Hook

```text
D
Hook D
Hook D
```

预期：

```text
one Promotion
one final processing ledger completed
second call returns already-completed / joined
```

---

## T07 — Rapid D/E same project

并发提交：

```text
Hook D
Hook E
```

预期：

```text
D once
E once
serialized order
```

---

## T08 — Two Projects may process in parallel

```text
P1 Commit A
P2 Commit B
```

允许并行。

不能因为全局锁串行所有 Project。

---

# 39. Conversation Boundary Test Plan

## C01 — Bridge Consumer persists boundary record

Input journal：

```text
user_prompt
assistant_response
git-commit-boundary/v1
```

预期：

```text
Conversation event persisted
Boundary persisted
ACK advanced
```

---

## C02 — Duplicate same Boundary is idempotent

两次同内容：

```text
success
```

---

## C03 — Same commitSha conflicting Boundary

预期：

```text
DATA_CORRUPT / deterministic conflict
```

不能静默覆盖。

---

## C04 — Offline B/C boundaries isolate D

Journal：

```text
Boundary A
Prompt B
Boundary B
Prompt C
Boundary C
Prompt D
Boundary D
```

Binder D：

```text
only Prompt D
```

不是：

```text
Prompt B + C + D
```

---

# 40. Full E2E — 核心业务验收

这是最终最重要的 E2E。

## E2E-01 — Online / Offline / Restart / Online

```text
Start Backend

Import Project at A

Prompt A
Commit A
    -> A analyzed

Stop Backend

Prompt B
Commit B

Prompt C
Commit C

Start Backend
    -> B NOT analyzed
    -> C NOT analyzed

Prompt D
Commit D
    -> D analyzed
    -> D snapshot excludes B/C

Final:
A = analyzed
B = not analyzed
C = not analyzed
D = analyzed
```

断言：

```text
changes/A.md exists
changes/B.md absent
changes/C.md absent
changes/D.md exists
```

以及 Analyzer invocation list：

```text
[A, D]
```

---

# 41. Full E2E — Upgrade Data

## E2E-02 — v4.1.22-shaped data -> current code

准备真实 v4.1.22 fixture：

```text
3 projects
2 AI profiles
API key
Knowledge Root
Project kbPath
embedding config
models/
knowledge markdown
```

启动 current Backend。

断言：

```text
/api/state:
    projects=3

/api/ai-profiles:
    profiles=2
    secret masked
    hasApiKey=true

/api/settings:
    knowledge root exact

project configs:
    repoPath exact
    knowledgePath exact

embedding:
    config exact

model cache:
    exists new path

MCP:
    resolve works
    get/search can read old Markdown
```

---

# 42. Full E2E — Broken Migration

## E2E-03

准备：

```text
legacy data exists
```

注入 migration failure。

启动 Backend。

预期：

```text
Backend does NOT report healthy fresh system
startup fails
legacy untouched
no empty projects registry replaces source
no default settings become authoritative
```

---

# 43. Windows Desktop / Installer Release Gate

因为用户实际事故发生在安装后的 v4.2.6，这次不能只测 Node unit tests。

至少完成一个 Windows Desktop upgrade smoke。

优先级：

### Gate A — packaged backend with legacy data

用临时 `KB_DATA_DIR` 构造 v4.1.22 fixture。

从 Desktop package 里的实际 core/backend 启动。

验证：

```text
projects
AI profiles
knowledge root
embedding
model cache
```

全部存在。

### Gate B — true installer upgrade（如果本机有前版本安装包）

流程：

```text
Install previous version
Configure:
    project
    AI profile
    knowledge root
    model cache

Close app

Install new fixed build over it

Open app

Verify all data preserved
```

这应该作为 Release Gate。

如果 CI 环境无法自动安装 Squirrel：

```text
记录为 manual Windows release test
```

但本轮交付前至少本机执行一次。

---

# 44. 现有测试必须全部运行

阶段测试通过后，最终：

```bash
node _site/_test/run-all-tests.js
```

或者：

```bash
npm test
```

当前 runner 会运行所有：

```text
*-test.js
```

任何旧测试失败时：

先判断：

```text
A. 新代码 regression
B. 测试锁定的是已被明确删除的旧 contract
```

只有 B 情况可以修改/删除测试。

禁止为了“全绿”重新加回：

```text
startup analysis
pending sweep
history catch-up
```

---

# 45. 建议重点运行的现有测试

至少逐个跑：

```text
data-dir-migration-test.js
project-layout-v2-migration-test.js
legacy-project-upgrade-e2e-test.js
storage-foundation-test.js
path-consistency-test.js

post-commit-automation-test.js
commit-reconciler-concurrency-test.js
commit-conversation-binding-test.js
commit-boundary-freeze-test.js
bridge-consumer-service-test.js
hook-trigger-test.js
full-integration-e2e-test.js

knowledge-promotion-recovery-test.js
index-writer-concurrency-test.js
mcp-server-test.js
```

旧：

```text
startup-reconciliation-independent-test.js
pending-sweep-test.js
```

必须按新 Contract 重写或拆除。

---

# 46. Static Architecture Gate

Codex 最后增加或更新 architecture guard test，至少检查源码中不再出现业务调用：

```text
reconcileProjectCommits(projectId, 'startup'
```

不再有：

```text
startup reconciliation will catch up
```

不再有：

```text
dispatchPendingAutomations
```

如果接口已删除。

但不要仅靠正则测试。

真正 E2E 仍是权威。

---

# 47. Recovery / Rollback

## Migration Code Rollback

任何 Migration activation 前：

```text
backup source
backup existing target
write journal
stage
validate
```

失败：

```text
rollback
no completion marker
startup fails
```

---

## 用户本机数据恢复 Rollback

恢复前生成：

```text
backup-current-<timestamp>
backup-legacy-<timestamp>
```

如果恢复后的 Backend 校验失败：

```text
停止 Backend
恢复 current backup
保留所有 migration recovery artifacts
```

不要删除旧源。

---

# 48. 完成标准 — P0-B Data Safety

必须全部满足：

- [ ] 找到并记录本机事故根因或明确说明未能找到旧源。
- [ ] `hasMigrated()` 不再以单个 `projects.json` 存在作为整套数据迁移完成依据。
- [ ] Legacy asset 定义只有一个权威清单。
- [ ] `embedding-config.json` 不会因第一层 relocation 漏掉。
- [ ] v4.1.22 `models/` 可安全迁移到 `cache/models/`。
- [ ] Migration `ok:false` 时 startup 必须停止。
- [ ] Legacy 数据存在时不能静默创建 default Settings / empty Registry。
- [ ] Empty v2 + non-empty legacy 被识别为 conflict/migration-required。
- [ ] completion marker 不再无条件压过 contradictory evidence。
- [ ] AI Profile 数量保留。
- [ ] API Key 内部保留、外部 redacted。
- [ ] Knowledge Root 精确保留。
- [ ] Project repoPath / knowledgePath 精确保留。
- [ ] Markdown 不被 migration 改写。
- [ ] LanceDB 若无法迁移可 rebuild。
- [ ] 本机用户数据恢复有 backup + validation。

---

# 49. 完成标准 — P0-A Trigger Architecture

必须全部满足：

- [ ] Analysis Trigger 只有 `git-hook`。
- [ ] Application Startup 不调用 Knowledge Analyzer。
- [ ] Application Startup 不扫描 pending commits。
- [ ] Offline Commit 不补分析。
- [ ] 下一次在线 Hook 不补分析之前 Offline Commit。
- [ ] Hook 处理 explicit `event.head`。
- [ ] event SHA 不是 current HEAD 仍可正确处理。
- [ ] Duplicate Hook exactly once。
- [ ] 快速 D/E 都不会丢。
- [ ] 同 Project 串行；不同 Project 可并行。
- [ ] Hook Backend offline 仍 exit 0。
- [ ] Hook 日志不再承诺 startup catch-up。
- [ ] 不新增 offline pending queue。

---

# 50. 完成标准 — Conversation Correctness

必须全部满足：

- [ ] Bridge Consumer 能持久化 `git-commit-boundary/v1`。
- [ ] Offline Boundary B/C 可在 Backend 后续启动时同步。
- [ ] 同步 Boundary 不触发 Knowledge Analysis。
- [ ] 当前 D 的 snapshot 只绑定 C..D Window。
- [ ] Boundary duplicate idempotent。
- [ ] Boundary conflict fail deterministically。
- [ ] Internal Workbench conversation 继续不会进入 Development Conversation。

---

# 51. Codex 每阶段输出要求

每完成一个 Commit，Codex 在终端/最终报告记录：

```text
Commit:
<sha / message>

Intent:
<本阶段修什么>

Files changed:
...

Behavior changed:
...

Tests:
PASS ...
PASS ...

Known remaining:
...
```

---

# 52. 最终 Codex 交付报告

最终必须包含：

## 1. Root Cause

```text
Data-loss root cause:
confirmed / likely / unresolved

Evidence:
...
```

## 2. Local Recovery

```text
Old data found:
...

Recovered:
Projects: n
AI Profiles: n
Knowledge Root: ...
Embedding: yes/no
Model cache: bytes/files

Secrets printed:
NO
```

## 3. Architecture

确认：

```text
Analysis Trigger:
post-commit only

Startup analysis:
removed

Git history catch-up:
removed

Offline commit analysis:
removed
```

## 4. Conversation

确认：

```text
Offline boundaries preserved:
yes/no

D does not consume B/C conversation:
PASS/FAIL
```

## 5. Tests

```text
Focused tests:
...

Full regression:
N passed
0 failed
```

## 6. Git

```text
Commits created:
...

Unrelated local changes untouched:
yes/no

Push performed:
NO
```

---

# 53. Codex 执行约束

Codex 必须遵守：

1. 先诊断，后恢复，后改代码。
2. 不把猜想当 Root Cause。
3. 不覆盖用户原始 Data Directory。
4. 不在任何输出中打印 API Key。
5. Migration 失败必须 fail closed。
6. 不为了兼容旧测试恢复 startup catch-up。
7. 不把 Bridge startup drain 错当成 Startup Knowledge Analysis。
8. Bridge 可以同步 Conversation/Boundary 事实，但不能在 Startup 触发 Analysis。
9. Hook 只处理 explicit Commit。
10. 不用 Git History 猜遗漏工作。
11. 不使用 current HEAD 代替 event commitSha。
12. 不用时间、UI selection、最近项目猜 Conversation project。
13. Markdown 保持 Source of Truth。
14. Index 保持 Derived。
15. 不 Push。
16. 不改与 P0 无关功能。

---

# 54. 推荐 Codex 入口提示词

将本计划文件放进仓库后，只需要给 Codex 一个短入口提示词：

```text
你现在要修复 project-knowledge-base 的两个 P0 问题。

源码基准和完整执行规范见：
<本计划文件路径>

任务：
1. 严格先执行计划中的本地数据只读事故调查，验证 Projects / AI Profiles / Knowledge Root / Embedding / Model Cache 为什么在 v4.2.6 升级后全部表现为空。
2. 修复 Migration / Upgrade Safety，确保旧数据存在或迁移失败时绝不能静默进入 Fresh Install。
3. 删除 startup -> Knowledge Analysis。
4. 删除隐含的 baseline..HEAD Git History catch-up，让 post-commit Hook 只处理 event.head 对应的明确 Commit。
5. 修复 offline Commit Boundary，使离线 Conversation 不污染下一次在线 Commit，但绝对不能重新引入 startup analysis。
6. 按计划中的 Commit 顺序和测试矩阵执行。
7. 每阶段测试通过再 Commit。
8. 不 push。
9. 不覆盖用户未提交修改。
10. API Key / Token 绝不出现在日志和报告中。

不要重新设计需求，不要自行缩减测试，不要为了旧测试通过而恢复已被计划明确删除的旧行为。

完成后输出：
- 本机数据事故 Root Cause
- 数据恢复结果
- 所有代码 Commit
- 修改文件
- Focused tests
- Full regression
- 未解决风险
```

---

# 55. 最终架构验收图

```text
                    DEVELOPMENT FACTS

Claude / Codex / OpenCode
          |
          +-----------> AI Coding Event Bridge
          |                     |
          |             Conversation + Boundary
          |                     |
          |                     v
          |              Conversation Store
          |
          +-----------> Git Commit
                              |
                              v
                       post-commit Hook
                              |
                       explicit commitSha
                              |
                              v
                    Commit Event Processor
                       /       |        \
                      /        |         \
             Conversation   Git Diff   Existing KB
                  Snapshot      |          |
                      \         |         /
                       \        |        /
                        Frozen Claim
                              |
                              v
                     Knowledge Analyzer
                              |
                              v
                        Staging/Validate
                              |
                              v
                        Markdown Knowledge
                              |
                              v
                         Derived Index
                              |
                              v
                      MCP Search / Ask
                              |
                              v
                         Next AI Coding
```

Startup：

```text
Application Startup
     |
     +--> Migration
     +--> Promotion Recovery
     +--> Index Recovery
     +--> Hook Repair
     +--> Bridge Conversation/Boundary Drain

     X--> Git History Scan
     X--> Pending Commit Detection
     X--> Knowledge Analysis
```

---

# 56. 本轮真正的 P0 结论

这次不要把两个问题分别当成两个孤立 Bug。

它们本质上都是同一种架构问题：

> **系统存在过多“隐式恢复 / 隐式推断”行为。**

数据侧：

```text
看到某个文件
-> 猜已经迁移
-> 失败后继续初始化 defaults
```

Analysis 侧：

```text
看到 Git HEAD 比 lastAnalyzedCommit 新
-> 猜这些 Commit 都应该补分析
```

本轮统一修复原则：

```text
明确事实 > 推断

Explicit Event > State Scan

Fail Closed > Silent Fresh Install

Missing Knowledge > Fabricated Knowledge

User Data Preservation > Automatic Convenience
```

完成本计划后，Project Knowledge Base 的核心运行模型应该明显更简单、更可解释、更可靠。
