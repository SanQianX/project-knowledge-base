# pk-team 长期任务与 gh-aw 集成｜GLM 执行计划

2026-11-21 修订。接续已有 AI 团队的创建、成员配置、任务管理和 Review。持续任务首个实际工具是 GitHub Agentic Workflows（`gh-aw`），首个作业是用 Code Simplifier 定时简化代码。 [在对话中发起一次性团队任务的计划](/D:/SanQian.Xu/project-knowledge-base/docs/plans/pk-team-autonomous-execution-glm-plan-20261121.md)

## 与正在执行的 P0–P5 并行

P 计划继续实施一次性团队任务。Q 计划在另一份干净 checkout 中先准备 `gh-aw`，独立使用测试数据、端口、CLI 配置和获准的 GitHub 测试仓。两份计划各自留证据和提交。需要操作同一远端 `main` 或相同产品文件时，按下表交接。

| Q 计划可立即做 | 接入产品的交接点 |
|---|---|
| Q0 核对权限和版本，实测官方 MCP 的 `initialize/tools/list/tools/call`。 | Q1 将工具绑定接到已有成员和任务。等 P2/P3 的成员、任务、存储与授权接口有已验证提交，按最新 `main` 一次接入。 |
| 将 Q2/Q3 的 Code Simplifier 模板、编译、补丁验证和收据解析在独立目录做成可复用单元。有授权的测试仓可部署、真跑 cron、核验云端暂停，并开始记录 Q4 的离线和 24 小时云端证据。 | Q2/Q3 将部署控制、收据回读和审查接到关联任务。验收裁决沿用 P1 的真实证据接口；成员、任务与授权以 P2/P3 落地的契约为准。 |
| 整理运行记录、可应用补丁、验证脚本和对应源 SHA。 | P4 的页面与数据接口落地后接入 Q 的成员工具、长期任务和运行历史，再完成 Q4 从页面配置、回读、暂停的整体验收。Q5 接续扩展。 |

共用位置包括 Workflow 的 `src/domain.js`、`src/tasks.js`、`src/store.js`、`src/server.js`、`ui/app.js`，以及主仓的 Workflow MCP、Skill 和代理接线。P 先负责当前在改的共用文件。Q 的先行工作可在独立 clone 的本地 `main` 或授权测试仓形成提交，不向两仓的共用 `origin/main` 推未接好的实现。P 每次交接提供两仓相关 SHA、已验证接口和测试。Q 在对应文件交接后，从最新 `main` 重新验证，再按单元提交和推送。同一文件有正在进行的新改动时，明确交接归属后再写入。Q 无需等整个 P5 完毕才开始可独立的工作。

独立预检、MCP 实测和真实 GitHub 定时试跑按各自证据记录。产品绑定、同一 `taskId` 回读和界面暂停的验收由整合后的系统完成。缺测试仓授权或模型时，继续本地编译、MCP 和产物单元测试，在检查点记录具体缺项。

## 用户流程

1. 按原流程创建 AI 团队，选择一个已启用的开发成员作为维护 Agent。在成员「工具」中绑定 `gh-aw`，选已登记的 GitHub 项目，核对仓库、实际模型来源和连接权限。
2. 在现有「任务」中新建「长期任务」，标题可以是「持续简化代码」。选负责 Agent、`gh-aw / Code Simplifier`、范围、交付方式和北京时间。建议初次用每天 03:17。按项目所需调整频率。任务继续运行，直到用户暂停或关闭。
3. 在同一个任务内预检并生成部署变更。经授权的 Git 提交流程把 `.md` 与编译后的 `.lock.yml` 部署到目标仓库默认分支。GitHub 识别到该工作流、确认云端模型可用后，在任务详情显示「已启用」。后续更改频率或角色职责，也在原任务内生成部署修订。
4. 到点由 GitHub-hosted Actions 实际启动 `gh-aw`。每轮只挑一个有价值的简化，执行修改和项目测试；通过后保留可应用的补丁。仓库允许且用户选择后，可以走草稿 PR 交付。没有可做的改动时记录「本轮无合适改动」。
5. 任务页一直使用同一 `taskId`。每轮都能看触发时间、实际运行者、基础提交、测试、patch 或 PR 链接。点「暂停」需让 GitHub 停止后续触发并回读确认；恢复续用原任务。网站和知识库关闭时，已启用任务仍由 GitHub 执行，下次打开补齐运行记录。

团队成员拥有任务，成员工具用于实际查询和审计。定时轮次使用已部署的成员职责、仓库范围和 GitHub 端模型配置；实际运行身份来自该轮 GitHub 与 `gh-aw` 回执。一次性开发任务继续沿用原链路。

```text
AI 团队 → 负责 Agent（绑定 gh-aw 工具）→ 长期任务（同一个 taskId）
                                           ↓
                             GitHub Actions 定时运行 Code Simplifier
                                           ↓
                          真实补丁、测试、可选 PR → 回到原任务
```

## 已核对的官方能力与源码

| 能力 | 实施依据 |
|---|---|
| Agent 可以接入官方 `gh-aw` MCP | `gh aw mcp-server` 支持 stdio，提供 `status`、`health`、`audit` 等工具。默认关闭工作流写工具。手动触发、启停走 GitHub 官方 Workflow API。 [gh-aw MCP](https://github.github.com/gh-aw/reference/gh-aw-as-mcp-server/) [GitHub Workflow API](https://docs.github.com/en/rest/actions/workflows) |
| GitHub 可以定时实际简化代码 | GitHub 有官方 Code Simplifier 模板与源码。`gh aw compile` 将 Markdown 工作流编译成 Actions `.lock.yml`。`schedule` 可用 cron 和 IANA 时区；工作流需在默认分支生效。GitHub 的定时有延迟、漏跑和公开仓不活跃停用的可能，界面展示下一次预计时间与实际记录。 [模板源码](https://github.com/githubnext/agentics/blob/main/workflows/code-simplifier.md) [编译](https://github.github.com/gh-aw/reference/compilation-process/) [定时语义](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) |
| 云端 Codex 需要明确的模型授权 | 官方 `engine: codex` 支持 OpenAI API key、OpenAI Workload Identity Federation 或符合条件的 GitHub Copilot 推理。本地用户登录属于本地 Codex 入口。GLM 在开工时证明准备采用的云端方案可用。缺授权时标出具体缺项，继续编译、只读和测试装配。 [gh-aw Codex 认证](https://github.github.com/gh-aw/engines/codex/) |
| 云端产物支持补丁和草稿 PR | `safe-outputs.upload-artifact` 可限目录、大小与数量上传运行产物；`create-pull-request` 可限制路径、设草稿和保护文件。首版默认补丁产物，符合两个源码仓的 main 开发规约。启用草稿 PR 时按仓库授权使用临时提案分支。 [产物输出](https://github.github.com/gh-aw/reference/safe-outputs/#artifact-uploads-upload-artifact) [PR 输出](https://github.github.com/gh-aw/reference/safe-outputs-pull-requests/) |

当前两仓远端 `main` 基线是 Workflow `f8780c0`、知识库 `f40f621`。Workflow 现有 `src/domain.js` 管理单个默认团队和成员，`src/tasks.js` 管理 `taskId`、`ownerMemberId`、执行记录和检查点。`src/checks.js` 可跑真实 ESLint/Knip，`src/store.js` 提供事务、CAS、请求幂等与 outbox。主仓已有 `_site/lib/workflow-tool-runtime.js`、`bin/project-knowledge-mcp.js`、`pk-team/SKILL.md`，QA 已有按 Git SHA 查询 CI 的 `qa-autopilot/lib/registry.cjs`。当前 Windows 有 `gh` CLI，开工时需在隔离环境实际核对 `gh-aw` 安装与模型授权。 [Workflow HEAD](https://github.com/SanQianX/ai-coding-workflow/commit/f8780c0dc619f9c5d1f5e0f727afadf47ecbbf39) [知识库 HEAD](https://github.com/SanQianX/project-knowledge-base/commit/f40f6214e2ac5f0c0c04f6551a695a33eeaa85c3)

## Q0｜核对版本、目标仓和权限

- 先读两仓 `AGENTS.md`，核对最新 `main` 与上述基线。开发副本、样例仓、数据/知识根、浏览器、CLI/GitHub 配置和端口独立。日用服务及 5917 的端口、PID、健康和数据根有可对照基线。前一份 P0–P5 的功能按实际提交和测试确认。
- 在已授权的测试 GitHub 仓里确认默认分支、Actions 可用、可部署工作流的身份、`Actions: read` 的记录读取权限，以及需要时的 `Actions: write` 启停权限。不同权限分开使用。现有团队仓凭据只在它的权限与用途明确定义时复用。可以用仓库受限 GitHub App 或已授权且隔离的 `gh` 身份。工作流文件发布走仓库既有 Git 审查和授权。
- 使用已知官方 release 固定并记录 `gh-aw` 版本。实际执行 `gh aw version`、受信仓中的 `gh aw doctor`，通过真实 MCP `initialize → tools/list` 核对当前版本。缺扩展时在隔离配置目录安装，核对 Windows 上实际配置和扩展查找路径，避免以日用 CLI 已登录推断测试环境授权。凭据仅由受信执行环境提供，记录认证类型和授权范围。
- 安排真实云端 Codex 的授权入口、成本上限、失控暂停方式。用合成退款或路由仓做真实测试。权限或模型缺失只限制依赖该能力的门禁。

Q0 保存只读预检证据。回退只关闭本次拥有的测试资源。 [gh-aw 安装和 CLI](https://github.github.com/gh-aw/setup/cli/)

## Q1｜团队成员绑定真实工具，任务支持长期运行

**开发位置。** Workflow `src/domain.js`、`src/tasks.js`、`src/store.js`、`src/server.js`、`docs/contract.md` 和对应领域/API 测试。主仓只改必要的工具/代理接线 `_site/lib/workflow-tool-runtime.js`、`bin/project-knowledge-mcp.js`、`plugins/project-knowledge/skills/pk-team/SKILL.md`。产品核心保持 Node ≥22、CommonJS、零新增运行时 npm 依赖。

1. 在已有成员上新增受控的工具绑定。首版只实现 `toolKind:"gh-aw"`。绑定包含 `memberId/teamId`、已登记的 `projectId`、GitHub 仓库身份、受信凭据引用、能力和修订。工具运行入口由部署配置提供，成员选择已登记的仓库与工具。共用已有成员启用状态与管理权限，服务端从实际任务/会话身份校验所属团队。
2. 复用已选成员 `ownerMemberId` 和现有任务数据，增加可选 `taskKind:"recurring"` 与调度绑定。配置记录节奏/时区、工具绑定、范围、预算、期望启用状态、远端状态与部署版本。每轮以现有 run 或有界外部运行记录关联原任务。长期任务的启用状态与某一轮通过或失败分别存储。原有一次性任务保持相同入口和历史，旧数据缺字段使用原语义。
3. 把真实 `gh aw mcp-server` 作为成员工具的后端。优先通过已有受信 MCP 接线，用受限 stdio 派生进程，在实际隔离仓使用读取能力。客户端允许的工具选择 `status`、`health`，按项目授权开放 `audit`。对资源执行仓库、工作流和运行 ID 校验。MCP 在默认读取模式启动，管理动作走另行授权的窄命令。Workbench 尚需实测能否给指定成员注入 MCP；若现有 driver 无 per-session 注入口，优先由已有 `pk-team` MCP 服务在服务端向真实 `gh-aw` MCP 转发受限调用。对话收到调用结果和运行引用。
4. API 增补沿用现有团队成员与任务资源。新增长期任务的 `enable`、`pause`、`run-now` 等只在必要时作为动作，其他状态读 `status/resume`。只读请求允许同步 GitHub 的可见事实，创建、发布和触发需显式管理授权。兼容旧 UI、壳与读写旧任务记录。

**门禁。** 已配置 Agent 通过真实 Codex 会话发起至少一次被许可的 `gh-aw` MCP 调用，并保留调用、绑定和实际返回证据。验证无绑定/禁用成员/跨项目读取会失败，同名仓和伪造成员不可访问。重复创建同一长期任务只拿到一个 `taskId`。旧任务及成员更新兼容。回退为关工具能力、撤消费方接线，保留已建任务和成员。收益是让成员真正调用工具，并能用同一任务继续管理。

## Q2｜部署一次，后续由 GitHub Actions 持续调度

**开发位置。** Workflow 现有业务入口与小型 `gh-aw` 适配模块；团队 UI 沿用上一计划 P4，在 `ui/app.js`、`ui/index.html`、`ui/app.css` 增补成员工具绑定和长期任务详情。壳 `_site/lib/module-bridge.js` / `_site/lib/server-app.js` 仅补受信路由。版本化模板放源码模块的可打包模板目录。GitHub 目标仓的编译文件在正式授权部署时写入其默认分支。

1. 用已审查的官方 Code Simplifier 源码为参考，生成一个任务专属模板，文件名绑定稳定的公开工作流别名，例如 `pk-team-code-simplifier-<alias>.md`。团队保存任务时生成可核对的变更，包含 `on.schedule`、`on.workflow_dispatch`、成员职责、真实测试入口、允许修改的目录、执行上限和产物规则。`workflow_dispatch` 可声明短的、不含私人信息的请求关联值用于对账。任务标题等用户输入按数据处理，生成配置使用转义和有限字段。
2. 在干净、受信测试 clone 用实际版本运行 `gh aw compile <workflow> --validate --strict`。核对生成的 `.lock.yml` 的触发时间、默认分支、关键 job、Action 固定引用、超时、读取权限与安全输出。部署使用用户已授权的 Git 流程，源 `.md` 和编译 `.lock.yml` 同提交。刷新频率、角色规则或工具配置时创建修订，用同一路径和 `taskId`。记录 `repositoryId/workflowId/path/defaultRef/lockDigest/deployCommit`。以 GitHub API 在默认分支读到对应工作流和已部署配置作为就绪依据。
3. GitHub 是唯一的定时触发源。Workflow 仅在打开任务、明确同步、启动恢复或已有读侧同步机制里补记录。`run-now` 只调用已绑定工作流的 `POST .../dispatches`，行动意图和幂等键先落盘。当前官方接口可返回 `workflow_run_id`。回执不确定时优先按已声明的关联值和远端列表对账，未核实时暂停重发。使用实际 API 回执而非把队列作用等同执行成功。
4. 将暂停/恢复映射到该 `workflowId` 的 `PUT .../disable` 和 `PUT .../enable`，再 `GET` 回读云端状态。区分「暂停请求待确认」「云端已暂停」「上一轮仍在运行」「本地读不到远端」。暂停默认拦住新定时轮次，处理已开始的轮次已有可见指示。成员停用、权限撤回或解绑时明确提示其远端计划状态，先完成云端暂停对账。补查时若远端配置漂移或被 GitHub 停用，展示原因与操作入口。
5. 使用 `concurrency` 给同仓的简化运行串行处理，已有运行不被新周期打断。GitHub 端实际实施每轮模型和时间上限，每轮最多一个补丁。对最新已验证产物保留 GitHub run/artifact 索引，运行前对账相同提交与候选，已经处理的候选不重复制 patch；人工重跑和 cron 也遵循同一规则。待处理基线允许轮次继续挑选未处理问题。有条件的情况用真实前置 job 决定是否启动 agent。漏跑如实记录，避免为错过的每个时间点补一遍。

**门禁。** 用授权的 GitHub 测试仓真实编译、部署并读取 `workflowId`；从 AI 团队的原任务完成手动触发、暂停、恢复。两次保存不产生两个远端工作流。错误 ref、错误路径、权限撤回、远端禁用、部署内容与已保存配置不一致均有真实可诊断状态。退出界面后远端启用仍有证据。回退先停远端已绑定工作流并验证，再回退源码提交和 UI。收益是定时设置真正连接到 GitHub 运行。 [编译与操作](https://github.github.com/gh-aw/setup/cli/) [Actions API](https://docs.github.com/en/rest/actions/workflows) [并发策略](https://github.github.com/gh-aw/reference/concurrency/)

## Q3｜云端真实简化、测试并回传交付物

**开发位置。** 上一阶段模板与目标仓的最小固定验证脚本、Workflow 的 run/receipt 投影、现有 `src/checks.js` 与 `src/snapshots.js` 的必要复用。项目自己的测试与 lint 配置继续作为权威。保留 `P1` 可信审查和 `P3` 负责成员整改的能力边界。

1. 从受信 `head_sha` 观察近期改动和未解决的候选，优先处理 ESLint 的复杂分支、过深嵌套或可去除的小段重复。知识库的复杂度阈值 30 是已有告警，来自 `eslint.config.mjs`，按已有策略比较前后。给 agent 小范围生产代码与测试职责。建议每轮最多改 4 个关联文件、150 行增删。锁文件、运行清单、发布/CI 权限、公开接口、数据和迁移有保护规则。
2. 真实 `gh-aw` 模型执行在 GitHub runner 的隔离工作区修改。复用确定性检查和仓库既有测试，在同一基础 SHA 做前后对比。适用时用 gh-aw 的独立验证 job，在清洁 checkout 校验实际差异、应用后跑测试，以真实退出码、patch 哈希和工具版本产出验证收据。只支持固定、已审核的验证入口；模型产物中附带的命令不直接执行。No-op、额度受限、超时、缺工具、错误退出、不完整输出和新主分支过期分别记录。
3. 默认配置 `safe-outputs.upload-artifact`，只接收受限目录下的一份小补丁与说明。可信验证 job 在检测及候选产物上传之后执行，使用相同的基础 SHA 重新检出、`git apply --check`、应用并运行固定的回归。由该 job 产生单独的证据产物，包含 `runId/runAttempt/headSha/patchDigest`、执行的测试和退出码。无候选时以前置 job 记录的实际跳过原因为准。只对校验一致的补丁标「代码已简化，可审阅」。本地查询优先复用已授权的 GitHub CLI/API 和有界摘要，避免主动执行产物内容。允许扩展草稿 PR 前，验证效力与仓规，经另行授权使用 `safe-outputs.create-pull-request` 的草稿、允许路径、文件数和保护文件设置。该模式只有验证过的同一 patch 能交付，编译产物的实际依赖顺序须实测。
4. 保留独立 Reviewer 业务入口。若项目要求 Reviewer，前置条件是上一份 P1 的证据修复可用。同步后的实际补丁作为审查输入，结果引用原 `taskId`、原 GitHub run 和补丁哈希。已有受信的云端 Reviewer 时可在相同快照独立执行；走已有 Workbench 审查且本机离线时，显示「云端已产出，等待独立审查」。审查通过才显示「可合并」，真实合并结果另从 Git 对账。
5. 以 `repositoryId/workflowId/runId/runAttempt` 做远端运行幂等键，持久化简短摘要和有界游标。校验 `run.head_sha`、分支、事件、`lockDigest`、真实测试 job 和产物 checksum，失败或缺失的证据不产通过。GitHub 总体 success 可能只代表无候选或 jobs skipped。至少保留每轮 `event`、运行链接、模型执行证据、改动范围、测试状态、产物和新鲜度。重复同步不重复建卡。若 GitHub 产物到期，仍然显示原始运行和「产物已过期」。
6. 「任务」列表显示长期任务状态。任务详情展示负责 Agent、工具、仓库、实际部署频率、下一次预计执行、最近状态及运行历史。每轮可直接点到可审阅补丁、GitHub Actions 或草稿 PR。「团队设置」展示工具握手、云端回执和实际凭据状态。成员工具与长期任务各用同一套项目绑定。

**门禁。** 一轮实际远程 Codex 生成能应用的变更，真实 ESLint 复杂度或结构变化达到当前合同，回归测试通过。另一轮无可处理项，按编译链和实际 runner 证据确认付费 Agent job 跳过。用合成坏补丁验证拒绝受保护路径、假收据、错误仓库或提交。GitHub 真实运行回到原任务，然后反复同步和重启，历史稳定、页签可打开。回退先停远端触发，再回退模板/适配，GitHub 与本地保留证据。收益是代码在后台真改过，同时能按行和提交验证变更。 [安全产物](https://github.github.com/gh-aw/reference/safe-outputs/) [前置 job](https://github.github.com/gh-aw/reference/steps-jobs/) [Runs API](https://docs.github.com/en/rest/actions/workflow-runs) [Artifacts API](https://docs.github.com/en/rest/actions/artifacts)

## Q4｜验收持续运行与暂停

| 场景 | 通过证据 |
|---|---|
| 团队实际拥有任务 | 按原流程建队、选择维护 Agent、绑定真实工具、创建长期任务，并从同一 `taskId` 看第一次执行。从真 Codex 会话可回读 `gh-aw` 实际状态。 |
| 真定时重复运行 | 在明确授权的测试仓用短测试周期，由 GitHub 至少触发两个 `event=schedule` 的真实 run。其中至少一轮发生在本次隔离知识库和发起对话关闭时，产出实际简化补丁并通过验证。后期开回正式节奏。手动 dispatch、注入时钟和已有 CI 结果各自留作机制证据。 |
| 断点回读 | 只启动本次拥有的隔离知识库，看到同一任务下的新 run、SHA、patch 链接和验证收据。重复同步没有重复任务或重复回执。 |
| 暂停、恢复、调整频率 | 页面暂停后读到远端 `disabled_manually`；再次恢复用同一个 taskId。更改节奏产生实际部署修订，验证新 `.lock.yml` 的 schedule 与 UI 一致。GitHub 返回错误时呈现远端已知状态和下一步。 |
| 24 小时观察 | 实际观察至少 24 小时，记录计划/真实触发时间、漏跑、取消、模型用量和交付。未观察满 24 小时保留「观察中」。长期模式在观察结束后有下一次预计运行。 |
| 回归 | 两仓现有普通开发、Review、项目设置、团队成员、记忆绑定与数据兼容测试通过。核对日用服务身份及数据保护；测试主分支目标只有预先授权的部署提交。 |

真实上游网络、权限或模型不可用时，保留已验证的代码分项和原因。任何「云端自运行」结论以两次真实定时记录、其中一轮离线产物及回读证据为准。GitHub-hosted job 限额按平台执行。 [GitHub Actions 限制](https://docs.github.com/en/actions/reference/limits)

## Q5｜沿用同一个长期任务机制扩展处理范围

首要交付是 Code Simplifier。其持续运行、暂停和结果回读通过后，复用已有成员工具绑定、计划与产物契约，按项目分别启用下面的工作类型。

| 工作类型 | 可验证的交付 |
|---|---|
| 结构与复杂度 | 实际减少冗余分支或重复代码。用同一 ESLint 配置和原有回归同时验证。 |
| 清理死代码 | 先完成 `.ai-quality/policy.json` 里的 Knip 入口清单，涵盖动态加载、CLI、MCP、浏览器、运行清单和公共导出。真实分析加实际构建、调用与独立审查支持删除。未知调用方只做候选。 [Knip 动态引用与误报](https://knip.dev/guides/handling-issues) |
| 文档、API 说明和 examples | 用项目已有路由、契约测试与文档做输入，产出 README/API 示例补丁。首个真实样例使用 `GET /api/workflow/v1/workflow-tasks/:taskId/blocking`，验证有未完成依赖时的 200 和未知任务 404。新增对外 API 走普通开发任务的契约与授权。 [文档维护范例](https://github.github.com/gh-aw/gallery/docs-automation/) |

每种类型的模板、收据与测试独立验证。成果都使用相同的 Agent 工具和长期任务信号，用户可以为不同事项配置各自的长期任务。

## GLM 执行与逐步提交

开工先跑 Q0，按并行表推进 Q1 的 MCP 实测和 Q2/Q3 的独立试跑。拿到 P 的相关提交后接入 Q1–Q3，交付至少一份实际补丁，并完成 Q4 的产品验收。Q5 按项目启用。验收以实际候选源码、实际 GitHub 仓和编译工作流为准。

```powershell
# 已核对的隔离候选或授权 GitHub 测试仓。变量来自 Q0/Q2 真实绑定
gh aw version
gh aw compile $workflowName --validate --strict
gh api "repos/$repo/actions/workflows/$workflowId"
gh api "repos/$repo/actions/workflows/$workflowId/runs?event=schedule"
gh aw audit $runId --repo $repo --models
```

```powershell
# Workflow 开发副本
node --test test/checks.test.js test/rework.test.js test/api.test.js
npm test
npm run test:contract
npm run test:integration
npm run test:package

# 知识库开发副本。$workflowRepo 为核对过的候选绝对路径
$env:KB_WORKFLOW_TEST_SOURCE = (Resolve-Path (Join-Path $workflowRepo 'src/server.js')).Path
node _site/_test/workflow-tools-test.js
node _site/_test/workflow-module-wiring-test.js
Remove-Item Env:\KB_WORKFLOW_TEST_SOURCE
npm test --prefix qa-autopilot
```

每个实现单元按仓独立提交，依次检查 `git diff --check`、定向测试、该项真实门禁。按用户对 GLM 代码实施的授权推送并核对远端 SHA 和 CI。正式仓中启用长期任务和允许草稿 PR 分支使用目标仓独立授权。变更运行行为的脚本、fixture 生成脚本和契约进 Git，实际产物、日志、凭据与测试数据放进隔离本地目录。回退先暂停远端并对账在途，再按消费者和提供者逆序 `git revert <sha>`。

检查点保留阶段、两仓前后 SHA、编译器与锁文件哈希、仓库/工作流 ID、长期 taskId、两轮真正的 schedule run、实际模型、测试、补丁、停机区间、远端暂停结果和回退 SHA。报告分别说明「成员连接已验证」「GitHub 已部署」「定时真实执行」「产物已通过测试」和「独立 Reviewer 已完成」。这几项各有实际证据后才标通过。
