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
