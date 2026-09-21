# 集成修复实施计划：壳 + 模块嵌入（UI 已定稿版）

详细文档：`docs/ui-integration-repair-plan.md`（已生成）；设计决策记录：`docs/vector-hub-workbench-integration-plan.md` §9。后端深层集成（vector-hub 替换 LanceDB、摄取器）沿用主文档阶段 1/2，不在本计划内。

## 基线（已在工作区，未提交）

嵌入协议已实装于两个模块工作区并经预览验证：claude-ai-workbench（app.js embed bridge：kb:sidebar / kb:select-project / kb:ready / kb:projects + URL 参数；app.css 折叠规则）、vector-hub（ui/index.html 同协议）。

## T0 提交基线（0.5h）
review 并分别提交两个模块的协议改动（单一主题 commit）。

## T1 模块上游改动（~1.5 天）
- **T1.1 协议扩展**（agent-terminal app.js）：`kb:open-session`（复用 openSession，回执 kb:session）、`kb:list-sessions`（listSessions 非归档，上限 50，回执 kb:sessions）、`kb:archive-session`、`kb:remove-project`（带 keepSessions，依赖 T1.3）。
- **T1.2 齿轮移位**：vector-hub 的 #settings-btn 从 side-foot 迁到 main 顶部右侧；agent-terminal 主区顶栏加常驻设置入口（openSettings('providers')）。折叠侧栏后设置仍可达，独立打开不受影响。
- **T1.3 keepSessions**（terminal packages/server）：workbench-service.js removeProject(id, {keepSessions}) 跳过 113-120 行会话删除循环；http-handler 支持 DELETE /projects/:id?keepSessions=1；审计记录标志。

## T2 pkb 壳实现（ui/index.html + app.js，~2-3 天）
以 ui/integrated-ui-preview.html 为设计基准：
- 双导航（Agent 终端/知识检索）+ ▤ 折叠图标（独立状态）；移除旧 Claude Code workbench 面板；
- 嵌入视图：iframe ?embed=1 + 连接状态灯 + 联动 chip（kb:projects 回执驱动：命中绿/未登记黄）+ 独立打开；
- 项目栏聚合（数据源 T3.3）：每项目 ▸ 会话折叠区（kb:list-sessions → 点击 kb:open-session、hover 归档 kb:archive-session）；右键菜单（归档全部/移除项目·保留数据）；
- 导入表单两地址（①开发项目地址→terminal 添加项目；②知识库地址→vector-hub 导入）；
- 设置抽屉精简为：开发对话、日志；移除 AI 模型/知识库存储/向量检索节；新增文案入 i18n.js。

## T3 pkb 后端接线（server-app.js，~1-2 天）
- **T3.1 模块代理路由**（决策：代理，不开 CORS）：/api/terminal/* → :5760，/api/vectorhub/* → :8787，loopback 限定+超时；
- **T3.2 导入联动**：导入成功后服务端调 terminal POST /projects 与 vector-hub POST /api/import；连线表（projectId↔workspace↔knowledge↔两模块标识）存项目 config；模块未启动→"待登记"+健康检查后补登记；
- **T3.3 聚合接口** GET /api/projects/aggregated；
- **T3.4 管理操作**：移除=terminal removeProject(keepSessions=1)+vector-hub 删索引+pkb 解除登记（全部保留本地数据）；归档透传；
- **T3.5 进程编排**：pkb 按 settings（modules.autoStart/端口/命令）拉起并守护两个模块服务，失败重拉（上限+退避），手动模式仅探测+提示。

## T4 验收（~0.5-1 天）
六条标准：①折叠无残留、▤ 独立、联动可见切换；②导入后三侧登记正确；③会话列出/打开/归档；④移除不清理知识目录、terminal 会话记录、ConversationStore；⑤两模块独立打开可用、pkb 重启恢复；⑥现有 _site/_test/ 测试面与 desktop 冒烟不回归（不动 GROUP B 后端与 commit 流水线）。

## 顺序与风险
T0 → T1（三项可并行）→ T2（依赖 T1.1）→ T3（T3.1 先行，余可交叉）→ T4。
风险对策：postMessage origin 首版 '*'（loopback）后收窄；服务未启动→状态灯+占位+自动拉起；会话过多→上限 50；模块独立发版→协议带版本字段；已否决项（CSS 裁切、输入框贴边）不再做。