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
