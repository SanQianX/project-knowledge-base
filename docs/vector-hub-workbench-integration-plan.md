# 集成分析：vector-hub 与 claude-ai-workbench 替换现有两模块

> 生成日期：2026-09-19。基于对三个代码库的实际探索（非推测）。
> 现状基线：project-knowledge-base 4.2.15。

## 0. 结论（TL;DR）

两个新模块形态完全不同，不能用同一种方式集成：

- **vector-hub → 直接替换 GROUP B（向量库模块）的内层**。接缝选在
  `RuntimeIndexAdapter`（server-app.js:265）与 `KnowledgeToolRuntime` 的私有实例
  （knowledge-tool-runtime.js:190-222），保留 `KnowledgeRetrievalService` 的
  "Markdown 为真相"外壳与全部对外契约（HTTP/MCP/CLI）。索引是派生物，
  **无需数据迁移**，切换后全量重建即可。
- **claude-ai-workbench → 只能替换 GROUP A（对话模块）的"终端/驱动"半边**。
  它是 live 驱动型终端（主动发起会话），而 pkb 对话模块的核心是**被动采集 +
  git commit 边界绑定**——workbench 没有这个能力（无 bridge、无 commit 字段、
  无时间/文本查询）。所以：workbench 以独立进程接入并替换
  `claude-cli-runner` + `/api/claude/sessions*`；`ConversationStore`、
  `CommitConversationBinder`、bridge 被动采集**保留**，新增一个
  AgentTerminalIngestor 把终端会话规约进 ConversationStore。

注意：`D:\SanQian.Xu\knowledge\claude-ai-workbench` 是文档库（minimal-kb/v1，
内容停留在 v0.2.x）；**真实仓库在 `D:\SanQian.Xu\claude-ai-workbench`**，v0.3.0，
Agent Terminal 是 0.3.0 新增的。集成以真实仓库为准。

---

## 1. 新模块形态盘点

### 1.1 claude-ai-workbench v0.3.0（真实仓库）

- npm workspaces monorepo，5 个包（contracts/client/core/ui/server），唯一运行时依赖
  `@anthropic-ai/claude-agent-sdk`；HTTP 用原生 node:http，持久化为纯 JSON。
- **形态**：`createWorkbenchServer(options)` 库嵌入 / `agent-terminal-server` CLI
  （默认 127.0.0.1:5760，数据目录 `~/.agent-terminal`）/ REST+SSE API
  `/api/claude-workbench/v1`（完整契约 docs/sdk/openapi.yaml）/ 浏览器 SDK。
- **能力**：驱动 claude-code（agent-sdk）、codex（app-server JSON-RPC 或 cli --json）、
  opencode（serve HTTP 或 run --json）、**zcode**（GLM app-server，新agent）四类会话，
  所有事件归一化为带序号的 `claude/*` 事件流。
- **存储**：`projects.v1.json`、`profiles.v2.json`、`credentials.v1.json`、
  `archived-sessions.v1.json`、`cli-sessions/<sessionId>.json`（≤5000 events，
  防抖落盘）、`attachments/`、`audit.jsonl`。
- **硬缺口**（对 pkb 而言）：
  1. 无被动采集（只记录自己托管的会话）；
  2. **无任何 git commit 概念**（grep "commit" 在 packages/ 下零命中）；
  3. 查询只有 listSessions(contextId) + 单会话快照 + SSE 回放，无时间范围/文本检索；
  4. 与 `@sanqianx/ai-coding-event-bridge` 零关联。

### 1.2 vector-hub v0.1.0

- TypeScript 双格式库（CJS+ESM），唯一运行时依赖是 vendored Vectra 0.15.0
  （`file:packages/vectra`）。`engines: node>=22`（本机 v24 满足；pkb 无 engines 限制）。
- **分层**：纯库核心 `VectorHub`（零 HTTP）→ 可选 HTTP 层 `createServer(manager)`
  （:8787）→ CLI（serve/sync/watch）→ 静态控制台 UI。
- **核心 API**：`new VectorHub({rootPath, embeddings, storage?})`，
  `upsertDocument / deleteDocument / search / listProjects / syncFolder / watchFolder /
  deleteProjectIndex`；escape hatch `getProjectIndex()` 直接拿 vectra
  LocalDocumentIndex。
- **embedding**：默认远程 **MiniMax `embo-01`（1536 维，中文一流，db/query 非对称）**，
  或任意 OpenAI 兼容端点；vectra 自带 TransformersEmbeddings/LocalEmbeddings
  （本地 ONNX）但**未接入 HubManager**，只能库模式手工传。
- **检索**：cosine，`isBm25:true` 时 BM25+语义混合（失败自动回退纯语义）；跨项目
  并行扇出按分数合并；结果 `{project, uri, score, snippet, docType, tags, startPos,
  endPos, ...}`。
- **存储**：`<rootPath>/<project>/` 每项目一目录（index.json 向量 + catalog.json +
  文档 .txt），无外部 DB 进程；内容哈希使未变文档 upsert 为 no-op。
- **理念一致**：源文件夹是唯一真相，向量索引是可重建缓存（换模型 → 删目录 → 重同步）
  ——与 pkb 的 "authoritative Markdown; LanceDB is one rebuildable derived index" 完全同构。
- 与 pkb 零代码耦合；`kb-sync.ts` 的 frontmatter(docType/tags/modules) 约定与 pkb 的
  知识库布局兼容。

---

## 2. 必须冻结的对外契约（集成不能破坏的面）

| 契约 | 位置 |
| --- | --- |
| HTTP 路由 | `/api/knowledge/{search,ask,entry,history,maintenance}`、`/api/conversations/{projects,turns}`、`/api/claude/sessions*`、`/api/bridge/{notify,status}`、`/api/hooks/post-commit`、`/api/ai-profiles`（server-app.js:843 起的 if/else 链） |
| MCP 工具 | `project_knowledge_{resolve,record_requirement,search,ask,get,history}`（bin/project-knowledge-mcp.js:129-137） |
| CLI | `project-knowledge-kb search/ask/get/history` |
| commit 流水线内部契约 | `CommitReconciler.prepareClaim` → `retrieveForCommit`（冻结 manifest + sha256 校验，knowledge-retrieval-manifest/v1）→ `CommitConversationBinder.bind`（commit-conversation-snapshot/v1）；`ANALYSIS_PHASES` 的 `index.queued/applied` |
| 运行时数据布局 | `<dataDir>/index/`（索引位置将变）、`runtime/runs/<projectId>/<runId>/input/retrieval/`、`runtime/index-sources/<projectId>.json`、conversation-events JSONL |
| UI 消费 | ui/app.js 调 `/api/conversations/*` 与 `/api/claude/sessions*` 全家桶 |

---

## 3. GROUP B 集成方案（vector-hub）

### 3.1 接缝与替换点

替换内层实现，保留检索服务外壳：

```
HTTP/MCP/CLI ──> KnowledgeToolRuntime ──> KnowledgeRetrievalService   [保留]
                                              ├─ scanCurrent()        [保留：Markdown 真相路径]
                                              └─ recallIndex()        [改写：vector-hub 替代 embedQuery+hybridSearch]
IndexService ──> RuntimeIndexAdapter.indexProject                     [改写：vector-hub upsert 替代 LanceDB 写入]
```

具体改动点：
1. **server-app.js `RuntimeIndexAdapter`（:265-361）**：内部改为持有 `VectorHub`
   实例；`indexProject` 走 `upsertDocument`（整文档，让 vector-hub 分块）；
   `buildFull` 改为"新目录建索引 + 校验 + 原子改名"（对应现有全量重建语义）。
2. **knowledge-tool-runtime.js（:190-222）**：删掉自建的 `KnowledgeDatabase` +
   `LocalEmbeddingService`，改为共享同一个 VectorHub 适配器（现状是两处各建各的，
   顺手收敛）。
3. **knowledge-retrieval-service.js `recallIndex`（:172-185）**：
   `embedQuery`+`hybridSearch` 替换为 `hub.search(query, {projects:[projectId],
   isBm25:true, ...})`；结果映射回现有 `{uri, score, snippet}` 形态以维持
   manifest 兼容——**若 shape 有实质变化，bump knowledge-retrieval-manifest 版本**
   （commit 完整性校验依赖 hash）。
4. **删除依赖**：`@lancedb/lancedb`、`@huggingface/transformers`（合计体积大头）。

### 3.2 两条实现路线（推荐 A 起步）

- **路线 A：文档级 upsert**。`hub.upsertDocument({project, uri, text, docType,
  metadata})`，分块交给 vectra TextSplitter（512 token、markdown 感知）。
  优点：最少代码、天然获得 BM25 混合与内容哈希去重；缺点：CHUNKER_VERSION 失去
  意义、pkb 自己的 chunk 元数据（entryType/scope/title）不再逐块生效（docType/tags
  仍可透传）。由于检索本来就以 scanCurrent 的 Markdown 重切块为主信号，索引只是
  recall 叠加，可接受。
- **路线 B：chunk 级写入**。经 `hub.getProjectIndex()` 直用 vectra
  LocalDocumentIndex，把 pkb 自己 chunkMarkdown 的结果按 chunk upsert，元数据全保留。
  优点：保留现有 chunker 语义与逐块元数据；缺点：绕过 VectorHub 抽象、代码更多、
  BM25 需要自建。
- 若检索质量评估（见 3.5）路线 A 不达标，再降级到 B。

### 3.3 项目映射与配置映射

- 项目名：pkb `projectId` → vector-hub project 名。**必须先核对
  `VectorHub.isValidProjectName`（禁路径穿越字符）能否接受 pkb 的 projectId 格式**，
  不行则做一层编码映射，并在 storage-layout 中登记新索引路径
  （建议 `<dataDir>/index/vector-hub/<projectId>/`，即 `rootPath=<dataDir>/index/vector-hub`）。
- 配置：`settings.embedding.{modelId,remoteHost,localModelPath,localFilesOnly}`
  → 新 `settings.retrieval.{provider:'minimax'|'openai', apiKey, model, endpoint}`；
  migration-service 里 legacy `embedding-config.json` 的迁移逻辑同步改写。
  env：`KB_EMBEDDING_FAKE` → `VECTOR_HUB_EMBEDDINGS=mock`（测试用 mock embeddings）。
- 依赖方式：`file:../vector-hub`（开发期）或 npm pack 私发。**注意 vector-hub 的
  vectra 依赖是 `file:packages/vectra`，npm pack 出的 tarball 能否正确携带 vendored
  包需要实测**（`npm run verify` + 在干净目录 install 试装）。

### 3.4 数据迁移

无需迁移。索引是派生物：切换版本后对每个项目执行
`POST /api/knowledge/maintenance/rebuild`（全量重建，vector-hub 侧等价于重新
sync/upsert），旧 `<dataDir>/index/knowledge.lancedb` 保留一个版本周期后删除。
embedding 维度 512→1536 与 chunk 语义变化都随重建自然生效。

### 3.5 质量与回归验证

- 用 vector-hub 自带的 `scripts/eval-golden.ts`（hit@1/hit@3/MRR）对 pkb 真实知识库
  语料跑基线，对比现有 LanceDB hybrid 的召回。
- pkb 测试面改造：`knowledge-db-test.js`、`embedding-config-test.js`、
  `knowledge-retrieval-service-test.js`、`knowledge-maintenance-test.js`、
  `index-writer-concurrency-test.js` 等改为跑 vector-hub 适配器 + mock embeddings；
  desktop 侧 `packaged-model-smoke.cjs`/`packaged-smoke.cjs` 引用了打包后的
  embedding-service/knowledge-db 路径，需要同步更新。

### 3.6 GROUP B 主要风险

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| **离线/隐私能力丢失** | 现默认本地 ONNX `bge-small-zh-v1.5`（512 维，零网络）；vector-hub 默认远程 MiniMax API（要 key、要网络、语料出本机） | 如需离线：库模式传入 vectra `TransformersEmbeddings`（需验证中文模型质量与 `HubManager.saveSettings` 换模型自动重建的兼容）；或 settings 提供本地 provider 分支 |
| manifest 完整性 | retrieveForCommit 结果 shape 变化会破坏已冻结 run 的校验 | 结果映射回旧 shape 或 bump manifest 版本号 |
| vendored vectra 打包 | file: 依赖嵌套，发布链路未验证 | npm pack + 干净目录 install 实测 |
| 检索质量回退 | 分块 512 token/GPT-3 BPE vs 现有 chunker | eval-golden 基线对比；不达标走路线 B |

---

## 4. GROUP A 集成方案（claude-ai-workbench）

### 4.1 职责对齐：现有 GROUP A = 四块能力

| 现有能力 | 现有实现 | workbench 对应物 | 处置 |
| --- | --- | --- | --- |
| 交互终端（会话驱动/SSE/权限/中断） | claude-cli-runner + `/api/claude/sessions*`（仅 Claude Code） | WorkbenchService + 4 agent 驱动（claude-code/codex/opencode/zcode）+ REST/SSE | **替换** |
| 被动采集外部会话 | bridge hooks → journal → BridgeConsumerService → ConversationStore | 无（只记录自托管会话） | **保留 bridge 链路** |
| commit 边界与会话绑定 | hook-trigger → writeBoundary → CommitConversationBinder → snapshot → claim | 无 commit 概念 | **保留**，新增终端摄取源 |
| 对话查询 | ConversationQueryService（按项目/日期/游标翻页） | 仅 listSessions+单会话 | **保留**，数据源不变 |

### 4.2 部署形态：独立进程（推荐）

`agent-terminal-server` 作为独立本地服务（127.0.0.1:5760，`~/.agent-terminal`），
生命周期与 pkb 解耦（终端会话不因知识库服务重启而中断）。

- pkb 的 `/api/claude/sessions*` 路由改为对 terminal API 的**薄代理**（用
  `@claude-ai-workbench/client` SDK），对外路径与响应形状保持不变，ui/app.js 零改动；
  或后续把前端直接指向 terminal（其 API CORS 已放开，folder-picker 类敏感端点限
  loopback）。
- 备选：`createWorkbenchServer` 进程内嵌入 pkb server（少一个进程），代价是 pkb
  重启即断终端会话、且要处理 maxSessions(50)/maxConcurrentRuns(4) 与 pkb 生命周期
  的耦合。除非有强理由，不推荐。

### 4.3 新增：AgentTerminalIngestor（关键缺口补齐）

与 `BridgeConsumerService` 并列的新摄取器，让终端里发生的对话也进入
ConversationStore、从而被 commit 绑定与查询服务看到：

1. **项目映射**：terminal `ProjectStore` 的 `projectPath` ↔ pkb 项目工作区根路径
   （与 bridge 的 exact workspaceId 匹配同一原则：只按路径精确匹配，不猜）。
2. **摄取方式**：定期 `listSessions(contextId)` 增量扫描 + `subscribe` SSE 追事件，
   会话到终止态时把 `claude/*` 事件流规约为 `ai-coding-event/v1`
   （user_prompt / assistant_response；text-delta 聚合、tool-use 侧写），
   `conversationStore.appendBridgeEvent` 写入。
3. **commit 链路不变**：git post-commit → hook-trigger → `/api/hooks/post-commit` →
   `drainThrough` + `writeBoundary` → binder 冻结 snapshot。终端摄取发生在边界之间
   即可被正确圈定。
4. **去重（重要坑）**：bridge 给工作区装了 Claude Code hooks——terminal 在同一工作区
   驱动 claude 时，**同一会话会被 bridge hooks 再采一遍**，双写。terminal spawn 子
   进程时注入 `AI_CODING_EVENT_BRIDGE_CAPTURE=0`（现有 claude-cli-runner.js:384 同款
   手法），或 ingestor 侧按 sessionId 去重。zcode/codex/opencode 的驱动是否命中
   bridge 采集面需逐个核实（codex notify、opencode plugin 只装在被装过的机器上）。
5. **conversation-exclusions 扩展**：现有 Codex turn repair 逻辑要为 zcode 事件
   词汇增加归一化分支。

### 4.4 AI Profile 双源问题

pkb `settings.ai`（`/api/ai-profiles` 读写 settings-store）与 terminal
`profiles.v2.json` + `credentials.v1.json` 是两套 profile。二选一作为唯一源：

- **推荐 terminal 持有**（它要做模型探测、凭据测试、mid-session 换绑），
  pkb 的 `/api/ai-profiles` 改为代理；`ai-profile-resolver` 的
  `resolveEffectiveAiProfile`（server-app :399/:1277、commit-reconciler :351、
  analyzer 自动会话用）改为从 terminal 读。
- `ai-vendor-presets.js` 已是死代码（零生产调用方），直接删除。

### 4.5 历史数据迁移

旧 workbench 会话（`<dataDir>/_ai/<slug>/claude-workbench/*.json`，
schema `claude-workbench-session/v1`）可写一次性导入器进 terminal 的
`cli-sessions/` 或直接进 ConversationStore。量小可不做，仅保留只读归档。

### 4.6 GROUP A 主要风险

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 双写/重复采集 | bridge hooks 会捕获 terminal 驱动的 claude 会话 | spawn 注入 CAPTURE=0 + sessionId 去重 |
| commit 绑定断链 | 终端会话若摄取延迟跨过 commit 边界，snapshot 圈不全 | ingestor 在 post-commit 的 drainThrough 中也触发一次同步（与 bridge 同语义） |
| 事件语义差异 | claude/* 事件流 ≠ ai-coding-event/v1（turn 边界、role 判定） | 规约层放 conversation-exclusions 同级，单测覆盖 codex-conversation-projection-test 模式 |
| 进程编排 | terminal 未启动时 pkb 代理路由要优雅降级 | 代理层 health 探测 + 503 语义，UI 提示启动方式 |

---

## 5. 实施顺序建议

**阶段 0（准备，半天）**
- 确认 vector-hub `npm pack` 产物可安装（vendored vectra）；
- 确认 `isValidProjectName` 对 pkb projectId 的兼容性；
- 冻结第 2 节契约清单为回归测试基线（现有 `_site/_test/` 已覆盖大半）。

**阶段 1（vector-hub，先做——风险低、无数据迁移）**
1. 新建 `vector-hub-adapter.js`（实现 indexProject/search/close 接口，mock 注入口）；
2. 改 `RuntimeIndexAdapter` 与 `KnowledgeToolRuntime` 指向适配器；
3. settings/迁移/env 映射；重建 API 冒烟；
4. eval-golden 对比基线，达标后删 `@lancedb/lancedb`+`@huggingface/transformers`
   与 `knowledge-db.js`/`embedding-service.js`/`knowledge-schema.js` 中死代码；
5. 全量测试 + desktop 打包冒烟。

**阶段 2（claude-ai-workbench）**
1. 起 terminal 独立服务，`/api/claude/sessions*` 改代理（对外形状不变）；
2. 实装 AgentTerminalIngestor（含去重与 post-commit 联动）；
3. profile 收敛到 terminal，删 ai-vendor-presets；
4. claude-cli-runner 退役（analyzer 自动会话迁移到 terminal 的
   `registry.asRunner()` 或保留 SDK 直连——按 RuntimeKnowledgeAnalyzer 改动量定）。

**阶段 3（清理与文档）**
- 旧 LanceDB 目录退役、CHANGELOG/INDEX.md 更新、
  `protected-architecture-gate-test` 等架构门同步。

---

## 6. 关键源码引用速查

- 替换点：`_site/lib/server-app.js:265-361`（RuntimeIndexAdapter）、
  `_site/lib/knowledge-tool-runtime.js:190-222`、
  `_site/lib/knowledge-retrieval-service.js:172-185`（recallIndex）、
  `_site/lib/server-app.js:1271-1322`（claude sessions 路由）、
  `_site/lib/server-app.js:469-475`（BridgeConsumerService 构造）。
- 新模块入口：`D:\SanQian.Xu\claude-ai-workbench\packages\server\index.js:23`
  （createWorkbenchServer）、`D:\SanQian.Xu\vector-hub\src\core\hub.ts:36`（VectorHub）、
  `D:\SanQian.Xu\vector-hub\src\server\manager.ts:80`（HubManager）。
- 对外契约：`bin/project-knowledge-mcp.js:129-137`、`server-app.js:843+`（路由链）、
  `_site/scripts/hook-trigger.js:107`（commit 边界）。

---

## 7. 附：被动采集（bridge）是否需要单独再做一个模块

**结论：不需要新建——它已经是独立模块。** `@sanqianx/ai-coding-event-bridge`
（v0.1.2，node_modules 实测）已包含被动采集的全部采集端：per-agent connectors
（claude-code / codex / opencode 的 hook-entry 与 codex session-parser）、
installers、原子 journal（appendEvent/appendCommitBoundary）、多消费者注册与
cursor 压缩、turn-identity、headless conversation-query。pkb 侧的
bridge-adapter / bridge-consumer-service / ConversationStore / binder 是**消费端**，
承载 pkb 领域逻辑（workspace→project 映射、commit 绑定、排除规则），应留在 pkb。

**边界划分（维持现状即可）：**

| 职责 | 归属 |
| --- | --- |
| hooks/connectors、installers、journal、事件归一化、compaction | bridge 模块 |
| workspace→project 映射、ConversationStore、commit 边界冻结与绑定、查询、排除规则 | pkb |

**当前唯一确认的缺口**：bridge 无 zcode connector。但被动采集依赖 agent 自身的
hook/notify 面（Claude Code hooks、codex notify、opencode plugin）——zcode 若无
等价机制则被动采集本就不可行；而经 Agent Terminal 驱动的 zcode 会话由
AgentTerminalIngestor 覆盖，不需要被动采集。**决策前先确认 zcode 是否存在
hook/notify 机制**，这决定缺口是"没做"还是"不存在"。

**不建议现在重写的原因**：journal 原子性/锁/cursor/compaction 是全系统可靠性
要求最高的机制，重写风险最大、收益最小；hooks 已装在用户机器上，重写需迁移；
且 bridge 不在 vector-hub / workbench 两个集成的关键路径上。

**何时值得做、放哪**（满足其一再启动）：(a) 需要为 bridge 不支持且具备 hook
机制的 agent 增加被动采集面；(b) 出现第二个 journal 消费者导致接口不够用；
(c) 事件归一化需要与 workbench drivers 深度共享。若启动：作为 claude-ai-workbench
monorepo 的 sibling 包（如 `@claude-ai-workbench/capture`），共享 contracts 与
agent 格式知识，保持 appendCommitBoundary / readEvents / ackConsumerCursor /
installers 等 SDK 面兼容，pkb 的 bridge-adapter 仅换加载目标；journal 格式
兼容或提供一次性迁移，installer 幂等重装。

**落到本计划**：阶段 2 不动 bridge，只做 ingestor（含去重与 zcode 事件归一化）；
capture 模块化重写登记为条件触发的后续项。

---

## 8. 已确认的集成决策（2026-09-19，与作者对齐）

1. **历史会话不迁移**。ConversationStore（bridge 采集的对话、commit 边界、快照）
   原地保留，不属迁移范畴；旧 workbench 交互会话
   （`<dataDir>/_ai/<slug>/claude-workbench/*.json`）跳过迁移，原地只读归档。
   新 terminal 会话列表从空开始。切换时避免有正在运行的 analyzer 会话即可。
2. **AI Profile 以 claude-ai-workbench 为唯一源**。terminal 的 ProfileStore
   （profiles.v2.json + credentials.v1.json）持有全部 profile/凭据/模型探测；
   terminal 配好模型即可独立工作。pkb 侧：`/api/ai-profiles` 改为 terminal 代理；
   `resolveEffectiveAiProfile` 改从 terminal 读取（带本地缓存 + terminal 未启动时
   的降级语义）；`settings.ai` 做一次性导入 terminal 后从 settings-store 移除；
   pkb 的 profile 设置 UI 直接复用 terminal 自带的 profile-settings host。
   方向：pkb 依赖 terminal，terminal 不依赖 pkb。
3. **双写去重 + analyzer 会话不采集**。terminal 驱动的用户会话由 ingestor 采集；
   知识库再分析（analyzer 自动会话）的用户输入与 LLM 回复一律不进
   ConversationStore。实现上双保险：spawn 侧 `AI_CODING_EVENT_BRIDGE_CAPTURE=0`
   （堵 bridge hooks），ingestor 侧按会话标记过滤（需 workbench 的 startSession/
   会话持久化记录增加 `kind`/`metadata` 字段——一个小的上游改动）。
4. **commit 边界竞态的解法**：在 `handlePostCommitEvent`（post-commit-automation）
   中，`conversationStore.writeBoundary` 之前**同步**调用
   `ingestor.drain(projectId)`，拉取该工作区全部活跃会话的当前事件
   （经 terminal `loadSession`，读内存态，不受 JSON 落盘防抖影响），
   与 bridge 侧 `drainThrough(journalSequence)` 对称。保证边界写入时两侧数据齐备。

---

## 9. 新系统的 UI 形态（三模块拼装后）

**架构总纲（2026-09-19，作者确认）：壳不创造功能。**
壳（pkb Control Center）只做两件事：**连接**内部模块、把模块的功能**映射**
（投影）到壳的界面上。功能的本体（数据与逻辑）永远在模块里（terminal /
vector-hub / bridge）；壳上出现的每个能力都必须能回答"这是哪个模块的哪个
API/界面的投影"。壳可以保存"连线表"（哪个终端项目 ↔ 哪个索引项目 ↔ 哪个
工作区/知识库路径）——连线本身就是连接层的数据，不违反原则；但壳不自建
第二份功能数据。由此推论：壳的每个按钮都需要模块 API 或 kb:* 协议支撑，
模块侧改动清单是这套架构的地基。

原则：**pkb 的 Control Center 仍是唯一入口和外壳**；agent-terminal 与
vector-hub 控制台作为嵌入视图/管理面挂在后面。用户日常只开一个页面。

| UI 区域 | 现状 | 新形态 | 来源 |
| --- | --- | --- | --- |
| 侧栏 | 项目列表 + 单一导航"Claude Code" | 项目列表 + 导航：Agent 终端 / 知识检索 / 导入项目 | pkb shell 保留 |
| 主视图·对话 | 单 Claude Code 聊天 workbench | **Agent 终端**（4 agent 发现卡片、会话归档、模型/effort/权限/附件、SSE 流式） | 嵌入 `:5760/agent-terminal/`（iframe）或 `<claude-workbench-pane>` Web Component |
| 主视图·知识检索 | 无（只能靠聊天/MCP/CLI） | **语义检索页**：搜索框 + BM25/语义切换 + docType 过滤 chips（目标/架构/变更/模块/索引）+ 项目范围 + 结果列表 + 文档抽屉（markdown 渲染） | 原生页面，走 pkb `/api/knowledge/search`（后端已是 vector-hub）；交互模式照搬 vector-hub 控制台 |
| 设置·AI 模型 | pkb 自有 profile 表单 | **取消壳侧入口**：模型/凭据只在 terminal 自己的界面设置（模型选择器 →「管理模型」，或 :5760/profile-settings 直开）；pkb 后端 resolveEffectiveAiProfile 仍从 terminal 读 profile（数据依赖不变） | 决策 #2 + 壳纯化 |
| 设置·开发对话 | 项目+日期查看器 | 保留不变（数据里多出经 ingestor 进来的 terminal 会话） | ConversationQueryService |
| 设置·向量检索 | （曾计划壳侧代理节） | **取消**：设置内置于 vector-hub 控制台（齿轮移右上角后折叠态也可达） | vector-hub |
| 设置·知识库存储 | 全局知识根目录 + 删除项目 | **取消**：知识地址逐项目在导入②选定（全局根目录仅作导入表单的默认父目录记忆项）；删除项目进右键菜单（保留数据） | 被导入流程 + 右键管理吸收 |
| 设置·日志 | 已有 | 不变（连接层运行记录） | pkb |

**终版设置抽屉（2026-09-19 二次精简）**：**开发对话 / 日志——共两项**。
AI 模型设置的壳侧入口取消（terminal 内「管理模型」即唯一 UI 入口，
后端数据依赖不受影响）；壳上不存在任何模型/检索/存储类设置表单。
| vector-hub 控制台（:8787） | — | 保留为独立运维面（索引维护/重建状态/评测），不做日常入口 | vector-hub |

消失的部分：旧 Claude Code workbench 面板、pkb 自有 AI profile 表单。

**2026-09-19 决策修订（作者确认）**：模块 UI **原样嵌入，不做视觉重绘**。
- Agent 终端视图 = iframe `http://127.0.0.1:5760/agent-terminal/`（原版界面）；
- 知识检索视图 = iframe `http://127.0.0.1:8787/`（vector-hub 原版控制台，含其自带设置）；
- 设置·AI 模型 = iframe `http://127.0.0.1:5760/profile-settings/`（原版 profile 设置；后经二次精简取消壳侧入口，见下方终版设置抽屉）；
- 壳只提供导航/项目列表/导入/开发对话/日志，并为嵌入视图做服务健康探测
  （未启动时显示占位提示与启动命令）。
- 原 §9 表中"知识检索做 pkb 原生视图"的方案作废；交互预览见
  `ui/integrated-ui-preview.html`（已实测：两个原版 UI 经 iframe 嵌入正常渲染）。
- 遗留注意点：iframe 内外主题不一致（模块各有自己的主题体系，深色模式下壳与嵌入
  界面可能不同色，后续可通过 URL 参数/postMessage 做主题同步，属增强项非阻塞项）。

### 9.1 项目列表三重冗余的解法（2026-09-19 补）

问题：壳侧栏、agent-terminal 左栏、vector-hub 控制台各有一份项目列表，分属三套
存储（pkb project-store / terminal ProjectStore ~/.agent-terminal/projects.v1.json /
vector-hub registrations ~/.vector-hub/config.json）。已核实两模块前端均不读
URL 参数、无 postMessage 支持。

两层解法：

1. **数据层（必做）**：项目主数据以 pkb 为唯一源。导入时同步登记到 terminal
   （ProjectStore）与 vector-hub（registration），改名/移除时同步清理；映射关系
   （pkb projectId ↔ workspace path ↔ 项目名）由 pkb 维护。三处列表内容一致，
   由 pkb 保证。
2. **UI 层（推荐，需两个小的上游改动）**：给两模块加"嵌入模式"查询参数——
   - agent-terminal：`?embed=1&project=<id>`——收起左栏的项目管理/归档入口，
     预选指定项目；项目增删只在壳里做。
   - vector-hub：`?embed=1&projects=<name>`——收起项目管理卡片区（保留搜索
     与项目范围选择）；同步/删除等管理操作在独立打开（:8787 直开）时使用。
   - 壳的项目点击 → 以带参 URL 重载对应 iframe；后续可升级 postMessage 免重载。
   - 直开端口时仍是完整界面，嵌入模式不影响独立使用。
   分工：壳的项目列表=管理与导航（导入/移除/切换上下文/对话/日志）；
   内嵌视图=只管当前项目的会话与检索。

不建议砍壳的项目列表（承载管理功能与开发对话的项目过滤）。
预估上游改动量：每模块约 30-60 行（读 location.search + 收起对应区块 + 预选）。

**2026-09-19 进展**：嵌入协议已设计并一度实现（postMessage：kb:sidebar /
kb:select-project / kb:ready / kb:projects + URL 参数 embed/sidebar/project，
origin 限 loopback）；应用户要求回到规划讨论，**两个模块仓库的改动已全部回退**，
实现以补丁暂存于 `docs/embed-protocol-plan/*.patch`，定稿后 `git apply` 即可恢复。
预览页（ui/integrated-ui-preview.html）中折叠按钮为"规划演示"状态。

**决策定稿（2026-09-19，作者确认五点）**：

1. **默认折叠；联动必须可见**。模块项目列表嵌入时默认收起；展开后，在壳上点项目，
   模块内的选中态要肉眼可见地跟着切换——"看得见的联动"是验收标准。
   折叠开关定稿位置：**集成在壳侧栏各模块导航按钮上的 ▤ 小图标**（每个模块
   独立控制自己的列表显隐，点击图标不切换视图）；无独立开关盒、无边缘拉手、
   视图工具条不放。
2. **terminal 侧栏能力前移到壳**。折叠不再只是"藏起来"：历史会话/项目树进入壳的
   项目栏（壳项目条目默认收起会话列表，点击展开选择；归档不展示）。协议相应新增
   `kb:open-session`（壳 → terminal 打开指定会话）。
3. **两模块设置齿轮移位**（模块代码改动）：vector-hub 侧栏底部的齿轮、terminal
   的设置入口统一移到各自主区右上角，避免被侧栏折叠吞掉。
4. **项目一一对应匹配规则**：已定稿，见 §9.2。
5. **联动单向**：壳 → 模块；模块内切换项目不上报回壳。

### 9.2 项目一一对应与壳侧管理（2026-09-19 定稿）

**登记（导入即映射，人选定即映射，不做模糊匹配）**：壳的导入表单收两个地址：
- ① 开发项目地址（git 工作区）→ terminal `POST /projects`
  `{name: <pkb projectId>, rootPath}`——即 terminal「添加项目」按钮背后的 API；
- ② 知识库地址（markdown 根目录）→ vector-hub `POST /api/import`
  `{sourceDir, projectName: <pkb projectId>, watch: true}`——即控制台
  「导入本地文件夹」按钮背后的 API；
- pkb 在项目配置保存映射：projectId ↔ workspacePath ↔ knowledgePath ↔
  {terminalProjectId, vectorHubProjectName}。
- 命名规则：两模块项目名 = pkb projectId（vector-hub 侧须过
  `isValidProjectName`，不合规则改用 slug 并在映射里记真实名）。
- 容错：模块服务未启动时导入不失败（pkb 先登记），模块侧登记进重试队列、
  状态显示"待登记"，服务可用后补做。

**移除项目（默认不清理）**：
- pkb：解除登记，保留知识目录（现有行为）；
- vector-hub：删除索引——源 markdown 永不触碰，天然满足要求；
- terminal：`removeProject` 现状**会连会话一起删**（workbench-service.js:113-120，
  已核实：abort 活动会话 → deleteSession → 清归档）——**需上游新增
  `keepSessions` 选项**（仅解除登记，保留会话记录文件），上游改动清单 +1；
- ConversationStore（bridge + 摄取器沉淀的对话存档）不受任何模块移除影响。

**归档会话**：壳的历史会话行提供"归档"操作 → terminal
`PUT /sessions/:id/archive`（已有 API，terminal 归档按钮背后同一接口）；
归档后不展示（与决策 2 一致）。

**壳的会话列表数据源**：terminal `listSessions(contextId)`。壳与 terminal
跨源（不同端口），直接 fetch 需开 CORS；为不扩大面，走协议扩展：
`kb:list-sessions {project}` → 回发 `kb:sessions {sessions[]}`（postMessage）。

**协议汇总（更新后）**：kb:sidebar / kb:select-project / kb:open-session /
kb:list-sessions → kb:sessions / kb:ready / kb:projects + URL 参数
（embed/sidebar/project）。

**模块上游改动清单（累计）**：① 嵌入协议（两模块，补丁已暂存
docs/embed-protocol-plan/，需补 kb:open-session / kb:list-sessions）；
② 设置齿轮移至主区右上角（两模块）；③ terminal removeProject 加
keepSessions 选项。

**2026-09-19 嵌入协议已实装**：① 已 `git apply` 到两个模块工作区（未提交），
含 kb:sidebar / kb:select-project / kb:ready / kb:projects + URL 参数
embed/sidebar/project；壳预览弃用 CSS 裁切模拟（裁切会在左缘露出控件残影），
改用真实协议：iframe 带 `?embed=1` 默认折叠（模块自身 `display:none`，干净无
残留），▤ 图标发 kb:sidebar，壳项目点击发 kb:select-project，回执驱动
联动状态 chip（已实测：vector-hub 返回"联动: vector-hub"，terminal 对未登记
项目如实返回"未登记"）。kb:open-session / kb:list-sessions 与 ②③ 仍待做。

嵌入方式建议：agent-terminal 用 iframe（完整应用、自带 SSE 与主题，避免重写）；
知识检索做原生视图（pkb 掌握项目上下文与 i18n/主题，且后端路由本来就是 pkb 的）。
注意 iframe 与外壳的主题/语言一致性需要终端侧支持 query 参数或 postMessage 同步。
