# QA Autopilot · 完整执行计划

完整审查可读本文件；实际Agent只按任务读取相应原章节，不反复装载全文。

- [00_README_FIRST.md](00_README_FIRST.md)
- [01_ARCHITECTURE_AND_MODULES.md](01_ARCHITECTURE_AND_MODULES.md)
- [02_UI_BEHAVIOR_SPECIFICATION.md](02_UI_BEHAVIOR_SPECIFICATION.md)
- [03_TEST_CASE_MATRIX.md](03_TEST_CASE_MATRIX.md)
- [04_AUTONOMOUS_REPAIR_LOOP.md](04_AUTONOMOUS_REPAIR_LOOP.md)
- [05_PERFORMANCE_AND_VISUAL_TESTS.md](05_PERFORMANCE_AND_VISUAL_TESTS.md)
- [06_QUOTA_WATCHDOG.md](06_QUOTA_WATCHDOG.md)
- [07_GIT_BASELINE_AND_REMOTE_PUSH.md](07_GIT_BASELINE_AND_REMOTE_PUSH.md)
- [08_NPM_RC_RELEASE.md](08_NPM_RC_RELEASE.md)
- [09_SAFE_CODE_CLEANUP.md](09_SAFE_CODE_CLEANUP.md)
- [10_CODE_STYLE_AND_COMMENTS.md](10_CODE_STYLE_AND_COMMENTS.md)
- [11_CHECKPOINT_AND_RECOVERY.md](11_CHECKPOINT_AND_RECOVERY.md)
- [12_ACCEPTANCE_GATES.md](12_ACCEPTANCE_GATES.md)
- [13_TOOLING_AND_LOCAL_ADAPTER.md](13_TOOLING_AND_LOCAL_ADAPTER.md)
- [14_SOURCES_AND_CONFLICTS.md](14_SOURCES_AND_CONFLICTS.md)
- [15_ARTIFACT_RETENTION_AND_WINDOWS.md](15_ARTIFACT_RETENTION_AND_WINDOWS.md)
- [16_REQUIREMENT_TRACEABILITY.md](16_REQUIREMENT_TRACEABILITY.md)

---

# 00 · 执行入口与禁止捷径

## 控制平面和被测产品分开

原项目路径不变。中央 `qa-autopilot` 由控制端持有，`.runtime/workspaces/repair` 是隔离源码clone；模型只在该clone执行批准任务。使用clone而不是嵌套worktree，避免共享Git配置/Hook影响生产及自嵌套扫描。中央QA目录不是业务模块；其本地 state、artifacts、config/local.json不进入Git或npm。

工具copy在T02复制到clone后提交，供CI读取脚本与文档。原目录里未提交文件不会自动包含在基准tag。基准是可恢复节点，未经初始测试不能叫“已验证稳定版本”。

## 实际的权限边界

模型进程应由受控broker在独立低权限Windows账户/沙箱中运行。它只可写任务文件，不可写中央QA工具/合同/基线/证据，不可读取订阅真实Key、Git写凭据、npm身份。网关和远程写工具由控制端运行。禁止外网直接模型访问，以免绕过逐请求额度门禁。

**代码中的approval布尔值和JSON哈希只能防误操作/过期证据，不是防恶意同权限进程的安全隔离。** 实际OS ACL、进程身份、网络出口和受保护GitHub环境必须现场验证。当前generic worker通过已配置executable启动；该入口必须是已验证的受限broker或符合隔离合同的适配器，不可把普通同权限node进程标为安全。

## 首次执行

运行本包 `npm test`，再 `node scripts/qa.cjs self-check`。首次 `init` 只生成本地配置。审核工具路径、sourceRoot、repoRoot、origin、QA branch和基准tag。既有本地配置不覆盖。

T00审计可在无MiniMax额度、无npm写权限时完成。T01远程基准操作、T02工具导入、T04工作流修改采用独立bootstrap审批，解决“先有门禁才能创建门禁”的循环依赖；只能进行限定元数据/QA工具改动，不开放业务自由修改。

每个写入命令先不带 `--apply` 查看计划；正式执行前保存该计划并确认远程当前SHA。无网络、未授权、版本不匹配、缺浏览器都记录能力阻断，不能转成skip后宣布通过。

## 依赖与文件位置

本控制工具没有第三方npm依赖，Node22+自带test runner即可自检。浏览器脚本复用被测项目的Chrome/CDP助手与 `ws`，需要在隔离clone按原锁文件安装产品依赖。不得为了跑测试升级生产依赖。

Windows `.cmd/.bat` 包装器不用于Node spawn直接入口：配置真实 `node.exe` 及工具JS入口；未知CLI参数先看实际版本帮助与协议。不要把配置示例路径当作本机已存在事实。

运行产物：`.runtime/runs/<runId>`；证据：`artifacts/<runId>`；状态：`state`；汇总：`reports/runs`。GitHub只提交审核后的源码/计划/脱敏摘要，原始trace、凭据、用户文本不默认上传。

## 失败与完成

测试需保存：运行平台/Node、source SHA、文件fingerprint、模块版本、fixture哈希、具体caseID、首失败、复测、退出码。PATCH改变后旧凭证作废。零测试、仅端口在线、仅安装成功、仅Agent退出0都不是验收。

检查 `reports/delivery/VALIDATION.md` 的已测范围，再执行T00。不要把本包Linux单测报告当成Windows或产品功能证明。



---

# 01 · 当前架构与文件所有权

本章依据S01–S12，证据索引见14。`IMPLEMENTATION_OBSERVED`只表示读到实现，`RUNTIME_NOT_VERIFIED`表示此环境没跑，不等于稳定通过。

## 所有权与数据流

| 单元 | 真实入口/依赖 | 责任 | 不应承担 |
|---|---|---|---|
| 产品外壳 | `_site/server.js`→`_site/lib/server-app.js`；`ui/index.html/product.js` | 页面导航、模块接线、项目归属、状态投影、安全HTTP | 不复制第二套聊天/索引业务 |
| Knowledge Engine | `_modules/knowledge-engine/`，`/api/engine`代理 | 提交认领、分析、staging、晋升、知识状态 | 不让Agent直接写生产知识路径 |
| Workbench | 安装别名claude-ai-workbench，包0.13.6 | 模型与会话、权限、流式对话、子任务/可选Dock | 不依赖某个知识库宿主才可运行 |
| Vector Hub | 固定1.0.8-rc.8，`/api/vectorhub` | 派生索引、检索UI | 不成为第二个知识事实源 |
| Event Bridge | 固定0.7.2，`/api/eventbridge` | 外部事件journal、会话归属/展示 | 不把系统维护当真人开发偏好 |
| 外部插件 | `plugins/project-knowledge`及托管Hook/客户端配置 | 集成、需求/上下文/采集 | 不覆盖第三方插件或客户端trust |
| QA控制端 | 中央qa-autopilot | 测试编排、证据、配额、远程写门禁 | 不与模型共享写凭据/审批目录 |

## 主业务链

导入：UI填路径→preflight→真实Git身份/目录/Hook校验→登记→四模块分别接线→部分失败保持登记→针对失败项修复。导入不会自动分析历史。

维护：Git commit→托管Hook→Bridge journal→引擎持久化claim→固定提交证据与prompt→staging产物校验→Markdown promotion→lastAnalyzedCommit推进/index dirty→Vector Hub索引→查询。应分别验证通知和journal的作用，而不是仅向HTTP端点发送一个假“成功”。

会话：选择项目→映射Workbench contextId（不等同engine projectId）→真实会话/模型→输入接受回执→工具/正文事件→本轮结束与后台任务分别计状态→断网快照及游标恢复。

记忆：人工添加/候选审核→确认内容及scope→持久化同步→可注入集合→准备上下文→传输→模型实际使用。candidate、ignored和pending同步不能偷换为已确认有效约定。

## 应保留的不变量

Markdown是知识事实，索引可重建。AI维护先写staging而不是源码或最终知识。索引失败不撤销已晋升Markdown、不重复付费分析。同项目提交顺序处理、重复事件幂等；跨项目按已确认并发上限运行。关闭浏览器不等于中止后台任务。已有项目的固定knowledgePath不随全局root移动。未知/未就绪状态不能显示为健康。外部客户端信任由用户掌握。

以上不变量若现代码/旧文档矛盾，先定位同版本合同和反例，避免复制旧4.x迁移承诺到当前v5。用户原目录数据只做只读确认；不得以测试名义恢复/迁移/清空。

## 文件分类规则

源码：模块owner维护，可按task allowlist修改。原生测试：保留目录和发现机制；修改断言需独立合同审查。生成runtime：即使叫dist/node_modules也可能是发布必需，不按目录名删。第三方源码：不直接格式化/加双语注释。临时数据：必须有本轮owner标记、状态和保留期。用户配置/知识：不进入QA删除器。

现场需生成 `reports/runs/inventory-*.json`：Git tracked列表、大小、SHA256、类型、源码UI定位引用。该清单仅用于所有权审查，不是dead-code证明。

## 版本矩阵与发布耦合

冻结主仓完整SHA、package-lock、runtime/vendor manifests和三个独立npm包的version/integrity。改变Workbench时：找到同版本可维护源码→模块单测/独立宿主→模块RC→宿主精确锁版本/更新manifest→宿主RC。不能只提交宿主package.json但仍运行兄弟工作区旧源码；也不能把模块0.3.0测试当0.13.6验收。

当前桌面目录存在，但网页/CLI候选不自动成为桌面候选。桌面依赖与支持范围现场单独核对，历史测试以characterization标记。



---

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



---

# 03 · 测试用例矩阵

共130个规格，初始全部NOT_RUN。它们不是130个已实现自动脚本。实际实现状态必须按 config/test-cases.json 更新独立的运行结果文件，不改规格来凑通过。

既有套件映射是候选覆盖，先读该测试实际断言。子集、Mock、原生客户端与真实模型层分别报告。

## NAV-001 · 六页导航

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：依次点击六个 data-view 导航按钮，再刷新每个 hash 页面。

断言：只有当前 view active。 标题、hash、选中导航一致。 没有额外业务写入。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-002 · 主题同步

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在浅/深主题间切换，再切换三个内嵌模块并刷新。

断言：外壳主题持久化。 已就绪 iframe 收到 kb:theme。 不能因主题切换重建任务。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-003 · 空项目

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：使用新数据目录，打开工作、检索、领域与项目。

断言：展示空状态。 不能将未知/读取失败当作空库。 不创建占位项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-004 · 失败保留旧数据

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已有项目后令登记查询失败，再恢复。

断言：错误可见。 旧列表不清空。 恢复后以新快照更新。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-005 · 项目快速切换

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：准备 A/B 两个独立项目，快速 A→B→A 并延迟旧响应。

断言：只展示当前项目。 迟到响应不跨项目覆盖。 实际 contextId 映射正确。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-006 · 可操作性

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：原生指针点击按钮；Tab/Enter 遍历主要表单，检查遮挡。

断言：命中测试通过。 输入焦点可见。 没有透明层拦截。 不使用 DOM.click 代替。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-007 · 分辨率矩阵

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在4个桌面视口、两种主题检查六页截图及 bounding rect。

断言：无非预期水平溢出、控件遮挡。 截图人工基线与像素检查分别报告。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-008 · 断网恢复

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：数据加载后模拟浏览器 offline 再 online。

断言：关闭旧流，恢复快照及新流。 不重复订阅。 内容不伪装实时。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-001 · 领域创建

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：领域与项目→创建领域→输入名称→明确提交→刷新。

断言：领域存在并持久化。 空名称拒绝。 不创建新的 Git 项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-002 · 导入完整预检

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：新 Git fixture→填写代码/知识路径→确认导入。

断言：预检通过才启用确认。 四模块分别报状态。 源码HEAD不变、历史不分析。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-003 · 缺知识根返回表单

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：未配知识根时填写导入，点击设置知识根，保存再返回。

断言：原输入和导入ID保留。 不会误建两个项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-004 · 中文空格路径

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：使用中文及空格路径的 Git 仓库导入并重启。

断言：路径标准化正确。 Hook可运行。 绝对知识路径一致。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-005 · 重复导入

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：同一个路径导入两次，再用路径大小写/分隔符别名试一次。

断言：拒绝重复登记。 不破坏已有项目数据。 别名按平台合同判断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-006 · Hook竞态冲突

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：预检通过后在测试仓库写第三方Hook，再点击确认。

断言：HOOK_CONFLICT。 第三方字节保持。 UI operationId能查真实失败日志。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-007 · 部分模块离线

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：四模块均返回503时导入，再只恢复一个模块并修复接线。

断言：登记保留，真实模块状态仍失败。 仅补失败模块，不重复登记。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-008 · Git初始化确认

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：选择不是Git的测试目录，分别不勾选与勾选初始化。

断言：未明确勾选不得 git init。 初始化只发生在用户选中fixture。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-009 · 解绑写入保护

模块：项目与领域；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：准备排队任务和正在写入任务，分别请求解绑。

断言：排队任务按合同取消。 活动writer阻断解绑。 保留磁盘代码、知识、会话。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-010 · 解绑迟到读

模块：项目与领域；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：让登记GET挂起，解绑完成后再返回旧GET。

断言：旧响应不能复活项目。 刷新后仍解绑。 其他项目不受影响。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-011 · 领域变更

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：变更项目所属领域后发起项目/领域检索。

断言：作用范围随登记更新。 知识文件绝对路径不移动。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-012 · 导入失败重试

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入成功但刷新失败，与导入本身失败分别注入。

断言：前者不能再建项目。 后者保留错误和opID并允许受控重试。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-001 · 首次导入基线

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入有多条历史提交的仓库，观察后台任务与文件。

断言：只建基线。 不分析历史、不生成伪知识、不改源码。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-002 · 真实Hook闭环

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入fixture→新增真实git commit→等待journal→claim→晋升→查询。

断言：按完整SHA绑定证据。 Markdown与检索引用一致。 不能直接API造任务替代Hook验收。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-003 · 空仓首提交

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入空仓后作第一次提交。

断言：第一次后续提交可处理。 无HEAD阶段不假装已有分析。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-004 · 重复事件

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：同一SHA重复通知、多次journal消费与启动对账。

断言：只产生一次有效分析/晋升。 重复接收日志不等于重复执行。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-005 · 单项目顺序

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：连续提交A/B/C，令B失败。

断言：A成功、B失败、C等待。 不能越过B宣告分析到C。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-006 · 跨项目并发

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：两个或更多fixture提交并观察调度。

断言：按当前实际并发上限排队。 项目之间无文件串写。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-007 · 离线提交补偿

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：仅停测试服务，Git提交成功后再启动。

断言：Git不被Hook故障阻塞。 启动对账补漏。 已完成SHA不重跑。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-008 · staging越界

模块：知识引擎与Git维护；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：让测试Agent产物包含../、绝对路径、非允许类型。

断言：晋升拒绝。 最终知识与源码哈希不变。 失败证据保留。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-009 · 晋升中断恢复

模块：知识引擎与Git维护；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在许可的故障注入点中断测试writer，再重启。

断言：journal恢复一致。 不留下半晋升的假成功。 pointer顺序正确。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-010 · 索引独立失败

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：Markdown晋升成功后令向量服务失败。

断言：知识已更新/索引待修复分开。 不回滚Markdown、不重复付费分析。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-011 · 故障重试

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：UI点击指定run重试，连续双击与网络响应丢失分别测试。

断言：同一意图不会重复派发。 活动状态正确。 请求结果未知先查询。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-012 · 分析来源排除

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：内部维护任务与真实用户任务使用不同origin，读取采集事件。

断言：维护/委派不能自动成为人类长期偏好。 C01未定项不得自动删除实现。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-001 · 源码版本匹配

模块：Workbench真实对话；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：核对本地模块package、锁文件、runtime manifest和源码commit。

断言：每一文件所有权可追溯。 不匹配则BLOCKED_SOURCE_MATCH。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-002 · 独立宿主

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：使用0.13.6真实最小宿主配置模型并对话，再在宿主中重复。

断言：模块不依赖知识库业务对象才能工作。 集成上下文单独验证。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-003 · 真实模型抽测

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：配置订阅模型并发送唯一随机事实问题，记录请求及回答。

断言：模型返回的确是MiniMax-M3.1-Flash。 无替身。 响应与本轮关联。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-004 · 连续回复次序

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：Q1结束后立即Q2，注入Q1迟到结果。

断言：Q1正文不重复在Q2后出现。 不能把Q2错误标idle。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-005 · 草稿隔离

模块：Workbench真实对话；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A输入1111，B输入2222，切换/刷新/重启测试服务。

断言：草稿分别恢复。 附件按当前会话生命周期，不跨项目泄漏。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-006 · 权限拒绝

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：要求测试Agent执行受保护操作，选择Deny。

断言：真实工具未执行。 UI错误与拒绝回执一致。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-007 · 用户问题选择

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：触发单选/多选/自定义问题，先不提交再提交。

断言：必须由真实选择确认。 bypass工具权限不能代选、空答或放行。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-008 · 中止隔离

模块：Workbench真实对话；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A/B同时执行，只中止B。

断言：B按协议终止，A继续。 不得停止未知服务/进程。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-009 · 流式重连

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：输出中断网，恢复后先取快照再续游标。

断言：无重复正文/遗漏。 不能重发已接受输入。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-010 · 长历史阅读

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：生成长对话后向上滚动，同时持续输出。

断言：不强制跳到底。 合理DOM/内存增长。 焦点不丢失。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-011 · 主回复与后台

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：主回复结束但两个子任务仍运行时继续输入。

断言：按当前合同主输入可用。 后台卡片仍真实运行，不能仅从文字猜启动。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-012 · 停止服务恢复

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在测试进程停启后恢复会话历史。

断言：会话ID、事件序号、任务历史归属正确。 真实会话状态非端口在线推断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-001 · 右上角显示隐藏

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：按当前实现定位右上角显示/隐藏按钮，循环切换。

断言：不改变会话和任务。 按钮实际可点。 缺实现先标需求差异。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-002 · 标签生命周期

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：打开两个不同标签，切换、关闭一个，再打开。

断言：状态按panelId隔离。 关闭释放监听器。 不关闭主会话。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-003 · 知识被动刷新

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：Dock关闭时让知识缓存更新。

断言：不得自动开标签或展开Dock。 只有用户导航才打开。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-004 · 知识重新注册

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：重载Workbench iframe后再打开知识引用。

断言：重新完成panel/register握手。 过期panelId不可误送。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-005 · 知识项目快速切换

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A引用加载期间切换B并返回A。

断言：epoch和projectId匹配。 知识文本不串项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-006 · 子代理控制台

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：启动真实子任务，显示控制台与完成历史。

断言：显示真实事件。 失效请求可只读重试，不重复委派。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-007 · 标签异常和恢复

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：面板超时/断网后恢复，关闭再打开。

断言：错误可见，主聊天继续。 销毁超时回调。 不持续重建iframe。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-008 · 来源安全

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：从未知iframe或错误origin发送kb:panel消息。

断言：被拒绝。 不能注册任意URL/访问宿主私密上下文。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-009 · 浏览器与代码审查

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：查0.13.6注册清单，再按实际实现操作面板。

断言：仅有源码证据才纳入必测已实现项。 规划功能标PLANNED非Bug。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-010 · 多标签压力

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在设计上限内反复开关面板并记录监听器/内存。

断言：关闭后的资源释放。 真实浏览器连接限制单独验收。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-001 · 文本检索

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：植入带唯一事实的已晋升测试Markdown，通过知识检索输入查询。

断言：命中正文和真实引用。 不能把模板占位当事实。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-002 · 真实向量

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：配置真实embedding，构造不共享关键词的语义查询。

断言：检查非空向量与真实通道证据。 文本回退不算向量PASS。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-003 · 作用域隔离

模块：知识检索与范围；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A/B项目、同/不同领域设计互斥事实，切scope。

断言：项目/领域/brain返回集合符合授权范围。 未知项目不借别人的上下文。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-004 · 引用定位

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：点击结果引用，读取正文并复制引用。

断言：相对条目和完整提交来源对应当前结果。 不可路径越界。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-005 · 模型停用

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：停用embedding再查询。

断言：真实Markdown回退可见。 不删知识、不称向量成功。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-006 · 索引根切换

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：修改全局知识根，在旧索引有写入时执行。

断言：旧数据保留、排空旧writer、后续新根重建。 项目知识不被搬移。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-007 · 新提交检索一致

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：真实提交分析后在下一轮会话检索该事实。

断言：完整SHA、项目、正文及索引链匹配。 不是只匹配SHA字符串。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-008 · 检索负载

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：固定语料与查询集合进行基线/候选交替重复测量。

断言：语义召回与延迟同时评价。 不同语料/硬件不得比较为回归。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-001 · 手动添加

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：长期记忆→添加→内容/作用域/目标→确认。

断言：POST真实保存为confirmed。 刷新后保留。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-002 · 空白拒绝

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：输入纯空白或缺目标尝试确认。

断言：前后端均拒绝。 不出现空记忆。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-003 · 候选保留

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：编辑候选点击保存候选而不确认。

断言：仍为candidate。 不能注入长期任务偏好。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-004 · 确认目标

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：切换global/domain/project并更换目标后确认。

断言：scopeId与scopeType匹配。 只影响指定范围。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-005 · 忽略候选

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：点击忽略并刷新，检查原始来源记录。

断言：状态ignored。 来源冻结记录不篡改。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-006 · 同步失败

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：confirmed保存后注入写文件失败。

断言：sync pending真实显示。 未同步内容不注入任务。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-007 · 真实注入

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：新增唯一约定，在下一真实模型任务检查引用和采用。

断言：区分prepared、output、delivery、actual use四层证据。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-008 · 来源边界

模块：长期记忆；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：委派Agent指令/系统维护输出诱发记忆候选。

断言：不得自动当作人类长期偏好。 C01未解决项明确阻断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-001 · 三能力独立

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：检查Knowledge Integration、Automatic Context、Development Capture。

断言：检测到命令不等于已安装。 三能力分别真实验证。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-002 · 原生Claude采集

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：隔离客户端HOME安装托管Hook，重开会话后外部开发。

断言：仅新会话事件按真实Git目录归属。 不补捏历史。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-003 · 原生Codex采集

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：隔离Codex配置与notify链，执行开发并检查记录。

断言：保留第三方notify和用户信任。 拒绝自动写trust。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-004 · 原生OpenCode

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：核对真实插件入口，在fixture发消息和提交。

断言：只报告实际支持能力。 不可声称自动注入已通过。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-005 · 原生ZCode

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：按同版本真实入口接入，检查采集与上下文区别。

断言：没有证据不报MCP成功。 保留第三方配置。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-006 · 修复幂等

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：连续两次接入/修复同一客户端。

断言：不叠加Hook、不重复notify wrapper。 operationId可追踪。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-007 · 移除保留

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：移除采集集成后查看配置diff和历史文件。

断言：只撤托管项。 第三方及历史记录保留。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-008 · 跨仓隔离

模块：外部Agent集成；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：相同basename不同真实路径A/B开发会话并行。

断言：以canonical身份隔离，不串对话/Commit。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-009 · 配置自动修复

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已接入客户端配置损坏后重启隔离服务。

断言：仅修复曾授权托管部分。 未知命令冲突则阻断而非覆盖。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-010 · 真实送达

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已确认上下文注入后，模型引用任务事实并实际使用。

断言：单凭Hook日志或output事件不足以声明送达。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-001 · 活动分页

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：生成多页知识run，切页并打开详情再更新。

断言：按游标稳定分页。 打开详情不被刷新重置。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-002 · 失败重试状态

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：制造quota耗尽/前序失败/索引pending等状态。

断言：文案区分真实原因。 状态不能都显示已成功。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-003 · 日志查询

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：系统状态→诊断，输入唯一operationId，选择当前项目。

断言：GET返回与UI一致。 不含其他项目敏感信息。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-004 · 日志实时续接

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：无搜索时订阅流，查询+订阅交界插入日志。

断言：streamCursor无缝续接，不丢失或重复。 关闭弹窗断开流。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-005 · 日志上限

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：持续写入超过100条可见日志。

断言：当前界面保持有界节点。 历史仍可查询而非静默永久丢失。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-006 · 导出脱敏

模块：活动与诊断；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：写入假密钥到嵌套error/context字段，导出诊断。

断言：写/查/导出均脱敏。 不能在测试报告保存原真密钥。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-007 · 高级过滤核对

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：分别核对API日志级别、时间、component字段与当前UI控件。

断言：API支持不等于UI已提供控件。 README与DOM差异记录而不造按钮。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-008 · 网络失败反馈

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：查询超时和导出失败分别触发。

断言：UI显示失败。 不能生成空文件冒充成功导出。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-001 · 四模块健康

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：启动隔离实例，分别观察外壳及四模块ready。

断言：端口在线不等于全部模块就绪。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-002 · 维护默认模型

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：保存后台默认后临时切聊天模型，再启动维护。

断言：后台默认不随临时聊天选择变化。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-003 · 凭据留空

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已有embedding凭据后留空保存，再读取mask元数据。

断言：留空不覆盖。 响应、日志不泄露secret。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-004 · 知识根路径

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：修改全局root再导入新项目，比较已有项目knowledgePath。

断言：新导入使用新root。 旧项目固定路径不改变。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-005 · 端口冲突

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：占用默认端口再CLI启动隔离实例。

断言：按实际协议选择/报错。 Hook使用记录端点非写死端口。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-006 · 停止指定实例

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：两个独立数据目录启动，停止其中一个。

断言：只停验证过的目标。 独立模块/其他实例保持。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-007 · Origin防护

模块：设置与生命周期；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：对隔离实例发错误Origin及非回环未认证请求。

断言：拒绝不允许来源。 不得为了E2E改成通配CORS。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-008 · 请求边界

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：测试无效JSON、超长输入、路径越界。

断言：返回确定错误、不崩溃。 不写入非目标目录。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-009 · Windows恢复

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：服务/浏览器/控制器重启后对照持久化和PID身份。

断言：不得按旧PID误杀重用进程。 失去归属证明先阻断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-010 · 桌面范围

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：核对当前桌面package依赖和发布合同，仅测仍支持功能。

断言：不把历史桌面功能恢复当本轮必做。 网页候选不冒充桌面发布。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## QTA-001 · 账户识别

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：核对订阅Key、CLI地区、实际模型行及周权益。

断言：不能把PAYG余额当五小时额度；保护旧套餐权益。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-002 · usage字段歧义

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：回放只有usage_count的响应，再回放带明确百分比响应。

断言：无语义证据时UNKNOWN；明确百分比优先。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-003 · 低额度停止

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：80→19→9配额注入，分别尝试派发任务与单次请求。

断言：19不派新任务；9不转发新模型调用；保护在途请求。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-004 · 额度恢复

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：暂停后两次新鲜80%样本，恢复原任务检查点。

断言：恢复只执行未完成动作；不是睡固定5小时。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-005 · 查询故障

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：模拟401、429、503和超时。

断言：分别分类，UNKNOWN拒绝新调用；不切PAYG或自动买积分。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-006 · 共享消耗

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：另一客户端快速消耗同一订阅，观察采样陈旧性。

断言：安全裕量不足提前暂停；承认单次在途调用无法保证永不耗尽。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-007 · 进程重启

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：停止控制器，保留checkpoint+journal，再启动。

断言：校验journal链；活动worker/Git操作状态未知时先对账不重发。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-008 · 绕过防护

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：worker尝试读真实订阅/Git/npm凭据、改控制合同或直接连上游。

断言：真实OS ACL/网络策略拒绝；布尔配置和提示词不算隔离证据。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-001 · 原始改动保护

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：原工作区有未提交或本地领先远程提交时执行baseline。

断言：只报告并阻断；不reset、stash、覆盖或假称已冻结未提交改动。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-002 · 基准远程验证

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：独立clone后创建非v基准tag与QA分支并核对ls-remote。

断言：tag解引用与分支均为完整基准SHA；不能把操作命令成功当远程完成。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-003 · 测试凭证失效

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：测试后修改一个源码字节或合同，再试提交。

断言：fingerprint/contractHash不匹配而拒绝。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-004 · 新文件泄密

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：在任务许可新文件中加入假token，尝试提交。

断言：暂存前拒绝；不允许只扫描git diff遗漏untracked。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-005 · Push回执丢失

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：在临时裸仓fixture模拟远程已推成功但客户端超时。

断言：读远程HEAD、parent、操作ID后确认；不重复commit或force push。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-006 · CI取消失败

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：推送后CI失败、取消、缺Windowsjob分别测试。

断言：均不能记PASS；CI按本次SHA+QA分支匹配。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-007 · 单问题回退

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：已推修复出现新回归，使用受控revert后再测。

断言：远程历史完整保留；数据恢复单独验证。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-008 · 清理单独提交

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：一个功能修复和一个dead-code清理尝试合并。

断言：任务类型/文件许可不同，拆分并各自回归。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-001 · 正式通道封锁

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：测试v*、baseline、错误rc号、合法qa-rc标签。

断言：仅精确qa-rc/x.y.z-rc.n可进入候选通道；latest无自动出口。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-002 · OIDC身份

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：核对package、workflow filename、受保护environment与publisher。

断言：真实权限未配置则BLOCKED_PUBLISHER；不加长效token替代。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-003 · 制品泄漏

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：向pack列表加入qa/state/.env，再运行audit。

断言：拒绝；必要引擎与plugins不能被清理掉。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-004 · 不可变发布

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：同一个RC版本重复触发、已有tag或发布响应丢失。

断言：查Registry/integrity/动作日志；不改tag、不覆盖同版本。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-005 · 官方独立安装

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：固定version从official registry安装到owned prefix。

断言：version/resolved/integrity/源码SHA匹配；不用global或移动next作凭证。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-006 · 四模块安装运行

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：在该安装路径启动四模块与真实模型、Git闭环。

断言：不能借兄弟源码/node_modules/link运行；安装成功不等于runtime通过。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-007 · latest保护

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：发布前后查询latest，并保留next当前指向。

断言：latest始终不被本次候选修改；异常立刻阻断。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-008 · 稳定版审批

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：全部候选验收通过后检查发布动作。

断言：仅READY_FOR_STABLE_APPROVAL；不将rc直接重标latest。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-001 · 动态入口证明

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：选择搜索不到引用的CLI/Hook/插件文件提出删除。

断言：必须查exports/bin/运行注册/打包/平台路径，不能直接删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-002 · 格式独立

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：只改变本次触及代码格式及关键双语注释。

断言：无全仓格式化、许可证变化或功能语义改变。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-003 · 链接逃逸

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：owned run嵌入指向项目外目录的junction/symlink。

断言：dry-run即拒绝；外部目录内容不变。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-004 · 硬链接防护

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：临时目录含hardlink到保留文件。

断言：拒绝清理；没有跨边界误删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-005 · 活跃数据保留

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：ACTIVE/FAILED/RETAIN与旧PASSED目录混合。

断言：仅PASSED且到期进入清单；首失败/检查点/基线永不自动删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-006 · 清理清单变动

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：生成dry-run后修改文件，再apply。

断言：hash校验拒绝；不按旧清单盲删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-007 · Windows重启锁

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：重启留有锁文件但旧PID可能重用。

断言：不按年龄删锁；核对启动时间/命令/目录后人工或平台监督回收。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-008 · 清理回归

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：删除已证明死代码后跑相关API/UI/pack与候选安装。

断言：无回归才远程提交；不能用覆盖率未执行作为删除依据。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。



---

# 04 · T00–T14执行合同与修复循环

每次只读当前阶段及关联case，不要把整个开发包重新塞进模型。外部任务以编号/合同hash/真实源码指纹绑定；本文件不授权任何生产写。

## T00 · 环境与只读审计

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：配置真实路径/工具；读取当前HEAD、远程main、用户修改、模块版本和浏览器。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs audit --config config/local.json
```

通过：不修改生产；所有未知项有明确阻断代码。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T01 · 基准冻结

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：确认当前已提交基准；创建独立clone和非v tag/QA分支。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs baseline --config config/local.json
```

通过：dry-run审核→单次授权apply→远程SHA确认；未提交内容不进入tag。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T02 · QA归档与初始工具提交

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：校验交付hash；向隔离clone复制审核过的QA源文件，不拷state/运行产物。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node tools/install-control-copy.cjs config/local.json
```

通过：工具自检通过；bootstrap为独立chore提交并push，用户工作区不变。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T03 · 实际Agent与额度通道接线

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：订阅账户核对→CLI JSON→单请求网关→真实worker适配器→Windows监督。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
npm test
```

通过：假额度闭环通过且真实单次调用有本地回执；未验证不能开无人值守。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T04 · 候选发布保护

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：受保护环境/发布身份审核；替换发布模板到同文件名；禁止stable。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node --test tests/workflow.test.cjs
```

通过：纯tag路由反例通过；实际npm身份单独确认，无发布还未调用。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T05 · 行为合同及来源冲突

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：按实际源码扩充清单，解决C01及模块source-matching。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs inventory --config config/local.json
```

通过：需求/实现/未知分列，不让Agent以现状给Bug背书。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T06 · UI与测试体系接线

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：原生单测、pointer UI脚本、截图基线、全模块真实E2E适配。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node tools/browser-shell.cjs config/local.json
```

通过：低层通过不能代替四模块；缺能力精确BLOCKED。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T07 · 初始扫描问题池

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：分层跑现有全部测试，采集失败及环境问题，建立Bug合同。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs run-suite --suite all --contract templates/task-contract.example.json
```

通过：实际运行文件数/退出码/skip全记录；不从静态猜测造Bug。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T08 · 逐Bug修复

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：复现→允许文件→最小patch→目标回归→远程push→CI。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node tools/supervisor.cjs config/local.json --once
```

通过：适配完成才可执行；模型退出0不代表PASS；失败先保留现场。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T09 · 工程清理

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：独立清理候选队列、所有权与动态入口证据、单独提交。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs cleanup-plan --hours 24
```

通过：代码删除与临时清理不同；不为数量指标删除文件。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T10 · 全面与性能验收

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：同环境基线/候选交替测量；原生客户端、真实模型与故障恢复。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node tools/performance.cjs config/performance.local.json artifacts/performance.json
```

通过：阈值经确认；未测/跳过不能纳入PASS。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T11 · RC准备和真实发布

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：版本/锁/manifest独立release提交，针对最终SHA补齐门禁与CI。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs rc-plan --config config/local.json
```

通过：固定RC、不可变远程tag、6类真实gate；只next。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T12 · 独立RC安装迭代

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：官方源固定版本新prefix安装；以真实安装入口运行全套验收。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs rc-install --version 5.0.25-rc.1 --config config/local.json
```

通过：版本是示例需按当前Registry选择；安装和runtime分开。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T13 · 质量收敛

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：最终同一制品两轮核心全验；P0/P1零、其余签收、无flaky。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
node scripts/qa.cjs report --config config/local.json
```

通过：输出READY建议而非自行签发授权。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。

## T14 · 等待正式授权

输入：上一阶段证据、当前真实源码/工具版本及未解决风险。

执行：保留证据、候选receipt、变更/回退表；停止自动修改。

入口命令（在中央qa-autopilot执行；配置与示例参数先核对）：
```text
无stable发布命令
```

通过：用户批准前绝不更新latest。

失败：保留首失败及操作intent，不能跳过条件；现场能力缺失列BLOCKED而非PASS。只继续无依赖、无副作用的安全任务。


## 两条状态轴

`lib/state.cjs`是追加journal与CAS检查点原语，支持合法阶段转换、INTENT/DONE和受控resume；`tools/supervisor.cjs`是已审核单Bug任务执行器，另有task/quota状态文件。二者不是一套已经覆盖全部产品行为的智能Agent；发现新Bug和编写测试合同仍由MiniMax按计划做，控制端批准后进入队列。

代码默认队列为空。不可让模型通过自己改queue、approvedContractHash、proof或authorization证明自己正确。控制端把每个合同限定为一个Bug和精确文件路径；同批最多一个writer，性能时停止其他重任务。

## 机械Bug闭环

发现→重现（首失败）→区分环境/需求/实现问题→填写合同→在当前源码建立失败回归→独立审核正确性→最小修改→复测目标/影响域→完整文件指纹一致→审查diff→提交并push→等待同SHA全部CI门禁→完成。

已有失败测试可直接作为重现。如果需要新回归测试，先以独立且标为RED-characterization的测试基础提交保留反例，并注明CI预期失败；**该提交不能标为bug已修复**，不得发RC。或者由控制端冻结测试文件/执行非提交复现，而不是把未审核断言交给修复模型同时改。初版supervisor要求干净源码及已有失败receipt；不满足则先完成这一步的受控准备，不偷偷放宽启动条件。

一个Bug的成功修复原则上一个fix提交；若远程CI才发现问题，可有同Bug补救fix/revert，不强行amend重写远程历史。临时红测试、bootstrap、release元数据是独立明确类型，不冒充一个新Bug。

## 失败和预算

同一Bug自动尝试上限建议2，控制器默认遇一次失败即阻断供复核，比2更保守。禁止超时后盲重发“帮我继续”。先核对进程、修改集、请求accept及远程状态，再批准新的attempt。无新证据的重复试错不消耗更多配额。

压力/模型请求设置独立预算。低额度暂停新Agent请求，不停止正在晋升数据或进行Git/npm对账的确定性控制操作。没有明确账号/实例所有权的进程不能kill。

最终两轮验收应针对同一个固定RC制品，无源码/模块/环境漂移。发现问题进入新候选循环；不是反复跑同一小撮用例就能宣称“没有Bug”。



---

# 05 · 真实UI、视觉、性能、负载与故障测试

## 分层证据，不替换概念

L1函数/后端合同：原生suite。L2真实浏览器外壳＋可控模块故障：本包browser-shell。L3四模块真实集成、真实模型/embedding与原生客户端：必须现场适配。L4安装制品上的同样链路：固定RC验收。通过L2不能表示L3/L4通过。

`browser-shell.cjs`使用CDP Input.dispatchMouseEvent、Input.insertText，先滚动并elementFromPoint验证目标未遮挡；不是document.click。会在4视口×2主题×6页保存截图，并以真实Git/登记/Hook验证导入，但四模块503为故障替身。原生Windows文件夹对话框、真实模型和所有Dock内部控件未由此脚本覆盖。

## 视觉基线

批准前冻结：OS/浏览器完整版本、字体渲染环境、viewport、deviceScaleFactor、真实浏览器缩放（不要把CSS zoom当等价）、主题、locale/timezone、fixture和source版本。字体/动画/时间字段漂移先消除原因；对合理动态区域只允许小范围、列明原因的掩码，禁止遮住全部输出获得绿图。

流程：源版本截图→人工检查和批准→保存SHA及环境ID→候选同环境截图→像素差异图＋DOM几何/点击/焦点测试→审查。初始基线可能已经含Bug，像素相同只说明没变，不说明好用。意图明确的UI修复通过验收后才能独立批准新基线，绝不自动update-snapshots。

本包零依赖PNG比较支持8位RGB/RGBA、非隔行。其它格式会拒绝，不擅自低质转换。
```powershell
node tools/visual-compare.cjs baselines/approved.png artifacts/current.png baselines/approved.json 'win-chrome-verified-env' artifacts/visual-diff
```
approved.json必须包含approved、environmentId、图片sha256、channelTolerance、maxChangedRatio，阈值由人工定。输出diff.png/comparison.json只是单图比较，不是全产品视觉PASS。

## 性能基线和统计

先定义每个场景的fixture规模、冷/热启动、缓存策略、采样点、并发、持续时间、预热和资源背景。基线与候选交替运行至少5个独立重复样本，保存原始数据、环境及时间；P95/P99需足够请求量，小样本不能用P99讲精度。长任务延迟把模型外部服务、服务排队、后端处理和UI渲染分别计时。

基线不能成为“当前本来很慢也算正常”的借口：同时定义可接受的绝对体验目标和相对回归阈值，标明谁确认。未批准阈值时只报MEASURED_NOT_ACCEPTED。关键场景：首页可交互、项目切换、长会话滚动、Dock开关、日志分页、检索、后台维护前台响应、静置网络请求数。

本包performance工具只做**有界loopback只读HTTP测量**，允许health和aggregated、20–2000样本、1–8并发。不能把它当成完整压力/内存泄漏测试：
```powershell
node tools/performance.cjs config/performance.local.json artifacts/performance-run.json
```
config需由控制端验证实例PID/startTime/dataDir/source SHA，填写ownedInstanceVerified、identityReceipt、environmentId、fixtureHash、route、count、concurrency。单纯布尔字段不等于身份校验。服务root和fixture仅属于本轮。

## 长时/负载扩展

现场增加独立脚本采样所属PID树的CPU/RSS/heap、event-loop延迟、handle/socket/listener计数、UI DOM数量，按启动/预热/稳态/结束/空闲恢复分阶段记录。浏览器多标签要真实创建，例如1→2→4→8；Node WebSocket连接数不能替代浏览器同源行为验收。

工作负载分开：项目数/日志数/知识文档量/Commit事件率/会话与面板数；不同时增加多个变量。系统设计并发2不代表收到第3个任务就是Bug，应检查正确排队、背压、内存有界和退出恢复。大规模模型负载使用协议一致的可控替身，真实模型另设明确调用预算。不得用测试流量打外部服务做压力。

Soak先做有界短批确认无严重问题，再延长至批准窗口；磁盘可用空间、内存、外部调用成本触发熔断。每轮测试时间预算与额度管理是两回事。

## 故障矩阵

针对真实生命周期注入：导入预检和登记之间Hook变化；commit通知丢失；持久claim前后进程中断；staging校验失败；晋升日志落盘前后中断；索引失败；SSE游标重复/缺口/失效；模块端口变更；权限拒绝；UI离线；控制器/Agent中途退出。

每项写清注入点、预期安全状态、恢复步骤、不得变化的哈希与资源释放。仅允许故障注入fixture服务。不能强杀来源不明PID，不能对生产磁盘制造写满，也不能为了重现而破坏第三方配置。

完整性能、soak、原生客户端/四模块E2E属于T06/T10现场实施及验收；本包没有假造这些场景的通过报告。



---

# 06 · 配额查询、逐请求网关和安全暂停

## 实际账户为准

当前官方M Plan说明首次使用开启5小时窗口，到期重置；每周窗口独立。历史Token Plan可能保留特殊权益，必须记录本账户脱敏权益回执。不要根据“周无限”取消查询，也不要自动升级、取消自动续订或改按量付费。

官方支持 `mmx quota`；CLI源码支持 `mmx quota show --output json`。官网FAQ给出token_plan/remains接口示例。各地区/Key类型应现场验证；API普通Key余额并非订阅用量。本包CLI模式默认入口为空，故意不猜本机mmx位置；Windows应node.exe加mmx实际JS入口。

## 字段处理

`model_remains`中精确选择已确认模型行，多个匹配或没匹配都UNKNOWN。`current_interval_remaining_percent`为明确0–100数值时优先；没有它时 `current_interval_usage_count`不能想当然当已用或剩余。必须有verifiedCountMeaning及其观察证据，或先停止。

周额度：读取实际响应里验证过的percent字段，或由人批准“无限周权益”并留证。未确认周限制不得放行。字段出错、401/403、查询429、网络失败、陈旧样本都闭合保护。查询节奏默认120秒只是保守建议，不是官方保证的速率许可；触发429应退避。

## 两层门禁

任务派发：剩余<=20%停止新大任务。单模型请求：<=10%拒绝新请求。恢复：>=35%，至少两次新鲜连续采样。20/10/35是本方案保护值，不是套餐规则；应按真实单任务开销调整且hard<stop<resume。

网关持有真实订阅Key，worker只持本地随机token。允许的协议路径仅 `/v1/messages`、`/anthropic/v1/messages`、`/v1/chat/completions`，明确model和max_tokens<=4096；默认单请求并发。未知路径/模型/过大输出拒绝。流式透传支持背压、超时和断连。真实SDK若需要其它路由，在T03按协议补测试后扩展白名单，不得绕过网关。

**承诺边界**：配额接口存在滞后，同账户其它工具也会用额度；单个已在途请求可能超出预计。任何系统都不能仅凭余额轮询保证“永不中断、永不触及积分包”。保留余量、限制并发/输出/上下文，并验证账户的额外计费设置；不自动购买额外资源。

## 控制启动

控制端安全注入MINIMAX_API_KEY与QA_GATEWAY_TOKEN，不把值写在命令、计划、Git或报告。配置正确后分别启动：
```powershell
node tools/quota-gateway.cjs config/local.json
node tools/supervisor.cjs config/local.json --once
```
这是本机控制程序，不代表ChatGPT在后台替你运行。持续运行去掉--once前，必须通过worker适配/进程隔离/恢复测试。

## 真正的暂停协议

通用worker请求为 `pkb-qa-task/v1`，包含task、合同、工作目录、resume及resultFile。网关拒绝新调用后，已验证适配器在安全边界退出75，写入：
```json
{"protocol":"pkb-qa-task/v1","taskId":"QA-001","status":"PAUSED_QUOTA","safeBoundary":true,"checkpoint":{"opaqueSessionId":"实际可恢复会话","nextStep":"实际未完成步骤"}}
```
worker响应不是测试证据。控制端重新计算HEAD/文件fingerprint、审查变更范围才保存暂停。恢复前再查quota，达到恢复门限后把同一task及checkpoint传给适配器；不会创建新Git提交。无法正常退出或只断网不回协议时为BLOCKED_AGENT，需要核对进程和文件，不能假称已自动恢复。

本包自检用假worker验证两次暂停恢复保持同一Git HEAD；真实MiniMax/Codex/Claude/OpenCode承载者必须实现此协议并留真实回执。**`mmx quota`是查额度工具，不等于一个能修代码、能恢复会话的Agent启动器。**

## Windows重启

计划任务只负责启动受控账户下的网关与控制器。须设置明确Node路径、Start in、无多实例、日志位置和退出策略；不把密码/Key放任务参数。`scripts/resume-controller.ps1`只是入口包装，不会注册任务或自动删除锁。重启后先验证旧worker是否存活、PID创建时间、job/端口及Git/npm意图，再清除确认无主的锁。由可靠OS监督保证“旧进程已退出”后可自动恢复；没有该能力则安全阻断，不冒充完美无人值守。



---

# 07 · 基准、隔离clone、远程提交及回退

## 初始基准

T00审计原项目HEAD、origin/main、工作区diff。当前参考SHA只是审查锚点，执行前重新比较；不能偷偷更新用户代码或冻结错误目录。

本包baseline默认只生成dry-run。有原生用户未提交修改或本地/远程不同则阻断，保存只读差异并决定要测哪个已提交版本。不能reset/stash；tag不含未提交内容，此项明确告知。

批准后在中央QA `.runtime/workspaces/repair` 创建本地非硬链接clone，Git模板/用户目录隔离，origin设回精确仓库。原生产Hook不复制；控制端自身commit/tag/push使用该clone的空Hook目录覆盖全局core.hooksPath，防止误触生产维护；产品Hook测试只在独立Git fixture真实安装运行，不能因此被全局禁用；不建立指向原node_modules的junction。创建QA分支、非v基准annotated tag，并一次atomic push后ls-remote核对tag解引用和branch都等于基准SHA。

已有工作目录或远程refs时不覆盖，进入恢复核对。remote不支持atomic时此工具报错；需经审查单独执行并补双ref核对，不默认降级。

## Bootstrap例外

QA工具拷贝、发布工作流保护、最初测试接线属于独立chore/test任务，不是假Bug。先用 `install-control-copy.cjs` dry-run，校验交付manifest，只拷脚本/计划/例子，排除delivery日志/本地状态。人工/控制端审查精确文件清单后提交并push；CI只从审查后的远程QA分支读取。

中央控制器本身不随修复模型任意升级；修改中央工具要先独立评审、跑自检、重新建立信任和hash。单纯在源码副本里修改控制文件并不应该影响正在运行的中央门禁。

## 单Bug事务

工具 `commit-push`要求：QA分支/精确origin；实际工作文件全在合同allowlist；无预先暂存；无secret/生成数据；非空、大小有界；受保护文件额外审批；真实suite receipt PASS/非零测试/无skip/flaky/timeout，HEAD、fingerprint、contractHash完全一致。

先记录INTENT→精确git add→diffcheck及暂存集合核对→commit（附QA证据footer）→非force指定QA ref push→ls-remote验证→记录PUSHED_CI_PENDING→同SHA CI必需Linux22/24和Windowsjob成功才DONE。

命令：
```powershell
node scripts/qa.cjs commit-push --contract config/tasks/QA-001.json --receipt artifacts/<真实run>/receipt.json
```
先审查dry-run；本地配置权限完整才可加--apply。路径中的<真实run>必须从实际返回receiptPath获取，不是字面值。

门禁不会只检查已追踪git diff；新增untracked允许文件也要扫描凭据。启用凭据安全扫描只能降低风险，不能自动证明没有所有秘密。对二进制/公共API/存储变化提高审批等级，不把大文件移出allowlist绕过。

## Push/CI中断

INTENT已存在时不得重试commit。读取本地HEAD/parent/footer、remote QA head、原fingerprint和操作日志。
- 本地无提交且工作区保持原状态：批准后恢复当前事务。
- 已本地提交、远程还是parent：验证该提交后只补push。
- 远程已为本次SHA：标已推，查CI，不再提交。
- 远程其它SHA：阻断，不能自动merge/rebase/force。
- tag已存在：验证解引用，不移动。

CI要匹配本次完整SHA、QA branch、workflow路径、push事件和全部必需job。被新push取消、未运行、skipped、旧SHA绿色都不通过。等待当前CI结束后再推下一任务，避免cancel-in-progress让每个bug没有真实远程验收。

## 回退

已推送问题用独立revert或修复提交保留历史；不可amend+force。恢复用户数据不能仅靠Git，若曾有schema/数据变更，需预先设计独立备份/逆操作，因此本自动循环默认禁止这类变更。

基准tag是最后安全比较点，不意味着要把整仓强制reset回去。可用新隔离clone安装旧固定版本比较，保持原用户工作区和生产服务不动。



---

# 08 · 真实next候选、制品证据与稳定版保护

## 发布通道

当前工作流v*无明确候选隔离，T04之前禁止推v/rc发布标签。包内 `templates/publish.rc-only.yml` 是待审核替换模板，安装为 `.github/workflows/publish.yml`，整个QA期间只接收 `qa-rc/x.y.z-rc.n`。无stable触发、无latest写命令。基准tag `qa-baseline-*`不触发。

选择同文件名是减少OIDC身份变化，不代表不需要核对：模板加入受保护环境 `npm-rc-gate`，npm Trusted Publisher配置必须匹配仓库/文件/环境。管理员设置独立reviewer、禁止自行审批、受保护tag/工作流权限后再用；不能让模型自己修改workflow解除审批。OIDC身份本身不自动限制dist-tag，因此“next-only”必须由代码保护及独立审批共同保证。

模板沿用现有Node24及npm11大版本，运行记录确切CLI版本；现场选择审查过的确切版本以获得更强可复现性。旧runbook关于npm12或registry-url的经验不是永久官方合同，按现行官方文档和真实身份探针验证。

## 准备候选

读官方Registry现有版本，选择尚未存在且递增RC。每Bug都push，但不是每Bug都publish。阶段性修复/清理通过L4后，版本元数据、锁文件、插件清单、runtime/vendor manifest同步，独立release准备提交；针对这个最终SHA重新验收，避免测试发生在改版本前。

`qa rc-plan`要求源码clean、remoteQA HEAD匹配、CI通过、六类发布证据（unitIntegration、realE2E、visual、performance、faultRecovery、pack）都属于同HEAD/fingerprint，且有独立reviewedBy和文件hash。模板 `rc-acceptance.example.json`没有通过凭证，不能直接改几个PASS使用。

真实E2E凭证须mode=REAL_PRODUCT、realModel=true。browser-shell的REAL_BROWSER_SHELL_MOCK_MODULES明确不能满足。证据可信性靠控制端权限和独立复核，手工JSON字段本身不具有可信执行证明。

## 发布事务

1. dry-run生成固定version/SHA/tag/next/latestBefore计划。
2. 控制端核对门禁及Publisher授权后，只推精确候选tag；记录INTENT与解引用SHA。
3. GitHub受保护环境审查：本次SHA、证据、latestBefore、模块版本。
4. CI再跑release:verify、原生全suite；pack一次生成tgz并审查文件列表，发布**同一tgz**，显式 `--tag next --provenance --access public`。
5. 查询官方Registry核对固定version、integrity与tgz一致、next指向候选、latest未被本轮改变。存在传播延迟时有界读取重试，不重复publish。
6. 发布完成状态为PUBLISHED_NOT_INSTALLED；继续安装验收后才能标候选通过。

发布未知、同版已存在、tag存在不移动也不重新覆盖；查工作流、Registry和intent对账。候选失败发新rc，必要时经过批准将next指向先前通过候选；本包没有自动dist-tag回退按钮。

## 真正的隔离安装

`rc-install`工具从官方源读**固定RC版本**而非移动next。新建owned目录、全新npm缓存、本地prefix：
```text
node <实际npm-cli.js> install --prefix <owned-prefix> --registry=https://registry.npmjs.org --save-exact @sanqianx/project-knowledge@<固定RC> --no-audit --no-fund
```
不执行global安装，不改用户默认registry，不复用本地TGZ/兄弟源码。安装生命周期可能运行代码，必须在受限QA环境批准后进行，不能因“官方源”就无限制信任依赖脚本。

读取prefix package-lock的resolved、integrity、version及已安装package.json；运行时从**这个安装目录**启动，并保存源SHA/模块manifest/真实PID和dataRoot身份。检查runtime:verify/release:verify适用于安装制品的真实命令，不能要求包中未发布的开发脚本存在而误判产品。

随后：CLI→四模块health→实际浏览器→真实模型→Git提交知识闭环→检索→恢复→既定性能。固定安装版没有的源测试工具由中央QA在外部调用，而不是拷入安装目录改制品。安装工具输出INSTALLED_NOT_RUNTIME_VALIDATED正是提醒还有后续验收。

## 最终稳定发布

latest在整个测试周期保持不由QA自动修改。两轮同RC验收通过，P0/P1归零、P2/P3签收、证据完整后只READY_FOR_STABLE_APPROVAL。用户明确授权后另建稳定发布合同：正式版本不是rc重新标latest，版本转换影响的制品仍需最终核验。此包故意不提供stable命令。



---

# 09 · 安全代码清理与临时产物治理

## 两类清理，不共用执行器

代码清理：删除死代码/旧文件、合并重复逻辑，是业务源码改动，必须Git版本化且独立review、test、push。中间产物清理：仅删除本轮拥有且到期的临时数据，使用白名单删除器，不产生无意义Git提交。这两类不能用一个“rm所有无用文件”替代。

## 死代码证据链

每个候选记录：文件owner、为何疑似无用、直接/动态引用、exports/bin/插件注册/字符串路由、平台条件、GitHub Actions、npm files/runtime manifest、是否兼容恢复入口、替代实现及测试证据。静态搜索或覆盖率未执行仅能提出候选。

特别保护：动态import/require、IPC/SSE事件名、CLI bin、原生Hook、插件marketplace、vendored runtime、独立模块入口、旧版本读取/恢复逻辑。不要因为目录叫dist、node_modules、desktop、legacy就删；不要根据主仓没import独立模块内部代码就判断不需要。

## 风险与审批

低：确定归属的临时文件、局部拼写/注释修正。中：已证明无调用的内部函数、少量重复工具。高：公共API/存储/第三方Hook/发布/权限/多模块接口/大量目录迁移。高风险自动循环不处理，提出独立合同并获得许可。

测试基线→删除最小候选→目标/模块/跨模块测试→DOM用户流程→pack→需要时真实RC安装。未能证明功能保持就撤回该清理的工作区patch或另作revert，不用增加if/禁用测试掩盖回归。每个清理task单独refactor/chore提交且push远程QA分支。

## 临时删除器

`ownedRun`记录 `.qa-owner.json`，仅PASSED、finishedAt有效且到期的 `.runtime/runs/<runId>`进入dry-run。ACTIVE/FAILED/RETAIN不自动删，.runtime/workspaces更不在范围。首失败保留的是脱敏日志/截图/必要状态，不把真实Key放进“故障备份”里。

清理前停止并核对自有进程，关闭独立测试profile、锁/文件句柄；“测试进程返回0”不足以证明所有孙进程退出。控制端确认进程tree身份及数据目录后才许可PASSED转入删除周期。恢复数据应先保留，不能过早标成功。

dry-run逐文件列相对路径与SHA；拒绝symlink/junction、hardlink、特殊文件、.git/node_modules等受保护子树。apply重新扫并比较planHash；逐文件unlink然后只删除空目录，**不执行recursive rm或git clean**。对未知变动即停止，保留剩余现场。代码可防误删，但不能在恶意同权限进程持续置换路径时提供完整TOCTOU沙箱保证；需要独立ACL和独占清理窗口。

默认24小时是保守初值，最少1小时。失败证据由人工/已审批归档政策处理，不无限保留大日志到磁盘满：设置容量告警、脱敏归档和审批清理队列，容量不足则停止新测试，不偷偷删失败数据。

## 执行

```powershell
node scripts/qa.cjs cleanup-plan --hours 24
node scripts/qa.cjs cleanup-apply --plan state/cleanup-plan.json --apply
```
第二条只有开启已审核cleanup权限、无活动控制锁才执行。dry-run输出与实际删除审计分开保留；路径未匹配/清单变化返回阻断。不能把.cleanupEnabled自行改成true当作进程所有权证据。



---

# 10 · 代码规范与简短双语注释

以同模块现有风格为准。新增控制代码使用Node CommonJS、明确输入检查、固定退出码和有界输出；公共业务API保持原风格和命名。格式整理不是架构重写的借口。

## 修改规则

一个任务只修改允许文件与必要逻辑。命名表达实际语义；异步分支明确错误/取消/超时，finally释放自有资源；事件监听注册/注销配对；控制数据使用可验证schema。保持Windows路径、CRLF/shebang、中文/空格路径和Linux语义可测。禁止跨模块复制大段实现形成新的owner。

只格式化本次触及函数或小文件。不要全仓formatter、批量排序所有导入、批量翻译标识符、变更所有引号风格。格式/注释任务与bug修复独立提交；简单同处必要格式修正可随fix，但不得掩盖功能diff。

## 注释

解释不明显的业务约束、风险、顺序与原因，不复述每行代码。新增/修改关键注释采用一行简洁中英双语，例如：
```js
// Reject stale evidence before commit. / 提交前拒绝过期证据。
// Keep promoted Markdown on index failure. / 索引失败时保留已晋升知识。
// Never follow a junction during cleanup. / 清理时不得跟随目录联接。
```
中文与英文要一致，不加入无法证明的“绝对安全”“保证零Bug”。JSDoc参数/返回/异常保持真实，不把伪代码当完整实现。协议标记、pragma、许可证、第三方源码与生成代码不批量翻译。过期TODO要先确定是否还代表真实缺口，不能为了整洁删掉未解决风险提示。

## 格式验收

git diff --check、语法检查、目标测试；涉及脚本入口/换行必须pack/install验证。重排格式不能成为降低覆盖率、删catch或吞异常的理由。所有清理收益记录在独立任务：减少多少真正重复、保留哪些动态入口、有哪些不确定项，而非仅用删除行数评价。



---

# 11 · 检查点、事务恢复与副作用幂等

## 存储原语

Store使用文件锁、revision CAS、先追加journal后原子checkpoint；journal记录前状态hash。state.lock不按年龄自动删除。恢复只按连续revision/hash重放**本地状态**，不会重做Git/npm外部副作用：
```powershell
node scripts/qa.cjs recover-state --config config/local.json
```
进程/断电可能发生在journal与checkpoint之间，该命令可恢复已落盘状态；journal缺口或hash不符拒绝。Windows文件替换/持久性必须本机验证，Linux自检不是Windows断电保证。

## 状态字段

source：原基准SHA、当前QA parent、fingerprint；task：ID、合同hash、阶段、attempt、allowedFiles；test：首失败/复测路径、退出码、fixture/environment；remote：目标ref、已确认SHA、CI run/job；release：固定version、tag、tgz integrity、latestBefore、registry receipt；quota：采样时刻、字段来源、恢复计数；process：broker身份/PID/创建时刻/工作目录；恢复动作只有一个明确的nextStep。

核心状态INITIALIZING、BASELINE_VERIFYING、DISCOVERING、REPRODUCING、TRIAGING、FIXING、VERIFYING、COMMITTING、PUSHING、CI_VERIFYING、REGRESSION_TESTING、CODE_CLEANUP、CLEANUP_VERIFYING、RC_PREPARING、RC_PUBLISHING、RC_VALIDATING、PAUSING、PAUSED_QUOTA、RESUMING、BLOCKED、READY_FOR_STABLE_APPROVAL。图中没有自动stable状态。

Store和supervisor的任务状态采用不同职责文件，不能人工把phase改DONE跳过实际gate。operator恢复动作也需要记录原因、原值和实际证据。

## 恢复矩阵

| 中断点 | 必查事实 | 下一步 |
|---|---|---|
| Agent正在改代码 | broker/PID身份、实际diff、测试文件是否变动 | 能证明安全pause则用同task checkpoint继续；否则BLOCKED_AGENT |
| 配额安全退出75 | taskID、protocol、safe boundary、parent、fingerprint | 新鲜额度达门限后继续同任务，不重新造Bug |
| 本地commit返回丢失 | HEAD/parent/footer和INTENT | 确认已commit则只补远程操作 |
| push返回丢失 | ls-remote完整SHA与local HEAD | 相同则查CI，不再commit/push盲重试 |
| CI尚运行/取消 | 本次SHA+branch+workflow+所有jobs | 等待或失败处理；旧绿job不可代替 |
| RC tag已推发布未知 | tag解引用、workflow和Registry版本 | 查到相同integrity才确认；否则阻断不移动tag |
| npm install中断 | prefix归属、npm进程、package-lock及runtime文件 | 不复用不完整receipt；保留首次失败，新run新prefix |
| 清理中断 | 已删除清单、剩余文件、owner和活跃进程 | 重新dry-run并审批；不沿用旧清单无限删除 |
| 机器重启残留锁 | PID可能复用，必须核对创建时刻/broker与目录 | 由OS监督证明旧进程结束后恢复，不按mtime删锁 |

## 并发与退出

控制器单实例、Git写锁、测试锁、RC发布GitHub concurrency不取消在途发布。清理窗口与worker/test/commit互斥。工作时间长不代表失控；根据心跳、进程、工具活动和批准任务期限判断。

runLogged有超时与有界输出，超时先停止其直接子进程；无法确认孙进程结束时返回未确认进程树，不自动清理该run。完整Windows Job Object/broker生命周期须T03现场实现/验收。缺该能力时安全停止比冒称全自动恢复更重要。

## 恢复测试的真实等级

本包已用本地fixture验证journal缺口恢复及受控假worker两次quota暂停续跑；没有真实Windows重启、真实MiniMax CLI session恢复或GitHub/npm断线写入实验。后者按本章矩阵在本机专用fixture验证，不能转写成已通过。



---

# 12 · 门禁、证据和完成定义

## 证据等级

SOURCE_OBSERVED：读到源码/文档，不是执行。
SELFTEST_PASS：本包工具在当前Linux/Node环境测试通过。
REAL_BROWSER_SHELL_MOCK_MODULES：实际浏览器与外壳、模块替身。
REAL_PRODUCT：四模块/真实模型等定义范围实跑。
RC_INSTALL：官方固定制品安装receipt。
RC_RUNTIME：该安装制品的实际业务验收。
NOT_RUN/BLOCKED/FAIL/FLAKY：均不是PASS，也不折算通过率。

状态/结果只能由控制端真实进程与断言产生。保存raw exit code、时间、环境、完整SHA/fingerprint/模块版本、测试数量、skip、首失败与复测。不是Agent回答“完成”后写PASS。避免把日志中的正常字符串skip误归为环境跳过：初版runner保守匹配，若误报需要审查实际test协议并改解析器/补反例，不删除业务测试。

## 分层门禁

G0 基准和数据安全：原目录不变、隔离目录身份和远程基准确认。
G1 单问题：真实反例、task合同、最小diff、目标测试非空且通过。
G2 影响域：模块+上下游测试，相关真实UI路径/数据状态通过。
G3 远程：精确QA push已确认，同SHA必需CI全部成功。
G4 全产品：130矩阵适用项逐case证据、四模块/原生客户端必要矩阵、没有未解释flaky。
G5 候选：版本与manifest、pack、发布身份、完整gate、官方固定RC下载和运行。
G6 收敛：最终相同制品两轮重要路径无新可复现缺陷；P0/P1零；P2/P3风险明确签收；性能/视觉已批准；无隐藏未测高风险。
G7 稳定审批：仅READY_FOR_STABLE_APPROVAL，由用户另行授权。

已证明非本版功能可N/A，但必须附同版本源码/合同理由和独立审核。不能用“很难测”“没有工具”“模型额度不足”作为N/A；这些是BLOCKED。

## 候选证据集合

模板rc-acceptance中的6项分别引用真实控制端JSON文件和SHA256。每个文件都需包含status PASS、head、fingerprint；realE2E还需mode REAL_PRODUCT和realModel true。其它质量项应增加实际sample/cases/environment/thresholdReviewedBy，不能仅凭这些最小字段获取可信性。OS与独立reviewer保证文件没有被测试模型篡改。

源码或版本元数据变化使旧fingerprint失效；不要为了重用旧通过记录从fingerprint中随意排除变化文件。可对纯发布说明使用明确版本化证据映射，但必须独立批准，不由模型自动判断“没影响”。

## 最终报告结构

基准与最终SHA/RC/SRI；真实执行case数；每种mode通过/失败/阻断/未测数；按P0–P3问题及对应远程commit/CI；UI差异与批准者；原始性能样本和阈值；原生客户端/真实模型覆盖；清理项与保留理由；额度暂停/恢复次数与异常；数据保护验证；可回退步骤；未完成项；稳定版是否获用户明确授权。

`qa report`目前仅汇总本地suite receipts并提醒它不证明全部case，不生成虚假READY。最终矩阵审核由T13完成，证据不足则NOT_READY。



---

# 13 · 工具能力、现场适配和不支持项

## 已提供的实际实现

lib/safety：路径/链接边界、原子JSON/锁、受控env、命令日志、拥有标记与清理。
lib/quota：实字段解析、保守UNKNOWN、暂停/恢复门限、CLI/HTTP查询。
lib/state：journal/CAS/operation intent/recovery。
lib/git：源指纹、范围/凭据扫描、baseline clone与远程核对、逐问题commit/push。
lib/runner：原生test发现、隔离执行、真实receipt。
lib/registry：精确CI/job/Registry、pack审查、候选门禁/tag、固定RC隔离安装。
tools/quota-gateway：逐模型请求拦截和流式转发。
tools/supervisor：已批准单Bug队列、配额调度、受控pause75/resume、复测、push及CI等待。
tools/browser-shell：原生指针/键盘外壳冒烟＋真实导入/Hook，模块故障替身。
lib/png与visual-compare：有界RGB/RGBA PNG解码、差异图和批准基线检查。
tools/performance：受限loopback读API测量与匹配基线对比原语。
tools/ci-rc-guard及rc-only.yml：RC tag、版本、pack、Registry和latest不变核验。
tools/inventory/report/install-control-copy：只读清单、有限报告、基于交付manifest的安全拷贝。

## 现场还必须完成

1. **真实worker适配器**：用户实际承载MiniMax的是哪种CLI/SDK需要读取本机版本、help、session协议；不能猜执行参数。配置worker.executable/args，让它接收pkb-qa-task/v1、在指定clone改允许文件、退出75安全checkpoint、resume继续同任务。SDK实际发每次模型请求都必须经过网关，禁止隐式另一provider/Key。
2. **权限与Windows进程监督**：受限broker、进程Job/ACL、网络出口、目录隔离、stdout敏感数据约束和重启恢复；本包不包含可跨所有Windows Agent实现的通用broker。
3. **真实产品测试扩展**：130个规格中的完整原生客户端、真实模型/embedding、四模块、完整Dock和长时性能脚本，在匹配源/实际环境补齐；不要将现有starter称作已覆盖所有场景。
4. **可信审批**：审批者和证据目录不能被模型写；GitHub Environment/publisher从用户账号实际验证。布尔配置不是审批流程。
5. **性能/视觉基线**：当前没有用户批准截图或绝对性能SLO，初始只采样/审查。
6. **安装产物E2E**：固定RC安装工具已提供，真实运行方式/模块身份需要现场对接，安装receipt不自动PASS runtime。
7. **新Bug发现→合同队列**：按case运行获取反例，由MiniMax提出合同，再由控制端/独立reviewer批准；supervisor不会凭空发现或自行批准问题。

这不是省略需求：这些项是T03/T05/T06明确的开发与验收任务，具有阻断条件。用户Windows、凭据与真实客户端不可从本容器事实推断。任何未完成项都不能在最终报告隐藏。

## worker验收合同

输入：固定taskID、合同hash、sourceRoot、resultFile、resume对象，env QA_REQUEST_FILE/QA_RESULT_FILE。stdout只是日志，不是成功凭证。退出0表示patch已完成可测试，75表示quota安全暂停，其它/timeout表示阻断。控制端在每次退出后重新读取Git diff，无法证明边界即阻断。

必须证明：模型路由正确；网关9%样本后上游新增调用为0；配额恢复同task继续；改控制文件/读真Key/直接Git push被OS拒绝；第一次错误patch未提交；正确patch经独立测试提交；断线没有重复派发；Windows机器重启时没有重复进程或错误清理。

## 待扩展但不可走捷径

不支持的API路由、图片/附件模型请求、原生文件夹UI或真实权限弹窗不应伪装通过。添加适配器时复用现有API合同，留首次失败，先补协议测试再改变白名单。模型自带自动重试要有界，收到QA_QUOTA_PAUSED应退出75保存而不是忙等耗资源。



---

# 14 · 源码证据、外部资料与差异登记

## 审查范围

本次通过GitHub连接器读取了主项目提交元数据、package.json、发布工作流、ui/index.html、ui/product.js主要逻辑、server入口、server-app前180行、原生测试入口、product-import-ui-test全体及CDP/spawn助手；独立Workbench package和分支元数据。**没有完整checkout并逐行审查全仓、没有读取到同版本Workbench全部源码、没有运行真实产品。**

下表 URL 固定主项目SHA，不使用移动main给后续版本背书。行号用于定位源文件，不等于原始connector JSON外层行号。本包自己的判断均标为“设计/待验证”，不把建议写成现存实现。

| ID | 文件或官方资料 | 本次所支持事实 |
|---|---|---|
| S01 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/package.json | 主包5.0.24、Node>=22、Workbench0.13.6、包files及脚本 |
| S02 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/.github/workflows/publish.yml | v*触发、未显式next、现有OIDC配置 |
| S03 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/ui/index.html | 六页真实导航、表单ID、内嵌模块和系统抽屉 |
| S04 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/ui/product.js#L1-L120 | iframe协议、项目epoch、可选知识Dock与注册 |
| S05 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/ui/product.js#L480-L835 | 接入/日志/模型/导入/记忆/解绑具体操作链 |
| S06 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/_site/server.js | HTTP入口转交server-app |
| S07 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/_site/lib/server-app.js#L1-L180 | 运行服务依赖和Origin/令牌/JSON边界 |
| S08 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/_site/_test/run-all-tests.js | 动态*-test.js、分进程、--no-report、后端子集不算全验 |
| S09 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/_site/_test/product-import-ui-test.js | 真实外壳与真实Git，四模块503替身；不是四模块全E2E |
| S10 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/_site/_test/helpers/cdp-browser.js | send/evaluate/screenshot/setViewport/close接口；只传新建profile |
| S11 | https://github.com/SanQianX/project-knowledge-base/blob/c7d5b2bc86b7e51fe6e322999294bb497af1808c/_site/_test/helpers/spawn-server.js | helper默认legacy，产品测试须明确engine；隔离参数 |
| S12 | https://github.com/SanQianX/Claude-Ai-Workbench/blob/be654e20b413ec839c37cc2d367a9674d34c9176/package.json | 默认源码分支版本0.3.0，不可当作0.13.6 |
| S13 | https://platform.minimax.io/docs/m-plan/usage-rules | 当前M Plan按首次使用开启独立5小时/7天窗口；CLI可查 |
| S14 | https://platform.minimax.io/docs/m-plan/faq | 官方quota API示例、订阅与PAYG/积分包区别、历史套餐权益说明 |
| S15 | https://github.com/MiniMax-AI/cli/blob/main/src/commands/quota/show.ts | mmx quota show --output json；model_remains字段 |
| S16 | https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts | usage_count存在历史语义差异，明确百分比用于消歧 |
| S17 | https://github.com/MiniMax-AI/cli/blob/main/src/client/endpoints.ts | 订阅quota与普通Key余额路由不同 |
| S18 | https://docs.npmjs.com/trusted-publishers/ | OIDC工作流/包/环境身份须匹配，最低CLI/Node要求现场核对 |
| S19 | https://docs.npmjs.com/cli/v11/commands/npm-publish | dist-tag和不可重复版本；发布精确tgz |
| S20 | https://playwright.dev/docs/test-snapshots | 视觉比较依赖固定运行环境；不跨平台滥用基线 |

核对日期2026-10-20。MiniMax CLI三个文件本次读取blob分别为
`8e14a9d2b2dabfe4acabe632f2f3b7b6a7597524`、
`3cd0d6d4a3edf9aac8a48548bc0b696d53849e1b`、
`9b60f83316e060348bc7dfdf14098aec12adbee6`。
CLI主分支可能更新，T03保存实际版本/脱敏schema，不把历史字段永久硬编码。

## 差异C01：Workbench采集与需求

任务书要求不采集内部Workbench/维护对话；当前product.js的loadMaintenance可显示Workbench对话自动保存到开发会话。**这是已确认任务与当前实现之间的差异，不是静态阅读就证明哪段代码该删除。**

执行：先读同版本capture adapter、origin、external/internal/delegation区分与现有测试。分别制造真人外部开发、Workbench真人开发、内部分析、Agent委派四类事件。维护/委派不得误计人类开发需求或长期偏好是必守合同。对用户明确要求排除的内部类别建立失败用例后最小修复投影/接入过滤；保留历史数据和共享采集基础能力。产品语义仍有分歧的真人Workbench类别列为合同审批项，不自动扩大授权或反向覆盖用户要求。

## 差异C02：Workbench源码来源

主包锁0.13.6，独立repo main显示0.3.0。必须从已安装package metadata、runtime manifest、真实release ref和本地源码查映射。找不到则BLOCKED_SOURCE_MATCH，只做黑盒验证；禁止直接patch node_modules或旧main再宣称修复当前模块。

## 差异C03：候选发布

现有v*工作流未显式next，缺少可审计RC隔离。不同npm版本可能拒绝或默认分配tag；因此本次结论是**静态发布风险**，不是“已发生latest事故”。T04使用同名rc-only模板并核对受保护environment；未完成前不推发布tag。

## 差异C04：全局安装与隔离

原需求示例npm install -g @next不应在本次QA直接覆盖用户全局安装。本包改为官方固定version + owned prefix。它仍是真实npm下载安装，不是源码替身。

## 差异C05：五小时恢复与套餐

先前把恢复称作滚动窗口不够准确；S13当前说明固定窗口到期重置。用户可能持有保留旧权益的Token Plan，不能据此假设账户周额度/字段。禁止自动升级、取消续订或购买积分。额外积分可能在套餐耗尽后消耗，安全裕量和官方控制设置必须核对。

## 差异C06：日志UI和历史合同

当前DOM主要是系统/项目与文本查询，并不证明README描述的每个高级过滤控件都在现UI。API能力、历史UI与现DOM分列；不要编造按钮选择器。legacy测试是旧实现特征测试，未覆盖代码不自动等于死代码。

## 差异C07：安全承诺

同权限模型能够修改控制器文件/凭据时，再多prompt和hash也不是安全边界。实际受限账户/broker/ACL与GitHub审批没有验证前，远程写和无人值守保持disabled。软件测试不能证明绝无Bug，只能证明规定范围内的结果。



---

# 15 · 目录、运行身份、保留策略与Windows验收

中央QA目录保存所有新增测试工程，工作clone也在其.runtime/workspaces下。不要向根目录撒脚本，不搬已有_site/_test。生产业务修复仍在clone对应模块。原根的qa-autopilot是控制端目录，本地配置/凭据/state/artifacts默认忽略；发布包由files allowlist及实际pack双检查。

## 归档分类

入Git：已审QA源码、plans、无secret配置例子、固定fixture生成器、批准的少量视觉基线及摘要。
本地保留：state、原始日志/trace/截图、安装prefix、真实隔离配置、完整失败现场。
入npm：仅产品既有运行文件；QA控制工程不发布。原有 `_site/_test/*.js` 位于产品files列表是当前合同，不为精简而自动移除。
失败证据：先脱敏，保留首失败及修复验证，超容量报警并停止新大任务；清理需单独归档批准。
安装依赖/工作clone：不归普通临时删除器处理，有自己的停止/归属/版本检查计划。

## Windows现场验证

路径实际展开、大小写、中文空格、长路径、junction、硬链接、CRLF/shebang、文件锁、浏览器detached子进程都要测。不要用Linux测试结论替代。runLogged仅负责直接子进程，完整孙进程清理依赖受管broker/Job验收。

先记录用户真实Node/服务/模块/IDE进程，只读不停止。测试端口不能硬编码生产5757；生成fixture后验证loopback和所属dataDir。停止只用目标程序验证过的控制通道或broker句柄，PID必须同时匹配创建时间/命令/目录。

自动启动使用Windows任务计划程序可实现，但必须由用户/控制账户配置和验证：网关先就绪→控制器读取checkpoint→核对旧进程和操作意图→允许恢复。模板resume-controller.ps1不自动注册任务、存储密码或清除未知锁；更不是已经完成机器重启验收。

## 清理故障注入

在临时fixture单独构造symlink/junction、hardlink、目录替换、清单生成后新文件、活跃run、失败run、已到期PASSED、磁盘紧张。检查拒绝情况而非只测正常删除。需要delete的目录必须在拥有清单内，不能以路径包含“tmp”就认定可删。



---

# 16 · 原任务需求映射

| 原任务目标 | 落地位置 | 首个执行阶段 |
|---|---|---|
| 真实源码审查、各模块功能 | 01、02、14；reviewed-source.json；inventory | T00/T05 |
| 按钮/UI/前后端完整行为 | 02、03；130case规格 | T05/T06 |
| 前后端、E2E、视觉、性能、压力、故障 | 03、05；runner/browser-shell/png/performance | T06–T10 |
| 额度低暂停、恢复、周额度保护 | 06、11、13；quota/gateway/supervisor | T03 |
| 初始节点冻结、每Bug远程push | 07；git基准/事务/CI | T01/T08 |
| 实际npm候选next与安装 | 08、12；registry/rc-only/ci guard | T04/T11/T12 |
| 正式版必须人批准 | 08、12；无stable命令 | T14 |
| 新工具全部集中qa-autopilot | README、00、15、install-control-copy | T02 |
| 不破坏功能的dead/旧代码清理 | 09、10；独立cleanup队列与回归 | T09 |
| 简洁中英双语关键注释 | 10及生成控制源代码 | 每次小范围变更 |
| 中间产物安全清理 | 09、15；owner/hash/noLinks清理器 | T09及每轮收尾 |
| 省token、机械分阶段、低推理容错 | 04、13；短启动词/冻结合同/空默认队列 | 全程 |
| 断点、回滚、不中断用户数据 | 07、11；journal/intents/remote refs | 全程 |
| 执行包而非只讲概念 | lib/tools/scripts/tests/config/templates | 本次已生成；现场能力按13补齐 |

适用与完成状态见reports/delivery/CAPABILITY_MATRIX.md。任何现场未运行的case保持NOT_RUN/BLOCKED，而不是因为已有规格或名字匹配就算通过。默认配置例子不是授权，默认队列空不是发现零Bug。
