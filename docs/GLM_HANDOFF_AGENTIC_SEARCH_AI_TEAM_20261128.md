# 智能检索与 AI 团队工作流交接

2026-11-28 · 给接手的 GLM

在现有 `main` 和未提交的改动上继续。智能检索沿用 [Agentic RAG 与自适应上下文实施计划](./Agentic_RAG_Adaptive_Context_PLAN.md) 和 [M0–M3 验收台账](./agentic-context-execution.md)。AI 团队自动维护已随 5.5.4 发布，继续工作前先区分线上包、隔离候选和本地源码的状态。

## 用户现场与测试数据

用户从另一台电脑粘贴了「当前检测算法参数有那些」的检索结果。页面显示「确定性检索 · 已降级 · 2 轮 · 8.8 秒」，随后列出 TCC-detect 的文档片段和纯文本路径。用户要在检索页读到按算法归纳的答案，能点开引用，并在向量召回不全时查到相关的当前资料。

现场问题来自聊天中的文字。这次没有连接另一台电脑，也没有读取其知识目录、模型配置或日志。验证使用本机隔离实例和另外编写的圆弧、条纹检测文档。其中 `arcPeakThreshold=47` 和 `stripeWindowWidth=29` 都是测试值。现场那次降级的原因待从实际运行机器核实。

## 源码与已发布版本

| 工作位置 | 接手时的状态 |
| --- | --- |
| `D:/SanQian.Xu/project-knowledge-base` | 宿主 `main` 为 `6716e7c`，与当时的 `origin/main` 一致。智能检索页面和浏览器验收仍是未提交改动。 |
| `D:/SanQian.Xu/.project-knowledge-test-temp/smart-search-results-20261128/engine` | 智能检索引擎改动在这份隔离的 `main` 上，基线为 0.4.3 发布线 `dffd3b2`。改动未提交，`src/agentic-context/answer.js` 是新文件。 |
| `D:/SanQian.Xu/knowledge-engine` | 原工作区为 `2795e43`、0.3.4，有其他未提交改动。保留这个工作区，从上面的隔离版本接续本次改动。 |
| `D:/SanQian.Xu/ai-coding-workflow` | Workflow `main` 为 `85cfdd1`，源码 0.4.3，检查时工作区干净。 |

已核对 npm 上的宿主 `@sanqianx/project-knowledge@5.5.4` 和 Workflow `@sanqianx/ai-coding-workflow@0.4.3`，二者当时都在 `next`。5.5.4 的受审包对应 `92f48f2`，包校验值与注册表一致。正式 Workflow 0.4.3 的校验值与当前锁文件一致，其 25 个校验文件均与运行时清单匹配。后续的 `6716e7c` 移除了 5.5.4 的一次性发布选项。[宿主 5.5.4 注册表记录](https://registry.npmjs.org/@sanqianx%2fproject-knowledge/5.5.4) · [Workflow 0.4.3 注册表记录](https://registry.npmjs.org/@sanqianx%2fai-coding-workflow/0.4.3)

5.5.3 发布了可选的智能检索和自适应上下文。5.5.4 发布了新的 Agent 自动维护，仍锁定 Engine 0.4.3 和 Workbench 0.13.16。本文下述带答案和可点击引用的修复还在本地源码，已发布的两个宿主版本均未包含它。

## 智能检索

启用入口为「系统状态 → 智能上下文」。可选择已保存的 Workbench 模型，配置深度检索时限，再在「搜索」选择项目、范围与「智能检索」。只查长期记忆时仍按原入口处理。快速检索继续使用现有 Hybrid Search。

- **源码中的问题。** 结果页把智能检索内容直接渲染为摘录和纯文本路径。规划出错时，引擎会改做原问题检索，前几轮取得的证据没有进入结果。还复现了按文件名二次检索时，文档末尾的校验段排在参数表之前，导致同一文档已命中却漏了参数。
- **宿主改动。** `resources/ui/product.js` 和 `product.css` 对知识问答向 `/api/engine/context/agentic` 发送 `answer: true`，显示归纳结果、编号引用和「知识来源」。点击引用用现有 `/api/engine/get` 打开原文，文档版本已变化时提示重新检索。模型不可用时给出降级原因，保留能打开的来源。浏览器验收在 `tests/run-agentic-context-clients.js`。
- **引擎改动。** `src/context.js` 只在显式深度问答启用摘要。 `src/agentic-context/` 基于现有混合检索和当前文件目录迭代查证，短文档保留核对后的正文，长文档支持按偏移继续读。规划失败时保留已核对的证据，并在模型和预算允许时尝试回答。摘要引用限定在当前范围内仍可读取、版本仍有效的事实，证据不足时标明可能有遗漏。原生任务 Hook、长期记忆组合和 Session Index 沿用既有路径。版本检查位于 `src/retrieval.js` 和 `src/runtime/contracts.js`。
- **原任务的进度。** M0–M2 已按原台账验收。M3 已验证的 Claude Code、Workbench 路径确实收到知识并通过代码断言。Codex 原生账号认证和 Hook 审核、真实向量独立复测、MiniMax Gold 门禁仍有阻塞。初始盲测有一项 FAIL，具体结果见台账。此次搜索页修复未重跑上述门禁。

### 这次修复的验收

隔离目录为 `D:/SanQian.Xu/.project-knowledge-test-temp/smart-search-results-20261128`，证据保存在其 `logs`。

| 验收 | 结果与证据 |
| --- | --- |
| 真实浏览器和 GLM-4.7 | **PASS，两次。** 未给夹具导入向量索引。确定性路径只取得相关来源，缺少两项参数。智能检索从目录追查到两份文档，回答包含两项默认值，逐个点击引用打开了对应原文。切到仅确定性检索后，显示降级原因和可打开的来源。两次中文问答耗时 5.2 秒、6.2 秒。见 `browser-answer-final-1.log`、`browser-answer-final-2.log`。 |
| Engine 回归 | **PASS。** 共 301 项，298 通过、3 跳过，无失败。覆盖文件名匹配仍取到参数、伪造引用过滤、文件或记忆在生成期间失效。见 `engine-suite.log`、`engine-targeted.log`。 |
| 宿主针对性测试 | **PASS。** 项目范围、领域检索、记忆组合、Session Index 和集成适配。隔离候选 `npm run runtime:verify` 校验 5 个模块通过。候选基于较早的 5.5.4 快照，当时用该快照锁值匹配的本地 Workflow 包完成安装。最终发布包的校验另见上文。 |
| 本机已有实例的只读核对 | **PASS。** 前后核对的 4 份配置哈希、12 个监听进程身份和 8 个健康响应一致。见 `protected-before.json`、`protected-after.json`。 |

复现时从隔离的 `host` 目录执行 `node tests/run-agentic-context-clients.js browser`。将 `PKB_CONTEXT_CANDIDATE_ROOT` 指向该 `host`，`PKB_CONTEXT_ENGINE_SOURCE` 指向上述 `engine`，`PKB_CONTEXT_TEST_MODEL` 为 `glm-4.7`，`PKB_CONTEXT_CHROME_EXECUTABLE` 使用已安装的 Chromium 或 Edge。由隔离进程环境提供有效的 `ZAI_API_KEY`，凭据无需写入文件或日志。使用独立的 TEMP、用户配置和浏览器资料目录。引擎全量回归命令为 `node --test --test-concurrency=2 test/*.test.js`。

## AI 团队工作流

这次新版改动在「AI 团队 → 自动维护」。普通团队任务仍走既有 Leader 规划、开发、审查与交付流程。自动维护由负责的 Review Agent 按计划提示词运行。

- 在「团队设置」给负责成员绑定 Workbench 模型。在「自动维护」登记仓库和本机检查工具，新建计划时选 Agent、检查工具和目标仓库，填写提示词与触发条件。手动「运行一次」可用于首次验证。已存在的直接工具计划在托管模式中显示「待配置 Agent」，编辑保存后继续运行，计划和历史保留。
- 同一计划可绑定多个仓库。提交触发取事件中的分支和 SHA，只运行提交所在仓库。手动和每日运行使用本地目标分支的提交，仓库可跟随当前分支或固定分支。同仓库排队，不同仓库最多同时运行 3 个。
- Agent 请求登记工具检查实际的提交，结果以真实退出码和收据为准。「允许 Agent 修复」仅授权隔离 worktree 内本次基线提交涉及的可写文本文件。通过复检后交付候选提交，目标分支推进时要在新基线上复检。页面可查候选 SHA、工具输出和只读原因。
- Workflow 0.4.3 还修复了旧版 Git 返回相对路径时的 worktree 校验。丢失路径会记录在运行详情。既有目录被占用或 Git 登记不一致时走保护，不覆盖现有工作区。

实现集中在 Workflow 的 `src/maintenance.js`、`maintenance-config.js`、`maintenance-runner.js`、`maintenance-agent.js` 与 `ui/app.js`。宿主只负责路由和连接，Workbench 持有模型和凭据，引擎持有长期记忆。操作与工具契约见 [AI 团队成员工具开发指南](./ai-team-member-tools-guide.md) 和 `D:/SanQian.Xu/ai-coding-workflow/docs/contract.md`。后续如继续完善自动维护，从 `test/maintenance.test.js` 与 `test/support/product-web-ui-test.js` 复验旧计划、真实检查收据、分支推进和页面。本文核对了发布物，未在用户真实仓库上执行维护计划。

## 接手续作

1. 先查看宿主、隔离引擎、Workflow 的 `git status --short --branch`，阅读各仓 `AGENTS.md`。保存智能检索两处未提交差异，并包含新文件 `src/agentic-context/answer.js`。如果 GLM 在另一台电脑接手，需要一并取得这两处改动，当前已发布包和本文无法还原未提交代码。
2. 从最新 5.5.4 发布源对齐隔离宿主。合并页面代码时同步更新 `module-runtime-manifest.json` 中 `product.js`、`product.css` 的哈希。当前主仓清单与已发布 UI 对齐，工作区这两个新文件的哈希还不匹配。保留现有依赖锁，确认新 Engine 候选后再走宿主的版本和打包验证。
3. 用上述隔离用例复跑真实模型和浏览器，并检查最终候选安装包。若要定位用户那次现场降级，先在实际运行机器上只读核对版本、所选模型、请求或降级日志及该项目的授权知识范围。
4. 保留现有数据、配置和运行实例。QA 使用独立安装前缀、合成知识、独立配置和端口。完成回归后分别做 Git 检查点。需要交付 npm 更新时先取得该次发布授权，再按相关仓库的受审候选发布流程执行。
