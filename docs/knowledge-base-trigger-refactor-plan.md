# 知识库触发方式改造 Plan

## 1. 改造目标

知识库以后只保留两种触发方式：

1. **Git Hook 实时触发**：用户完成 `git commit` 后，立即通知知识库检查并分析新 Commit。
2. **程序启动时补查**：知识库程序启动后，检查所有项目，把遗漏的 Commit 补上。

其他入口不得再直接启动知识库分析。

Git Hook 的安装和卸载属于“项目生命周期”，不是新的知识库触发方式：

- 导入项目时自动安装。
- 删除项目时自动卸载。
- 不提供手动安装、重新安装和卸载按钮或接口。
- 对已经安装了错误 Hook 的旧项目，新版本只执行一次自动修复，不要求用户手动处理。

项目配置和分析状态也要按项目隔离：

- `projects.json` 只作为项目索引，只在导入、删除项目时修改。
- 每个项目使用自己的配置文件和状态文件。
- 不同项目可以并行分析，但不能再共同改写同一个 `projects.json`。
- 同一个项目的 Commit 必须串行分析，防止自己的状态互相覆盖。

### 必须保留的现有知识库路径交互

当前产品已经有“知识库本地地址”设置，正确的用户流程必须保持为：

```text
先在设置页面选择一个全局知识库根目录
验证并保存该根目录
再导入代码项目
系统在该根目录下为新项目确定知识库目录
把最终的项目知识库绝对路径固定保存到该项目的 config.json
```

- 导入项目时不再要求用户重复选择知识库路径。
- 全局根目录只负责决定“以后新导入项目”的默认知识库位置。
- 已导入项目必须继续使用自己已经保存的知识库绝对路径；以后修改全局根目录时，不能让旧项目静默切换目录。
- `~/.project-knowledge/projects/<project-id>/` 只保存本软件的内部项目配置和运行状态，不保存 `modules/`、`changes/` 等实际知识内容。
- `modules/`、`changes/`、`README.md` 等实际知识文件保存在用户选择的知识库根目录下面的项目子目录中。

### 可诊断性与长期日志原则

日志必须能够还原一次操作从开始到结束的完整链路，而不是只记录“启动补查完成、数量为 0”之类的汇总消息：

- 系统启动、项目导入、Hook、Commit 补查、AI 分析、知识文件写入、索引更新和项目删除都要有可关联的开始、成功、失败日志。
- 日志必须有明确等级、项目标识、操作标识、Commit、阶段、耗时和结构化错误；不同等级在界面中使用不同颜色和图标。
- 日志文件保存在 `~/.project-knowledge/logs/`，跨程序重启和版本升级保留，不能只存在于终端或内存中。
- 默认长期保存，同时提供明确的保留期限和磁盘容量上限，避免日志静默消失或无限占满磁盘。
- “没有待处理 Commit”属于 `debug` 诊断信息，不应作为大量 `info` 日志淹没真正的系统状态变化。

### 知识库真实性原则

一条可信的知识应该来自三个部分：

```text
固定分析提示词 + 用户的 AI 提问需求 + 该 Commit 的实际代码变化
```

- 用户需求说明“为什么要改、希望实现什么”。
- Git Commit 和 Diff 说明“代码实际上实现了什么”。
- 固定提示词负责比较需求和实现，并把确认过的结果写入知识库。

不能只扫描整个项目后推测需求。没有用户需求、也没有本次代码变化的“项目初始化分析”，可能把推测内容写成事实，因此必须取消。

## 2. 原代码有多少个触发入口

原代码共有 **5 个实际入口**，可以归纳为 **4 类触发方式**：

| 编号 | 原入口 | 代码位置 | 是否保留 |
| --- | --- | --- | --- |
| 1 | 导入项目后自动执行初始分析 | `_site/server.js` 中 `importProjectFromLocalPath()` 调用 `dispatchProjectInit()` | 删除 |
| 2 | Git `post-commit` Hook | `POST /api/hooks/post-commit` 调用 `handlePostCommitEvent()` | 保留 |
| 3 | 手动模拟分析 | `POST /api/projects/:slug/automation/simulate` | 删除 |
| 4 | 手动执行初始分析 | `POST /api/projects/:slug/automation/init` | 删除 |
| 5 | 程序启动时补查 | `server.listen()` 中调用 `dispatchPendingAutomations()` | 保留 |

补充说明：

- `/context-pack` 只生成上下文，不启动分析，因此不算触发方式。
- `/analyze/initial` 的旧自动分析已经被移除，目前只会启动 Claude 对话，也不算知识库自动触发。

### 当前 Hook 安装已经确认的问题

- `_site/server.js` 把 `SITE_ROOT` 传给 `installHook()`，这个路径指向 `ui` 目录。
- `hook-manager.js` 又在该路径后拼接 `scripts/hook-trigger.js`，最终可能写成 `ui/scripts/hook-trigger.js`。
- 真实触发脚本位于 `_site/scripts/hook-trigger.js`，因此 Commit 后可能出现“找不到脚本”，知识库完全收不到通知。
- Hook 虽然计算了当前仓库路径 `REPO_ROOT`，但实际发送的仍是导入时写死的绝对路径；项目移动后会失效。
- 项目导入目前即使 `hookResult.ok` 为 `false`，仍会返回项目导入成功，导致用户不知道 Hook 实际没有安装成功。

## 3. 改造后的统一流程

两个入口都调用同一个 Commit 补查函数，例如：

```text
reconcileProjectCommits(project, trigger)
```

两个入口的区别只有“什么时候开始检查”，不能使用不同的分析提示词：

```text
确定检查起点：lastAnalyzedCommit 或 trackingStartCommit
查找检查起点之后的 Commit
按照时间顺序逐个处理
每个 Commit 都读取对应的用户需求和实际代码变化
每个 Commit 都使用同一套 Commit 分析提示词
某个 Commit 成功后，再把它保存为 lastAnalyzedCommit
```

新项目导入时只把当前 HEAD 保存为 `trackingStartCommit`，作为以后开始记录知识的起点。导入前的历史代码和当前完整项目都不自动分析。

`trigger` 只允许两个值：

```text
git-hook
startup
```

## 4. 代码修改任务

### 任务一：删除三个多余入口

修改 `_site/server.js`：

- 删除项目导入完成后对 `dispatchProjectInit()` 的调用。
- 删除 `/automation/simulate` 接口。
- 删除 `/automation/init` 接口。
- 保留 `/api/hooks/post-commit`。
- 保留程序启动时的 `dispatchPendingAutomations()`。
- 项目导入只负责读取已设置的知识库根目录、确定并保存项目知识库路径、创建知识库目录和安装 Hook，不再直接分析。
- 保留项目导入时记录当前 HEAD 为 `trackingStartCommit` 的行为。

### 任务二：统一两种触发入口

修改 `_site/lib/post-commit-automation.js`：

- 增加统一入口 `reconcileProjectCommits()`。
- `handlePostCommitEvent()` 只负责找到项目，然后调用统一入口。
- `dispatchPendingAutomations()` 遍历项目并调用统一入口。
- 删除 `renderProjectInitPrompt()`、`dispatchProjectInit()` 和项目文件概览式初始化分析。
- `dispatchAutomation()` 保留为内部执行步骤，不能被 HTTP 接口直接调用。
- 分析记录中的触发来源只允许 `git-hook` 和 `startup`。
- 无论由 Hook 发现还是启动补查发现，同一个 Commit 必须生成完全相同的分析任务。

### 任务三：修正 Commit 检查起点

修改或保留 `_site/lib/scanner.js` 的以下规则：

- 新项目没有 `lastAnalyzedCommit` 和 `trackingStartCommit` 时，把当前 HEAD 写入 `trackingStartCommit`，不分析当前项目。
- 有 `lastAnalyzedCommit` 时，检查 `lastAnalyzedCommit..HEAD`。
- 没有 `lastAnalyzedCommit`、但有 `trackingStartCommit` 时，检查 `trackingStartCommit..HEAD`。
- Git 必须使用 `--reverse`，保证 Commit 按时间顺序处理。
- 每个 Commit 成功后立即更新 `lastAnalyzedCommit`。
- 某个 Commit 分析失败时停止后续 Commit；下次 Hook 或启动补查从失败位置继续。

兼容旧数据：

- 已有 `lastAnalyzedCommit` 的项目继续从该 Commit 后面补查。
- 没有 `lastAnalyzedCommit`、但已有 `trackingStartCommit` 的项目继续使用原跟踪起点。
- 两个字段都没有的旧项目，在下一次启动时只建立 `trackingStartCommit`，不做初始化分析。
- 本次改造不自动删除以前由 `project-init` 产生的知识文件，避免误删；只停止继续产生此类内容。

### 任务四：把用户需求加入 Commit 分析

当前 `_site/lib/automation-config.js` 的 Commit 提示词已经包含 Commit、变更文件和 Diff 摘要，但没有单独的“用户 AI 提问需求”。需要补充：

- 为每个项目保存待关联的用户需求记录，至少包含项目、需求正文、记录时间、AI 工具和会话标识。
- Claude Code、OpenCode、Codex 的接入层只负责记录用户需求，不得直接触发知识库分析。
- Commit 分析时优先读取与当前项目、当前开发会话或明确需求编号关联的需求。
- 不能把其他项目或其他会话的“最近一次提问”错误绑定到当前 Commit。
- 找不到可靠需求时，提示词必须写明“需求上下文未记录”，只记录代码可以证明的变化，不允许猜测业务目的。

建议新增统一变量：

```text
{{userRequirement}}
```

统一 Commit 提示词至少要包含：

```text
用户需求
Commit 信息
Commit 实际变更文件和 Diff
现有知识库相关内容
需求与实际实现是否一致
需要新增、修改或删除的知识
```

修改 `_site/lib/automation-config.js`：

- 删除 `DEFAULT_INIT_PROMPT_TEMPLATE` 和 `initPromptTemplate`。
- 将 Hook 提示词明确为唯一的 Commit 分析提示词。
- 为兼容旧配置，可读取旧 `hookPromptTemplate`，但新配置统一使用 `commitPromptTemplate`。

### 任务五：把 Git Hook 绑定到项目生命周期

修改 `_site/lib/hook-manager.js` 和 `_site/scripts/hook-trigger.js`：

- Hook 只发送“项目有新 Commit”的通知，不在 Hook 内执行分析。
- 知识库没有运行时，Hook 失败也必须正常退出，不能影响 `git commit`。
- Hook 不需要保存任务；遗漏内容由下次程序启动补查。
- `installHook()` 改为接收明确的 `triggerScriptPath`，不要再接收含义不清楚的 `siteRoot`。
- 安装时使用 `_site/scripts/hook-trigger.js` 的真实绝对路径，并在写入 Hook 前确认该文件存在。
- Hook 使用 `git rev-parse --show-toplevel` 得到的 `REPO_ROOT`，不要再使用导入时写死的项目路径。
- 如果 Hook 已经由本系统管理，重复执行安装必须安全地更新旧 Hook，不能生成重复内容。
- 如果已经存在其他工具或用户自己的 `post-commit`，不能自动覆盖；项目导入必须明确失败并说明冲突原因。
- Hook 模块只管理 Git Hook，不再顺便创建或删除 `CLAUDE.md`；不同 AI 工具的配置由各自接入模块负责。

修改 `_site/server.js` 的项目导入流程：

```text
确认用户已经在设置页面保存了可写的知识库根目录
生成稳定的 projectId 和不可变的知识库目录名
确定并保存该项目的知识库绝对路径
检查或初始化 Git
建立 trackingStartCommit
自动安装 Hook
检查 Hook 文件和触发脚本都有效
保存项目导入成功
```

- Hook 安装是项目导入的必需步骤。
- 安装或检查失败时，整个导入返回失败，不能继续显示“导入成功”。
- 失败时回滚本次已经写入的系统 Hook 和项目登记，不能留下半完成状态。

修改项目删除流程：

```text
确认没有正在运行的任务
自动卸载本系统管理的 Hook
删除项目登记
根据用户选择处理知识库数据
```

- 只能删除带有本系统标记的 Hook，不能删除其他工具或用户自己的 Hook。
- 仓库仍然存在、但本系统 Hook 卸载失败时，停止删除并显示明确原因，方便下次直接重试删除项目。
- 仓库目录已经不存在时，可把 Hook 视为无法继续存在，允许删除项目登记。

为当前已经导入的项目增加一次性迁移：

- 新版本第一次启动时，检查旧的本系统 Hook 标记和版本。
- 只自动更新带有本系统标记、且脚本路径错误或版本过旧的 Hook。
- 修复成功后记录 Hook 版本，后续启动不再重复改写。
- 这只是旧版本迁移，不增加新的知识库分析触发方式。

### 任务六：删除手动入口和旧界面调用

搜索并删除前端对以下接口的调用：

```text
/automation/simulate
/automation/init
/hook-install
/hook-uninstall
```

- 删除 `POST /api/projects/:slug/hook-install`。
- 删除 `POST /api/projects/:slug/hook-uninstall`。
- `installHook()` 和 `uninstallHook()` 只作为项目导入、项目删除及一次性迁移使用的内部函数。
- 界面可以只读显示 Hook 是否正常和失败原因，但不能提供手动安装、重新安装或卸载操作。
- 界面如需显示分析状态，只能读取运行记录，不能直接启动知识库分析。

### 任务七：把项目配置和运行状态拆成单项目文件

当前所有项目共同读写 `projects.json`。当多个项目同时完成分析时，可能出现下面的覆盖：

```text
项目 A 读取旧 projects.json
项目 B 读取同一个旧 projects.json
项目 A 写入自己的 lastAnalyzedCommit
项目 B 随后写入自己的结果，并把项目 A 的修改覆盖掉
```

改造后的目录结构：

```text
~/.project-knowledge/
├─ projects.json
└─ projects/
   ├─ <project-id-1>/
   │  ├─ config.json
   │  ├─ state.json
   │  └─ requirements.jsonl
   └─ <project-id-2>/
      ├─ config.json
      ├─ state.json
      └─ requirements.jsonl
```

文件职责：

- `projects.json`：只保存项目 ID 索引和必要的显示顺序，只在导入、删除项目时修改。
- `config.json`：保存项目名称、代码路径、由全局根目录解析出的知识库绝对路径、启用状态和创建时间等低频配置。
- `state.json`：保存 `trackingStartCommit`、`lastAnalyzedCommit`、当前分析状态、最后错误和 Hook 迁移版本等运行状态。
- `requirements.jsonl`：按行追加该项目的用户需求记录，避免多个项目共同覆盖一个需求文件；没有需求记录时不创建。
- 当前分支、当前 HEAD 等可以直接从 Git 得到的信息不长期保存。

这里的 `projects/<project-id>/` 是内部元数据目录，不是项目知识库目录，里面不能再创建 `knowledge/modules/` 或 `knowledge/changes/`。

内部项目元数据目录必须使用稳定的 `projectId`，不能使用项目名称、Slug 或项目路径。项目改名或移动目录时，仍然使用原来的 `projectId`。

建议增加两个明确的数据访问模块：

```text
ProjectRegistryStore  -> 只管理 projects.json
ProjectStore          -> 只管理单个项目的 config.json、state.json 和 requirements.jsonl
```

其他业务代码不能再直接读取、修改和整体覆盖 `projects.json`。

并发与写入规则：

- 不同项目可以同时分析，各自只修改自己的 `state.json`。
- 同一个项目只能有一个 `reconcileProjectCommits()` 在运行；Hook 和启动补查同时发现该项目时，合并为同一个任务。
- 同一项目的多个 Commit 严格串行处理；一个 Commit 成功后，才原子更新 `lastAnalyzedCommit`。
- JSON 保存必须先写同目录临时文件，确认完整后再替换正式文件，不能直接覆盖写入。
- 导入和删除项目修改 `projects.json` 时使用单独的全局写入锁。

旧数据迁移：

1. 新版本启动时读取旧 `projects.json`。
2. 为每个项目生成或沿用稳定的 `projectId`。
3. 把配置写入对应的 `config.json`，把分析状态写入对应的 `state.json`。
4. 确认所有单项目文件都写入成功后，再把 `projects.json` 缩减为项目索引。
5. 迁移过程中任何一步失败，都继续使用原文件，不能留下部分迁移状态。
6. 迁移只执行一次，不能改变原有的 `trackingStartCommit` 和 `lastAnalyzedCommit`。

### 任务八：保留“先设置知识库根目录，再导入项目”的流程，并清理存储架构

#### 当前代码审查结论

当前流程本身是正确的，不应改成“每导入一个项目都选择一次知识库路径”：

- `_site/lib/knowledge-store.js` 使用 `rootPath` 保存全局知识库根目录。
- `_site/server.js` 的 `importProjectFromLocalPath()` 没有接收单项目知识库路径；普通本地项目通过 `defaultProjectKbPath(slug)` 得到 `rootPath/slug`。
- 项目导入后又把解析出的 `kbPath` 保存到项目配置，因此已经具备“全局默认根目录 + 单项目固定路径”的基础。

需要修正的是存储职责混乱，而不是删除这个设置入口：

- `knowledge-store.json` 只保存少量全局设置，却又单独占一个配置文件。
- 修改知识库根目录时，`applyKnowledgeStoreConfig()` 会把向量数据库也迁移到该根目录。
- `_site/lib/knowledge-storage-location.js` 会在用户选择的根目录下再创建 `.project-knowledge/knowledge.lancedb`，把用户知识文件与软件内部索引混在一起。
- `bin/project-knowledge-kb.js` 又直接读取 `~/.project-knowledge/knowledge.lancedb`，与服务端的数据库位置规则不一致。
- 多个模块分别拼接知识库、数据库和配置路径，缺少一个唯一的路径解析入口。

#### 配置文件清理决策

`~/.project-knowledge` 根目录目前直接出现的主要文件，应按下面规则整理：

| 当前项目 | 是否有业务需要 | 改造后的归属 |
| --- | --- | --- |
| `knowledge-store.json` | 需要其中的知识库根目录设置，不需要单独文件 | 合并到 `settings.json` 的 `knowledge.rootPath` |
| `ai-profiles.json` | 需要 | 合并到 `settings.json`；AI 密钥按产品决定允许明文保存 |
| `embedding-config.json` | 需要用户设置 | 合并到 `settings.json.embedding` |
| `logging.json` | 需要等级、保留期等设置，不需要单独文件或可变日志目录 | 合并到 `settings.json.logging`；日志目录由 `StorageLayout` 固定 |
| `claude-prompts.json` | 只有用户自定义提示词时才需要 | 默认提示词留在代码中；仅把覆盖值保存到 `settings.json` |
| `github-team.json`、`team-git-providers.json` | 团队功能启用时需要 | 合并到 `settings.json.integrations`，未启用时不生成 |
| `projects.json` | 需要 | 只保留项目 ID 索引，不保存项目详情和分析状态 |
| `knowledge-scopes.json` | 部分字段需要 | 项目绑定移入单项目 `config.json`，全局设置移入 `settings.json`，取消根目录常驻文件 |
| `removed-projects.json` | 只对删除恢复有用 | 移到 `recovery/deleted-projects.json`，按需创建并设置清理策略 |
| `team-stores-cache.json` | 是缓存，不是配置 | 移到 `cache/team-stores.json`，允许删除并自动重建 |
| `embedding-model-state.json` | 是运行状态，不是配置 | 移到 `runtime/embedding-model-state.json` |
| `.hook-trigger-errors.log` | 是日志，不是配置 | 改为 `logs/hooks/<date>.jsonl`，纳入统一等级、轮转和保留规则 |
| `models/` | 是可重建缓存 | 移到 `cache/models/` |
| `knowledge.lancedb` 及维护状态 | 是可重建索引 | 固定到内部 `index/`，不能跟随用户知识库根目录移动 |

目标内部目录保持少而稳定：

```text
C:\Users\SanQian\.project-knowledge\
├─ settings.json
├─ projects.json
├─ projects\
│  └─ <project-id>\
│     ├─ config.json
│     ├─ state.json
│     └─ requirements.jsonl       # 有需求记录时才创建
├─ index\
│  └─ knowledge.lancedb           # 派生索引，可重建
├─ cache\
│  ├─ models\
│  └─ team-stores.json
├─ runtime\
├─ logs\
│  ├─ app\
│  ├─ hooks\
│  └─ projects\
│     └─ <project-id>\
└─ recovery\                      # 只有启用删除恢复时才创建
```

除 `settings.json`、`projects.json` 和已导入项目的 `config.json`/`state.json` 外，其余文件和目录都按需创建。程序启动不能为了“准备默认值”而生成一批空配置文件。

用户选择的知识库根目录只保存真正的知识内容：

```text
<knowledgeRootPath>\
└─ <不可变的项目目录名>\
   ├─ README.md
   ├─ GOAL.md
   ├─ ARCHITECTURE.md
   ├─ modules\
   └─ changes\
```

该目录下不能生成 `.project-knowledge/`、LanceDB、日志、模型缓存、迁移状态或软件配置文件。

#### 设置和导入的准确语义

设置页面继续提供一个全局 `knowledgeRootPath`：

1. 保存前验证目录存在或可以创建、是目录且可以实际写入；只做权限探测，不创建业务文件。
2. 未成功设置根目录时，导入按钮不可用；后端导入接口也必须再次校验，不能只依赖前端。
3. 普通本地项目导入时，从这个根目录生成项目子目录；导入界面不增加第二个知识库路径选择框。
4. 目录名在导入时生成一次并固定。可以沿用当前可读的 `slug`，发生冲突时追加短 `projectId`；项目显示名称以后改变时不能重新计算目录。
5. 最终绝对路径保存为单项目 `config.json` 的 `knowledgePath`，它是已导入项目的唯一事实来源。迁移期可以兼容读取旧字段 `kbPath`，但不能长期保留两个可写字段。
6. 团队知识库绑定属于明确例外：它可以使用团队仓库给出的路径，但也必须把最终路径固定保存到该项目配置中。

修改全局根目录时必须遵守：

- 只影响以后新导入的项目。
- 已导入项目继续使用各自 `config.json` 中的 `knowledgePath`。
- 设置保存动作不迁移 Markdown、不迁移向量数据库，也不批量改写所有项目配置。
- 如果以后保留“迁移已有知识库”功能，它必须是独立、明确的操作：先复制、校验文件数量和内容、原子切换项目路径，最后再由用户决定是否删除旧目录；不能通过修改设置隐式触发。

#### 统一路径模块和导入事务

新增唯一的 `StorageLayout`（或 `KnowledgePathResolver`）模块，统一提供：

```text
getDataDir()
getKnowledgeRootPath()
getProjectMetadataDir(projectId)
resolveNewProjectKnowledgePath(storageName)
getProjectKnowledgePath(projectConfig)
getIndexPath()
getCachePath()
getRuntimePath()
getLogPath()
```

- `_site/server.js`、`knowledge-tool-runtime.js`、索引器、MCP 和 `bin/project-knowledge-kb.js` 都只能调用这个模块，不得各自 `path.join()` 猜路径。
- 对已导入项目，解析器必须读取 `config.json.knowledgePath`，不能再用当前全局根目录和 Slug 临时重算。
- 向量数据库固定为内部派生数据。先保持一个统一数据库，避免本次重构同时引入多数据库查询复杂度；数据库写入由一个索引服务串行提交，不由多个模块直接打开不同路径。

项目导入要作为一个可回滚事务执行：

```text
读取并校验 settings.json 中的 knowledgeRootPath
检查同一代码仓库是否已经导入
生成 projectId、不可变目录名和最终 knowledgePath
检查目标目录是否为空或确实属于同一项目，禁止静默覆盖
创建知识库结构和单项目配置/状态
初始化 Git 并记录 trackingStartCommit
安装并验证 Hook
最后把 projectId 加入 projects.json
```

- 任一步失败时，撤销本次新建的项目索引项、内部配置和本系统 Hook；只删除本次新建且仍为空或可证明属于本次事务的目录。
- 删除项目时默认只删除内部登记、状态和派生索引，不删除用户选择目录中的 Markdown 知识；只有用户明确选择“同时删除知识库”时才单独确认并执行。

#### 一次性迁移

升级时按下面顺序迁移，任何一步失败都继续使用旧数据：

1. 把 `knowledge-store.json.rootPath`、AI 配置、Embedding 设置、日志设置及启用中的集成设置合并到 `settings.json`。
2. 为每个旧项目创建稳定 `projectId`，把旧项目详情拆入 `config.json` 和 `state.json`。
3. 已有 `kbPath` 原样迁移为 `knowledgePath`，不能因为当前全局根目录不同而重算或移动知识库。
4. 旧项目没有 `kbPath` 时，才使用“旧 `rootPath` + 旧 Slug”计算一次，并立即固定保存。
5. 把现有向量数据库从旧的任一已知位置迁移到内部 `index/knowledge.lancedb`；验证可打开和记录数后再切换，失败时保留旧库。
6. 完成并校验后才停止读取旧文件。迁移备份集中放到一个带版本号的恢复目录，不在根目录散落多个 `.bak` 文件。

### 任务九：把当前日志改造成可长期追踪的诊断系统

#### 当前日志代码已经确认的问题

当前 `_site/lib/structured-logger.js` 只是一个最小 JSONL 读写器，还不能承担正式软件的故障诊断：

- 只定义了 `info`、`warn`、`error`，没有 `trace`、`debug` 和不可恢复故障使用的 `fatal`。
- `retentionDays` 只被读取和保存，没有任何清理、归档或磁盘容量控制代码，因此这个设置实际上没有生效。
- `logEvent()` 使用空 `catch {}`，日志目录不可写或磁盘已满时会静默丢日志。
- 服务启动、JSON 恢复、存储初始化等内容仍直接写 `console.log/error`，不会稳定进入日志文件。
- `post-commit-automation.js` 没有统一 Logger，通常只能看到补查结束摘要，看不到某个项目、某个 Commit、AI 请求、知识写入和状态推进分别在哪一步失败。
- 大部分失败只记录 `error.message`，没有错误类型、错误码、堆栈、原因链、阶段和重试次数。
- 示例中的 `dispatched: 0` 是无工作可做的正常诊断信息，却被记为 `info`；这种消息多了以后会淹没真正有价值的事件。
- 日志页面默认把 `dateFrom` 和 `dateTo` 都设置成当天，因此用户默认只能看到今天的日志，容易误以为历史日志没有保存。
- `readLogs()` 会同步读取匹配目录中的所有日志、全部解析和排序后才截取 500 条；日志长期积累后会阻塞服务并越来越慢。
- 界面存在两套日志列表表现，其中一套只有 `warn/error` 文字颜色，另一套所有等级基本同色；日志详情只是原始 JSON，没有直接突出错误阶段和调用链。
- 当前测试只验证“保存日志设置后能查到一条 `logging_config_updated`”，没有验证等级、关键流程覆盖、写入失败、长期保留、轮转、分页和历史查询。

#### 统一 Logger 和等级规则

保留轻量 JSONL 方案，不为日志再引入一个复杂数据库。把 `structured-logger.js` 重构成唯一的 `Logger` 服务，业务模块通过依赖注入或 `logger.child(context)` 使用它：

```text
logger.trace()
logger.debug()
logger.info()
logger.warn()
logger.error()
logger.fatal()
```

除 Logger 自己在日志写入失败时使用的最终控制台回退外，业务模块不再直接调用 `console.log/warn/error`。

等级语义和界面表现固定如下：

| 等级 | 使用场景 | 界面颜色 |
| --- | --- | --- |
| `trace` | 极细粒度内部步骤，默认关闭 | 灰色 |
| `debug` | 无状态变化的诊断信息、路径解析、无待处理 Commit、缓存命中 | 青色 |
| `info` | 导入成功、分析开始/完成、状态推进等有意义的正常状态变化 | 蓝色或绿色 |
| `warn` | 自动恢复、重试、降级、部分成功、即将达到容量限制 | 黄色或橙色 |
| `error` | 单次操作失败，但主程序仍可继续运行 | 红色 |
| `fatal` | 配置或数据损坏导致程序无法继续、未捕获异常 | 深红底色 |

- 默认开启 `info`、`warn`、`error`、`fatal`；`debug` 和 `trace` 可在设置中启用。
- 颜色之外还要显示等级文字和图标，不能只靠颜色区分。
- 相同事件必须使用稳定事件名，例如 `project.import.started`、`commit.analysis.failed`，不能随意改变消息文本来代替事件类型。

#### 日志记录结构

升级为 `log/v2`，核心诊断字段不能全部塞进含义不清楚的 `meta`：

```json
{
  "schema": "log/v2",
  "id": "唯一日志 ID",
  "ts": "2026-08-17T10:20:30.000Z",
  "level": "error",
  "component": "commit-reconciler",
  "event": "commit.analysis.failed",
  "message": "Commit analysis failed during AI request",
  "projectId": "稳定项目 ID",
  "projectSlug": "用于显示的 Slug",
  "operationId": "一次完整操作的关联 ID",
  "jobId": "后台任务 ID",
  "runId": "分析运行 ID",
  "commitSha": "对应 Commit",
  "phase": "ai-request",
  "attempt": 2,
  "durationMs": 15342,
  "error": {
    "name": "Error",
    "code": "ETIMEDOUT",
    "message": "request timed out",
    "stack": "...",
    "cause": "..."
  },
  "context": {}
}
```

- 一次项目导入、一次启动补查和一次 Commit 分析各生成一个 `operationId`；该操作下的所有日志必须沿用它。
- 每个开始事件必须有对应的完成或失败事件，并保存 `durationMs`。只有开始、没有结束的操作可以在下次启动时被识别为异常中断。
- 项目相关日志必须写 `projectId`；有 Commit 时必须写 `commitSha`；有 AI 运行时必须写 `runId`。
- 错误对象保留 `name`、`code`、`message`、`stack` 和 `cause`，同时对路径和错误文本做长度限制。
- 日志必须统一脱敏，不能写入 AI 密钥、Git Token、OAuth Secret、完整请求头或其他凭据。AI 提示词和完整 Diff 也不直接写日志，只记录长度、哈希和相关文件数量。

#### 必须覆盖的真实业务链路

| 链路 | 至少需要的日志 |
| --- | --- |
| 程序生命周期 | 启动开始、配置/迁移结果、监听成功、正常退出、未捕获异常、未处理 Promise 拒绝 |
| 项目导入 | 参数校验、路径确定、Git 检查/初始化、知识库创建、Hook 安装、项目登记、成功或回滚失败 |
| Git Hook | Hook 收到 Commit、通知成功、服务未运行的降级结果、Hook 脚本错误 |
| 启动补查 | 补查开始、每个项目的待处理数量、跳过原因、补查结束；全部为 0 的摘要使用 `debug` |
| Commit 分析 | Commit 发现、任务入队、开始、需求关联、Diff 准备、AI 调用、输出校验、知识写入、索引更新、状态推进、成功或失败 |
| AI 调用 | 配置和模型标识、开始、耗时、重试、限流/超时/协议错误；不记录密钥和完整提示词 |
| 知识与索引 | Markdown 原子写入、索引开始/完成、写入条数、失败和回滚 |
| 配置与迁移 | 设置变更、旧配置迁移、数据库迁移、备份与验证结果 |
| 项目删除 | 运行任务检查、Hook 卸载、内部数据删除、外部知识库保留或删除选择、最终结果 |

`reconcileProjectCommits()` 要接收带上下文的 Logger。不同项目可以并行写各自的项目日志，同一 Commit 的各阶段通过相同 `operationId`、`runId` 和 `commitSha` 串起来。

#### 长期保存、轮转和故障保护

日志路径不再让用户任意修改，统一由 `StorageLayout` 返回：

```text
~/.project-knowledge/logs/
├─ app/YYYY-MM-DD.jsonl
├─ hooks/YYYY-MM-DD.jsonl
└─ projects/<project-id>/YYYY-MM-DD.jsonl
```

- 每日轮转；单个文件达到 50 MiB 时继续写入 `YYYY-MM-DD.001.jsonl`，防止单文件过大。
- 默认保存 365 天；`retentionDays: 0` 表示不按时间删除，满足需要长期保留全部历史的场景。
- 增加 `maxTotalSizeMB`，默认 2048 MiB。接近上限时写 `warn`；达到上限时优先清理最旧的 `trace/debug` 文件，再按明确策略处理旧文件，不能突然删除新错误日志。
- 清理任务在程序启动后和每天固定时间运行一次，输出被删除文件、释放空间和剩余范围；`retentionDays` 不再是无效配置。
- 程序更新或重装不能删除数据目录下的日志。项目删除默认保留该项目日志，并在日志中标记项目已删除；由独立的清理设置决定何时移除。
- Logger 使用单一写入队列，保证一条 JSON 不会被并发写坏；关闭程序前刷新队列。`error/fatal` 写入失败时必须回退到 `stderr` 并在界面状态中显示“日志系统异常”，不能空 `catch`。
- Hook 在主程序未运行时写入独立的 `hooks` 日志，主程序下次启动后仍能读取，不能影响 `git commit` 成功。
- 旧的按天 `.log` 文件不立即删除；读取器在迁移期同时支持 `.log` 和 `.jsonl`，确认新系统稳定后再按统一保留策略处理。

#### 日志 API 和界面

把 `/api/logs` 改为按时间倒序扫描匹配日期文件并使用游标分页，不能先把多年日志全部载入内存：

```text
GET /api/logs?from=&to=&levels=&projectId=&component=&event=&operationId=&q=&pageSize=&cursor=
```

- 默认查询最近 7 天，不再把开始和结束日期强制设为今天。
- 后端从最新文件向旧文件扫描，达到 `pageSize` 就停止并返回 `nextCursor`；默认每页 100 条。
- 支持按等级、项目、组件、事件、Commit、`operationId` 和全文关键字过滤。
- 日志列表只保留一套组件，删除当前两套重复实现。
- 顶部显示各等级数量，支持自动刷新/暂停、日期范围、项目、组件和等级筛选。
- 每行显示时间、彩色等级、项目、组件、事件、阶段、消息和耗时；`error/fatal` 行使用明显但可读的背景或左边框。
- 详情面板优先展示操作链路、Commit、阶段、耗时和错误堆栈，再提供完整 JSON；支持复制单条日志和复制 `operationId`。
- 时间在文件中统一保存 UTC，界面按本机时区显示，并允许查看原始时间。
- 可导出指定日期范围和项目的诊断日志；导出前继续执行同一套凭据脱敏规则。

#### 日志迁移顺序

1. 把旧 `logging.json` 的有效等级和保留天数迁移到 `settings.json.logging`；旧的自定义日志目录只作为迁移来源，不再作为长期可编辑设置。
2. 新 Logger 先同时读取旧 `.log` 和新 `.jsonl`，保证升级后历史日志仍可查询。
3. 把 `.hook-trigger-errors.log` 迁移或归档到 `logs/hooks/`，保留原始时间和内容。
4. 所有关键业务模块接入新 Logger 并通过覆盖率测试后，才删除散落的 `console.*` 和旧 `logEvent()` 包装。
5. 迁移失败只记录警告并继续保留旧文件，不得因为日志迁移阻止知识库主功能启动。

## 5. 测试修改

重点修改这些测试：

- `_site/_test/post-commit-automation-test.js`
- `_site/_test/pending-sweep-test.js`
- `_site/_test/scanner-test.js`
- `_site/_test/tracking-start-test.js`
- `_site/_test/hook-trigger-test.js`
- `_site/_test/hook-runtime-endpoint-test.js`
- `_site/_test/simple-import-test.js`
- `_site/_test/knowledge-store-test.js`
- `_site/_test/knowledge-storage-location-test.js`
- `_site/_test/structured-logger-test.js`
- `_site/_test/logging-api-test.js`
- `_site/_test/logging-ui-test.js`
- 扩充 `_site/_test/knowledge-store-logs-supervision-test.js`，不能只验证一条设置日志
- `bin/project-knowledge-kb.js` 与服务端路径一致性测试
- 新增用户需求记录与 Commit 关联测试
- 涉及 `/automation/simulate`、`/automation/init`、`/hook-install`、`/hook-uninstall` 的 UI/API 测试

必须通过以下场景：

1. 程序运行时提交 Commit，Git Hook 立即触发一次分析。
2. 程序关闭时提交多个 Commit，提交过程不报错；下次启动后全部补上。
3. 新项目导入和第一次启动都不执行初始化分析，只建立 `trackingStartCommit`。
4. 重复启动且没有新 Commit 时，不重复分析。
5. 同一个 Commit 被 Hook 和启动补查同时发现时，只分析一次。
6. 项目导入完成后不会立即启动分析。
7. 两个手动分析接口已经不可用。
8. Hook 实时发现和启动补查发现的 Commit 使用同一个提示词。
9. 多个遗漏 Commit 严格按时间顺序逐个分析，并逐个更新 `lastAnalyzedCommit`。
10. 有用户需求时，知识库同时记录需求和实际实现；没有可靠需求时，不推测需求。
11. 项目中不再存在 `DEFAULT_INIT_PROMPT_TEMPLATE`、`renderProjectInitPrompt()` 和可触发的 `dispatchProjectInit()`。
12. 导入项目会自动安装 Hook，并确认 Hook 指向真实存在的 `_site/scripts/hook-trigger.js`。
13. Hook 安装失败时，项目导入失败，不会出现“项目成功、Hook 失败”的半完成状态。
14. 删除项目会自动卸载本系统 Hook，不需要用户先操作 Hook。
15. 手动安装、重新安装和卸载 Hook 的接口及按钮已经不存在。
16. 移动项目目录后，Hook 使用运行时仓库路径，仍能发送正确的项目地址。
17. 已有错误路径的本系统 Hook 在版本升级后只自动修复一次。
18. Hook 安装和卸载不会创建、修改或删除 `CLAUDE.md`。
19. 两个项目同时完成分析时，各自的 `lastAnalyzedCommit` 都能正确保存，不会互相覆盖。
20. 同一个项目被 Hook 和启动补查同时发现时，只运行一个补查流程，并按顺序更新状态。
21. 写入 `state.json` 过程中程序中断时，原文件仍然完整有效。
22. 旧版 `projects.json` 可以一次性迁移为项目索引和单项目文件，原有 Commit 位置不会丢失。
23. 项目改名或移动路径后仍沿用原 `projectId`，不会产生第二份项目状态。
24. 未设置或无法写入 `knowledgeRootPath` 时，前端和后端都拒绝导入项目。
25. 先设置根目录再导入项目时，项目知识库创建在该根目录的固定子目录中，导入过程不再次要求选择路径。
26. 两个项目导入后使用不同的知识库子目录，并分别把最终绝对路径保存到自己的 `config.json`。
27. 修改全局根目录后，旧项目仍使用原路径，新导入项目使用新根目录。
28. 项目显示名称改变后，`projectId`、知识库目录名和 `knowledgePath` 都不改变。
29. 用户选择的知识库根目录中只出现知识 Markdown，不出现 `.project-knowledge`、LanceDB、日志或模型缓存。
30. `server.js`、MCP、`knowledge-tool-runtime.js` 和 CLI 得到完全相同的知识库路径与索引路径。
31. 目标知识库目录与其他项目冲突时导入明确失败，不覆盖已有文件。
32. 导入中途失败时，项目索引、单项目文件、Hook 和本次新建目录都按事务规则回滚。
33. 删除项目默认保留外部 Markdown 知识库；只有明确选择时才删除。
34. `knowledge-store.json`、`ai-profiles.json` 等旧配置可以一次性合并到 `settings.json`，AI 密钥值保持不变。
35. 已有项目的旧 `kbPath` 原样迁移为 `knowledgePath`，不会被当前全局根目录重新计算。
36. 向量数据库成功迁移到内部 `index/` 后，设置知识库根目录不会再移动它。
37. 未使用团队、恢复或缓存功能时，不生成对应的空配置文件和目录。
38. 六个日志等级都按固定规则过滤，界面在浅色和深色主题下显示对应颜色、文字和图标。
39. 没有待处理 Commit 的启动补查记录为 `debug`；有实际处理或状态变化时才记录 `info`。
40. 项目导入成功和失败都能通过同一个 `operationId` 还原路径解析、Git、知识库、Hook、登记和回滚阶段。
41. 每个 Commit 的发现、AI 调用、知识写入、索引和状态推进日志包含相同的 `projectId`、`runId`、`commitSha` 和 `operationId`。
42. 操作失败日志包含错误类型、错误码、堆栈、阶段、耗时和原因链，而不是只有一行 `error.message`。
43. 日志目录不可写或磁盘模拟满时，Logger 不会静默吞错，会回退到 `stderr` 并报告日志系统异常。
44. 程序异常退出后，已经完成写入的日志保持合法 JSONL；下次启动能够识别只有开始而没有结束的操作。
45. 程序重启、升级和项目删除后，历史日志仍按保留策略可查询。
46. 默认查询最近 7 天，并可使用游标连续读取多页；读取多年日志时不会一次加载和排序全部文件。
47. 默认 365 天保留、`retentionDays: 0` 和 `maxTotalSizeMB` 三种策略都按定义工作，清理结果可追踪。
48. 单日日志超过 50 MiB 时正确分段，跨分段查询顺序和过滤结果仍然正确。
49. 主程序未运行时 Hook 错误写入 `logs/hooks/`，不影响 Commit；下次启动可以查询这条记录。
50. 旧 `.log`、`.hook-trigger-errors.log` 和 `logging.json` 迁移后仍能读取，迁移不会删除原始历史。
51. API Key、Token、OAuth Secret、请求头和其他凭据不会出现在普通日志、错误堆栈或导出文件中。
52. 日志页面只保留一个实现，等级颜色、筛选、自动刷新、操作链路和错误详情都有 UI 回归测试。

## 6. 完成标准

改造完成后，整个项目中只有下面两个公开入口能够启动知识库分析：

```text
Git Hook       -> handlePostCommitEvent()
程序启动补查   -> dispatchPendingAutomations()
```

两者最终必须进入同一个 `reconcileProjectCommits()`，并对每个 Commit 使用同一套提示词，不能各自保留一套分析逻辑。

新项目从导入之后的第一个新 Commit 开始形成知识；任何知识都应尽量同时具备“用户为什么要改”和“代码实际上怎么改”这两类依据。

Git Hook 生命周期只有一条公开规则：项目导入自动安装，项目删除自动卸载。用户不需要也不能通过独立按钮管理 Hook；异常信息必须直接显示在导入或删除结果中。

项目数据也只有一条并发规则：多个项目可以并行分析，但每个项目只写自己的状态文件；单个项目内部必须按 Commit 顺序串行处理。`projects.json` 不再保存频繁变化的分析状态。

知识库路径也只有一条公开规则：用户先在设置页面选择全局知识库根目录，再导入项目；系统为新项目生成并固定实际知识库路径。导入时不重复选择，修改全局根目录不影响旧项目。

`~/.project-knowledge` 只保存软件设置、项目元数据和内部派生数据；用户选择的知识库根目录只保存真正的项目知识文件。所有运行入口使用同一个路径解析模块，不能再出现服务端、MCP 和 CLI 各自采用不同路径的情况。

日志系统也只有一个实现：所有业务模块写入统一 Logger，关键操作都有开始、完成或失败记录，并能通过 `operationId`、项目和 Commit 串成完整链路。日志默认长期保存在内部数据目录，支持真实生效的轮转、保留、容量保护、分页查询和等级颜色，不能再出现“只看到当天几条无意义汇总日志”或日志写入失败却完全无提示的情况。
