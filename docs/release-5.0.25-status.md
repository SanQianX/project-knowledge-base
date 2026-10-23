# 5.0.25 候选交付状态

2026-10-24：本版本尚未发布或替换现有桌面。按用户要求沿用 5.0.24 的实际流程：精确 TGZ 上传 `next`，从官方 npm 独立下载安装并验收，然后晋升 `latest`；桌面在候选验收和可恢复备份完成后受控升级。

候选包含 Workbench 0.13.7 的模型额度管理、商标悬停/聚焦版本提示、vendored knowledge-engine 0.2.7-rc.11 的重试与提交顺序保护、Event Bridge 0.7.3 的 Windows 路径修复及已验收的 Hook 故障隔离。vector-hub 保持精确版本 1.0.8-rc.8。模块来源分别是 Workbench `eff8a2282f2a9259f05d729ed25c9c593938d79a`、engine `28475eb83f794d6fa578577b4f6e80114d40a85c`、Bridge `4b51af4a8153391e2acb410a83c72be976f0f0d1`。

隔离候选源码回归首轮为 187/196；Windows 测试目录过长及测试脚手架写死旧 Bridge 版本导致的八项失败，修正测试环境和声明版本绑定后，八项实际复测全部通过。当前为 195 项通过，官方 npm 全新安装用例尚待模块上传，不能记为通过。此数量属于源码回归，与 qa-autopilot 的 130 条逐 expected 行为验收不同；后者仍按 Leader 已审记录计数，不能以文件数量或计划代替覆盖。

当前发布认证存在两个实际失败：Bridge [任务 39994682956](https://github.com/SanQianX/ai-coding-event-bridge/actions/runs/39994682956) 的旧发布 Token 返回 E404；Workbench [任务 39996364814](https://github.com/SanQianX/Claude-Ai-Workbench/actions/runs/39996364814) 在源码测试通过后，OIDC 身份交换返回 `package not found`、ENEEDAUTH。两次均未发布新版本。本机 npm 也未登录，须恢复有发布权限的认证后才能执行上传。不能据此宣称产品测试失败，也不能把 Git 提交视为 npm 发布完成。

尚需完成：官方制品下载与哈希复核、实际 5.0.25 桌面包的 UI/原生依赖/启动重启/升级冒烟、最终源码提交与同 SHA CI、正式 registry 回执、全线检查点与备份、安装替换后核实际桌面/core/模块版本及原数据。早期测试误写的共享记忆向量索引已保全现场，由独占恢复任务处理；真实知识文件未被该误写覆盖。候选通过前继续保护运行中的 5.0.24。
