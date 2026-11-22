# GLM M0–M2 实施启动提示词

你是这次实施的负责人。我已确认本地《M0–M2 执行计划》，授权你开始修改代码、运行隔离测试、提交代码，并将通过门禁的小步骤推送到两个仓库的 `origin/main`。收到我要求执行本文件的指令后逐项自主执行，无需等我逐步确认。

## 先读取完整计划

使用文件读取工具完整读取 `D:\SanQian.Xu\project-knowledge-base\docs\plans\ai-workflow-m0-m2-reviewed-execution-plan-20261121.md`。读到末尾的「6. 数据兼容、减法与最终报告」，再按编号执行。[完整审查计划](./ai-workflow-m0-m2-reviewed-execution-plan-20261121.md)

本文件的实施补充与审查计划共同构成任务合同。原生客户端验收只跑 Codex。Claude Code 实跑延后，其 403 不计入本轮门禁。开工前同时读取两个原仓库的 `AGENTS.md`。先核对实际源码和当前 Git 基线。读取 `D:\SanQian.Xu\wk-m0m2-20261121\evidence\checkpoint-05-m1a-m2a.md`，按已推送的候选 SHA 续跑，首项为 M0 Codex 原生 E2E。计划路径无法访问时，报告该绝对路径和具体错误。

## 仓库
- D:\SanQian.Xu\project-knowledge-base
- D:\SanQian.Xu\ai-coding-workflow

先做开工预检，简短汇报后自动继续。
1. 读取两份 AGENTS.md。核对已落盘计划中的基线 SHA、实际远端 main、Git 推送连通性和 CI 查询权限。上次本机 Git HTTPS 出现过连接重置，务必在你自己的执行环境验证。
2. 核对隔离测试实例和 Codex 登录。用同一个实际执行的 `codex.exe` 和隔离 `CODEX_HOME` 检查 `login status`，用该 CLI 的 `/model` 选出当前可用模型，再用同一个 `codex.exe exec -m <该模型 ID>` 做最小推理预检。Windows 上先查 `Get-Command codex.exe` 并核对版本。当前裸 `codex` 命中 npm `0.137.0`，会在读取 `model_reasoning_effort = "ultra"` 时退出。已核对本机客户端自带的 `codex.exe` 可以读取当前配置并显示 ChatGPT 登录状态。记录版本、登录方式和模型 ID。报 `model_not_found` 时保留脱敏错误及实际参数，按该次请求排查。GLM Profile 和预算在 M2 Leader 验收时核对。需要我登录、信任 Hook 或批准额外费用时，指出具体缺项并继续独立工作。
3. 两仓各用独立 clone，在 main 开发。原主仓 checkout 有未提交文件和指向真实知识库的 post-commit Hook。检查 clone 的实际 Hook 路径，避免提交触发真实知识库写入。

执行 M0 → M1 → M2。按审查计划的编号逐项完成，每项都要能单独验证和回退。
- 只读当前编号相关的文件。先确认源码和复现，再改最小范围，优先复用现有接口。
- 每项先跑规定的测试和 git diff --check，再显式暂存相关文件、提交、推送。核对 GitHub 上的实际 SHA，等待该 SHA 的 CI 结果后再推进依赖它的步骤。跨仓先提交提供接口的一侧，再提交调用方。
- 一个阶段全部通过后才进入下一阶段。该阶段必要的真实 Codex、GLM Leader 或 Windows 验收缺失时，明确记为 PARTIAL 或 BLOCKED。Mock、工具列表、进程启动或后台记录都不能算真实 E2E 通过。
- M1 的关键证据是原 Codex 开发会话通过 MCP 收到独立 Codex Reviewer 的具体 findings，在同一 taskId 内完成修改并复查。保留开发会话 ID、Reviewer 独立会话／执行 ID、实际模型 ID、两轮快照和收据。两端使用同一个获准模型时，按独立审查记录。用户手工接力和复制审查结果的次数均为零。
- 测试或 CI 失败时保留首失败证据，定位后复测。远端推送受阻时保留已通过本地验证的提交，记录未推送 SHA。需要回退已推代码时，用 git revert 按依赖逆序回退，复测后正常推送。禁止强推、重写历史或绕过分支保护。

保护现有环境。所有安装、数据、知识、模块状态、客户端配置和端口使用隔离测试环境。保持日常知识库与各模块运行，禁止修改用户数据和配置、覆盖全局安装、发布 npm、推送标签或部署。

每完成一个编号，在仓外证据目录更新短检查点，记下提交 SHA、远端 SHA、测试命令和退出码、CI、真实运行 ID、证据路径，以及下一步或回退点。上下文变长时从最后一个检查点继续。

结束时给我一份早上可以直接看的报告。逐项列出 PASS / PARTIAL / BLOCKED、两仓最后成功推送的 SHA、真实验收证据、第一个未通过的门禁、未推送提交和恢复命令。如果条件只允许完成 M0 或部分 M1，就交付已验证的结果。

## 复用已验收的实施补充

- **M0 依赖基线**。原主仓 checkout 的 `node_modules` 比 Git 锁定版本旧，`runtime:verify` 会先报 Workbench 版本不符。在隔离 clone 按现有 CI 方式运行 `npm ci --ignore-scripts` 后验证锁定版本。候选组合可复用主仓 `_site/scripts/pack-module-candidates.js` 的 `--workflow-source`。保持原目录、正式依赖 pin 和在线实例。
- **M0-A 真实 CLI 门禁**。Workflow `src/bin.js:40` 已通过 `runtime.listen` 绑定，`:62` 再调用同一个 `server.listen`。修复二次绑定，使用首次监听返回的地址和端口。通过打包后的 `src/bin.js serve --data <隔离目录> --host 127.0.0.1 --port <隔离端口>` 启动后，确认健康检查、启动日志无 `ERR_SERVER_ALREADY_LISTEN`，并验证仅本次启动的进程可正常退出。直接构造 `createWorkflowServer` 的测试继续保留。
- **M0-C Bridge 观察接线**。主仓 `_site/lib/module-bridge.js:830` 的托管 Workflow 配置缺显式 `KB_EVENT_BRIDGE_URL`。Workflow `src/consumer.js:67` 的 `drain` 丢弃 `notifyUrl`。复用现有消费者和回调，补齐已解析 URL 和通知参数，避免通知后的 drain 重注册时覆盖回调。用隔离 Bridge 验证启动注册、真实事件更新同一任务的观察状态及重启去重。验收状态仍由业务证据驱动。
- **M1-A 选模校验**。已提交的 Codex Reviewer 使用 `--ignore-user-config`，当前没有显式传 `--model`。读取审查计划 M1-A，用该 Codex CLI 和当前 ChatGPT 工作区预检已通过的 ID 显式选模，并保留运行后身份核验。GLM 自身及 Workbench Leader 的 `glm-*` 模型 ID 只用于 GLM 调用。
- **M1-B 等待上限**。现有宿主普通代理为 10 秒，MCP 自己为 15 秒。维持 `review_result` 的 `waitMs ≤ 8000`，验证慢检查可由 202 和后续查询完成，不调整全局代理超时。
- **M2-A 旧客户端兼容**。Workflow `src/domain.js:167` 当前整对象重建项目设置。加回归测试证明旧客户端提交原有字段后，新增 Leader 配置及原配置仍然保留。
