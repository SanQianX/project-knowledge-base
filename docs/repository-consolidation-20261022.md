# 2026-10-22 仓库与分支整理

本次按用户“本地与远程收敛到最新主线，并在保持功能的前提下整理测试代码与产物”的要求执行。历史 QA 计划中的待批准状态由本次明确授权取代；没有发布 npm 包、推送 release tag 或变更 npm dist-tag。

## 维护主线

| 仓库 | 整理前 | 整理后的代码基准 |
|---|---|---|
| project-knowledge-base | 13 本地分支、3 远程分支、5 worktree | 5.0.24 + 最新 QA `702e352`，并合入本地 QA `81a2362` 的验收资料 |
| Claude-Ai-Workbench | 12 本地分支、3 远程分支、11 worktree；远程 main 仍是旧版 | 0.13.6 `423cc0a` 的完整开发线，保留权威计划与带历史标记的交接资料 |
| ai-coding-event-bridge | 本地为 feature；远程 main 落后 8 提交，默认分支为 feature | 完整 0.7.2 开发线及 CI/Windows 路径修复 |
| vector-hub | 单一 main | 保持 1.0.8-rc.8 功能代码 |
| knowledge-engine | 单一 main，本地领先 1 提交 | 将已嵌入主产品的 `85c618f` 同步到远程 main |

五仓库本地与远程均只保留 `main`，默认分支统一为 `main`。为原本没有本地 main 的 Workbench 和 Event Bridge 补建 main 后，共删除 25 个旧本地分支和 5 个远程分支；每仓库仅保留主工作区。AGENTS.md 已记录：后续不自动创建 feature、QA、release 或 backup 分支，只有用户明确要求时才创建。

## 内容保全与清理

- 五仓库全部引用均在仓库外生成 bundle，`bundle verify` 后独立恢复所有原分支与 worktree SHA。未提交文件另存原始字节与 SHA-256。
- 归档并移除 14 个旧 worktree；可重建的依赖与 dist 不重复保存，其余文件含忽略的测试证据均进入 tar.gz，验证清单和哈希后才移除。
- 从源码树移出 `.git.rar`、`pk43check/pk.tgz`、3 个重复文档 ZIP、3 个早期 UI 原型及日志 UI 对比原型，共 9 个文件、约 8.4 MiB。运行入口和包内容未引用这些文件；历史版本仍可从 Git 或归档恢复。
- 旧 QA clone、日志、运行状态、截图、原本地配置与失败现场移到仓库外。QA 控制工具和正式回归测试继续保留。配置重新初始化为待配置状态，避免旧控制器继续重建已清理的分支。
- 独有未提交 QA 锁接管修改，以及 repair clone 的 22 个未完成测试补充文件，按 WIP 原样归档，没有混入已验收的主线。
- `projects/`、知识库、模块实际 `data/`、用户客户端状态和运行依赖保留。

主项目旧 `backup/pre-clean-history-20260701-221430` 包含与当前代码无共同祖先的 50 个历史提交。它的完整历史已独立恢复验证后归档；未将已淘汰产品代码强行合入当前 main。Workbench 非祖先分支已按原审计的补丁等价、源文件和新旧契约覆盖证据核对，独立历史保存在 bundle。

## 验证

| 范围 | 结果 |
|---|---|
| 主项目完整回归 | 157 个测试文件通过，0 失败，包含真实浏览器与打包启动测试 |
| 主项目 release:verify、npm pack dry-run | 通过；模块版本、内容哈希、发布包边界通过；[功能清理提交 9e91af2 的 CI](https://github.com/SanQianX/project-knowledge-base/actions/runs/39788978358) 的 Node 22/24 Linux 与 Windows 三项通过 |
| QA 控制工具 | 106 通过、0 失败、0 跳过；self-check 通过 |
| Workbench release:verify | 966 项中 963 通过、0 失败、3 个既有跳过；SDK 与版本检查通过 |
| vector-hub | 73 通过；build 通过 |
| knowledge-engine | 204 项中 202 通过、0 失败、2 个既有跳过 |
| Event Bridge | 本地 30 个测试文件通过；Windows 盘符大小写回归已完成失败/通过对照；[GitHub CI 39788814417](https://github.com/SanQianX/ai-coding-event-bridge/actions/runs/39788814417) 的 Node 18/24 Linux/Windows 四项通过 |

初次本地测试遇到 Chrome 配置、TEMP 路径格式及并发构建超时，修正测试环境后重新运行通过。Workbench 同时修正测试对跨盘路径、路径分隔符和带颜色 TypeScript 诊断的假设，未放宽功能断言。Event Bridge CI 删除了对已移除的 core/ui workspace 的打包步骤；另外根据 GitHub Windows 现场诊断修复了 `RUNNER~1` 与 `runneradmin` 这类 8.3 短路径别名的比较，与项目身份解析统一采用 native realpath。

## 恢复位置

本机完整恢复材料：`D:/SanQian.Xu/.project-knowledge-backups/consolidation-20261022/`。其中 `README.md` 说明 bundle、文件备份、worktree 归档、WIP 和验证日志的恢复方法。备份不进入远程仓库。

历史审计和 PHASE_STATUS 的数字是当时的快照；以本记录及当前 Git 引用为准。
