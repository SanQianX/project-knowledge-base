# T07B · 130 项测试规格执行台账

- 生成时间：2026-10-21T15:59:39.581Z
- 规格总数：**130**

## 判定分布

| 判定 | 数量 | 含义 |
|---|---|---|
| PARTIAL | 61 | 仅部分期望被覆盖 |
| COVERED | 46 |  |
| BLOCKED | 13 | 被门禁或能力阻断，无法执行 |
| NOT_COVERED | 10 | 没有任何测试断言该规格的期望 |

## 按模块

| 模块 | 规格数 | PARTIAL | COVERED | BLOCKED | NOT_COVERED |
|---|---|---|---|---|---|
| 产品外壳 | 8 | 5 | 3 | 0 | 0 |
| 项目与领域 | 12 | 4 | 8 | 0 | 0 |
| 知识引擎与Git维护 | 12 | 10 | 2 | 0 | 0 |
| Workbench真实对话 | 12 | 9 | 2 | 1 | 0 |
| 右侧工作区 | 10 | 6 | 4 | 0 | 0 |
| 知识检索与范围 | 8 | 7 | 1 | 0 | 0 |
| 长期记忆 | 8 | 2 | 0 | 0 | 6 |
| 外部Agent集成 | 10 | 9 | 1 | 0 | 0 |
| 活动与诊断 | 8 | 5 | 2 | 0 | 1 |
| 设置与生命周期 | 10 | 4 | 4 | 0 | 2 |
| 额度与恢复 | 8 | 0 | 0 | 8 | 0 |
| 版本和远程门禁 | 8 | 0 | 8 | 0 | 0 |
| 候选发布和安装 | 8 | 0 | 4 | 4 | 0 |
| 工程清理 | 8 | 0 | 7 | 0 | 1 |

## 逐条明细

| ID | 模块 | 标题 | 优先级 | 模式 | 实施测试文件 | 判定 | 证据 |
|---|---|---|---|---|---|---|---|
| NAV-001 | 产品外壳 | 六页导航 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| NAV-002 | 产品外壳 | 主题同步 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| NAV-003 | 产品外壳 | 空项目 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| NAV-004 | 产品外壳 | 失败保留旧数据 | P1 | SOURCE_GUIDED_PROCEDURE | product-progress-status-test.js | **COVERED** | 收据 test-all-1792592987036 |
| NAV-005 | 产品外壳 | 项目快速切换 | P1 | SOURCE_GUIDED_PROCEDURE | workspace-ui-contract-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| NAV-006 | 产品外壳 | 可操作性 | P1 | SOURCE_GUIDED_PROCEDURE | BROWSER-SHELL | **COVERED** | 收据 browser-1792597601145 |
| NAV-007 | 产品外壳 | 分辨率矩阵 | P1 | SOURCE_GUIDED_PROCEDURE | BROWSER-SHELL | **PARTIAL** | 收据 browser-1792597601145 |
| NAV-008 | 产品外壳 | 断网恢复 | P1 | SOURCE_GUIDED_PROCEDURE | product-progress-status-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-001 | 项目与领域 | 领域创建 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| PRJ-002 | 项目与领域 | 导入完整预检 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-003 | 项目与领域 | 缺知识根返回表单 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-004 | 项目与领域 | 中文空格路径 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-005 | 项目与领域 | 重复导入 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-006 | 项目与领域 | Hook竞态冲突 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-007 | 项目与领域 | 部分模块离线 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-008 | 项目与领域 | Git初始化确认 | P1 | SOURCE_GUIDED_PROCEDURE | import-preflight-api-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-009 | 项目与领域 | 解绑写入保护 | P0 | SOURCE_GUIDED_PROCEDURE | project-remove-running-guard-test.js | **COVERED** | 收据 test-all-1792592987036 |
| PRJ-010 | 项目与领域 | 解绑迟到读 | P0 | SOURCE_GUIDED_PROCEDURE | project-delete-recovery-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| PRJ-011 | 项目与领域 | 领域变更 | P1 | SOURCE_GUIDED_PROCEDURE | project-lifecycle-transaction-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| PRJ-012 | 项目与领域 | 导入失败重试 | P1 | SOURCE_GUIDED_PROCEDURE | project-lifecycle-transaction-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-001 | 知识引擎与Git维护 | 首次导入基线 | P1 | SOURCE_GUIDED_PROCEDURE | product-import-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| ENG-002 | 知识引擎与Git维护 | 真实Hook闭环 | P1 | SOURCE_GUIDED_PROCEDURE | commit-evidence-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-003 | 知识引擎与Git维护 | 空仓首提交 | P1 | SOURCE_GUIDED_PROCEDURE | startup-analysis-disabled-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-004 | 知识引擎与Git维护 | 重复事件 | P1 | SOURCE_GUIDED_PROCEDURE | commit-boundary-freeze-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-005 | 知识引擎与Git维护 | 单项目顺序 | P1 | SOURCE_GUIDED_PROCEDURE | commit-boundary-freeze-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-006 | 知识引擎与Git维护 | 跨项目并发 | P1 | SOURCE_GUIDED_PROCEDURE | commit-evidence-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-007 | 知识引擎与Git维护 | 离线提交补偿 | P1 | SOURCE_GUIDED_PROCEDURE | orphaned-claim-recovery-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-008 | 知识引擎与Git维护 | staging越界 | P0 | SOURCE_GUIDED_PROCEDURE | knowledge-promotion-recovery-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-009 | 知识引擎与Git维护 | 晋升中断恢复 | P0 | SOURCE_GUIDED_PROCEDURE | knowledge-promotion-recovery-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-010 | 知识引擎与Git维护 | 索引独立失败 | P1 | SOURCE_GUIDED_PROCEDURE | index-error-display-contract-test.js | **COVERED** | 收据 test-all-1792592987036 |
| ENG-011 | 知识引擎与Git维护 | 故障重试 | P1 | SOURCE_GUIDED_PROCEDURE | orphaned-claim-recovery-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| ENG-012 | 知识引擎与Git维护 | 分析来源排除 | P1 | SOURCE_GUIDED_PROCEDURE | project-lifecycle-transaction-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-001 | Workbench真实对话 | 源码版本匹配 | P0 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-002 | Workbench真实对话 | 独立宿主 | P1 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-003 | Workbench真实对话 | 真实模型抽测 | P1 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **BLOCKED** | 收据 test-all-1792592987036 |
| WB-004 | Workbench真实对话 | 连续回复次序 | P1 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **COVERED** | 收据 test-all-1792592987036 |
| WB-005 | Workbench真实对话 | 草稿隔离 | P0 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-006 | Workbench真实对话 | 权限拒绝 | P1 | SOURCE_GUIDED_PROCEDURE | workbench-permission-test.js | **COVERED** | 收据 test-all-1792592987036 |
| WB-007 | Workbench真实对话 | 用户问题选择 | P1 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-008 | Workbench真实对话 | 中止隔离 | P0 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-009 | Workbench真实对话 | 流式重连 | P1 | SOURCE_GUIDED_PROCEDURE | module-stream-proxy-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-010 | Workbench真实对话 | 长历史阅读 | P1 | SOURCE_GUIDED_PROCEDURE | workspace-ui-contract-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-011 | Workbench真实对话 | 主回复与后台 | P1 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| WB-012 | Workbench真实对话 | 停止服务恢复 | P1 | SOURCE_GUIDED_PROCEDURE | module-stream-proxy-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| DOCK-001 | 右侧工作区 | 右上角显示隐藏 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-ui-contract-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| DOCK-002 | 右侧工作区 | 标签生命周期 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-lifecycle-test.js | **COVERED** | 收据 test-all-1792592987036 |
| DOCK-003 | 右侧工作区 | 知识被动刷新 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-lifecycle-test.js | **COVERED** | 收据 test-all-1792592987036 |
| DOCK-004 | 右侧工作区 | 知识重新注册 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-ui-contract-test.js | **COVERED** | 收据 test-all-1792592987036 |
| DOCK-005 | 右侧工作区 | 知识项目快速切换 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-ui-contract-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| DOCK-006 | 右侧工作区 | 子代理控制台 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-lifecycle-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| DOCK-007 | 右侧工作区 | 标签异常和恢复 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-lifecycle-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| DOCK-008 | 右侧工作区 | 来源安全 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-ui-contract-test.js | **COVERED** | 收据 test-all-1792592987036 |
| DOCK-009 | 右侧工作区 | 浏览器与代码审查 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-ui-contract-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| DOCK-010 | 右侧工作区 | 多标签压力 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-panel-lifecycle-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-001 | 知识检索与范围 | 文本检索 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-query-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-002 | 知识检索与范围 | 真实向量 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-scopes-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-003 | 知识检索与范围 | 作用域隔离 | P0 | SOURCE_GUIDED_PROCEDURE | knowledge-retrieval-service-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-004 | 知识检索与范围 | 引用定位 | P1 | SOURCE_GUIDED_PROCEDURE | vector-storage-root-test.js | **COVERED** | 收据 test-all-1792592987036 |
| RET-005 | 知识检索与范围 | 模型停用 | P1 | SOURCE_GUIDED_PROCEDURE | vector-storage-root-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-006 | 知识检索与范围 | 索引根切换 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-query-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-007 | 知识检索与范围 | 新提交检索一致 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-scopes-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| RET-008 | 知识检索与范围 | 检索负载 | P1 | SOURCE_GUIDED_PROCEDURE | knowledge-retrieval-service-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| MEM-001 | 长期记忆 | 手动添加 | P1 | SOURCE_GUIDED_PROCEDURE | shared-scope-root-binding-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| MEM-002 | 长期记忆 | 空白拒绝 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| MEM-003 | 长期记忆 | 候选保留 | P1 | SOURCE_GUIDED_PROCEDURE | shared-scope-root-binding-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| MEM-004 | 长期记忆 | 确认目标 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| MEM-005 | 长期记忆 | 忽略候选 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| MEM-006 | 长期记忆 | 同步失败 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| MEM-007 | 长期记忆 | 真实注入 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| MEM-008 | 长期记忆 | 来源边界 | P0 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| CAP-001 | 外部Agent集成 | 三能力独立 | P1 | SOURCE_GUIDED_PROCEDURE | native-context-integrations-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-002 | 外部Agent集成 | 原生Claude采集 | P1 | SOURCE_GUIDED_PROCEDURE | conversation-origin-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-003 | 外部Agent集成 | 原生Codex采集 | P1 | SOURCE_GUIDED_PROCEDURE | native-context-integrations-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-004 | 外部Agent集成 | 原生OpenCode | P1 | SOURCE_GUIDED_PROCEDURE | native-context-integrations-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-005 | 外部Agent集成 | 原生ZCode | P1 | SOURCE_GUIDED_PROCEDURE | native-context-integrations-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-006 | 外部Agent集成 | 修复幂等 | P1 | SOURCE_GUIDED_PROCEDURE | integration-capture-setup-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-007 | 外部Agent集成 | 移除保留 | P1 | SOURCE_GUIDED_PROCEDURE | integration-capture-setup-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-008 | 外部Agent集成 | 跨仓隔离 | P0 | SOURCE_GUIDED_PROCEDURE | cross-repo-isolation-e2e-test.js | **COVERED** | 收据 test-all-1792592987036 |
| CAP-009 | 外部Agent集成 | 配置自动修复 | P1 | SOURCE_GUIDED_PROCEDURE | integration-capture-setup-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| CAP-010 | 外部Agent集成 | 真实送达 | P1 | SOURCE_GUIDED_PROCEDURE | client-capture-restart-e2e-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| LOG-001 | 活动与诊断 | 活动分页 | P1 | SOURCE_GUIDED_PROCEDURE | logging-api-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| LOG-002 | 活动与诊断 | 失败重试状态 | P1 | SOURCE_GUIDED_PROCEDURE | product-progress-status-test.js, product-diagnostics-ui-test.js | **COVERED** | 收据 test-all-1792592987036 |
| LOG-003 | 活动与诊断 | 日志查询 | P1 | SOURCE_GUIDED_PROCEDURE | logging-api-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| LOG-004 | 活动与诊断 | 日志实时续接 | P1 | SOURCE_GUIDED_PROCEDURE | logging-sse-no-gap-test.js | **COVERED** | 收据 test-all-1792592987036 |
| LOG-005 | 活动与诊断 | 日志上限 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| LOG-006 | 活动与诊断 | 导出脱敏 | P0 | SOURCE_GUIDED_PROCEDURE | log-redaction-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| LOG-007 | 活动与诊断 | 高级过滤核对 | P1 | SOURCE_GUIDED_PROCEDURE | product-diagnostics-ui-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| LOG-008 | 活动与诊断 | 网络失败反馈 | P1 | SOURCE_GUIDED_PROCEDURE | product-diagnostics-ui-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| SYS-001 | 设置与生命周期 | 四模块健康 | P1 | SOURCE_GUIDED_PROCEDURE | module-process-lifecycle-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| SYS-002 | 设置与生命周期 | 维护默认模型 | P1 | SOURCE_GUIDED_PROCEDURE | claude-workbench-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| SYS-003 | 设置与生命周期 | 凭据留空 | P1 | SOURCE_GUIDED_PROCEDURE | qa-autopilot:sensitive environment not inherited, qa-autopilot:redaction | **COVERED** | 收据 qa-selftest-2026-10-21T15-48-25-017Z |
| SYS-004 | 设置与生命周期 | 知识根路径 | P1 | SOURCE_GUIDED_PROCEDURE | shared-scope-root-binding-test.js | **COVERED** | 收据 test-all-1792592987036 |
| SYS-005 | 设置与生命周期 | 端口冲突 | P1 | SOURCE_GUIDED_PROCEDURE | module-dynamic-port-test.js, bin-cli-test.js | **COVERED** | 收据 test-all-1792592987036 |
| SYS-006 | 设置与生命周期 | 停止指定实例 | P1 | SOURCE_GUIDED_PROCEDURE | project-remove-running-guard-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| SYS-007 | 设置与生命周期 | Origin防护 | P0 | SOURCE_GUIDED_PROCEDURE | server-security-test.js | **COVERED** | 收据 test-all-1792592987036 |
| SYS-008 | 设置与生命周期 | 请求边界 | P1 | SOURCE_GUIDED_PROCEDURE | server-security-test.js | **PARTIAL** | 收据 test-all-1792592987036 |
| SYS-009 | 设置与生命周期 | Windows恢复 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| SYS-010 | 设置与生命周期 | 桌面范围 | P1 | SOURCE_GUIDED_PROCEDURE |  | **NOT_COVERED** | - |
| QTA-001 | 额度与恢复 | 账户识别 | P0 | CONTROLLER_ACCEPTANCE | account balance not quota, ambiguous usage never inferred | **BLOCKED** | 已登记 |
| QTA-002 | 额度与恢复 | usage字段歧义 | P0 | CONTROLLER_ACCEPTANCE | ambiguous usage never inferred, duplicate model rows block | **BLOCKED** | 已登记 |
| QTA-003 | 额度与恢复 | 低额度停止 | P0 | CONTROLLER_ACCEPTANCE | quota thresholds 10, stale quota blocks | **BLOCKED** | 已登记 |
| QTA-004 | 额度与恢复 | 额度恢复 | P0 | CONTROLLER_ACCEPTANCE | recovery requires two samples, recovery hysteresis | **BLOCKED** | 已登记 |
| QTA-005 | 额度与恢复 | 查询故障 | P0 | CONTROLLER_ACCEPTANCE | upstream application failure blocks | **BLOCKED** | 已登记 |
| QTA-006 | 额度与恢复 | 共享消耗 | P0 | CONTROLLER_ACCEPTANCE | duplicate model rows block | **BLOCKED** | 已登记 |
| QTA-007 | 额度与恢复 | 进程重启 | P0 | CONTROLLER_ACCEPTANCE | supervisor controlled quota pause resumes the same task without new Git commits | **BLOCKED** | 已登记 |
| QTA-008 | 额度与恢复 | 绕过防护 | P0 | CONTROLLER_ACCEPTANCE | gateway exhaustion blocks actual next upstream call, gateway unauthorized blocked | **BLOCKED** | 已登记 |
| GIT-001 | 版本和远程门禁 | 原始改动保护 | P0 | CONTROLLER_ACCEPTANCE | controller commit does not run a configured production-like hook, out of scope change blocks | **COVERED** | 已登记 |
| GIT-002 | 版本和远程门禁 | 基准远程验证 | P0 | CONTROLLER_ACCEPTANCE | release baseline tag rejected, release exact RC tag accepted, QA branch accepted, origin exact ownership | **COVERED** | 已登记 |
| GIT-003 | 版本和远程门禁 | 测试凭证失效 | P0 | CONTROLLER_ACCEPTANCE | actual local Git fingerprint invalidates stale proof | **COVERED** | 已登记 |
| GIT-004 | 版本和远程门禁 | 新文件泄密 | P0 | CONTROLLER_ACCEPTANCE | package leak credentials.json, package leak .env, package leak artifacts/trace.zip | **COVERED** | 已登记 |
| GIT-005 | 版本和远程门禁 | Push回执丢失 | P0 | CONTROLLER_ACCEPTANCE | ref parsing rejects malformed SHA, no empty successful change, out of scope change blocks | **COVERED** | 已登记 |
| GIT-006 | 版本和远程门禁 | CI取消失败 | P0 | CONTROLLER_ACCEPTANCE | RC without complete release gates blocks, fixed RC accepts | **COVERED** | 已登记 |
| GIT-007 | 版本和远程门禁 | 单问题回退 | P0 | CONTROLLER_ACCEPTANCE | state illegal transition blocks, state stale revision blocks, operation idempotence, journal recovers checkpoint gap without replaying action, resume requires actual reconciliation | **COVERED** | 已登记 |
| GIT-008 | 版本和远程门禁 | 清理单独提交 | P0 | CONTROLLER_ACCEPTANCE | cleanup removes only old successful owned files, cleanup excludes active failed retained runs | **COVERED** | 已登记 |
| REL-001 | 候选发布和安装 | 正式通道封锁 | P0 | CONTROLLER_ACCEPTANCE | reject nonfixed RC 1.2.3, reject nonfixed RC v1.2.3-rc.1, reject nonfixed RC 1.2.3-beta.1 | **COVERED** | 已登记 |
| REL-002 | 候选发布和安装 | OIDC身份 | P0 | CONTROLLER_ACCEPTANCE | fixed RC accepts, reject nonfixed RC latest, reject nonfixed RC next | **COVERED** | 已登记 |
| REL-003 | 候选发布和安装 | 制品泄漏 | P0 | CONTROLLER_ACCEPTANCE | RC without complete release gates blocks | **BLOCKED** | 已登记 |
| REL-004 | 候选发布和安装 | 不可变发布 | P0 | CONTROLLER_ACCEPTANCE | 依赖 REL-003 的真实候选与受保护环境。 | **BLOCKED** | - |
| REL-005 | 候选发布和安装 | 官方独立安装 | P0 | CONTROLLER_ACCEPTANCE | 依赖真实 next 候选发布后才有独立安装可验。 | **BLOCKED** | - |
| REL-006 | 候选发布和安装 | 四模块安装运行 | P0 | CONTROLLER_ACCEPTANCE | package runtime allowlist, missing engine blocks, empty package blocks | **COVERED** | 已登记 |
| REL-007 | 候选发布和安装 | latest保护 | P0 | CONTROLLER_ACCEPTANCE | release stable tag rejected, release baseline tag rejected | **COVERED** | 已登记 |
| REL-008 | 候选发布和安装 | 稳定版审批 | P0 | CONTROLLER_ACCEPTANCE | 依赖 REL-003/REL-004 的真实 next 候选。 | **BLOCKED** | - |
| CLN-001 | 工程清理 | 动态入口证明 | P0 | CONTROLLER_ACCEPTANCE | cleanup removes only old successful owned files | **COVERED** | 已登记 |
| CLN-002 | 工程清理 | 格式独立 | P0 | CONTROLLER_ACCEPTANCE | cleanup excludes active failed retained runs, cleanup dry-run hash mismatch blocks | **COVERED** | 已登记 |
| CLN-003 | 工程清理 | 链接逃逸 | P0 | CONTROLLER_ACCEPTANCE | package leak artifacts/trace.zip, cleanup removes only old successful owned files | **COVERED** | 已登记 |
| CLN-004 | 工程清理 | 硬链接防护 | P0 | CONTROLLER_ACCEPTANCE | cleanup removes only old successful owned files | **COVERED** | 已登记 |
| CLN-005 | 工程清理 | 活跃数据保留 | P0 | CONTROLLER_ACCEPTANCE | 【无任何测试断言】超容量报警与停止新大任务的门禁在 lib/cleanupPlan 内，但自检无用例覆盖：缺口，需补一个自检用例。 | **NOT_COVERED** | - |
| CLN-006 | 工程清理 | 清理清单变动 | P0 | CONTROLLER_ACCEPTANCE | cleanup removes only old successful owned files | **COVERED** | 已登记 |
| CLN-007 | 工程清理 | Windows重启锁 | P0 | CONTROLLER_ACCEPTANCE | cleanup dry-run hash mismatch blocks, atomic state update and exclusive collision | **COVERED** | 已登记 |
| CLN-008 | 工程清理 | 清理回归 | P0 | CONTROLLER_ACCEPTANCE | root requires explicit approval, cleanup dry-run hash mismatch blocks | **COVERED** | 已登记 |
