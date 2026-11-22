# 记忆组合/五页 UI/自动恢复 实施设计（代码级决策）

日期：2026-11-11。基于交接计划 + 两仓库代码阅读。等待 session-index 5.0.33 发布期间的分析产物。
版本策略：对方 5.0.33/引擎 0.2.8 已占用；本功能版本在启动实施前重新读取 registry 决定（候选 5.0.34 / 0.2.9）。

## 基线快照（2026-11-11 分析时）

- 主仓库 main = `3ede90d`（对方 session-index 已合入，CI 六项绿）；工作区剩 AGENTS.md +8 行（对方未提交）与未跟踪文件。
- 引擎 main = `e9d316c`（0.2.8 已发 next，SRI sha512-IASK3Lzg…）。
- 日常实例：主 36064:5757 / Workbench 20412:5760 / vector-hub 2096:8787 / bridge 39284:8790 / engine 29664:5790，从 `%APPDATA%\npm` 安装目录运行，不占用源码树。

## 引擎侧设计（knowledge-engine）

### Schema v4 迁移（store.js + 新 memory-groups.js）

- `schemaVersion: 3 → 4`。load()：接受 v3（就地迁移到 v4：补 `memoryGroups: []`、组合字段缺省，不动 text 原字节）与 v4；其余报 SCHEMA_UNSUPPORTED。旧引擎读 v4 会自然抛错 = 安全拒绝（计划 §3.11）。
- 迁移在 server 启动 initializeHook（已持有 engine-runtime.lock writer lease + store.load 失败即释放）内完成；写前备份 `engine-state.json.bak-v4`（同目录原子写），迁移记录 `{migratedAt, fromVersion, counts}` 存 state.migration。
- 重复迁移幂等：v4 直接通过；中断恢复 = load 失败保留原文件（原子写已保证全有/全无）。
- memory 记录新增可选 `title`（string ≤120）；v4 校验放宽 manual text 上限 2000 → 8000（load 与 create/update 同步）。无 title 的旧记录仅在读取投影时生成展示标题（首行/前 40 字符），不回写。
- 新组合实体 `state.memoryGroups[]`: `{ id: 'group-<uuid>', brainId, name (1–80 唯一/brain、大小写不敏感), memberMemoryIds: [], boundProjectIds: [], revision: 1, createdAt, updatedAt, deletedAt: null }`。
  - 关系存于组合实体（全量 state 常驻内存，双向查询成本可忽略）；唯一性由成员/绑定数组去重保证。
  - 删除组合 = `deletedAt` 标记 + 清空两数组（tombstone 语义与 memory 一致）；删除记忆 = 现有 tombstone + 从所有组合成员数组移除该 id。

### MemoryService 扩展（memories.js + 新 src/memory-groups.js 服务模块）

- 新 `scopeType: 'group'`（TYPES 加第四值）：`scopeOf()` 对 `scopeType==='group'` 返回 `{type:'group', id: memory.brainId}`（不落回 global 默认 —— 旧记录无 scopeType 仍默认 global，不变）。
- `applicable(memory, project)` 扩展：`confirmed && brain 相同 && (legacy 作用域命中 || (scopeType==='group' && 存在未删除组合 member 包含 memory.id 且 boundProjectIds 含 project.projectId))`。这是唯一可见性判定扩展点 —— context.js 的 applicableMemories/memory-delta、检索 readableEntry、effective-memories API 全部自动获得一致行为（计划 §3.6 统一可见性）。
- materialize：`entry(group memory) = 'memories/group-library/<groupId>.md'`？——否，按组合分文件：`memories/groups/<groupId>.md`，内容 = `# 组合：<name>\n\n## <memoryId>\n\n<title>\n\n<body>\n\n来源：…`。descriptor() 增加该模式；existingEntries 增加组合文件；组合增删成员/改名/绑定变化都触发 `materialize()`（现有 onMaterialized → 共享索引重导入链路自动生效）。
  - boundProjectIds 变化不影响文件内容（文件按组合组织），但影响 readableEntry。
- `readableEntry(scope, entry, project)`：entry 为 groups/<id>.md 时 → 组合存在未删除 && boundProjectIds 含 project.projectId && 有 confirmed 成员。
- `memoryForChunk(scope, entry, headingPath)`：沿用 heading=id 机制不变（组合文件同样 `## <memoryId>`）。
- `list()` 投影增加 `title`（缺省生成展示标题）、`groups: [groupId...]`（反查）。
- create/update 增加 title 校验；update 支持 expectedRevision？—— memory 记录本身不加 revision（现有语义保留），并发冲突由 MEMORY_DUPLICATE 指纹 + 409 保护；组合实体带 revision（M08）。
- 字符上限：title 120、body 8000；上下文注入预算不足时截断注入文本但存储/检索/get 读全文（context.js memoryItem 已有 slice，沿用）。

### 组合服务 API（server.js 路由，浏览器经外壳 /api/engine/* 代理）

| 路由 | 能力 |
| --- | --- |
| GET /api/memory-groups?query&limit&before | 分页（同 listRunPage 模式：sequence 不适用 → 用 name 稳定排序 + offset 游标 或 组合自带 seq；取 `revision` 排序干扰 → 用 createdAt+id 稳定键） |
| POST /api/memory-groups {brainId,name} | 新建（同名 409） |
| GET/PATCH/DELETE /api/memory-groups/:id | 详情（含成员/绑定计数）/改名（expectedRevision 409）/删除（保留成员记忆） |
| POST /api/memory-groups/:id/members {addMemoryIds,removeMemoryIds,expectedRevision} | 原子差量；校验同 brain、memory 存在未删除且 confirmed、幂等 |
| POST /api/memory-groups/:id/project-bindings {addProjectIds,removeProjectIds,expectedRevision} | 原子差量；项目存在且 enabled；幂等 |
| GET /api/engine/projects/:id/effective-memories?limit&before | 去重生效集合 + 每条 sources[{kind:'legacy-scope'|'group',groupId?}] + total/nextCursor |
| GET /api/overview | 全局聚合：needsTotal/needsPreview(≤3)（跨全部项目统计 failed+blocked，非最近 50 条窗口）、candidatesTotal/preview(≤3)、recoveringTotal、groupsPreview(≤4)、operationLogPreview —— 供首页 |
| /api/memories 扩展 | create 接受 title；list 投影 title/groups；title 搜索参数 q |

外壳（主仓库）侧再补：
- GET /api/projects/page?q&domain&limit&before —— 注册表服务端搜索+分页（server-app.js + product-data/project-registry-store）。
- GET /api/engine/overview 代理已天然存在（/api/engine/* 透传）。

### 自动恢复（coordinator.js + 新 retry-scheduler 模块）

- run 新字段：`recovery: { kind: 'transient'|'rate-limit'|'config-blocked'|'data-failed'|'unknown', attempts, nextRetryAt, lastAttemptAt, budgetExhaustedAt: null, wakeReason }`（仅 failed/index-pending 且未耗尽预算时存在）。
- 分类映射（结构化，不做自然语言判断）：MODEL_QUOTA_EXHAUSTED/MODEL_AUTH_FAILED/AI_RUNTIME_REQUIRED→config-blocked（不自动重试，等 runtime-config/额度事件唤醒——setProfile 唤醒一次）；MODEL_RATE_LIMITED/429→rate-limit（尊重 Retry-After，上限 30 分钟）；INDEX_FAILED NETWORK/TIMEOUT/5xx→transient；PATH/DATA 校验→data-failed（人工）；其余 unknown→transient。
- 调度：单一 timer（非每 run 一个 setTimeout）：`scheduleRecovery()` 扫描 due 的 run → this.retry(runId)（复用现有 FIFO/claim/互斥）；参数 {maxAttempts:3, delays:[10s,30s,120s]+±10% 抖动, totalBudgetMs: 30min}；可注入时钟（测试）。
- 已 promoted 的 index-pending 重试只走 index 阶段（现有 execute 逻辑已保证：run.promotedAt → 直接 this.index）；分析超时结果不明时 execute 入口先查 state.lastAnalyzedCommit/claim（现有 recovered 短路已存在，保留）。
- 手动 retry 清空 recovery 计数（R09 真实重新执行）；R05 自动+手动同时 → retry() 幂等（state 检查 queued/running 拒绝）。
- 重启恢复：initialize() 现有 'running'→queued 与 index-pending retry 保留；新增：装载 recovery 状态并重新调度（单一调度器，无重复派发）。
- 供应商共享退避：同 kind 故障 ≥N(3) 个项目 → 全局 cooldown（kind 级别 nextRetryAt 提升），恢复后逐项目错峰放行（jitter 已有）。
- overview/maintenanceStatus 暴露 recovering 计数与分类（UI「自动恢复中」「等待配置」「需要处理」）。

### 引擎测试（新增 canonical）

- test/memory-groups.test.js：CRUD/成员/绑定/幂等/409/跨 brain 拒绝/删除语义（M02–M09 核心存储层）。
- test/memory-visibility.test.js：applicable 扩展 + readableEntry/memoryForChunk 组合路径 + context 注入/移除增量 + search/get 过滤（M10–M12）。
- test/memory-migration.test.js：v3 混合样例→v4、重复迁移、中断（模拟写失败）、旧引擎拒读 v4（D01–D03）。
- test/retry-scheduler.test.js：虚拟时钟全场景（R01–R09）。
- 扩展 ui-retry.test.js / engine.test.js 中现有断言适配。

## 主仓库侧设计

### API（server-app.js）

- GET /api/projects/page（新）：服务端 q/domain 过滤 + 稳定排序（name）+ 分页 + total/nextCursor；基于现有 projection 数据源。
- 首页 overview：GET /api/engine/overview（引擎聚合）+ 本地事项（模块接线 pendingProjects、scopeStatus）在 UI 层合并（不新建第二后端聚合点）。

### UI（index.html/product.js/product.css 大改）

- 五页路由 home/memory/projects/search/activity；删除 work 导航与 view-work section；旧 `#work` hash → 落到 home（U01 兼容）。frames.terminal 保留（设置里"管理模型供应商"直接 initializeFrame('terminal') 到隐藏容器或 system 内嵌 —— 决策：保留 terminal iframe 挂载点（hidden），configureProviders 打开 system drawer 并向 terminal postMessage kb:open-settings；Workbench 服务依赖不动）。
- 首页：左「需要处理」(≤3+总数) + 自动恢复横幅；右「待确认记忆」(≤3+总数)；下「记忆组合」≤4 入口 + 管理按钮。数据 /api/engine/overview。
- 长期记忆页：左组合栏（全部/未归/各组合/新建）；右列表（服务端分页 q 搜索）；编辑器 dialog（title+多行 body）；组合设置/应用项目 dialog（跨页差量选择，客户端 Set 保存 selected，提交 add/remove 差量）；选入已有记忆 dialog；候选 tab 保留审核（确认后可选加入组合）。
- 项目页：工具栏（搜索/领域/分页 20）；组合拖放条 + 项目行 tags（× 解绑 = removeProjectIds 单项）；项目详情（组合 tags + 生效记忆分页带来源徽标）；导入/设置/领域管理沿用现有 dialog。
- 检索页：真实 /api/engine/search（scope=project/domain/brain + 类型筛选 all/knowledge/memory），结果点击 → 现有 referenceDialog 读取正文与来源；移除 vectorFrame 改为产品内渲染（vectorhub iframe 不再挂此页）。
- 活动记录页：保留 updates（runs）+ sessions（bridge iframe）两 tab；updates 内加 全部/自动恢复/需处理/已完成 筛选（引擎 runs API 扩展 filter 参数或 overview 分页）+ 操作记录（events 分页）。
- 设置（system drawer 不变）：外观/皮肤、维护模型、Agent 接入、诊断全保留；「管理模型供应商」不再跳 work。
- 状态管理：state.groups、state.effectiveCache(projectId→{items,total})、分页状态 {page,cursor,q} 每列表独立 + 请求 epoch 防旧响应覆盖（P05，沿用 activityEpoch 模式）。
- 安全：正文/来源全部 esc() 或 textContent（现有模式沿用）。

### 主仓库测试

- _site/_test/memory-groups-ui-test.js（U02/U03 全链路，真实引擎 spawn + 真实 API）
- _site/_test/home-overview-test.js（首页聚合/超 100 条旧异常仍可见 P04、失败不显示零待办 U06）
- 更新 run-all-tests 发现机制、retrieval-gold fixtures 不动（对方金标准）、release-browser-5025-smoke.cjs 导航断言改五页
- qa-autopilot/tools/npm-upgrade-preservation.cjs 扩展记忆/组合迁移保留断言

## 风险与依赖

1. 对方 session-index 的 memory-delta 依赖 applicable() —— 组合解绑产生移除增量自动正确；但 memoryHash 用 text+updatedAt，绑定变化不改变 hash，removal 检测靠 currentIds 差集（applicable=false）→ 正确。
2. 共享索引：组合文件进 brain scope → vector 重导入由 onMaterialized 链路触发；索引恢复不重跑分析（现有）。
3. runs 分页已有（sequence cursor）；groups 分页需新稳定键 —— 用 createdAt+id 复合 cursor。
4. 引擎 CI 矩阵 Node18/22/24：不引入新语法要求（structuredClone/hasOwn 均已在用）。
5. 外壳 snapshot 端点含 memories 全量 —— 新 UI 不再依赖 snapshot.memories 做列表（改分页端点），snapshot 保持兼容。

## 启动门槛核对清单（每次恢复工作先跑）

- [ ] npm dist-tags：project-knowledge latest/next 均 > 5.0.32（对方 5.0.33 已发布）
- [ ] 无 in_progress CI/publish run（两仓库）
- [ ] 对方金标准/验收进程结束（PID 30492 类）
- [ ] 重新 fetch main、读工作区状态、重读 package.json 版本
- [ ] 日常实例 5 进程/端口健康复测（只读）
