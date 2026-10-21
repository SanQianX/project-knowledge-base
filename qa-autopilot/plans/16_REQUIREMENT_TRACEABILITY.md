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
