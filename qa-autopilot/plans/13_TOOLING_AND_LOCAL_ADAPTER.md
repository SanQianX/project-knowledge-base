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
