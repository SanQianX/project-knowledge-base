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
