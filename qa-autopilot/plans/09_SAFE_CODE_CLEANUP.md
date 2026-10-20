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
