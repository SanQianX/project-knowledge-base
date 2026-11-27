# Agentic RAG 与自适应上下文验收台账

实施依据为同目录下的 `Agentic_RAG_Adaptive_Context_PLAN.md`，基线 SHA-256 为 `6244d198f1f45e8363f5229f130bc86836588eda69858ba45590e263bbcfe009`。本轮使用本机测试根 `D:/SanQian.Xu/.project-knowledge-test-temp/agentic-context-20261127` 的独立安装、临时 Git 仓库、数据、客户端环境和日志。生产保护快照及原始测试输出位于其 `logs/`。

## M0 · 基线冻结

| 仓库 | 本地开始 HEAD | 远端 main（实查） | 宿主锁、manifest、隔离安装和全局安装 |
|---|---|---|---|
| Project Knowledge | `27d4656`，有两份未跟踪计划 | `27d4656` | 5.5.2 |
| Knowledge Engine | `2795e43`，0.3.4，13 个文件未提交 | `7846033` | 0.4.2 |
| Workbench | `4486bc0`，有未跟踪 QA 文件 | `4486bc0` | 0.13.15 |
| Vector Hub | `073534d`，干净 | `073534d` | 1.0.8-rc.10 |
| Event Bridge | `94c02f2`，有未跟踪 artifacts | `94c02f2` | 0.7.5-rc.2 |
| Workflow | `1627e69`，干净 | `1627e69` | 0.4.2 |

六个仓库均在 `main`，查阅了相关 AGENTS.md、锁、包和历史。Knowledge Engine 的本地开发从隔离源码副本 `engine/main` 的 `7846033` 继续，原引擎工作树保留。主仓开发依赖实际为 Workbench 0.13.14、Vector Hub rc.9、Bridge rc.1、Engine 0.4.1、Workflow 0.4.0，基线使用隔离环境的 `npm ci` 和工作树 manifest 验证（全部 5 个运行时通过）。

默认数据目录有登记并解析到本仓，无活动的默认 runtime endpoint，任务板未连接。发现其他实例占用 54588–54594、55767–55770、61335，按实际监听 PID 保护，其中 54588 的宿主是测试实例 5.5.0，其引擎 0.4.1 运行于 54592。未接入这些服务执行测试。确认现场客户端分别为 Codex 0.137.0、Claude Code 2.1.143 和 OpenCode 1.18.5。ZCode CLI 未出现在 PATH，现有适配源码与契约测试可读。Codex/Claude 原生 Hook 使用 10 秒调用窗口、8,000 字符输出上限和 `additionalContext`，回执为标准输出完成。Workbench 在提交开发输入前调用同一引擎，旧路径的状态是在准备阶段更新。暂无可靠的原生模型接收确认。

复用 `3ede90d`、`51644bc` 的 Session Index 和强匹配摘录，`182338c`、`520a8f7`、`6fc95ee` 的有效记忆组合、成员验证和可见性，以及现有 Hybrid Search 与可信 Markdown 校验。Workbench 现有受信 `internal/maintenance-agent` 可通过已存 Profile 执行有界结构化模型回合，无需启动原生子会话。向量服务继续读现有接口。

| 命令（隔离前缀） | 退出码 | 结果 |
|---|---:|---|
| `npm ci --no-audit --no-fund`、`node src/scripts/verify-module-runtime.js --working-tree` | 0 | 锁定的 5 个 npm 运行时校验通过 |
| 引擎 `npm test` | 0 | 285 PASS，3 跳过，0 FAIL |
| 主仓 `node tests/context-session-index-test.js` | 0 | 旧 30 轮累计 ≤10 KB 回归通过 |
| `automatic-context-test.js`、`native-context-integrations-test.js`、`workbench-context-receipts-test.js`、`integration-adapters-test.js` | 0 | 各针对性测试通过 |
| `node tests/run-agentic-context-baseline.js` | 0 | B 组，受控词法回退，见下 |
| `node src/scripts/run-retrieval-gold-isolated.js <report>` | 1 | BLOCKED。既有 Gold Gate 指定 MiniMax embo-01，隔离环境没有该凭据或授权语料副本 |
| Z.AI 真实非流式 Messages 和 embedding-3 小请求 | 0 | 两个接口 HTTP 200，模型有输出，Embedding 返回 2,048 维。此项仅验证运行环境 |

冻结 `tests/fixtures/agentic-context-corpus.json`（SHA-256 `097d266294488e3360e60b987d6a2bd4ad6e44762416bb28e59e61c4c91c219c`）。32 项合成开发检索请求、8 个独立开发结果断言，包含 UI、故障、迁移、发布、跨模块和中英文。知识先于会话创建，使用语料清单中给出的手册与别名记录作为必要事实，现行约定是适用记忆。第 1 个问法用于调试，另外 24 个问法固定用于盲测。本轮暂无经授权的历史知识快照，合成结果只能说明所测行为。B 组调试集事实 8/16、相关记忆 8/8、无关记忆 56/64、累计 18,998 UTF-8 字节。盲测对应结果为 24/48、24/24、168/192 与 57,285 字节。每个样本均为独立首次请求。后续对照沿用相同源码、提示、验证和开发模型，分析时单列真实向量与受控词法。全套主仓回归在同一基线上另行保留日志。

预注册沿用计划 Q01–Q10、Q13。Q11 门槛为关键知识覆盖或首次编码通过率比 B 提升至少 10 个百分点，且无重大退步。Q12 总输入与输出 Token 警戒线为 B 的 1.2 倍，Hook 10 秒内返回，显式深度 60 秒上限，记录总体和各任务耗时与供应商 usage，估计用量单列。默认智能模式须等待真实门禁。

## M1 · Context Agent、任务记忆与检索页面

- Engine `94df910b161a9619326c518bf8513fa9cc98c08a` 接入单 Agent、只读白名单、真实工具回合、任务记忆选择和来源复验。工作台模型边界提交 `91df0d91aa2c0857564e4634c5cdfc4e37b83711`，复用现有 Profile 内部调用，增加 Context Agent 的输出上限和供应商 usage。宿主只负责配置、代理和显示，当前发布锁未变。
- `node --test test/agentic-context.test.js test/context.test.js test/memory-visibility.test.js test/memory-migration.test.js` 退出 0，28 PASS。恶意工具名和额外作用域参数被拒，伪造或撤销的 ID 从输出剔除。覆盖真实检索与协议桩、引用版本复验、候选记忆权限、超预算续读、取消、零轮停机和格式错误降级。工作台 `node --test tests/unit/maintenance-agent.test.js` 退出 0，2 PASS。宿主的 Session Index 和记忆组合 UI 回归退出 0。
- `node tests/run-agentic-context-real.js smoke` 退出 0。真实 Z.AI GLM-4.7、Embedding-3、Vector Hub 和工作台受信接口均参与。第 1 轮只返回引出别名的目录证据，第 2 轮返回该别名的权威值。候选准备 5,007 ms，3 次模型调用，供应商报告 2,736 输入和 178 输出 Token，输出 745 UTF-8 字节。B 组为 751 ms、2,317 字节，可靠事实从 1/2 到 2/2。
- `node tests/run-agentic-context-real.js debug` 退出 0。真实 Hybrid Search 基线 B 8/16 必要事实、8/8 相关记忆、56/64 无关记忆。候选 16/16、8/8、0/8，模型调用 25 次，单任务 4,354–7,949 ms。单例及 8 组原始计数见 `logs/m1-real-smoke.json` 与 `logs/m1-real-debug.json`。保持独立盲测集未运行。既有 MiniMax Gold Gate 仍 BLOCKED。

复现真实检索时，以隔离安装的锁定依赖运行脚本，将 `PKB_CONTEXT_ENGINE_SOURCE` 和 `PKB_CONTEXT_WORKBENCH_SOURCE` 指向对应源码根，使用测试进程的 `ZAI_API_KEY`。Vector Hub 的 OpenAI 兼容客户端固定追加 `/v1/embeddings`，测试夹具中的 loopback 适配器只把该请求转发到 Z.AI 公布的真实 Embedding API。应用仍使用原有 Vector Hub 接口。
