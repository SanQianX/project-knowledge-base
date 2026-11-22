# GLM 续跑 M0–M2

继续当前任务，从 **M0 的 Codex 原生 E2E** 补验开始。沿用此前的实施、隔离测试、提交和普通 `origin/main` 推送授权。按下面顺序实际执行，完成一项就更新检查点。

## 读取已有进度

- 完整计划 `D:\SanQian.Xu\project-knowledge-base\docs\plans\ai-workflow-m0-m2-reviewed-execution-plan-20261121.md`。
- 最近检查点 `D:\SanQian.Xu\wk-m0m2-20261121\evidence\checkpoint-05-m1a-m2a.md`。如果有更新的检查点，核对并从最新已验证步骤续跑。
- 沿用 `D:\SanQian.Xu\wk-m0m2-20261121\clone\` 下的两个隔离仓。检查点记录主仓 `f40f6214`、Workflow `a090145`。核对本地、远端和 CI 后复用已提交的 M0 实现、M1-A/B 机制和 M2-A 设置。已有验证结果按其对应 SHA 复用。

## 1. 补验 M0 Codex 原生 E2E

本轮的原生客户端验收只用 Codex。Claude Code 的真实调用延后，旧 403 退出阶段门禁。

- Windows 上使用 `Get-Command codex.exe` 查找并固定实际二进制路径。裸 `codex` 当前会命中旧 npm CLI `0.137.0`，它读到日用配置的 `ultra` 会退出。桌面自带的 `codex.exe` 已通过本机登录状态检查。用同一个 `.exe` 和已授权的隔离 `CODEX_HOME` 检查 `--version`、`login status`，再在该 CLI 的 `/model` 选择实际可用的 GPT 模型。用 `exec --sandbox read-only --ephemeral --skip-git-repo-check -m <该模型 ID>` 做一次最小真实请求，收到 `CODEX_OK` 后继续。保持日用配置。
- Codex 请求只用该工作区支持的模型 ID，GLM 的 `glm-*` ID 留给 GLM/Workbench。若仍遇到 `model_not_found`，记录实际二进制、版本、模型 ID、登录方式、Provider、脱敏命令和错误。只有该次请求失败的证据时，按具体请求报告。需要我在隔离环境登录时，给出准确路径、命令和待执行的下一步。
- 在已隔离安装的真实 Codex 会话调用 `pk-team`，保留 MCP 实际请求和返回。创建合成任务，触发真实程序检查，取得 ESLint 报错路径与行号，修复后再次检查。核验新快照、通过收据、验收证据匹配、新旧作业以及重复请求的结果。记录 `taskId`、会话 ID、模型 ID、`reviewJobId` 与收据。真实会话通过后才把 M0 标记 `PASS`。模型预检和 CI 绿都是前置证据。

## 2. 完成 M1

- **M1-A/B**。复用现有适配器、review 作业和 Skill。Reviewer 的现有 Codex argv 有 `--ignore-user-config` 且缺 `--model`。核对当前代码后，用受信配置把预检通过、属于 `allowedModels` 的 GPT 模型 ID 显式传为 `-m`。保留真实运行身份验证和 `MODEL_IDENTITY_UNVERIFIED` 拒绝路径。检查 Reviewer 收到与作业快照绑定的有界真实代码差异。用实际 Codex 开发会话触发独立 Codex Reviewer，在原会话收到具体 findings、整改并复查。开发与 Reviewer 可以使用同一个获准 GPT 模型，分别记录会话／执行 ID、模型 ID、前后快照和收据。能证明两个不同模型才记录跨模型。
- **M1-C**。按计划复用现有 Engine／Workflow 绑定和记忆权限。真实验证跨项目、错成员、仅声明绑定与撤销后的拒绝。验证通过后才启用成员级上下文。
- **M1-D**。按计划验证 LangGraph 可选图在 Windows 上的真实持久化和重启恢复。同一作业读回同一结果，未知派发先对账，避免重复模型调用。同步验证禁用图时现有直通 Review 可用。恢复门禁不通过时保留已验证的直通 Review，记录 M1 `PARTIAL` 和首个缺项。

## 3. 完成 M2

M1 门禁通过后，复用 M2-A 的 Leader 设置和旧客户端 PUT 合并回归，继续 M2-B。用隔离 Workbench 中已授权的 GLM Profile 创建独立 Leader 规划会话，复用现有会话、输入和事件接口。原生 Codex 会话 ID 继续用于当前开发链路。只有调用 Workbench `/delegations` 时才需要真实 Workbench 父会话。验证复杂任务的真 GLM 计划通过权限和顺序校验并进入 Review，普通任务的 Leader 调用数为零。隔离 Profile 缺失时，把真实 Leader 验收标记 `BLOCKED`，记录缺项和恢复步骤。

## 交付

每个新改动跑对应门禁和 `git diff --check`，只暂存相关文件。独立提交，推送 `origin/main`，核对远端 SHA 并跟到该 SHA 的 CI。纯补验把证据写到 `D:\SanQian.Xu\wk-m0m2-20261121\evidence\`，有代码变更才提交。保护日用服务、数据、配置和全局安装。保留仓库既有发布限制。

汇报每阶段 `PASS / PARTIAL / BLOCKED`，给出远端 SHA、CI、真实命令及退出码、证据路径、首个阻塞和下一条可执行命令。遇到账号、权限或环境阻塞时保留真实失败，继续不依赖该缺项的验证。所有阶段结论以实际证据为准。
