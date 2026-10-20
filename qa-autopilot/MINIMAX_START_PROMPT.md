# MiniMax 启动任务

项目：`D:\SanQian.Xu\project-knowledge-base`
执行包：`D:\SanQian.Xu\project-knowledge-base\qa-autopilot`
模型：MiniMax M3.1 Flash；账户权益以实际订阅回执为准。

先读取 README.md、plans/00_README_FIRST.md、plans/14_SOURCES_AND_CONFLICTS.md 和 reports/delivery/VALIDATION.md，再按 config/phases.json 从当前已验证阶段继续。不要重新生成整套计划，不要把全部文档每轮重复塞进上下文。

先运行本包 npm test 和 self-check；配置缺失则 init。T00只读审计。保护原工作区的全部改动，在 qa-autopilot/.runtime/workspaces/repair 独立clone中修改代码。初始QA工具导入和发布保护是独立bootstrap任务，不伪装Bug修复。

每个真实Bug：复现证据→确认正确行为→唯一QA编号及精确文件合同→最小修复→目标和影响域回归→控制端审查→提交并push远程QA分支→核对SHA和CI。测试失败、跳过、flaky、证据陈旧都不是PASS。禁止直接推main、force push、改正确断言、自动换截图基线或伪造日志。

额度守护必须有真实账户schema、周权益证明、真实worker适配器和逐请求拦截证据。缺一个则BLOCKED_ADAPTER/QUOTA，不得声称已能跨窗口无人值守。不能拿到Key后自行绕过网关或改用按量付费；不要动套餐权益。

全部新测试、计划、报告、临时文件集中在qa-autopilot；业务修复在实际模块。已有 _site/_test 不搬家。清理代码要证明无用，清理中间文件只用白名单工具，失败证据与用户数据保留。格式、简短中英双语注释和死代码清理单独提交，不大规模美化全仓。

npm只允许通过已审核RC流程发布next，再按固定版本从官方源装进隔离prefix，验证四模块真实运行。安装成功不是E2E成功。最终只能READY_FOR_STABLE_APPROVAL，禁止latest。

遇到已知缺失能力，按文档完成具体本地接线/验证，不重复问项目路径、模型或目标。涉及来源合同、同版本源码、权限或数据无法证明安全时，只阻断相关任务并保留证据。每轮输出：任务ID、阶段、来源SHA、失败/通过证据、变更文件、远程SHA、CI、额度状态、唯一下一动作。

现在开始T00；不要直接运行修复循环或发布。
