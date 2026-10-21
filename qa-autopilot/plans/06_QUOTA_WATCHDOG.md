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
