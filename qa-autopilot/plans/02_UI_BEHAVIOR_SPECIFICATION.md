# 02 · 真实前端操作、API与断言

来源S03–S05。下列DOM定位来自当前主仓，不臆造独立模块0.13.6内部按钮；内部按钮必须匹配安装版本后补充定位清单。所有写操作仅对fixture。优先role/label定位，必要时使用下列稳定ID；不要用坐标常量或DOM.click绕过遮挡。

## 全局与页面状态

六导航 `[data-view="home|work|search|memory|projects|activity"]`。当前section `#view-<view>.active`；`#pageTitle`应一致；hash刷新回到相同页面。`#projectSelect`更换当前项目、更新epoch与模块上下文。`#themeToggle`改变 `documentElement.dataset.theme` 和localStorage `kb.theme`。页面上展示成功必须进一步校验对应数据，不只读toast。

内嵌模块真实入口：
```text
#workFrame   /modules/terminal/agent-terminal/?embed=1&apiBase=/api/terminal&transport=live
#vectorFrame /modules/vectorhub/?embed=1&apiBase=/api/vectorhub&engineBase=/api/engine
#bridgeFrame /modules/eventbridge/?embed=1&apiBase=/api/eventbridge
#engineFrame /modules/engine/?embed=1&apiBase=/api/engine
```
框架等待 `kb:ready`，再发送theme、scope、project和visibility；origin和event.source均校验。不把iframe载入完成当业务ready。

## 流程A：设置→领域→项目导入

前置：独立数据目录，测试Git仓有一条baseline；知识根新空目录；由控制端配置需要的测试模型/模块，离线场景明示替身。

1. 点 `#openSystem`。在 `#brainName/#knowledgeRoot` 输入，点 `#saveBrainSettings`。实际顺序PATCH `/api/brain` `{name}`，PATCH `/api/settings` `{knowledge:{rootPath}}`，最后刷新登记。共享接线pending要保留而非假成功。
2. 进入projects，点 `#createDomain`，填 `#domainForm input[name="name"]`，点表单submit。POST `/api/domains`，刷新后列表存在。
3. 点当前页 `[data-action="import"]`，填写 `#importCode/#importName/#importKnowledge/#importDomain`。表单input触发250ms debounce；旧epoch结果不能覆盖新输入。
4. POST `/api/projects/preflight-import`。body来自当前表单：
```json
{"projectId":"project-<uuid>","brainId":"<实际智脑ID>","domainId":null,"localPath":"<fixture仓>","knowledgePath":"<fixture知识目录>","displayName":"QA项目","knowledgeLanguage":"zh-CN","confirmGitInit":false}
```
只有当前preflight ready且确认条件满足，`#confirmImport`才能启用。非Git需明确勾选；旧托管Hook替换附带返回的replacementProjectId，第三方Hook永不覆盖。
5. 点确认：POST `/api/projects/import` 同一输入ID。登记成功但有模块失败属于partial wiring，不是重新导入理由。界面进入projects并选中新项目。
6. GET `/api/projects/aggregated` 验证workspacePath/knowledgePath/domainId；只读看fixture Hook；Git HEAD仍baseline；导入没有AI历史任务。
7. 点 `#repairWiring` 对当前project `POST /api/projects/:id/module-register`。只补接线失败部分；证据包括四个模块各自状态。
8. 预检/注册错误必须显示 `#preflightStatus` 与operationId；GET `/api/logs`可关联。网络返回丢失先查登记，不重新造ID。

特殊：缺root时 `#setupImportRoot` 进入设置，保存后返回同一导入表单；防止输入丢失。目录选择按钮调用 `/api/terminal/system/pick-folder`；路径填写E2E不能声称已验原生Windows文件夹对话框，需要单独系统UI验收。

## 流程B：解绑及领域变更

项目详情领域select（实际动态ID `#projectDomain`）触发PATCH `/api/projects/:id` `{domainId}`，验证归属而不移动知识。

解绑打开现有确认对话框 `#unbindDialog`（动态按钮在源码清单中现场定位），点 `#confirmUnbind`，DELETE `/api/projects/:id` `{deleteKnowledge:false}`。应取消符合合同的排队任务，活动writer应阻止危险解绑；页面删除登记但磁盘代码/知识/历史不删。并发旧GET返回不能复活条目。UI重复点击与Escape处理必须验。

## 流程C：开始工作和右侧Dock

选项目→work→等待真实Workbench ready，核对contextId映射。模型供应商由 `#configureProviders` 将外壳切work并发 `kb:open-settings` 打开真实模块设置，不另造聊天UI。

按同版本原生DOM完成模型选择→输入→发送→权限→停止→恢复。保留输入accept回执、native modelID、本轮事件sequence、文本与工具执行证据。主回复结束和后台子任务运行不能混成一个busy状态。

知识面板provider固定 `kb.knowledge.references`。使用 `kb:panel/register` 注册 `/knowledge-panel.html`、read-only、single；**缓存更新不自动打开面板**。必须用户导航才创建/打开；重新加载iframe后重新注册。安全载荷最多50引用、每条text截断800字符；显示不解析任意HTML。

右上角隐藏/显示、子代理控制台与其他面板的当前实现需匹配0.13.6源码。浏览器/代码审查面板在没有源码证据时标PLANNED，不为了“补齐测试”擅自开发新产品功能。

## 流程D：知识检索

search中点击 `[data-scope="project|domain|brain"]`，外壳更新scope并向vectorFrame传 `kb:scope`。真正输入、搜索和结果在同版本Vector Hub里定位。以固定测试事实同时验证返回集合、正文、source/project/commit和引用文件哈希。向量必须检查非空索引及语义查询证据；fallback成功只能记文本回退成功。

引用弹窗 `#referenceDialog/#referenceContent/#referenceMeta` 与复制 `#copyReference`；Clipboard不可用时实现有fallback，需分别检查。引用不允许越界路径或把来自B项目的事实标成A。

## 流程E：长期记忆

memory页 `[data-memory-tab="confirmed|candidate"]` 分页；`#memoryScopeFilter/#memoryTargetFilter`筛选。点 `#addMemory`，填写 `#memoryText`、`#memoryScope`、`#memoryTarget`，`#confirmMemory`明确提交。

新记忆POST `/api/engine/memories` `{text,scopeType,scopeId,brainId}`；现有记忆PATCH `/api/engine/memories/:id`，confirmed只有明确确认动作；忽略PATCH `{status:"ignored"}`。保存candidate不等于确认。写入已保存但syncStatus pending时，UI必须显示待恢复，且不注入任务。

操作后重新打开页面/重启测试服务校验。模型实际使用一条唯一约定作为最终抽样证据，不能只读“knowledge prepared”日志。

## 流程F：活动、诊断、集成

活动updates/sessions通过 `[data-activity-tab]`切换；会话页使用bridge iframe。失败run动态按钮 `data-retry-run` 执行POST `/api/engine/runs/:runId/retry`，重试仅限该run并防重复。

`#openLogs`→`#logsDialog`→`#logsSearch/#logsScope`→`#loadLogs`：
GET `/api/logs?pageSize=100&q=<query>&projectId=<optional>`；无搜索时接 `/api/logs/stream?streamCursor=...`。当前DOM最多100条，历史持久化与可检索性另测。`#exportLogs` GET `/api/logs/export`，按当前范围导出。错误/secret递归脱敏。

外部接入GET `/api/integrations/status`；`data-agent-switch` install/uninstall通过POST `/api/integrations/<operation>` `{clients:[client]}`。正在检查不显示已连接；`complete:false`不等于成功；真实客户端需重开新会话。错误时显示operationId，再查看诊断。

## 流程G：维护及Embedding

`#maintenanceModel/#saveMaintenance`：PUT `/api/terminal/maintenance-default` `{profileId}`→POST `/api/modules/configure`。聊天临时选择不改变后台持久默认。

Embedding表单读取 `/api/terminal/profiles` 和 `/api/terminal/embedding-config`，PUT配置后同步modules。`secret`留空保持原凭据。停用 `{enabled:false}`；知识文件保留。禁把响应中的mask字段当真实密钥，也不能在截图中录入真实密钥后直接公开。
