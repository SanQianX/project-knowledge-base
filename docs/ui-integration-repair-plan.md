# 集成修复实施计划：壳 + 模块嵌入（UI 定稿版）

> 生成：2026-09-19。UI 方案已与作者逐项对齐（见
> `docs/vector-hub-workbench-integration-plan.md` §9 及其决策记录）。
> **实施状态（2026-09-19）：T0-T4 全部完成。**
> T0 两个模块各 2 个 commit（协议基线 + 扩展/齿轮/keepSessions）；
> T1 协议四条新消息 + 齿轮移位 + keepSessions 已实装并实测；
> T2/T3 pkb 壳与后端接线已上线（module-bridge.js + server-app 路由 + ui/ 重写），
> 登记→联动→keepSessions 移除全链路实测通过；
> T4 全量回归 115/115（8 个旧 UI 测试更新至新契约，1 个过时会话历史 UI 测试删除）。
> 遗留增强项：postMessage origin 收窄、kb:list-sessions 分页、协议版本字段。
> 后端深层集成（vector-hub 替换 LanceDB、终端摄取器 ingestor、Profile 收敛）
> 沿用主文档的阶段 1/2，不在本计划范围。

## 0. 基线（已存在、未提交）

- **嵌入协议已实装**于两个模块工作区（未提交）：
  - `claude-ai-workbench`：`apps/agent-terminal/app.js`（embed bridge：
    kb:sidebar / kb:select-project / kb:ready / kb:projects + URL 参数
    embed/sidebar/project）、`app.css`（`body.embed-collapse .sidebar{display:none}`）；
  - `vector-hub`：`ui/index.html`（同协议，aside 折叠）。
- 交互预览 `ui/integrated-ui-preview.html` 已逐屏验证：默认折叠、▤ 独立控制、
  项目联动回执（vector-hub 命中 / terminal 如实返回未登记）。
- 已否决项（不要再做）：CSS 裁切模拟折叠；输入框贴边铺满
  （保留 terminal 原版居中悬浮卡片设计）。

## 1. 任务分解

### T0 提交基线（0.5h）
review 两个模块工作区改动并各自提交（协议为主题，单一 commit）。
- claude-ai-workbench：app.js + app.css
- vector-hub：ui/index.html

### T1 模块上游改动（claude-ai-workbench + vector-hub，约 1.5 天）

**T1.1 协议扩展（agent-terminal app.js）**
- `kb:open-session {sessionId}` → 复用现有 `openSession(sessionId)` 路径；
  回执 `{type:'kb:session', ok, sessionId}`。用于壳的历史会话点击。
- `kb:list-sessions {project}` → `client.listSessions(contextId)`（非归档）；
  回执 `{type:'kb:sessions', project, sessions:[{sessionId,title,agentId,updatedAt}]}`
  （上限 50 条，按 updatedAt 倒序）。用于壳的项目栏会话折叠区。
- `kb:archive-session {sessionId}` → `client.archiveSession()`；回执 ok。
- `kb:remove-project {project}` → `client.removeProject(id)` 带 keepSessions
  （依赖 T1.3）；回执 ok。
- origin 校验维持 loopback 白名单。

**T1.2 齿轮移位（两模块 UI）**
- vector-hub `ui/index.html`：把 `#settings-btn`（现于 side-foot）迁到
  main 顶部工具行右侧；侧栏底部保留状态灯不动。
- agent-terminal：主区顶栏右端加常驻设置入口（ghost 图标按钮 →
  `openSettings('providers')`），与模型弹层内"管理模型"同目标。
- 验收：折叠侧栏后设置仍可达；独立打开时观感不劣化。

**T1.3 terminal `removeProject` 加 keepSessions（packages/server）**
- `workbench-service.js removeProject(id, options={})`：`options.keepSessions`
  为 true 时跳过 113-120 行的会话删除循环（仅 abort 活动会话、解除登记、
  注销 context），会话记录文件保留。
- `http-handler.js`：`DELETE /projects/:projectId?keepSessions=1` 透传。
- 审计日志记录 keepSessions 标志。

### T2 pkb 壳实现（ui/，约 2-3 天）

以 `ui/integrated-ui-preview.html` 为设计基准改造真实 `ui/index.html` + `app.js`：

**T2.1 布局与导航**
- 侧栏导航改为：`Agent 终端`、`知识检索` 两项（各带端口徽标 + ▤ 折叠图标，
  独立状态，点击图标不切视图）；
- 移除旧 Claude Code workbench 主视图与相关 JS（claude sessions 路由保留为
  后端代理的消费者，见 T3.1，不再由旧面板调用）；
- 主题/i18n 文案入 `i18n.js`。

**T2.2 嵌入视图**
- 两个 iframe（`?embed=1`），头部：连接状态灯（no-cors 探测）、联动 chip、
  独立打开链接、来源标注（仅 debug 模式显示）；
- postMessage 桥：▤ → `kb:sidebar`；项目点击 → `kb:select-project`；
  监听 `kb:ready`（补发状态）/ `kb:projects`（驱动联动 chip：命中=绿
  "联动: X"，未登记=黄 + 提示去导入登记）。

**T2.3 项目栏（聚合投影）**
- 数据源：`GET /api/projects/aggregated`（T3.3）；渲染项目卡（名称/路径/状态）；
- 每项目 ▸ 会话折叠区：展开时向 terminal iframe 发 `kb:list-sessions`，
  渲染 `kb:sessions` 回执；会话点击 → `kb:open-session`；hover 出归档按钮 →
  `kb:archive-session`；
- 右键菜单：`归档全部会话`、`移除项目…（保留本地知识库与会话记录）`
  → 后端代理（T3.4）+ 刷新聚合。

**T2.4 导入表单**
- 字段：① 开发项目地址（目录选择器）② 知识库地址 ③ 输出语言 ④ hooks 安装勾选；
- 提交走 `POST /api/projects/:id/module-register`（T3.2），pending 态显示
  "待登记"，成功后刷新聚合 + 联动 chip 变绿。

**T2.5 设置抽屉**
- 仅两节：开发对话（现有查看器不动）、日志（不动）；
- 移除：AI 模型表单、知识库存储、向量检索节及对应 JS。

### T3 pkb 后端接线（_site/lib/server-app.js，约 1-2 天）

**T3.1 模块代理路由（决策：代理，不给模块开 CORS）**
- `POST/GET/PUT/DELETE /api/terminal/*` → `127.0.0.1:5760/api/claude-workbench/v1/*`
- `/api/vectorhub/*` → `127.0.0.1:8787/api/*`
- 浏览器保持同源；代理层做 loopback 限定与超时。

**T3.2 导入联动**
- `POST /api/projects`（现有导入流程）增加可选双地址；
  成功后服务端调 terminal `POST /projects {name, rootPath}` 与 vector-hub
  `POST /api/import {sourceDir, projectName, watch:true}`；
- 连线表（projectId ↔ workspacePath ↔ knowledgePath ↔ terminalProjectId ↔
  vectorHubProjectName）存入项目 config；模块未启动 → 状态"待登记"，
  启动后（健康检查触发）补登记。

**T3.3 聚合接口**
- `GET /api/projects/aggregated`：合并 pkb 登记 + terminal projects +
  vector-hub registrations，按连线表对齐，返回壳所需字段。

**T3.4 管理操作**
- `DELETE /api/projects/:id?scope=modules` → terminal removeProject
  （keepSessions=1）+ vector-hub deleteProject（索引，不动源）+ pkb 解除登记
  （保留知识目录）；
- `PUT /api/terminal/sessions/:sid/archive` 透传。

**T3.5 进程编排**
- pkb 进程管理器按 settings（`modules.autoStart`、端口、启动命令）拉起/守护
  agent-terminal-server 与 vector-hub serve；健康检查失败重拉（上限+退避）；
  手动模式下仅探测并在 UI 提示启动命令。

### T4 验收与回归（0.5-1 天）

验收标准（全部可手工演示 + 自动化冒烟）：
1. 折叠干净无残留；▤ 两模块独立控制；展开态点壳项目，模块内选中态可见切换；
2. 导入两地址 → terminal 出项目、vector-hub 建索引并监控、聚合列表正确；
3. 会话区：展开列出（非归档）、点击在终端打开、归档后消失；
4. 右键移除：三侧解除登记；知识目录、terminal 会话记录（keepSessions）、
   ConversationStore 全部保留；vector-hub 源文件不动；
5. 独立打开 :5760 / :8787 完整可用；pkb 重启后状态恢复；
6. 现有测试面回归：`_site/_test/` 相关用例 + desktop 冒烟不受影响
   （本轮不动 GROUP B 后端与 commit 流水线）。

## 2. 实施顺序与依赖

```
T0 提交基线
 └─ T1 模块上游（T1.1/T1.2/T1.3 可并行）
     └─ T2 壳 UI（依赖 T1.1 的 list/open/archive 协议）
 └─ T3 后端接线（T3.1 先行；T3.2-3.5 与 T2 可交叉）
     └─ T4 验收
```

## 3. 风险与对策

| 风险 | 对策 |
| --- | --- |
| postMessage 目标 origin 用 `*`（本机 loopback） | 首版可接受；后续收窄为具体壳 origin（模块侧已有来源白名单） |
| 模块服务未启动 | 状态灯 + 占位提示 + T3.5 自动拉起；导入不硬失败（待登记） |
| 大项目会话过多 | kb:list-sessions 上限 50 + "仅最近"排序；分页留增强项 |
| 两个模块独立发版节奏 | 协议带版本字段（kb:ready 附 version）；壳按版本降级提示 |
| 旧 workbench 面板下线影响桌面端 | desktop 冒烟先行确认；保留后端路由一个版本周期 |

## 4. 交付物清单

- 模块：两个仓库各 1-2 个 commit（协议 + 移位/keepSessions）；
- pkb：壳 UI 改造 commit + 后端接线 commit + 本计划勾选完成；
- 文档：主文档 §9 增补实施状态；CHANGELOG 条目；
- 预览页保留为设计参照（不再作为运行时依赖）。
