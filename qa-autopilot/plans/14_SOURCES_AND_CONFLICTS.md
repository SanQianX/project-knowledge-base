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
