# MiniMax 启动任务 · 增加 B00 分支治理门禁

项目：`D:\SanQian.Xu\project-knowledge-base`
执行包：`D:\SanQian.Xu\project-knowledge-base\qa-autopilot`
模型：MiniMax M3.1 Flash。账户权益以实际订阅回执为准。

## 任务与入口

你是受控 QA 执行 Agent，而不是自由改仓库的管理员。先阅读 `README.md`、`plans/00_README_FIRST.md`、`plans/00_BRANCH_CONSOLIDATION.md`、`plans/14_SOURCES_AND_CONFLICTS.md` 和 `reports/delivery/VALIDATION.md`。后续按 `config/phases.json` T00–T14 的原执行合同推进；不要重写整套方案，也不要每轮读取全部文档。

## 执行顺序（新增 B00，不替换原 T00–T14）

1. **T00-A**：先运行 `npm test` 和 `node scripts/qa.cjs self-check`；执行只读环境审计。Windows 已出现 `symlink rejected / EPERM`，先查证并修复测试环境兼容性；Windows Junction 与真 Symlink 验证分别保留，不能删断言或把未运行算 PASS。`init` 生成 `config/local.json` 后 `CONFIGURATION_REQUIRED` 为正常待配置状态。
2. **B00-A（目前只授权此阶段）**：执行 `plans/00_BRANCH_CONSOLIDATION.md` 的多仓库只读分支审计。遍历可确认的主仓库和独立模块源码，区分本地分支、远程分支、跟踪引用和工作树。生成 `reports/branches/BRANCH_INVENTORY.md`、`BRANCH_INVENTORY.json`、`CONSOLIDATION_PLAN.md`，标注每个分支的 SHA、独有提交、风险与建议。不得执行 merge、push、delete、GitHub 默认分支修改，也不得自动执行带副作用的 `git fetch --prune`。
3. **B00-B（等用户批准）**：获得按仓库、按步骤的明确批准后，才可备份、验证、收敛 `main`、更新默认分支和单独删除已归档冗余分支。未经批准只能报告 `WAITING_BRANCH_APPROVAL`；不得自行解释批准范围。
4. **T01–T14**：分支治理完成或用户明确暂缓并选定可靠 QA 测试基准后，继续原配置中的 `T01` 基准冻结、`T02` 独立工具 bootstrap、`T03` 真实额度与 worker 接线、`T04` RC 发布保护、`T05–T10` 测试修复及工程清理、`T11–T12` npm `next` 候选发布与独立安装、`T13–T14` 收敛和等待正式批准。不要改变已有的 T01 baseline 工具合同。若需在 `config/phases.json` 表示 B00，先检查工具是否依赖固定阶段 ID；不安全则作为 T00 子阶段记录，不硬改 JSON。

## 分支治理的关键事实与约束

2026-10-20 的 GitHub 远程参考：知识库 `codex/native-agent-context` 对 main 无独有提交；Workbench 的 `agent/sdk-productization` 含当前 0.13.6 源码、领先 main，且包含旧 `codex/release-0.13.2-rc.21` 的历史；Event Bridge 的 `feat/ai-coding-event-bridge` 领先 main 且是默认分支。全部需要本机重新核实，**不能直接删 Workbench/Bridge 的最新分支，也不能把 Workbench 的旧 main 0.3.0 当成 0.13.6 修复源**。最终每仓库仅一条长期 `main`，但 QA 期间保留临时 `qa/*`，直至获准合入且验收完成。

## 永久安全合同

- 所有操作先读真实 Git 状态与远程 SHA，保留用户工作区的未提交修改。代码修复只在隔离 clone `qa-autopilot/.runtime/workspaces/repair` 进行。**禁止 force push、覆盖用户代码、未备份删除分支、擅改 GitHub 默认分支、移动 release tag。**
- 当前 B00 仅只读；远程 main 更新、分支删除、默认分支变更属于分别批准的写操作；不得绕过现有中央 Git 门禁。任何跨模块依赖、发布 workflow、npm tag 的未知状态都进入 BLOCKED。
- 每个真实 Bug：复现证据→正确行为合同→唯一编号及精确文件清单→最小修复→目标及影响域回归→控制端审查→远程 QA 分支 commit/push→核对 SHA 与 CI。未执行、跳过、flaky、证据过期不算 PASS。
- 额度守护需要真实账户 schema、周权益核对、真实 worker 适配器和逐请求拦截证据；不满足则 `BLOCKED_ADAPTER/QUOTA`，不得声称无人值守可靠。不可绕过网关、切换按量付费或泄露 Key。
- 新 QA 计划、脚本、审计、测试产物集中于 `qa-autopilot`；原 `_site/_test` 不搬迁。死代码清理须证明无用，中英双语简短注释和格式调整独立提交；临时清理由白名单工具执行，保留失败证据和用户数据。
- npm 只允许经批准的候选流程发布 `next` 并按固定版本独立安装验证；安装成功不能代替 E2E。禁止正式 `latest`。最终只能 `READY_FOR_STABLE_APPROVAL`。

每轮输出：任务ID/阶段、仓库及版本、来源 SHA、真实执行命令与 PASS/FAIL/BLOCKED 证据、变更文件、远程 SHA、CI、额度状态、需要的批准、唯一下一动作。不要重复询问已给出的项目路径和目标。

**现在开始 T00-A 的剩余验证，然后仅执行 B00-A 分支审计；不要开始 B00-B 合并/删除，也不要直接启动大规模自主修复或发布。**
