# M0–M2 执行计划｜GLM 可直接接手

**执行顺序为 M0 修复仓库定位和验收证据 → M1 打通当前 Codex 会话与独立 Codex Reviewer 的 Review，再接入可恢复的 LangGraph → M2 让 GLM 只为显式指定的复杂任务规划和分派。** 每个可独立验证的步骤单独提交、推送、记录远端 SHA。阶段门禁通过后才推进下一个阶段。

原始审查完成了源码、运行状态和官方资料核对，以及 11 个关键 JS 文件的语法检查。以下执行指令在用户确认实施后生效。

**续跑范围。** M0–M2 的原生客户端验收使用 Codex。已有 Claude Code 适配器保留，真实 Claude Code 测试延后。先读取 GLM 检查点，核对已推送的主仓 `f40f6214` 与 Workflow `a090145`，从 **M0 Codex 原生 E2E** 补验开始。已有的实现和验证证据按候选 SHA 复用。M1-A 和 M2-A 的部分实现已推送，各自剩余的门禁仍需验证。 [GLM 检查点](/D:/SanQian.Xu/wk-m0m2-20261121/evidence/checkpoint-05-m1a-m2a.md)

## 1. 原始审查基线

| 对象 | 当前状态 |
|---|---|
| `project-knowledge-base` | `main`，`5e9b1c1434a1df88b57090b1c04365d04ede7e8b`，包版本 `5.1.7`。工作区有用户修改的 `AGENTS.md` 和未跟踪文件，包含原 Plan。当前 checkout 有指向真实知识库的 `post-commit` Hook。 |
| `ai-coding-workflow` | `main`，`b439b382adf3be1b0f5fa31858197191ca610e24`，包版本 `0.1.2`。工作区干净。核心要求 Node ≥22、CommonJS、零运行时 npm 依赖。 |
| GitHub | 两个远端 `main` 已经通过 GitHub 接口核实，与本地 HEAD 一致。本机两次 `git ls-remote` 均遭遇 HTTPS 连接重置。实施前须验证 GLM 实际运行环境的 Git 推送链路。 |
| Windows / CLI | Node `24.13.0`、npm `11.6.2`、Codex CLI `0.137.0`、Claude Code `2.1.143`。已读本机 CLI 帮助，模型登录和完整参数组合待隔离实跑。 |
| 知识库 | Project Knowledge 能只读解析主仓并检索到知识。Workflow 仓库在当前实例返回 `PROJECT_NOT_FOUND`。E2E 在测试实例注册两个合成项目。 |
| 运行实例 | 壳 `5757/18484`、Workbench `5760/36836`、Vector Hub `8787/28408`、Event Bridge `8790/10380`、Knowledge Engine `5790/17120`、Workflow `5810/38984`。这些监听均为本机回环，审查前后 PID 与端口相同。 |
| 已安装模块 | Workbench `0.13.14`、Event Bridge `0.7.5-rc.1`、Knowledge Engine `0.3.4`、Vector Hub `1.0.8-rc.9`、Workflow `0.1.2`。壳报告五模块可达。Vector Hub 自身健康响应 `ok:false`，其 `__manifest` 条目无索引，本项目知识搜索仍有结果。保留此项基线，测试中比较有无新增异常。 |

源码入口和基线记录见 [主仓 AGENTS.md](/D:/SanQian.Xu/project-knowledge-base/AGENTS.md)、[Workflow AGENTS.md](/D:/SanQian.Xu/ai-coding-workflow/AGENTS.md)、[原 Plan V1.0](</D:/SanQian.Xu/project-knowledge-base/docs/AI 自主开发团队轻量化重构 Plan V1.0.md>)、[主仓 GitHub HEAD](https://github.com/SanQianX/project-knowledge-base/commit/5e9b1c1434a1df88b57090b1c04365d04ede7e8b) 和 [Workflow GitHub HEAD](https://github.com/SanQianX/ai-coding-workflow/commit/b439b382adf3be1b0f5fa31858197191ca610e24)。

### 原计划与实际代码的差异

| 阶段 | 判定与代码证据 |
|---|---|
| M0.1 基线和复用 | **已实现**团队、成员、任务、会话绑定、事实检查点、Git 快照、程序收据、返工项及 Bridge 消费。Workflow 已有原子写、跨进程锁、CAS 和 `requestId` 幂等，可直接复用。 [store.js](/D:/SanQian.Xu/ai-coding-workflow/src/store.js:196) [consumer.js](/D:/SanQian.Xu/ai-coding-workflow/src/consumer.js:177) |
| M0.2 项目与会话 | **需要修复** MCP Review schema 未声明仓库参数，测试直接调用内部 Runtime。`sourceRefs` 是数组，服务读取其 `.repoPath`，随后接受请求自带路径。`start` 可能创建 `unknown-project`，每次生成新请求 ID，吞掉绑定错误。Skill 说 `resume` 可重新绑定，实际只读。现有登记解析支持 Git 根，但按 `projectId` 查询时需另行核对提交的路径。 [MCP 工具](/D:/SanQian.Xu/project-knowledge-base/bin/project-knowledge-mcp.js:30) [Workflow Runtime](/D:/SanQian.Xu/project-knowledge-base/_site/lib/workflow-tool-runtime.js:68) [登记解析](/D:/SanQian.Xu/project-knowledge-base/_site/lib/knowledge-tool-runtime.js:139) [Review 路由](/D:/SanQian.Xu/ai-coding-workflow/src/server.js:285) |
| M0.3 证据与交付 | **需要修复** `passAll` 用同一收据满足全部自动项。手工提交 `"human"` 可以影响人工验收，模型验收缺少可信收据检查，交付判定遗漏任务阻塞、返工项和完整证据关联。快照把 Git blob OID 与文件 SHA-256 比较，只扫描部分扩展名，Review 路径没有传入未跟踪文件范围。检查执行期间的源码或验收修改也没有完整防护。 [验收和交付](/D:/SanQian.Xu/ai-coding-workflow/src/tasks.js:221) [快照](/D:/SanQian.Xu/ai-coding-workflow/src/snapshots.js:38) |
| M0.4 检查器和测试 | **部分实现，需修复**。正式安装包没有 ESLint/Knip。开发仓的 Knip 解析到了库入口，实测 `--version` 无输出，正确入口是 `bin/knip.js`。Knip JSON 解析和退出码判断也须修复。主仓测试硬编码开发机路径，缺目录时退出 `0`，并允许 `error` 充当 ESLint 抓到错误的证据。 [检查器](/D:/SanQian.Xu/ai-coding-workflow/src/checks.js:23) [现有集成测试](/D:/SanQian.Xu/project-knowledge-base/_site/_test/workflow-tools-test.js:16) |
| M0.5 原生入口 | **部分实现**。两个插件 manifest、`pk-team` 和六个工具已存在，当前 Codex 环境也暴露六个工具。现有安装就绪探针主要检查知识工具列表，仍需验证 Codex 原生会话确实调用了工作流工具。 [Skill](/D:/SanQian.Xu/project-knowledge-base/plugins/project-knowledge/skills/pk-team/SKILL.md) [集成探针](/D:/SanQian.Xu/project-knowledge-base/_site/lib/integration-installer.js:627) |
| M1.1–M1.3、M1.5–M1.7 | **缺失**真实 Reviewer、可恢复编排和当前会话整改闭环。现有服务执行的是同步程序检查，`reviews:false`，`review_result` 只读最后一张检查收据并恒报 `pending-model-review`。MCP 超时 15 秒，单检查期限 120 秒，先解决请求超时和重复执行。 [能力声明](/D:/SanQian.Xu/ai-coding-workflow/src/identity.js:17) [检查执行](/D:/SanQian.Xu/ai-coding-workflow/src/checks.js:31) [结果读取](/D:/SanQian.Xu/project-knowledge-base/_site/lib/workflow-tool-runtime.js:155) |
| M1.4 上下文和记忆 | **部分实现**。引擎已有 `/api/context`、可信成员绑定和组权限。Workflow 校验目前只比会话与成员，缺项目和可信依据校验。主仓托管启动也缺 Engine→Workflow 的 URL／认证接线。复用现有权限链，Bridge 继续只负责观察和归因。 [Engine 上下文](/D:/SanQian.Xu/knowledge-engine/src/context.js:81) [成员校验](/D:/SanQian.Xu/knowledge-engine/src/agent-members.js:219) [Workflow 校验](/D:/SanQian.Xu/ai-coding-workflow/src/server.js:406) [宿主模块接线](/D:/SanQian.Xu/project-knowledge-base/_site/lib/module-bridge.js:820) |
| M2.1–M2.6 | **配置基础已实现，Leader 链路缺失**。已有成员 `driverId/profileId/model/instructions/memoryGroupIds`，Workbench 已有 Profile、会话、输入、事件和委派。其委派接口要求真实 Workbench 父会话，外部 Claude/Codex 的原生会话 ID 无法用于该接口。 [成员字段](/D:/SanQian.Xu/ai-coding-workflow/src/domain.js:14) [Workbench HTTP 接口](/D:/SanQian.Xu/claude-ai-workbench/packages/server/lib/http-handler.js:168) [委派实现](/D:/SanQian.Xu/claude-ai-workbench/packages/server/lib/workbench-service.js:1812) |

## 2. GLM 开工、提交和过夜规则

1. **建立两份独立 Git clone，各自在 `main` 开发。** 先读原 checkout 的两份 `AGENTS.md`，核对实际远端和最近实施检查点，按已验证的候选 SHA 续跑。保留两个原 checkout 的全部改动。检查 clone 的 `core.hooksPath`、本地 Hook 及实际目标。主仓现有 Hook 会访问真实知识库，共享 `.git` 的 worktree 不能作为提交环境。新的隔离 clone 可以正常保留该仓所需的质量检查。
2. **先验证推送和模型环境。** 两仓在同一执行环境运行 `git ls-remote --heads origin main` 和 `git push --dry-run origin HEAD:refs/heads/main`，检查远端身份和权限。核对隔离客户端中可用的授权账号、模型和测试预算。Codex 预检使用实施环境实际选定的 `codex.exe` 和同一隔离 `CODEX_HOME`，记录版本、ChatGPT 登录方式、工作区和从该 CLI 的 `/model` 取得的模型 ID。用同一个 `codex.exe` 明确指定该模型先跑一轮最小 `exec`，再跑原生 E2E。预检区分 npm `codex` 入口和客户端自带的 `codex.exe`。目前 npm CLI `0.137.0` 无法读取 `model_reasoning_effort = "ultra"`，本机客户端的 CLI `0.171.0-alpha.13` 已通过现有配置的 `login status`，不需要改日用配置。若返回 `model_not_found`，保留脱敏错误、模型 ID 和认证方式。GLM Profile 仅用于 M2 Leader 验收。提前完成必要的登录或 Hook 信任确认。无法完成时记录具体阻塞及受影响的门禁，继续独立可验证的工作。 [Codex 登录](https://learn.chatgpt.com/docs/auth) [模型选择](https://learn.chatgpt.com/docs/models?surface=cli)
3. **隔离全部测试资源。** 使用仓外独立安装前缀、数据目录、知识目录、模块状态、客户端配置、浏览器配置和空闲端口。清理从父进程继承的生产 URL、路径和令牌。`KB_DATA_DIR` 和 `KB_KNOWLEDGE_DATA_DIR` 均显式设置。CLI 使用隔离绝对入口，启动使用 `start --data <测试目录> --port <测试端口> --no-open`，状态和停止均带 `--data <测试目录>`。Workflow 独立 CLI 使用 `serve --data <测试目录> --host 127.0.0.1 --port <测试端口>`。启动生命周期测试前后检查生产 API、PID、父进程、监听端口。冲突则换端口。只清理本次测试拥有的进程。
4. **一个实施编号对应一个可回退提交。** 先复现，修复后跑该编号的门禁和 `git diff --check`，显式 `git add -- <文件>`，核对 staged diff。提交后立即 `git push origin HEAD:refs/heads/main`，验证远端 SHA，再等该 SHA 的 CI。两仓现有 CI 都会取消同一分支上未完成的旧运行，因此同仓串行推送。分支保护、网络、并发更新或 CI 失败时保留本地提交和首失败证据，禁止强推。主仓 `main` 和 Workflow `main` 的 push 触发普通 CI，发布和发标签继续走独立流程。 [主仓 CI](/D:/SanQian.Xu/project-knowledge-base/.github/workflows/ci.yml:1) [Workflow CI](/D:/SanQian.Xu/ai-coding-workflow/.github/workflows/ci.yml:1) [主仓发布触发器](/D:/SanQian.Xu/project-knowledge-base/.github/workflows/publish.yml:31)
5. **每个编号写一条恢复检查点。** 记录 `阶段/编号、两个基线 SHA、本地/远端 SHA、能力开关、测试命令与退出码、真实客户端或模型运行 ID、证据目录、首失败、下一编号或回退提交`。日志和原始收据留在隔离目录，提交只包含源码、契约、可复用测试或 fixture 生成器。开新 GLM 会话只给当前编号、最近检查点和对应文件。失败先定位再有限重试，缺凭据、权限或真实运行条件时标记 `BLOCKED`，当天可验证的成果仍可保留。
6. **推送和回退以可运行组合为单位。** 跨仓始终先推提供方，后推能力探测保护下的调用方。已推版本用 `git revert <SHA>`，依赖逆序回退，复测再正常推送。两仓合测使用已核对 SHA 和哈希的本地候选 tarball。保留正式 npm pin、发布标签、现有安装和运行实例。普通 `main` 推送完成的交付物是源码和验证证据。

## 3. M0｜让项目、检查和验收可信

| 编号 / 仓库 | 实现范围和接口 | 直接收益与提交门禁 |
|---|---|---|
| **M0-A / Workflow** | `src/server.js`、`src/tasks.js`、`src/store.js`、`src/identity.js`、`docs/contract.md`。保留 `sourceRefs[]`。由任务 `projectId` 和受信项目映射确定 Git 根，真实路径和 Git 根必须一致。托管模式使用受信内部调用，Standalone 使用显式 `projectId → canonicalGitRoot` 服务端配置。客户端 `repoPath` 只作为匹配提示。复用 `requestId`，任务创建与可验证的绑定在同一事务落盘，允许显式 `resume` 重绑。无可靠会话 ID 时返回未绑定状态。 | 防止在错误仓库检查，防止超时重试建重复卡。用 `test/api.test.js`、`test/tasks.test.js`、`test/store.test.js` 覆盖同名仓、未知项目、目录不符、中文空格路径、并发重试、旧只读 `resume`。证明无权限调用在子进程启动前失败。 |
| **M0-B / Workflow** | `src/tasks.js`、`src/snapshots.js`、`src/checks.js`、`src/server.js`、`src/store.js`。给现有验收项增补可选 `requiredEvidence`，复用 `acceptanceRevision`、`snapshotId`、收据 ID 和现有状态。检查按任务、快照、验收版本、工具、策略和有效收据匹配。`done` 一律走同一判定，含显式暂停／取消、阻塞、有效豁免和未解决整改。人工确认必须来自可审计的授权入口，具备授权入口前保持待确认。Review POST 先原子保留作业并快速返回 `reviewJobId`，检查在事务外执行，结果读持久化作业与收据。 | 让失败原因可直接整改，避免把 lint 当单测或交付。真实 ESLint、Knip 各跑红→绿，检查已启动后移动文件、修改验收或并发提交，验证旧结果不会覆写新作业。伪造模型或人工通过、跨任务／工具借用收据均失败。 |
| **M0-C / 主仓** | `bin/project-knowledge-mcp.js`、`_site/lib/workflow-tool-runtime.js`、`_site/lib/server-app.js`、`_site/lib/module-bridge.js`、`plugins/project-knowledge/skills/pk-team/SKILL.md`、`_site/_test/workflow-tools-test.js`。复用登记解析和实例身份验证。由壳在现有安全校验后解析登记记录，并使用服务端私有 runtime token 转发内部 Review 请求。通用代理不得将客户端令牌变为模块信任。调整六个工具的 schema、处理器校验和 Skill；兼容旧参数，包括 `note`。`review_result` 增加可选 `reviewJobId`，读该作业的全部相关收据；老版本按能力清楚降级。 | 让 Codex 原生会话可靠调用业务链路。测试默认解析正式安装包，支持明确的本地候选包输入，缺包直接失败。通过真实 stdio MCP `initialize → tools/list → tools/call` 和宿主代理，覆盖六个工具和未安装／服务不可用。使用隔离候选包在真实 Codex 原生会话跑 M0 E2E。 |

**M0-B 实现细则**

- 快照读取 Git 记录和实际文件内容，按确定顺序哈希，覆盖 HEAD/基线、跟踪文件、受控配置、删除及显式包含的未跟踪文件。未跟踪文件有遗漏、文件不可读、路径越界、符号链接／junction 指向范围外、Git 对象或仓库不一致时返回明确错误。检查前后重新核对快照、提交时核对验收版本和作业占有权。失效结果保留诊断，不能满足当前验收。用较小的固定 fixture 检查重命名、删除、无扩展名文件、带空格和中文的根与文件名。
- 检查器只接受受信、已安装且可验证版本的入口，使用绝对 Node 入口和参数数组。复用项目锁定安装或管理员登记的固定工具根。现有程序检查只支持 ESLint、Knip，其他类型明确 `unsupported`。以真实工具的退出码、报告形状、截断、超时和可执行文件版本裁决。配置和插件也属于执行信任范围，仓库路径的校验不能代替工具配置授权。
- 当前旧任务的缺省验收定义继续可读，历史已交付记录保留。旧验收项重新提交时需要明确指定证据要求，不能按标题猜测检查工具。`acceptanceRevision` 变化后当前展示需反映待复核状态。

**M0 门禁。** Workflow 使用实际存在的 `npm test`、`npm run test:contract`、`npm run test:integration`、`npm run test:package`。主仓先跑 `node _site/_test/workflow-tools-test.js`、`node _site/_test/workflow-module-wiring-test.js`、`node _site/_test/integration-adapters-test.js`，阶段末跑 `npm run release:verify` 与 `npm test -- --no-report`。使用真实隔离安装的 `pk-team` 在 **Codex 原生会话**创建合成任务、重复请求、触发检查、取得具体 ESLint 规则和行号、修改文件、重新检查并获得新收据。该 lint 收据只满足指定 lint 项，另一个无单测收据的验收项仍未通过。再以 lint 为唯一必需证据的独立任务验证真实交付。记录 Codex 原生会话 ID、模型 ID 和 MCP 工具返回。回退顺序为 M0-C → M0-B → M0-A，保留受影响的历史作业，回退期间关闭受影响的验收写入。

## 4. M1｜当前会话收到独立 Review，并完成复查

### M1-A / Workflow · 真实 Codex Reviewer

在 `src/server.js`、`src/tasks.js`、`src/identity.js` 中复用 M0 作业和收据。复用已提交的 `src/review-native.js` 及专用测试。必过链路为 **当前 Codex 开发会话 → 独立 Codex Reviewer → 原开发会话整改与复查**。Reviewer 使用单独进程及会话，同一获准模型可验证独立审查链路。开发端和 Reviewer 的实际运行模型 ID 不同才记录为跨模型。证据包含验证成功的实际运行身份及其来源，证据不足时报告 `MODEL_IDENTITY_UNVERIFIED`。

Reviewer 只收到从已核验快照构建的有界任务合同、diff、必要收据和授权上下文。使用自己的空工作目录、隔离配置和有限超时。没有可用的安全参数组合时返回阻塞。保留 `reviewJobId、taskId、snapshotId、acceptanceRevision、reviewerRuntime、executionRef、verdict、findings`。每条可阻塞 finding 要有范围内路径、行号和理由。登录失败、超时、非零退出、无效 JSON、输出截断和模型身份未验证均不形成通过收据。

现有 Codex 适配器使用 `--ignore-user-config` 且未传 `--model`，`allowedModels` 只在运行后校验。M1 续跑时用受信配置从已预检的 ID 显式选定一个模型，确保它属于 `allowedModels`，启动时传 `-m <模型 ID>` 并保留运行后身份核验。以该 Codex CLI 和 ChatGPT 工作区实际提供的模型为准，GLM Leader Profile 的 `glm-*` ID 只用于 Workbench Leader。用同一隔离登录验证 `exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --json --output-schema … --output-last-message … --cd … --skip-git-repo-check -` 的完整组合。Windows 通过已验证的原生 `.exe` 或 `node.exe` 与已验证 CLI 入口启动，明确传 argv，使用 stdin 传有界审查材料。 [现有 Codex 适配器](/D:/SanQian.Xu/wk-m0m2-20261121/clone/ai-coding-workflow/src/review-native.js:58) [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)

**提交门禁和收益。** 真实 Codex Reviewer 产出合格的结构化结果。验证 Reviewer 无开发目录写权限，未加载生产 Hook 或 MCP，运行前后开发快照保持一致。用户可从当前 Codex 会话启动独立审查。合成收据只用于失败路径测试。

### M1-B / 主仓 · 把 findings 送回当前 Agent

修改 `bin/project-knowledge-mcp.js`、`_site/lib/workflow-tool-runtime.js`、`pk-team/SKILL.md` 和同一集成测试。复用已有 `UserPromptSubmit` 的 `cwd/session_id/turn_id` 及已验证的实例绑定。若宿主没有把当前会话身份提供给 MCP，使用有时效、绑定 `client + session + project + Git root` 的本机交接，在现有 Hook 与 Runtime 上补齐。遇到多个会话时按具体会话匹配。客户端声明继续用于观察，可信身份来自已验证来源。涉及 Hook 变更时先准备隔离客户端信任，保留现有用户配置。 [现有上下文 Hook](/D:/SanQian.Xu/project-knowledge-base/plugins/project-knowledge/scripts/context-hook.cjs:29) [Codex Hooks](https://learn.chatgpt.com/docs/hooks)

Skill 执行如下固定顺序：

```text
start / resume 同一 taskId
→ 当前会话开发并记录事实
→ request_review(taskId) 得到 reviewJobId
→ review_result(taskId, reviewJobId, waitMs≤8000)
→ 取得 findings、blockedReason 或交付裁决
→ 当前 Agent 针对同一任务范围整改
→ 新快照再次 request_review
→ 按服务端证据完成，或报告阻塞和可恢复的 taskId
```

`review_result` 复用已有工具做有界等待，请求保持在 15 秒 Runtime 超时内。会话结束后，用户可在之后的会话 `resume(taskId)` 继续。服务端对 `taskId + snapshotId + acceptanceRevision + 策略/Reviewer` 去重，并用 CAS 保留作业占有权。重复请求返回相同作业。超时且能确认没派发时允许有界重试。派发后结果无法确认时标记 `dispatch_unknown`，先对账。自动整改最多两轮，基础设施失败直接说明，进展与整改次数在服务端可查询。

**提交门禁和收益。** 在真实 Codex 原生会话输入一次 Skill 命令。用程序检查可通过、但存在业务边界错误的合成任务，验证第一轮 Reviewer 返回具体文件和行，原生开发会话自行取回结果、改动文件、产生不同快照并真实复查。保留同一 `taskId`、开发会话 ID、不同的 Reviewer 执行 ID、两轮收据和最终裁决。用户手工切客户端、复制审查提示词、复制 findings 的次数均为 **0**。另测同仓两个 Codex 会话并存、断线后恢复、同快照重复提交、结果乱序和两轮上限。这一步直接检验用户能否省去手工接力。

### M1-C / 两仓 · 补齐现有记忆权限链

Workflow 先修改 `src/server.js` 的现有绑定校验，加入项目、任务、可信依据、启用状态和成员版本匹配。主仓随后在 `_site/lib/module-bridge.js` 和现有宿主调用层补托管 Engine→Workflow 接线，使用引擎既有签发、验证和撤销接口，令牌只在服务端。项目级上下文使用现有 `/api/context`，成员记忆仅按已验证的 Reviewer 成员绑定返回。未配置绑定时显示项目级降级；权限验证失败时拒绝成员记忆。保留引擎既有预算，给模型的引用和事实限定到当前任务。 [引擎绑定接口](/D:/SanQian.Xu/knowledge-engine/src/server.js:88) [成员组过滤](/D:/SanQian.Xu/knowledge-engine/src/agent-members.js:178)

**提交门禁和收益。** 在隔离引擎中用两个项目、两个成员和不同的合成事实验证允许／拒绝。测错项目、错成员、仅声明绑定、禁用、撤销和超时。真 Review 回执有获准事实引用，越权事实未进入发送材料。部署组合保持旧模块可按能力降级。这一步节省手工交代已有项目约定。

### M1-D / Workflow · LangGraph 可选编排和重启恢复

官方注册信息显示审查时 `@langchain/langgraph@1.7.5`，依赖 SDK 和 Checkpoint 包，peer 包括 `@langchain/core` 与 `zod`。可选子包候选锁定 `@langchain/core@1.4.2`、`zod@4.6.7`、`@langchain/langgraph-checkpoint-sqlite@1.1.1`。LangGraph v1 按官方迁移要求以 Node ≥22 验证。SQLite saver 依赖 `better-sqlite3 ^12.10.0`，候选 `12.11.1` 提供 Windows x64 的 Node 22 和 24 预编译产物，本轮未执行安装。GLM 在动代码前复核官方元数据，提交精确 lockfile。 [LangGraph npm 元数据](https://registry.npmjs.org/@langchain%2Flanggraph/latest) [v1 迁移文档](https://docs.langchain.com/oss/javascript/migrate/langgraph-v1) [SQLite saver 元数据](https://registry.npmjs.org/@langchain%2Flanggraph-checkpoint-sqlite/latest) [Windows 预编译产物](https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v12.11.1)

- 在 Workflow 仓新增私有 `orchestrator/` 子包及其测试，拥有独立依赖和锁文件。使用显式配置的持久化编排入口，复用同一套核心检查、Reviewer 和裁决函数。核心 package、打包清单和零运行时依赖保持现有约束。默认直通模式保持可用。采用一个本地模块入口，省去新 HTTP 服务。
- 用 `StateSchema`、`StateGraph`、`START/END`、`addConditionalEdges` 和 `compile({checkpointer})` 真正执行。最小图为 `装载现有作业 → 执行检查 → 必要时调用 Reviewer → 由核心裁决`，输出整改、阻塞或可交付。SQLite 位于该测试实例自己的数据目录，`thread_id=reviewJobId`。图数据库只保存 ID、节点、哈希、版本和收据引用。任务、验收、派发记录以现有 Workflow 聚合为准。 [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) [持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- 在可恢复位置使用有版本的图和状态字段。先以 `getState` 核对 checkpoint，再结合业务收据决定 `invoke(null, config)`、安全地从未派发状态启动，或标记待核对。同步持久化模式也可能没有首个 checkpoint，因此先在 Workflow 持久化派发保留记录。找不到 checkpoint 或外部确认时，已经派发过的作业不能盲目重发。删除或改名仍有待恢复作业的节点会破坏恢复路径。 [Checkpoint 持久化模式](https://docs.langchain.com/oss/javascript/langgraph/checkpointers#durability-modes) [图版本兼容](https://docs.langchain.com/oss/javascript/langgraph/backward-compatibility)

**M1 最终门禁。** 在 Windows Node 22 和 24 独立安装、建库、写读及重启恢复，至少一次使用含中文和空格的数据库路径。真实测试覆盖通过、整改、失败分支，重启后同一 Job ID 和同一收据，无重复模型派发。模拟未知派发用于补充故障注入。开启图后再跑 Codex 开发、审查与整改闭环，并验证关闭图后直通 Review、团队任务和既有数据可用。衡量图带来的唯一新增收益是**重启后能继续核对作业且避免重复请求**。SQLite 或恢复门禁失败时关闭可选图，保留已验证的直通 Review，标记 M1 部分完成，M2 等待本门禁通过。回退可先禁用图，再逆序撤接线和适配器。已派发作业保留并完成对账。

## 5. M2｜只在复杂任务上调用 GLM Leader

| 编号 / 仓库 | 实现范围、接口和约束 | 门禁与直接收益 |
|---|---|---|
| **M2-A / Workflow** | `src/domain.js`、`src/tasks.js`、`src/server.js`、`src/identity.js`、`docs/contract.md`。给现有项目设置加可选 `leaderMemberId` 和受控预算配置，复用成员的 Profile、模型、说明、记忆组和启用状态。现有成员 ID 保持。只有明确请求 Leader 才生成计划。输出最多三个有序工作项，每项有目标、现有执行身份、前置项和验收。复用任务 Run／Checkpoint 存计划版本及运行引用。程序验证未知或重复 ID、前置顺序、循环、权限、预算和成员可用性。 | 普通任务立即走 M1，Leader 调用为 **0**。非法 JSON、错误依赖、禁用成员和预算不足留下可见阻塞。用户可以查看执行顺序和依赖，免去拆分后反复解释。 |
| **M2-B / 主仓接线，按需辅以 Workflow 修订** | `bin/project-knowledge-mcp.js`、`_site/lib/workflow-tool-runtime.js`、`_site/lib/module-bridge.js`、`pk-team/SKILL.md`。现有 `start` 可选 `leader:"request"`，返回任务及 Leader 作业状态，`resume` 读取计划和下一步。调用隔离 Workbench 已经授权的 GLM Profile，复用 `/api/terminal/sessions`、`/input`、`/events`、会话快照和权限配置。核对 Workbench `contextId` 映射、实际模型和输入来源。GLM Leader 只做有限规划，当前 Agent 接开发项，程序检查及 M1 Reviewer 自动接后续项。Workbench 管理的合法父会话可使用原生 `/delegations`，验证后才启用该路径。 | 选一个真实跨两个模块的需求，独立验证 GLM 收到批准的知识事实、返回有效计划、当前 Agent 按顺序完成、进入真 Review，最终证据完整。用类似难度任务记录实际减少了几次用户拆解或分派。再验证无 Workbench 时普通 M1 正常。 [现有 GLM 接入手册](/D:/SanQian.Xu/project-knowledge-base/docs/leader-glm-workbench-playbook.md:12) |

**M2 最终门禁。** 真 GLM 输出有 Profile／模型／运行 ID，计划通过代码的结构及权限校验。输出无效只允许一次有界修正。缺 Profile、超限、未获授权或无进展时保留可恢复任务，用户可回到 M1。简单任务整条链路的 Leader 调用和新增后台开发 Worker 调用均为 0。复杂任务完成真实串行分派和审查，且与手工方式相比至少少一次用户拆解或委派操作。回退先关闭 Leader 调用，再撤主仓接线和 Workflow 拓展，保留历史计划和执行收据。

**M2 范围决定。** 首期实现规划和串行交接，继续由用户正在使用的 Agent 写代码。后台 Worker 写入、自动合并、模型判断任务复杂度，以及每轮由 Leader 重规划均延后。这样可以独立验证 Leader 是否节省用户操作，再决定是否扩大自治范围。

## 6. 数据兼容、减法与最终报告

- **保留原始实体和状态。** `teamId/memberId/taskId/memoryGroupIds`、SessionBinding、Checkpoint、历史收据、项目设置、请求幂等记录、Bridge inbox/outbox 及游标均保留。继续使用 `ai-coding-workflow/state/v1` 的兼容可选字段，读时应用缺省值。新增写入仍走 `WorkflowStore.mutate`。保留 `name/apiVersion` 和现有能力字段语义，新增能力按探测启用。 [Workflow 状态契约](/D:/SanQian.Xu/ai-coding-workflow/docs/contract.md:61)
- **验证四个版本组合。** 在合成旧数据副本验证旧壳／旧 Workflow、新壳／旧 Workflow、旧壳／新 Workflow、配套新候选。检查旧任务、记忆引用和已交付历史可读，重新验收走新证据。验证重启、重复读取、未知字段保留、损坏文件处理、备份恢复。旧执行器如果可能绕过新证据门禁，回退时保留最近安全的 M0 写入路径，或只开放读取。恢复测试用备份和校验和，禁止用空状态覆盖受影响记录。
- **删除计划中的重复工作。** 保留六个 MCP 工具，通过 `review_result` 的可选参数支持有界等待。复用现有 Team、Run、Checkpoint、Workbench Profile 和知识记忆权限。延后 UI 重构、通用运行器、多 Agent 并行写代码、自动复杂度判断、新 Provider、自动发布和跨夜额度恢复。现有 UI、日报、提醒、Agent 页面和存储继续保留。
- **使用三组对照证明价值。** M0 记录错误交付次数为零及真实红→绿证据。M1 对照 Codex 会话的手工接力次数、复制次数、耗时和可取得的模型用量。M2 用简单／复杂任务对照，记录额外规划成本和减少的用户操作。无法取得真实 Token 或费用时记为未知。真实 CLI、真实 Provider、模拟故障注入分别列出。
- **最终交付一份短报告。** 按编号列两仓远端 SHA、对应 CI、可运行命令、Windows 实跑证据、Codex 开发与 Reviewer 会话和作业 ID、旧数据兼容结果、最后安全回退点。列出 `PASS / PARTIAL / BLOCKED`。先失败后恢复的证据保留。早上直接看报告即可定位最后一个已验证并推送的步骤，以及第一个未通过的门禁。
