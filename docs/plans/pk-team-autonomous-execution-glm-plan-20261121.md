# pk-team 从对话启动团队开发｜GLM 执行计划

审查日期为 2026-11-21。适用仓库为 `project-knowledge-base` 和 `ai-coding-workflow`。本文件接续此前 M0–M2 的代码。界面设计见 [可操作的本地 HTML](../ui-final-preview/pk-team-task-workbench-20261121.html)。HTML 中所有任务、身份、收据与状态切换均为标明的示例，只供确认交互。

## 给 GLM 的开工指令

收到用户确认执行本文件后，先做 P0，再按下面的提交单元执行。你负责两仓实现、实跑与远端 Git 交付。计划文件在用户的主工作目录，产品代码从包含下述基线的干净 `main` 开发。不要在已启动 5917 的 checkout 里改文件。每次只读本单元涉及的代码和上一个检查点，先复现，再修复、验证、提交和推送。遇到模型、权限或网络阻塞，保留任务和证据，继续无依赖项。最后报告真实通过项、仍缺的门禁和恢复指令。

用户将来在 Codex 中只发这一条。前置是项目已配置并启用团队执行。

```text
用 pk-team 为这个复杂需求创建任务，给我 taskId，然后按项目团队配置直接执行。

需求：<实际需求和验收要求>
```

第一条回报应含真实 `taskId`、项目、当前状态。模型可能耗时数分钟，先返回编号。需求和授权范围明确就继续，无须用户逐项派单。Leader 根据当次需求和已有成员拟定工作项，已配置的开发成员实际编辑，独立 Reviewer 提交意见，整改回到该任务和负责成员。页面只读状态也能让用户知道“谁在做、为什么没交付、下一步要不要我动手”。普通问答沿用原会话，小任务按现有流程处理。

## 基线和仍需修复的问题

审查时两仓远端 `main` 分别为 [Workflow f8780c0](https://github.com/SanQianX/ai-coding-workflow/commit/f8780c0dc619f9c5d1f5e0f727afadf47ecbbf39) 与 [知识库 f40f621](https://github.com/SanQianX/project-knowledge-base/commit/f40f6214e2ac5f0c0c04f6551a695a33eeaa85c3)。5917 的监听进程来自 `D:\SanQian.Xu\wk-m0m2-20261121\clone\ai-coding-workflow\src\bin.js`，数据在该轮隔离测试目录。知识库日用实例独立于它。用户主工作目录审查时仍是壳 `5e9b1c1`、Workflow `b439b38`，且壳有用户改动。开工时再次比对 Git，因为包版本 `0.1.2` 与 `5.1.7` 无法区分上述提交。

| 现状与差距 | 可核对的位置或事实 |
|---|---|
| 团队和任务已经有主存储。项目存了 Leader、预算和默认关闭的 `autoDispatch`。开发成员的执行模式固定投影为 `follow-session`，UI 只给 Reviewer 写入 Profile/模型。项目中的 Leader 指向现有成员，成员角色枚举里没有 `leader`。 | Workflow `src/domain.js` 的 `EXECUTION_MODE`、`createMemberRecord`、`normalizeProjectSettings`、`putProjectSettings`。`ui/app.js` 的 `memberPayload` 和 `memberFields`。 |
| GLM 真实规划已验证，产品自动派单仍缺。隔离 Workbench 的 `glm-5.3` 生成 w1→w2→w3，主会话实施了 w1，w2/w3 未执行。`/blocking` 读的是已有任务依赖。 | `D:\SanQian.Xu\wk-m0m2-20261121\evidence\checkpoint-08-m2b.md`、Workflow `src/server.js` 的 `workflow-tasks/:id/blocking`。该检查点的 PASS 仅用作规划证据。 |
| Codex 独立审查和真实 ESLint 已经存在。5917 的 `task_490f7db3e42fff46ae10` 第一轮 `rvj_0f5e41428108856f` 对 `refund.js:2` 给出意见，第二轮 `rvj_d113085a215f2b83` 的已核实模型 `gpt-6.2-sol` 通过。GET 详情仍为 `in_progress`，两项 `satisfied`、一条旧整改。 | Workflow `src/tasks.js` 的 `applyCheckReceipts`、`completeModelReview`、`evaluateDelivery`。通过分支不按来源消解旧整改，模型结果的快照核对和交付时模型证据复验均不完整。实际交错顺序应在隔离 fixture 重现。 |
| 程序检查结束就能把 job 标成 `completed`，此后才保留/执行模型阶段。MCP 按该状态提前结束等待，`_reviewAnswer` 仍写死 `pending-model-review`。显式传 job 时缺少与所传 taskId 的匹配检查。`resume` 目前主要读取合同。 | Workflow `src/server.js` 的 `/reviews` 链，主仓 `_site/lib/workflow-tool-runtime.js` 的 `_awaitJob`、`_reviewAnswer`、`reviewResult`、`resume`，及 `bin/project-knowledge-mcp.js` 六个工具的 schema。Skill 中 start 仍要求回报后等待验收确认。 |
| 审查和证据页面仍显示 W5/W6 占位。固定工作流页列能力，接入页写着“未接入”；配置列表为空与未握手易混淆。详情优先取列表缓存。四个复制按钮只写剪贴板，其中 start 会拼上已有任务号。 | Workflow `ui/app.js` 的 `clientCommand`、`renderTaskDetail`、`detailReview`、`detailEvidence`、`renderWorkflow`、`renderTools`。`src/identity.js` 的 `reviews:false` 与 5917 真实作业并存。 |
| 真实接口可复用。`GET review-jobs/:id` 给出 job、简要 receipts 和 task；`GET check-receipts/:id` 给完整收据。当前收据有 `toolVersion/exitCode/completeness/snapshotId` 等，缺可展示的已执行命令摘要。 | Workflow `src/server.js`、`src/checks.js`、`src/review-native.js`。主仓 `_site/lib/module-bridge.js` 已代理 Workflow，`/reviews` 单独做受信转发；`_site/lib/server-app.js` 阻断浏览器透传内部端点。 |

知识库可检索到旧版 `912282d` 的工具描述。对应年代的 Review 是占位，现行实现以上述提交为准。独立 Workflow Git 根目前没有知识登记，本计划已直接核对其源码。

## 执行边界与数据合同

- **三种身份分清。** 发起的 Codex 原生 `sessionId` 属于用户对话。Leader/开发的 Workbench `sessionId` 和 Reviewer 的 `executionRef` 分别是实际执行凭据。用同一 `taskId` 和工作项关联，分别保留配置成员、实际运行身份、执行时间、快照和证据。配置写着某模型只说明选择意图。
- **单一业务主库。** 继续用 Workflow 的任务、run、checkpoint、reviewJob、收据与 `store.mutate`。新任务下允许可选的团队计划和工作项字段。Workbench 负责驱动/Profile/会话，Event Bridge 负责观察，知识引擎负责记忆授权与正文，壳只做接线。可选 `orchestrator/` 保留现有用途。核心保持 Node ≥22、CommonJS、零运行时 npm 依赖。
- **最小自治。** 仅用户明确要求团队执行时，Skill 给已有 `project_workflow_start` 传可选 `executionMode:"team"`。未传沿用现行行为。项目需启用，并由管理者显式打开 `autoDispatch`。旧项目默认关闭。普通任务产生 0 次 Leader 调用、0 个新增后台开发执行。一次计划至多 3 项，按依赖串行写；允许给不同成员分派，同一仓库同一时间仅一个写者；不引入通用编排编辑器。
- **传给成员的最小合同。** 包含 `taskId/workItemId/planRevision`、项目和已授权仓库、目标、允许的变更范围、上游产物/快照、验收、最多必要的知识引用、交付格式。Leader 只看到可选成员 ID 和能力，不能提供命令、凭据、任意仓库路径或执行入口。记忆沿用现有绑定权限；未验证的原生会话声明不得升级为受信授权。
- **产品授权与开发流程独立。** 下文“逐步提交并推 main”用于 GLM 实施本计划。用户将来在产品里说“直接执行”，只授权该任务既定工作区的开发与检查。远端推送、发布、升级日用或其他影响范围的行为仍按该任务自身授权。

## P0｜确认工作副本和真实执行通道

**收益。** 首次开跑就知道是哪个源码、账号、工作区在工作，可以把环境问题与代码失败分开。

1. 两个源仓分别读 `AGENTS.md`，记录 `git status --short --branch`、`git rev-parse HEAD`、`git remote -v` 的脱敏目标、`git ls-remote --heads origin main`。在仓外新目录分别建干净的 `main` clone，验证上述基线是远端 HEAD 的祖先。可复用已验证的干净开发 clone，须与正在运行服务的源码目录分离。控制用户原仓与 5917 只读，不覆盖工作树。远端前进则读相关差异后调整锚点。
2. 记录日用壳和各模块实际监听、PID、健康，再登记 5917 等已有测试实例。新建私有测试前缀、数据、项目/知识、模块状态、浏览器与客户端 home，使用空闲回环端口、合成 Git 仓库和测试项目登记。显式指定数据目录，全程仅管理本轮启动的已确认进程。测试命令见下文。
3. 记录实际 Codex 可执行文件路径、版本和隔离 `CODEX_HOME` 的登录结果。在同一入口以实际可用 GPT 模型先执行一个最小请求，保留模型身份、退出状态。曾验证桌面 `codex.exe` 与 npm 入口版本不同；`gpt-6.2-sol` 是历史样本，开工时现场验证。GLM 只绑定已授权的隔离 Workbench Profile。无需 Claude Code 登录。凭据不出配置边界，不把授权复制到另一个前缀。缺权限记具体缺口。
4. 使用隔离 Workbench 的项目投影将业务 `projectId` 解析为 `contextId`。读已安装 `claude-ai-workbench/packages/server/lib/http-handler.js` 和 `drivers/codex-driver.js`（后者相对该 `lib/`）。Workbench 0.13.14 有 `POST /sessions`、`POST /sessions/:id/input`、`GET /sessions/:id` 和 `/events`；壳代理前缀为 `/api/terminal`。证明 Codex 成员能在**合成仓库**仅写一个允许文件并运行测试，记录前后 Git diff、实际传输/权限和 sessionId。优先受限 app-server 工作区写入。本机这版 Windows CLI fallback 在写模式会扩大沙箱权限，禁止用它自动替代。有效隔离写通道缺失就阻塞派发，保留普通 Codex 路径。
5. 从两个干净开发副本分别用 `git push --dry-run origin HEAD:refs/heads/main` 验证实施时的远端通道。跑既有 Workflow 和壳契约基线。隔离证据目录记录 `checkpoint-P0.md`。本步为只读预检，若只有运行记录，无产品提交、无空提交。

**门禁与回退。** 获取两仓基线、保护清单与可复现命令。真实通道失败的分项标 BLOCKED。P1 和只读界面工作可继续。回收已确认属于本轮的测试资源。

## P1｜先让 taskId 下的审查结果可信

**P1a · Workflow 提交。** 改 `src/tasks.js`、`src/server.js`，补 `test/rework.test.js`、`test/review-native.test.js` 或 `test/api.test.js` 中定向回归。沿用 `src/review-native.js` 写出的身份与收据。

1. 在保留 reviewJob 的事务内记录该轮是否要求模型及阶段状态。程序结束后，有模型要求而尚未终结时对客户端返回“审查中”。缺受信配置返回可诊断阻塞；仅程序检查的旧合同可正常终结。既有 `job.status` 有旧调用方，增补 `modelState` / `overallStatus` 或等价投影，再迁移读取方。区分“本轮运行结束”和“任务已可交付”。
2. 提交程序/模型结果时核对任务、当前有效作业、快照、验收版本、对应策略和已核实模型身份。历史 job 可以补写自己的历史结果，不能覆盖新一轮的整改、验收或下一步。收据按程序/模型来源归属，第二轮有效通过只解决已覆盖的旧意见，保留人工项、其他工具问题、其他工作项问题。旧模型凭证不能沿用到新快照。`evaluateDelivery` 对模型项复验有效引用；程序收据通过而尚待模型时不产生可交付状态。
3. 兼容既有“两个满足、一条旧整改”。有足够绑定信息时，从持久化 job/收据推导当前状态。在新代码的正常重审/显式恢复事务中持久化修复，保留历史。证据无法归属时提示重新审查。只读 GET 不改库存，不做全量清洗。产品界面若显示已交付，须与服务端裁决一致。

**P1b · 知识库提交，依赖 P1a 的新投影。** 改 `_site/lib/workflow-tool-runtime.js`、`_site/_test/workflow-tools-test.js`，仅在 schema/说明确有变化时改 `bin/project-knowledge-mcp.js`。`request_review/review_result` 返回同一作业的实际模型状态、identityVerified、行级意见、收据和裁决；同一次有界等待保留现有 8 秒上限。先检验 `job.taskId===args.taskId` 再展示或返回。历史 job 清楚标示历史，本轮的摘要不能借用全任务的最新整改。保留旧同步端点兼容与能力协商。

**门禁。** 定向覆盖晚到的 A、先完成的 B、重复回执、并行提交、快照/验收变更、仅 ESLint、无配置、他任务 job、旧版返回。隔离样例先有可执行的业务边界错误，真实 ESLint 可绿，独立 Codex Reviewer 必须给出可定位意见；原会话读取并修复，新 job、新快照、已核实模型、原意见留档、当前整改为 0、服务端 `done`。首轮没有抓到问题就记录真实结果，排查审查材料并重新验证，不手写一条 findings 顶替。对报告过的旧形状另用合成 fixture 测修复与无损。**回退**先撤壳读取变化，再撤 Workflow 作业投影，保留全部历史收据。**收益**是当前 Agent 拿到能改的意见，用户免去人工核对假阻塞与错归属。

## P2｜让一句话找到真实 Leader

**P2a · Workflow 提交。** 改 `src/domain.js`、`src/tasks.js`、`src/server.js`、`src/identity.js`、`docs/contract.md` 和相应 `test/api.test.js`、`test/tasks.test.js`。优先扩展 `projects/:id/settings` 的 `enabled/autoDispatch/leaderMemberId/leaderBudget`，只补项目允许派发的 `developerMemberIds[]` 与 `reviewerMemberId` 或等价已有映射。用现有 memberId 表示 Leader 的项目职务。输入须为同团队、已启用、角色和运行绑定适配的成员。选择 Reviewer 时用其已授权 driver/model/Profile 去匹配现有**受信** Reviewer 执行配置，不能忽略成员选择，也不能从 UI 自填程序路径。若两者不匹配，明确阻塞。升级前的全局 Reviewer 仍供旧任务使用。

**P2b · 知识库接线 + 工作流端的最小派发接线，按仓各提交一次。**

1. 主仓 `bin/project-knowledge-mcp.js` 和 `_site/lib/workflow-tool-runtime.js` 给 start 增加可选 `executionMode`。`plugins/project-knowledge/skills/pk-team/SKILL.md` 加入本文件的触发句。清晰的直接执行请求，先返回 taskId 和简短验收，再继续。旧客户端未传参或只说“建任务跟踪”，不启动团队。新客户端访问旧模块时明确告知版本不支持；同 `requestId` 重放同一任务，修复配置后的 `resume` 沿用它。
2. Workflow 在创建/激活同一任务的事务内记录团队模式、受信项目配置版本和规划待办。透过受信工具调用/服务接线确认许可。浏览器公开 `POST workflow-tasks` 或伪造 `client/sessionId` 不得自行启动付费/可写执行。按需改壳的 `_site/lib/module-bridge.js` / `_site/lib/server-app.js` 以及 Workflow 初始化；使用现有服务身份，保留浏览器禁止直通内部接口的边界。不能依赖“请求来自 localhost”当成权限。普通模式在旧接线上照常运行。 当前 `WorkflowToolRuntime.request` 只发 JSON 头，壳仅对匹配注册仓库的 review 请求附运行时令牌。团队激活需要验证调用者：优先复用已授权的本机 MCP 会话通道。若该版本确无可信调用者标记，最小扩展为限当前 OS 用户的本机 IPC 激活入口；stdio MCP 经此把已登记项目、taskId、requestId 交给壳，壳用既有服务令牌激活 Workflow。凭据不返回模型。覆盖独立桌面 Codex → stdio MCP → 壳 → Workflow 的真实路径和公开 HTTP 不能激活的回归。
3. Workflow 调用隔离 Workbench 的真实会话接口，使用现有注册项目/角色/获批 Profile，核对上下文和实际模型再发有界规划输入。仅真实 Workbench 父会话能用 `/sessions/:id/delegations`。从独立 Codex 对话发起时用受信创建的 Workbench 会话，以 taskId 关联。外部 Codex threadId 与 Workbench sessionId 分开存。主仓不能保存第二份计划。
4. 计划合同每项含 `id, goal, projectId, executorMemberId, dependsOn[], acceptance[]`，服务端验证唯一 ID、最多三项、依赖完整且无环、成员允许、项目在任务明确的授权范围内、验收可检验。只用现有项目/团队和短知识引用。按 `maxPlansPerDay/maxPlanRunsPerTask` 原子预留预算，并发 start/resume 计一次；非法计划允许在预算内纠正一次，失败可恢复阻塞。记录真实 model、sessionId、planRevision、分配人与依据。只接受真实模型返回有效计划后才能标为“已拆解”。

**门禁。** 真 Codex 对话说开工句，先取得可查询的 taskId，随后真实已选 Leader 生成至少两个有依赖的工作项。登记的两名开发成员可按任务职责被分别选中。截取脱敏会话/模型证据，验证重复 start 与普通任务的 0 调用。未启用项目、权限不足、Profile 缺失、超额、非法合同均有明确原因；不得偷偷改为主会话手写计划。**回退**关闭项目 `autoDispatch` 即停止新派发，撤接线，保留已有任务号和计划。**收益**是用户免写分工单、重复确认或另开聊天转述背景。

## P3｜按配置执行全部工作项，并把整改发回原处

**P3a · Workflow 提交。** 主入口为 `src/server.js`、`src/tasks.js`，持久化复用 `src/store.js` 的事务、`requestId`、outbox；需要抽离时只新增一个聚焦的团队执行模块，如 `src/team-execution.js`。`src/review-native.js` 继续承担只读 Reviewer。核心不引入 Workbench SDK、大模型 SDK 或强制 LangGraph。配置 URL/身份从已受信的模块接线注入。可选图已有 `dispatch_unknown` 的对账语义，可复用相同原则，不另建并行状态库。

1. 将有效计划写入同一任务。每个工作项具备分派成员、运行尝试、依赖、简短结果、工作区和证据引用。事务内认领 ready 项、写入待发记录和稳定的 `taskId/planRevision/workItemId/attempt` 键；释放存储锁后才创建会话、发输入。服务端按完成事件/有界对账推进，关闭网页或原对话离开后仍可执行。`status` 和只读 `resume` 仅观察队列；重复查询不能触发认领或再次投递。全局/按仓写锁须覆盖不同任务抢同一工作区的情况。
2. Leader 的 `executorMemberId` 决定实际 driver/Profile/会话。先取得注册的规范 Git 根、获得许可的工作区和受限写权限。记录执行者、实际 session/turn、前后快照及改动。只凭模型说“完成”或 Workbench `idle` 不解锁下游。核对允许的变更和该工作项的真实测试/产物，未满足就按预算重试或阻塞。不同成员可同一模型，但每个独立执行可追踪。Leader 和 Reviewer 只读。发起会话不可代做并冒充配置成员；无可用执行器，阻塞原因回到同一任务。
3. 服务重启先读未终结的执行，按已有 session/turn/operationRef 核对。派发请求可能已接受且回执丢失时标 `dispatch_unknown`，先查 Workbench 已存在的执行。无法确定时留待恢复，不重复发起写调用。区分缺权限、无进展、超时、预算耗尽和取消。配置关闭、成员禁用或用户取消后停止新派发，安全处理已发出的运行，留存事实。每工作项最多一次未启动的可重试错误重试，每任务自动整改上限默认 2 轮；重放和只读轮询不耗新预算。
4. 有实质代码审查要求则确保开启 `model_review` 验收，复用 P1 的真实程序 + 模型作业。意见含 `taskId/workItemId/reviewJobId/snapshotId/file/line/reason`。服务把意见交给对应开发成员的原会话；会话已失效时，有权限才创建同成员的新尝试，显式关联旧引用。没权限就提供可恢复下一步。新修复触发新快照和新作业。允许工作项内的预检/审查，但仅在所有必需项完成、依赖完成、最终快照全部验收有效时，才由 `evaluateDelivery` 裁决父任务 `done`。
5. 单仓所有项沿用任务绑定。跨仓沿用各自注册项目/仓库，确有需要时复用现有子任务、依赖和 reviewJob 作为每仓验收容器，由根 taskId 汇总。原有单仓 `repoPath` 永远保留；子证据不当作父任务本仓收据。跨仓在开始时逐仓核对授权、结束时校验每仓最新有效裁决，一个未通过则根任务未交付。旧 `/blocking` 对取消项的处理不可直接据此断言开发交付成功。

**P3b · 知识库提交。** 在现有 `resume/status/review_result` 输出短摘要，含当前工作项、真实运行者、最新有效意见、是否等待用户、下一步和证据引用。显式在新会话接续时，沿用现有 session-binding 和授权规则，可选显式绑定；只读 `status` 永远没有新副作用。团队模式的派发和审查由服务端单独拥有。发起会话不再自行编写已分派项，也不重复调用同一轮 `request_review`。被委派会话只执行收到的工作项，不能递归 start。Skill 在活跃 Codex 对话内先回 taskId，循有界等待、读取同一任务，直至完成/需用户。等待采用退避和任务版本，避免高频把完整日志送进上下文。已经退出的对话通过同一编号恢复，不声称服务端能向已关闭的原生聊天窗口推送消息。区分“当前聊天收到了结论”与“数据库保存了结论”。

**门禁。** 真实 Codex 对话 + 配置 Leader + 至少两名可区分的已配置开发成员串行实跑 + 独立 Codex Reviewer。每个计划项具备实际运行及产物，全部完成。检验一轮 `findings → 同任务同成员收到 → 修复 → 新快照复查通过`，原对话读到最终裁决。另测中断原客户端后任务继续，新会话按号接续不重建；隔离服务重启/回执丢失只对账不重复编辑；两个任务同仓无并发写。先用同一合成仓验证闭环，再用两个已登记的合成仓验证一方失败时根任务保持未交付。**回退**先禁用新认领、对账活动执行，再撤 P3b/P3a。**收益**是省去用户派发、搬运意见、催复查和跨会话重建上下文。

## P4｜用真实任务取代固定流程和占位页面

**P4a · Workflow 提交。** 修改 `ui/index.html`、`ui/app.js`、`ui/app.css` 与必要的 `src/identity.js`、`src/server.js`、`src/checks.js`。保持原生无构建页面、自托管、暗色、键盘和窄屏。预览决定信息组织，主题继承现有壳。正式代码禁止复制任何 preview fixture、演示任务或切换阶段控件。

| 页面与交互 | 数据来源与验收 |
|---|---|
| 一级仅“任务”“团队设置”。任务工作台显示列表、taskId、负责人、当前下一步，支持按标题/任务号定位。详情含执行计划、代码审查、验收证据。 | 沿用 `GET workflow-tasks` 和 `GET workflow-tasks/:id`。现有列表 `q` 只匹配标题，按完整 taskId 可直接读取详情，或补兼容匹配。详情以最新详情响应/revision 为准，切换任务忽略迟到响应。活跃任务可见时有界刷新，页面隐藏停止，恢复后拉最新。旧任务无计划时仍展示原有 checkpoints/runs。 |
| 顶部“在对话中发起”展示可复制的自然语言；已有任务只保留“复制接续提示词”。桌面列表常驻，窄屏可回任务列表。 | 复制时可预览文本；剪贴板不可用可手动选择。复制操作不启动任务、提交审查或创建第二编号。保留原项目过滤、建队/成员管理、项目启停、已有深链及壳嵌入导航；过时页签映射到对应设置/任务视图。 |
| 工作项显示 Leader、依赖、配置成员、实际执行与阻塞原因。代码审查先列当前意见，历史复查单列。每条说明问题、文件行、由谁提出、发给谁、当前是否解决。 | 读任务最新作业与 `GET review-jobs/:id`。仅程序运行、模型排队、缺配置、身份未核实、未知和服务不可达分别命名。同模型独立执行如实标明。可以从意见点开执行与作业，无需用户手动查 JSON。 |
| 验收先说明“验什么、结果、为什么”，再展开工具版本、命令摘要、退出码、完整性、快照、验收版本/时间及是否过期。 | 按需读 `GET check-receipts/:id` 和关联模型作业。新增收据可储存来自实际 argv 的脱敏短命令，旧收据无此字段显示“未记录”。`revision 1` 的中文标签为“验收定义版本 1”。旧证据标“历史/已失效”，未验证不可染绿。 |
| 团队设置保留成员向导、职责/记忆组绑定和项目开关，增加项目 Leader、允许开发成员列表、Reviewer 与明确自动执行开关。诊断并入设置。 | 复用 `members`、`projects/:id/settings`、`overview`、`consumer`、Workbench Profile、安全可公开的最近会话/收据摘要。Codex/MCP 显示能实际归属的最近工具调用；单有 declared 绑定时标为已声明。ESLint 版本和最近退出码取程序收据，Event Bridge 是否采集单独列。实现能力、项目配置、最近一次实跑独立显示；合法缺数据写“无记录”，取数失败写“暂不可用”。缺绑定给出可操作入口，权限不足显示管理位置。诊断只暴露已脱敏字段。 |

读 API 优先组合现有数据。确需计划/成员/诊断投影再在现有 v1 资源加可选字段。修正 `reviews` 能力含义并区分“支持”与“该项目就绪”。设置保存带 `requestId/expectedRevision`，冲突刷新再合并；管理权限及同源校验在服务端执行。standalone 使用 `/api/workflow/v1`，embed 保留 `/workflow-ui/?embed=1&apiBase=/api/workflow`、主题与后退协议；无授权的独立页仍能读既有任务。壳只在缺少受信投影时小改，按仓独立提交。

**门禁。** 对已真实运行的隔离实例，分别在 standalone 和壳嵌入页面验证整改、复查通过、仅程序、旧任务、空项目、服务不可达。桌面和窄屏点开可懂的证据，切任务时无串数据。选成员保存重开能读到原配置，真实运行匹配所选成员。复查的 taskId/job/snapshot/模型/退出码与 API 对照。`npm run test:web` 在此基线引用的 `test/support/product-web-ui-test.js` 不在 Git；先添加可复用的真实浏览器门禁或接通壳已有浏览器套件，确认执行数大于 0，留截图和日志。**回退**撤 UI 提交/恢复旧入口；新增 API 字段向后兼容，已建任务可用原客户端接续。**收益**是无需查看日志、猜按钮用途或复制四条命令即可判断是否要介入。

## P5｜过夜交付门禁与复测命令

**P5 · QA 提交。** 把可复用的复现和断言提交到对应源仓已有 `test/` 或 `_site/_test/`。证据、截图、测试账户、运行数据、安装产物留仓外。先核实已有脚本是否在 Git，再执行。以下示例中的路径变量指 P0 新建的干净开发副本；PowerShell 在对应代码库执行。

```powershell
# 在 Workflow 开发副本
node --test test/rework.test.js test/review-native.test.js test/api.test.js
npm test
npm run test:contract
npm run test:integration
npm run test:package
# P4 接通真实浏览器后
npm run test:web
```

```powershell
# 在知识库开发副本，$workflowRepo 为 P0 已核对的 Workflow 开发副本绝对路径
$env:KB_WORKFLOW_TEST_SOURCE = (Resolve-Path (Join-Path $workflowRepo 'src/server.js')).Path
node _site/_test/workflow-tools-test.js
node _site/_test/workflow-module-wiring-test.js
Remove-Item Env:\KB_WORKFLOW_TEST_SOURCE
# 另起隔离环境，用旧 pinned Workflow 再跑兼容用例
node _site/_test/workflow-tools-test.js
```

真实模型门禁通过正常 CLI 和安装候选的 MCP/Skill 进入。将下表场景封装为有限时、可恢复的本地 real-suite。优先复用 06/07/08 检查点的方法，移植前去掉绝对本机路径、凭据和硬编码端口。合成业务数据可以使用；工具进程/模型调用/权限/业务裁决必须真实。机制模拟只计单元层。CI 无模型凭据时分列机制结果和本地 real-suite，跳过或缺依赖不能计 PASS。

**主链路的实际入口。** 在 P0 新开的 PowerShell 中设置隔离的 `CODEX_HOME`、`KB_DATA_DIR`、`KB_KNOWLEDGE_DATA_DIR`，将候选 pk-team Skill 接入该测试客户端。隔离端的 MCP 配置用 `node <知识库开发副本>\bin\project-knowledge-mcp.js` 启动。`WorkflowToolRuntime.resolveBase()` 有两个分支。主验收让 MCP 子进程不继承 `KB_WORKFLOW_URL`，由隔离 `KB_DATA_DIR` 中的运行端点发现壳，自动走 `/api/workflow`。只有直连 Workflow 的契约测试才设置该变量为模块源站 `http://127.0.0.1:<模块测试端口>`，runtime 会追加 `/api/workflow/v1`。先检查服务标识、端口与 `tools/list` 的 start schema 含 `executionMode`，防止误连旧实例。

Windows 示例中的 `$codexExe`、`$gptModel`、`$fixtureRepo`、`$lastMessage` 分别为 P0 验证过的 CLI、账号模型、隔离合成 Git 根、仓外证据文件。使用前按该次 CLI 的 `exec --help` 核对参数。发起会话用只读文件沙箱，实际写入由已授权工作区的开发成员执行；若当前 CLI 的只读模式无法调用受信 MCP，记录限制，使用同等受限且已授权的原生会话重验。禁止改用 shell 手动派发来占位。

```powershell
& $codexExe login status
$request = '用 pk-team 为这个复杂需求创建任务，给我 taskId，然后按项目团队配置直接执行。需求：修复退款手续费边界，小于 100 元收 2 元，从 100 元起免收。补 99、100、101 元回归用例并经独立审查。'
& $codexExe exec --json --sandbox read-only --cd $fixtureRepo -m $gptModel --output-last-message $lastMessage $request
```

仅在隔离环境读取 `GET /api/workflow/v1/workflow-tasks/<taskId>`、`GET /api/workflow/v1/review-jobs/<reviewJobId>`、`GET /api/workflow/v1/check-receipts/<receiptId>`，按实际回执取 ID。在壳嵌入时对应前缀为 `/api/workflow/`。将原对话中的 tool call/result 时间序列和服务端 JSON 脱敏对照；日志在仓外，Git 中只放断言与 fixture 生成器。验收人员无需手工 POST `/sessions` 弥补产品路径缺失。

一次正向开发可能首轮就修好问题，这可计入“一句话交付”。另外用带已知边界缺陷的合成基线专测整改：让第一项先复现并在该快照交独立审查，然后由配置的开发成员根据真实意见修复。这样可稳定触达“有问题”的业务分支，又保留模型给出实际结论的自由。两场用例分别记录，首轮直接通过不能充作一次已发生的整改。

| 真实场景 | 必须保留的结果，缺一项即未过该门 |
|---|---|
| 简单任务与旧客户端 | 普通 start→原会话运行→原流程交付；Workbench 审计中 Leader 和新开发 Worker 均增加 0。旧版项目 PUT 保留 Leader/预算、团队、其他字段；原任务号、成员、历史、记忆绑定仍可读。 |
| 一句话团队开发 | 一条明确需求触发一个根任务；服务端返回编号早于首个慢模型结束；真实 Leader 生成各项及依赖，两个已配置开发成员实际执行自己负责的工作。最后一项有实物、测试及根裁决。禁止只执行 w1 或由 GLM 实施者手动替成员执行。 |
| 业务错误的整改回路 | 用退款样例，金额 <100 收 2，≥100 收 0。准备 99/100/101 的真实功能测试及一个 ESLint 检不出的边界错误。分步记录旧/新快照、首轮实际发现、发送和收到意见的执行、修复 diff、`node --test` 三组结果、真实复核及 `done`。业务测试与静态检查分别记录。 |
| 故障恢复与证据隔离 | 同 requestId 重放、同项目并发、旧结果晚到、调换两任务的 job、超预算、关闭开关/禁用成员、缺 Profile、无安全写通道、重启前后及旧前端/新服务和新前端/旧服务。记录副作用次数、哪些验收失效、同一 taskId 的恢复方法。 |
| 用户关页面或重开 Codex | 关闭测试浏览器/离开测试客户端，后台继续；新 Codex 对话根据同一 taskId 读取事实。另一次保持原会话在线，验证它在对话里读到问题和最终结果。两条路径分别留证。 |
| 可用性与效率 | 在同一验收标准的两个相近复杂需求做一次原生 Codex 对照与一次团队执行。初始需求后记录人工拆解/派发/搬运意见/催复核次数、用户等待时间、实际模型调用/可取得的 token 和总耗时。目标是团队样本这些人工转交为 0，且较对照至少少 1 次。若原生同样为 0，如实报告“未证实节省操作”，只报告已验证的接续/审计价值。功能门禁与效率结论分别记录。 |

**每个提交都是回退点。** P1a、P1b、P2a、P2b、P3a、P3b、P4a、P5 均为最小提交单元。跨仓单元拆为“Workflow 可兼容提供 → 壳消费”两个提交，为每个提交留明细。每步在对应干净 main 上检查 `git diff --check`、`git status --short` 和已暂存差异，只 stage 本单元文件，跑定向回归与该步运行门禁。记录提交前 SHA、测试命令/退出码、证据相对路径。提交后 `git push origin HEAD:refs/heads/main` 并核对远端 SHA 与该提交的 CI；已被更新时验证新远端包含本提交。失败不强推，不用 `reset --hard`。本步外部阻塞时允许完成独立可验证提交并标 PARTIAL，不宣布依赖门禁成功。再做下一步前核对远端；若网络中断有界重试，保留本地提交和待推顺序，避免将整晚进度说成已交付。

**回退顺序。** 数据先在隔离样例做备份、恢复、对照。新增字段可缺省，旧记录只读兼容；写入采用合并和 CAS，保留未知字段和旧证据。必须测新版写后旧版读取、旧客户端打补丁后新版字段保留，尤其是嵌套预算/计划。若旧服务写会丢失新字段，回退为关开关、停新派发、对账活动执行、保留新服务做兼容读取；在验证快照可恢复前不降级写真实数据。代码回退按消费者先、提供者后的倒序 `git revert <sha>`，先验证再推。日用升级、发布 npm、打 tag 或迁移真实数据单独授权。

**检查点模板。** 每步至多写一屏，下一晚直接读最后一份。

```text
单元 / 仓库 / 前后 SHA / 远端和 CI
真实入口 / taskId / workItemId / session 或 executionRef / reviewJobId / snapshotId
运行了什么 / 退出码 / 断言与证据文件 / 机制或真实 E2E
状态 PASS、PARTIAL 或 BLOCKED / 可重现阻塞 / 下一条可执行命令 / revert SHA
```

**交付边界。** 移除 W3/W5/W6 占位、固定流程说明页和重复复制按钮。保留原生 Codex 子代理处理日常轻任务的自由。此次延后多 Agent 并行写、任意工作流画布、通用插件市场、自动切换供应商、自动合并发布、另一套记忆/调度数据库、要求 Claude Code 实跑。定时刷新只能读实际状态。早晨报告首先给可打开的隔离页面、真实 taskId、完整的开发—整改—复查证据，然后列各仓 SHA、测试和效率对照。
