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

## M2 · 任务路由、跨轮增量与投递回执

- Engine `1e2a816022d0bcb6b9f5314b430f693fe7568974` 复用 `EngineContext` 会话映射、串行队列和 TTL。智能路径按项目、范围、客户端、会话和成员绑定隔离，短追问可继承主题。请求 ID 重试、已确认版本、未知的短期输出和有理由的恢复分别处理。重复片段按授权文档、哈希和区间裁剪。提交准备状态仅保留版本、源定位和有界任务线索，需要重放时复验并重建正文。
- Hook 发送 Adaptive 标志，旧引擎及关闭状态沿用 Session Index。标准输出回调之后尝试登记 `emitted`，回执中没有模型接收或使用证明。受信 Workbench 的 `acknowledged` 表示开发输入已被 driver 接受。新任务的 Deep 续查票据绑定当前任务及原范围，可显式恢复。原生自动压缩恢复待客户端验证。
- `node --test test/agentic-context.test.js test/agent-members.test.js test/workflow-validation.test.js` 退出 0，14 PASS。覆盖重复请求、无信任回执、撤销、跨项目隔离、恢复、取消、一次续查及真实 Workflow 验证接口。已确认首次发送后的 30 个静默轮新增正文 0 字节、额外模型调用 0。
- 引擎 `npm test` 并行默认值首次有 1 项既有 Git 冻结证据测试未在 250 ms 窗口内观察到重叠；两个项目均生成成功。相同断言在 `node --test --test-concurrency=2 test/*.test.js` 通过，291 PASS、3 跳过、0 FAIL。宿主 `automatic-context-test.js`、`native-context-integrations-test.js` 和旧 Session Index 回归均退出 0。

## M3 · 客户端、对照实验与候选包

### 实现及检查点

| 阶段 | 宿主 `main` | 引擎隔离 `main` | Workbench `main` |
|---|---|---|---|
| M0 | `365bc91` | 基线 `7846033` | 基线 `4486bc0` |
| M1 | `4547872` | `94df910` | `91df0d9` |
| M2 | `896674b` | `1e2a816` | 沿用 Profile 接口 |
| M3 | `c81eca6`、`b00ca59`、本台账所在提交 | `5e06244`、`2c5d83d`、`4edadc7`、`d988ec9` | `5f1084b`、`3347fb9` |

知识页快速检索沿用 `/api/engine/search`。智能检索走 `/api/engine/context/agentic`，自动 Hook 与显式调用逐级复用同一引擎。设置页可启用智能上下文、选择已有 Workbench Profile 的独立模型、配置 2–60 秒深度时限。旧安装的缺省值为关闭。自动 Hook 客户端总时限保持 10 秒，并遵循已有输出上限。深度路径最多 3 轮、10 个子查询、6 个完整条目和 5 次模型调用。记忆策略可选按任务筛选、强制约束或按需读取。

MCP 与 CLI 增加准备、刷新及分段读取强制记忆。复杂任务超出 Hook 窗口时，可由同一任务的 `continuationId` 继续，显式恢复会重新校验范围和版本。取消或供应商失败仍可继续原始开发请求。未发现可跨原生客户端统一使用的压缩事件，当前恢复以显式入口验收。`prepared` 表示引擎生成 pack，`emitted` 表示 Hook 完成标准输出，`acknowledged` 表示 Workbench driver 接受输入。收到和使用的证据来自下表的实际模型入站元数据及代码断言。

### 真实开发客户端

| 门禁 | 结果 | 交付证据（隔离目录 `logs/`） |
|---|---|---|
| C01 · Codex 0.137.0 | **BLOCKED** | 原生 app-server 列出 1 条与最终候选包路径匹配的 Hook，状态为 `untrusted`，`account/read` 无登录。`m3-codex-r3.log`，退出 2。继续该验收须在隔离 `CODEX_HOME` 里登录可用账户并通过原生 `/hooks` 审核。测试未读取日常登录文件。 |
| C02 · Claude Code 2.1.143 | **PASS** | 正常开发请求的首个 GLM-4.7 请求读到一次独有事实和适用记忆，实际编写的函数返回知识库中的值。另一次延迟了首次检索供应商请求，Hook 约 7.6 秒回退并发出续查票据，原生 Claude 在改代码前自行调用 MCP，同一 `taskContextId` 取得深度 pack 后通过相同代码断言。最终安装包文件路径复验 20.70 秒，首个请求含一次独有事实和适用记忆。`m3-claude-smoke-rows.json`、`m3-claude-mcp-rows.json`、`m3-claude-r3-rows.json`。 |
| C03 · Workbench 0.13.15 | **PASS** | 实际 driver 的首个成功模型请求包含原始需求、恰好一次的独有事实和适用记忆，验收代码正确。Workbench 记录 `acknowledged`，采集缓冲中的原始需求保持原文。候选源码真实向量用时 18.56 秒，最终安装包文件路径复验 24.87 秒。`m3-workbench-real.log`、`m3-workbench-r3.log`。 |
| C04 · ZCode 0.18.0、OpenCode 1.18.5 | **PASS（已验证范围）** | 最终安装包的 ZCode 原生 Hook 实际完成 `prepared` 与 `emitted`，首个 GLM-4.7 请求收到一次独有事实及适用记忆，编写代码通过，39.51 秒。使用文件降级路径，原生自动 MCP 未验证。`m3-zcode-r3.log`。OpenCode 保持现有手动 MCP 和采集能力，未扩展自动路径。原生适配及 ZCode 采集契约通过。 |

### 冻结检索与盲测修正

| 真实模型试验 | 基线 B 必要事实 / 适用记忆 / 无关记忆 | 候选 C 必要事实 / 适用记忆 / 无关记忆 | 结论 |
|---|---|---|---|
| 冻结调试集 8 条，GLM-4.7 + Embedding-3 | 8/16 · 8/8 · 56/64 | 16/16 · 8/8 · 0/8 | **PASS**，含真实证据引出新检索词的第二轮 |
| 初始盲测 24 条，GLM-4.7 + Embedding-3 | 24/48 · 24/24 · 168/192 | 40/48 · 24/24 · 0/24 | Q01 **FAIL**，83.3%。累计正文 57,336 → 16,738 UTF-8 字节。候选 62 次模型调用，供应商报告 64,668 输入、3,451 输出 Token |
| 独立复测 24 条，GLM-4.7 + 词法/文件 | 26/48 · 24/24 · 168/192 | 48/48 · 24/24 · 0/24 | 文件路径 Q01/Q02/Q04 **PASS**。57,751 → 18,513 UTF-8 字节。候选 71 次真实模型调用 |
| 独立复测的真实向量路径 | Embedding HTTP 429（代码 1113） | 未取得有效比较 | **BLOCKED** |

初始盲测 4 条遗漏都在模型零轮检索时提前返回记忆。引擎提交 `5e06244` 在确有待核实的项目事实时对原始问题做一次有界验证，并用任务实词约束降级时的普通记忆选择。无可靠命中的合法零轮行为仍通过回归。印证修复的 `tests/fixtures/agentic-context-postfix-corpus.json` 包含 8 项新任务共 24 个新问题，SHA-256 为 `398c6f34a5f9314cf100e5279ec61fe222084c389c0a9b2d2bcc75e9790d53fd`。原始计数及轮次见 `m3-blind-retrieval.json`、`m3-postfix-file-retrieval.json` 和 `m3-postfix-retrieval.json`。最新最小真实 Embedding 请求仍返回 429，见 `m3-final-embedding-capability.json`。MiniMax embo-01 Gold Gate 缺专用模型凭据及授权语料，独立 **BLOCKED**。

### Claude Code 真实代码对照

8 个独立合成开发任务各运行一次 A/B/C，共 24 个原生会话。同一 GLM-4.7，同一任务原文、初始代码和验收断言。A 无知识库，B 使用 M0 宿主插件与旧 MCP 工具表，引擎使用候选构建中开关关闭的兼容路径。C 使用修正后智能路径。B、C 使用相同真实向量配置。已发布引擎与候选兼容路径另用 P02 升级用例逐字比较。任务名按冻结语料标识。下列“首次”指首个包含原始任务的模型请求。

| 任务 | A 代码验收 | B 首次收到关键事实 / 代码验收 | C 首次收到关键事实 / 代码验收 | B / C 耗时（秒） |
|---|---|---|---|---:|
| routing | 失败 | 否 / 通过 | 是 / 通过 | 16.31 / 15.76 |
| retry | 失败 | 否 / 通过 | 否 / 通过 | 35.38 / 43.91 |
| ui | 客户端轮次用尽 | 否 / 通过 | 是 / 通过 | 52.78 / 19.36 |
| release | 失败 | 否 / 通过 | 是 / 通过 | 23.82 / 43.33 |
| audit | 失败 | 否 / 通过 | 是 / 通过 | 35.22 / 24.54 |
| migration | 失败 | 否 / 通过 | 是 / 通过 | 24.70 / 27.62 |
| cache | 失败 | 否 / 通过 | 是 / 通过 | 46.45 / 24.66 |
| events | 客户端轮次用尽 | 否 / 通过 | 是 / 通过 | 37.02 / 29.98 |

| 组别 | 代码验收 | 首次关键事实 | 开发输入 / 输出 Token | 检索输入 / 输出 Token | 已记录总 Token | 模型开发请求 | 端到端 p50 / p95（秒） |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 0/8 | 0/8 | 524,891 / 24,549 | 0 / 0 | 549,440 | 64 | 44.88 / 88.78 |
| B | 8/8 | 0/8 | 603,345 / 11,084 | 0 / 0 | 614,429 | 47 | 35.22 / 52.78 |
| C | 8/8 | 7/8 | 380,653 / 14,397 | 29,174 / 1,406 | 425,630 | 32 | 24.66 / 43.91 |

Q11 在该样本 **PASS**。首次关键事实覆盖提升 87.5 个百分点，代码验收保持 8/8。B、C 首次都收到当前任务适用记忆。B 调用 20 次旧知识读取，C 调用 5 次旧知识读取和 1 次深度续查。按最近秩计算 p50/p95。Q12 在已测范围 **PASS**，已记录总 Token 为 B 的 69.3%，低于 1.2 倍警戒线。C 组有一次超时调用缺供应商 usage，比例是已记录用量，费用未取得。原始记录依次见 `m3-ab-claude-rows.json` 的 A 行、`m3-baseline-client-rows.json` 的 B 行和 `m3-compare-vector-rows.json` 的 C 行。每任务仅一个试次，尚未评估真实历史知识快照及模型波动。

### 回归、升级及复现

- Q03 **PASS**。引擎 `d988ec9` 修复原生上下文的满包边界。旧布局先写证据，可能挤掉强制约束冲突和超预算读取提示。失败复现与修复重跑见 `m3-mandatory-overflow-red.log`、`m3-mandatory-overflow-green.log`。改为预留提示空间并先呈现强制约束，证据仍受原有上限约束。
- 引擎 `node --test --test-concurrency=2 test/*.test.js` 退出 0，294 PASS、3 跳过、0 FAIL，`m3-engine-final-r3.log`。Q05/Q07 的工具白名单、引用复验、伪造来源、跨作用域及撤销断言 **PASS**。Q06/Q08 的重复回执、30 个静默轮 0 新增字节及 0 额外模型调用断言 **PASS**。
- Q09 **PASS**。宿主 `npm test -- --no-report` 最终 237 PASS、0 FAIL，包括原有 Session Index 30 轮 ≤10 KB。基线首轮 234 PASS/3 FAIL，候选首轮 233 PASS/4 FAIL。共同失败为自动上下文测试继承 `CLAUDE_CONFIG_DIR`、Markdown 维护在深层 Windows 临时路径返回 500、旧打包 UI 在 npm 下载超时。最终重跑清除该变量、缩短临时路径并使用已预热 npm 缓存。候选额外失败为 MCP 断言仍预期旧 12 项清单，已更新为精确检查原 12 项与新增 3 项。对应日志 `m0-git-baseline-full.log`、`m3-host-full-pinned.log`、`m3-host-full-final.log`。
- Workbench `npm run verify` 首轮 1,161 PASS、5 跳过、2 FAIL，两个 SDK tarball 安装在子进程的 420 秒 npm 等待期超时。使用预热缓存重跑两个相同测试及整套 `npm run verify`，最终 1,163 PASS、5 跳过、0 FAIL，SDK 包校验和 TypeScript 检查同次退出 0。日志 `m3-workbench-verify.log`、`m3-workbench-sdk-install-retry.log`、`m3-workbench-verify-final.log`。
- P01/P02 **PASS**。用 `npm pack --ignore-scripts` 构建并在独立目录验证候选锁、tarball integrity 及 runtime manifest。候选暂存目录 `npm run release:verify` 退出 0。新前缀 `npm ci --offline --ignore-scripts --no-audit --no-fund` 退出 0。`node tests/run-agentic-context-package.js` 对锁定的已发布引擎 0.4.2 做隔离数据的就地候选升级，schema 6、8 条记忆及 1 个组合保留，关闭模式时既有开发上下文逐字相同，启用后可查询智能 pack。原生实测脚本已统一从候选安装解析运行时，修复源码目录的陈旧 Workbench 依赖使第一次 ZCode 文件路径实测丢失首发事实的问题。最终安装包以真实 Chromium 验证 UI 配置、快速/智能检索、引用与适用记忆。日志 `m3-r3-candidate-release-verify.log`、`m3-r3-candidate-install.log`、`m3-r3-installed-upgrade.log`、`m3-r3-installed-browser.log`。

在测试专用安装、端口、工作区、数据与客户端 home 下执行以下命令。`PKB_CONTEXT_CANDIDATE_ROOT` 可指向隔离安装的宿主包，或用 `PKB_CONTEXT_ENGINE_SOURCE` 与 `PKB_CONTEXT_WORKBENCH_SOURCE` 选择候选源码。真实调用使用测试进程授权的 `ZAI_API_KEY`，只通过进程环境提供。各模式应指向实际客户端可执行文件和隔离客户端配置。原始报告只保留可关联的元数据与计数，浏览器使用独立 profile。

```text
node tests/run-agentic-context-real.js smoke
node tests/run-agentic-context-real.js debug
node tests/run-agentic-context-real.js blind
node tests/run-agentic-context-real.js postfix
node tests/run-agentic-context-real.js postfix-file
node tests/run-agentic-context-clients.js smoke
node tests/run-agentic-context-clients.js mcp
node tests/run-agentic-context-clients.js compare
node tests/run-agentic-context-clients.js baseline-client
node tests/run-agentic-context-clients.js compare-vector
node tests/run-agentic-context-clients.js workbench
node tests/run-agentic-context-clients.js codex
node tests/run-agentic-context-clients.js zcode
node tests/run-agentic-context-clients.js browser
node tests/run-agentic-context-package.js
```

Claude、Codex、ZCode 与浏览器分别选择 `PKB_CONTEXT_CLAUDE_EXECUTABLE`、`PKB_CONTEXT_CODEX_EXECUTABLE`、`PKB_CONTEXT_ZCODE_EXECUTABLE` 与 `PKB_CONTEXT_CHROME_EXECUTABLE`。对照实验的 B 组及升级脚本用 `PKB_CONTEXT_BASELINE_HOST_SOURCE` 指向装有锁定依赖的 M0 宿主。`PKB_CONTEXT_FILE_FALLBACK=1` 可主动跳过客户端夹具的向量导入，作为单独降级试验。Codex 的独立 `CODEX_HOME` 要位于进程的隔离临时目录下，在该 home 登录并通过原生 Hook 审核。对照结果以 `PKB_CONTEXT_CLIENT_REPORT` 指定可写的隔离路径。

候选与已发布版使用相同版本号，产物按本地 SHA-256 区分。产物位于 `packs/final-r3/`。

| 离线产物 | 版本 | SHA-256 |
|---|---|---|
| 宿主候选 tarball | 5.5.2 | `96ae5eb43c482beafa84287c87540f9c3b4b94ea317f582517469bf4d6a0bd2a` |
| Knowledge Engine 候选 tarball | 0.4.2 | `75e9c93da4d7788672b356f422359ab967c5bb2f86a8a3ecd276c0ad45db4377` |
| Workbench 候选 tarball | 0.13.15 | `23daeebd4060394dfc82102480a18154d7c9b6b53a01044f9981f847fddd5450` |

其他实际装机版本为 Vector Hub 1.0.8-rc.10、Event Bridge 0.7.5-rc.2 和 Workflow 0.4.2。经 `git bundle verify` 校验的引擎 `main` bundle 在同一目录，包含候选 HEAD `d988ec9`。正式锁和已发布模块版本继续使用原值，候选锁及 manifest 仅写入隔离的打包前缀。可在设置页关闭智能上下文，恢复旧快速路径。无 npm 发布、推送或日常实例替换。

Q10 **PASS**。最后一次客户端测试结束后复核 4/4 配置文件 SHA-256、12/12 监听端口的原有 PID 及进程启动时间、8/8 基线健康端点。结果在 `m3-protected-after-final.json`。

### 判定

M0 基线冻结、M1 真实多轮闭环、M2 任务状态及回执均 **PASS**。M3 完整验收 **BLOCKED**，Codex C01 原生认证和 Hook 审核、独立盲测的真实向量复验、既有 MiniMax Gold Gate 待满足。初始 Q01 **FAIL** 独立保留。独立文件检索复测及已完成的 Claude Code、Workbench 和隔离候选升级门禁通过，默认智能模式保持关闭。历史语料尚待授权，有据可证的效果范围为合成开发项目。

## 检索页问答：先拆关键词再多路搜索 · 2026-11-28

本节只涉及检索页的问答路径（请求带 `answer: true`）。原生上下文路径的提示词、工具校验和各项上限未改动。检查点为引擎 `a55aa7b`、宿主 `93e3102`（此前带答案和引用的修复），本次为引擎 `513448c` 和宿主随后的一次提交，均未推送、未发布。证据在 `D:/SanQian.Xu/.project-knowledge-test-temp/smart-search-results-20261128/logs/agent-plan/`。

### 改动

- **先拆关键词**。第 1 轮由一次模型调用给出 2–4 个关键词，与原问题并行搜索。原问题照常搜索，文件名、提交号等精确匹配不受影响。规划不可用时只搜原问题，不算降级。
- **带来源的线索**。每次搜索保留的不同文档从 3 篇提高到 5 篇，评估步骤最多看到 10 篇，每篇标注被哪些关键词命中、所在小节、匹配类型和续读位置。
- **读取**。回答模式可按 `entryId` 读取已出现过的文档，或带 `query` 直接跳到匹配的位置。模型把续读位置当参数传回时按偏移量接受；`refId` 与 `entryId` 同时出现时以 `refId` 为准。
- **来源合并**。同一文档的多段合并为一个来源。
- **同轮共用扫描**。一轮内的并行搜索只读取并分块一次知识树，不跨轮、不跨请求缓存；返回前仍按磁盘内容复核每个文档。
- **预算**。回答模式的累计输入预算为 48000 估计 Token，规划与评估合计不超过 32000，单次调用不超过 20000 估计 Token 且不超过 60000 字符。归纳调用的输出被截断时保留已完整的要点。
- **页面**。状态行标出「向量+词法」「仅词法」或「文件检索」，回答上方显示每轮的关键词、读取数和新增文档数。日志只记计数，不记关键词。

### 与批准方案的差异

| 项 | 方案 | 实际 | 原因 |
|---|---|---|---|
| 评估提示词 | 另写一份 | 以原生提示词为底稿逐字保留，只追加视图说明和两条规则 | 改写后模型不再按标识符的确切名字搜索，也不选记忆；见下方探测记录 |
| 证据 ID 上限 | 6 放宽到 8 | 保持 6 | 上限写在原生提示词里，保持底稿一字不改 |
| 模型调用上限 | 5 不变 | 5；仅当一轮花在重复读取已完整展示的文档时为 6 | 否则这一次浪费会让三轮工具轮次用不满。轮次、搜索、读取上限不变 |

### 验收

| 验收 | 结果与证据 |
|---|---|
| 引擎针对性用例 | **PASS**，25 项全部通过。新增 12 项：规划与清洗、第二轮关键词只能来自第一轮结果、规划不可用与模型失败、按 `entryId` 和定位读取、来源合并、同轮共用扫描、重复读取不占轮次、读取返回空、截断保护、向量行校验。见 `engine-targeted.log`。 |
| 引擎全量 | **PASS**，313 项：310 通过、3 跳过、0 失败，见 `engine-suite.log`。此前一次同命令有 1 项失败：既有的 Git 冻结证据用例断言 `analysis intervals overlap`，即 M2 记录过的时序敏感断言，与本次改动无关，重跑通过。日志保留为 `engine-suite-run-a-flake.log`。 |
| 真实浏览器与 GLM-4.7，纯词法 | **PASS，两次**。`browser-lexical-1.log`：第 1 轮拆出 4 个关键词，1 轮、5.7 秒、4 次模型调用。`browser-lexical-2.log`：第 1 轮只命中目录，第 3 轮按名字搜 `stripe-detect` 补齐，3 轮、8.2 秒、5 次调用。两次都给出两个参数值并逐个点开引用，每篇来源只出现一次。 |
| 向量参与，模拟 Embedding | **PASS，一次**，只验证管线。`browser-vector-simulated-1.log`：状态行显示「向量+词法」，2 轮、8.0 秒。Embedding 由测试替身按字符二元组生成固定向量，不代表语义质量。 |
| 向量参与，真实 Embedding | **BLOCKED**。`browser-vector-1.log`：导入向量索引时 Embedding 接口返回 429。随后一个最小请求间隔 20 秒重试两次，均为 429、代码 1113，未给出重置时间，与上文「独立复测的真实向量路径」是同一状态。 |
| 宿主 | **PASS**。隔离宿主内 `verify-product-runtime.js`、`npm run runtime:verify` 和 5 个针对性测试通过。宿主仓库目录自身的 `node_modules` 仍是 M0 时期的版本，模块校验在那里会报 `Module version mismatch`，属既有状态，未在该目录重新安装。 |
| 日用实例只读核对 | **PASS**。前后 18 个监听进程及其启动时间、4 份配置哈希、6 个健康响应一致，见 `protected-before.json`、`protected-after.json`。本次快照覆盖了默认端口上的日用实例（5757、5760、5790、5810、8787、8790）和另外两组测试实例。 |

### 探测记录

修正前的版本共做过 10 次带调用轨迹的浏览器探测（`planner-trace-probe-a` 至 `-j`），6 次通过、4 次失败。失败原因逐项修正，均有对应用例：

1. 重写的评估提示词去掉了「结果给出此前未知的标识符时，搜那个确切词条」。模型转而搜索 `settlement routing handoff identifier` 这类描述，找不到答案文档。
2. 摘录已是整篇文档时仍给出 `nextOffset`，模型把它当作调用参数传回，整轮被拒。
3. 提示词里「handoff reference」的措辞让模型按概念造查询。
4. 提示词缺少「选择相关记忆」一句，模型返回空的记忆列表。

### 限制

- 真实向量加浏览器的端到端没有验证过。引擎向量行在多路搜索中的校验与融合只有单元用例覆盖。
- 规划出的关键词仍可能混入目录里的无关文档名。最终两次纯词法运行中有 1 次出现，未影响结果。
- 归纳调用常返回 `complete: false`，页面因此显示「证据不完整」，即使两个参数值都已给出。
- 效果范围是合成夹具。M3 的三项阻塞不变，本次未重跑那些门禁。

### 复现

在隔离宿主目录执行 `node tests/run-agentic-context-clients.js browser`。环境变量同上文，另加 `PKB_CONTEXT_CHROME_EXECUTABLE` 指向已安装的 Chromium 或 Edge，TEMP、HOME、`npm_config_cache` 指向隔离目录。`PKB_CONTEXT_BROWSER_VECTOR=1` 让浏览器模式索引页面所用项目的知识目录副本；`PKB_CONTEXT_EMBEDDING=simulated` 用测试替身代替 Embedding 接口，输出会标明 `embedding: simulated`。引擎全量回归为 `node --test --test-concurrency=2 test/*.test.js`。

## 发布轮次：从隔离验收到日用实例 · 2026-11-28

用户授权直接发布小版本到 npm 的 `next`、升级本机日用实例并用真实数据测试，循环到可用为止；`latest` 不动。另一个会话同时改 Workflow 模块，也会升级宿主版本，两处共用宿主工作区和日用实例。证据在 `D:/SanQian.Xu/.project-knowledge-test-temp/` 下的 `release-5.5.5-20261128`、`release-5.5.7-20261128`、`release-5.5.8-20261128`。

### 第 1、2 轮：长文档读全（引擎 0.4.4/0.4.5，宿主 5.5.5/5.5.7）

- **发现**。真实数据上，长文档只有开头约 400 字进入归纳，分散在多个小节里的参数被漏掉。
- **处理**（引擎 0.4.5）。命中的小节整段保留，另带至多三段与问题用词或已收集标识符相关的窗口，模型读过的页面优先，每篇文档和总量都有上限，分开的段落以一行 `…` 相接。收尾的规划回复不合用时重问一次。轮次用完后仍要求调用工具时，按「证据不完整」用已收集的证据作答，不算降级；引用了从未发出的证据编号时同样回退到已收集的证据。模型调用从 5 次增加到最多 7 次。
- **验收**。引擎全量 321 项：318 通过、3 跳过、0 失败。日用实例 5.5.7 配 glm-4.7，四个问题都是智能检索、无降级，各 5 次模型调用、3 轮。

| 问题 | 结果 |
|---|---|
| vector-hub | 4 个要点，20.8 秒 |
| project-knowledge-base | 2 个要点，26.0 秒。偏弱，各次运行有波动 |
| ai-coding-workflow | 6 个要点，带默认值，12.3 秒 |
| knowledge-engine | 6 个要点，如实说明没有定义 `injectionPolicy`，18.2 秒 |

`perProjectLimit` 的默认值仍未找出。

### 第 3 轮：先思考再回答的模型（Workbench 0.13.17，引擎 0.4.6，宿主 5.5.9）

- **现象**。日用实例上用户配置的 MiniMax-M3.1-Flash，四个问题共 8 次运行，0 次给出答案：1 次 `model-failed`，其余 `invalid-model-output`。
- **依据**。MiniMax 官方文档「模型调用」（platform.minimax.cn，2026-11-13 更新）：思考默认开启，省略 `effort` 时为最深一档；思考不能关闭，传 `thinking: disabled` 或 `effort: none` 返回 400；思考以 `thinking` 块返回并计入 `max_tokens`。Workbench 给知识引擎结构化调用的输出上限是 1024。
- **处理**。Workbench 对这类调用要求最浅的思考（Anthropic 兼容用 `output_config.effort`，OpenAI 兼容用 `reasoning_effort`），上限 1024 提到 4096，回复被输出上限截断时如实标出。服务商以 400 拒绝该字段时去掉字段重发；只有在拒绝信息点名字段时才永久去掉。不指明用途的调用原样不变。引擎把截断报为 `model-output-limit`：收尾回复被截断不再重问，归纳被截断时保留已完成的要点。兼容 `<think>` 块和包在句子里的 JSON 对象，没闭合的 `<think>` 里即使有 JSON 也不当作决定。无法使用的回复记一条不含内容的形态记录（调用名、长度、开头类型、键名）。
- **验收**。Workbench 路由单元测试 6 项通过。本地全量校验中测试和包检查通过；SDK 类型检查只有从目录的真实大小写路径 `D:/SanQian.Xu/claude-ai-workbench` 运行才通过，从 `Claude-Ai-Workbench` 进入时 TypeScript 把同一文件当成两个，属环境问题，与改动无关；CI 通过。CI 候选包与本地打包 129 个文件，126 个逐字节一致，3 个只有换行符差异。引擎全量 329 项：326 通过、3 跳过、0 失败；registry 上的包与本地审过的包逐字节一致。Z.AI 的 Anthropic 兼容端点接受 `output_config.effort: low`，返回 200。宿主的发布校验、打包安装冒烟通过；真实浏览器配 glm-4.7 通过：第 1 轮拆出 4 个关键词，2 轮，8.7 秒，5 次调用，测试前后日用实例的只读快照 0 处差异。
- **浏览器测试的一处竞态，已修正**。无模型时的智能检索约 50 毫秒就返回，页面上的「正在检索」只闪现一下，测试在下一次轮询时已看不到，于是把一个本来正确的步骤判成超时。现在提交前在页面里挂一个观察器，记录加载状态是否出现过，不依赖轮询时机。
- **实测**（日用实例 5.5.9，MiniMax）：四个问题 1 个正常。

| 问题 | 结果 |
|---|---|
| ai-coding-workflow | 5 个要点，11.6 秒，无降级 |
| vector-hub | 2 个要点，但标为降级 |
| knowledge-engine | 降级，没有答案 |
| project-knowledge-base | 60 秒超时 |

形态记录给出了真实原因：MiniMax 把工具调用和结论放进同一个对象，或结论里个别字段不合要求。是形状问题，不是截断。每次调用的输出只有 100–250 Token，最低思考深度已经生效；文档多的问题每次调用约 10 秒。第 3 轮按「输出上限」修的部分只解决了其中一小部分。

### 第 4 轮：读取形状略有出入的结论（引擎 0.4.7，宿主 5.5.11）

- **处理**。规划回复的结论形状略有出入时取其中合规的部分，不再整份作废：列表最多留 6 项，条目过长则截短，不是字符串的条目、不存在的缺口代码和多出的字段略去。每个字段在使用处仍会再核对一遍，安全性不依赖这一层的严格。工具调用和结论放在同一个对象里时，还有轮次可用就按调用执行，收尾时取结论。没有任何结论字段、或一个调用都没有的回复仍然无效。被略去的数量记在 `budget.adjustedReplies`，同样不含内容。归纳要点比要求的更长、带了多余字段或引用了不存在的来源时，保留要点并截短、去掉无效引用。「深度检索时限」上限从 60 秒提到 120 秒，默认仍是 60 秒；页面输入、宿主校验、宿主代理和页面等待四处一致，由一个测试钉在一起。原生上下文路径的时限链路未改。
- **验收**。引擎全量 334 项：331 通过、3 跳过、0 失败；CI 通过；registry 上的包与本地审过的包逐字节一致。

- **实测**（日用实例 5.5.11，MiniMax，两轮共 8 次运行）：全部是智能检索、无降级。

| 问题 | 第 1 轮 | 第 2 轮 |
|---|---|---|
| vector-hub | 3 个要点，14.1 秒：`resultLevel` 及其默认值、`perProjectLimit`、`maxResults` | 0 个要点，24.9 秒：没读到写参数的那条提交记录，归纳如实回答来源不足 |
| project-knowledge-base | 6 个要点，52.9 秒 | 5 个要点，23.8 秒 |
| ai-coding-workflow | 6 个要点，24.8 秒 | 6 个要点，15.8 秒 |
| knowledge-engine | 0 个要点，如实说明没有定义 `injectionPolicy`，13.8 秒 | 同上，13.8 秒 |

两处残留：三次结果带着「部分候选证据已变化或不可读」，实际是模型引用了从未发出的编号；vector-hub 的答案取决于规划器是否读到写参数的那条提交记录。由此有第 5 轮。

### 第 5 轮：引用与没读的命中（引擎 0.4.8，宿主 5.5.12）

- **处理**。引用了只在目录里出现的文档时，归纳前先读出来。引用了从未发出的编号时直接略去，不再提示证据有变；只有读过、随后发生变化的证据才这样提示。规划器收尾时还想再查一轮，或结论里带缺口时，各轮搜到却没读的文档以命中处的摘录一并交给归纳，至多三篇，精确命中优先；答案引用到的才列入来源。读够了、也没报缺口时行为不变。最初是无条件把这些文档加进来源，被三个既有用例拦下：它们会在规划器读够时也带进多余的来源。
- **验收**。引擎全量 337 项：334 通过、3 跳过、0 失败；CI 通过；registry 上的包与本地审过的包逐字节一致。宿主 CI 六个作业一次通过；CI 候选包与本地打包 139 个文件，128 个逐字节一致，11 个只有换行符差异。
- **实测**（日用实例 5.5.12，MiniMax，两轮共 8 次运行）：全部是智能检索、无降级，耗时 8.3–25.1 秒，「证据已变化」的提示不再出现。

| 问题 | 第 1 轮 | 第 2 轮 |
|---|---|---|
| vector-hub | 3 个要点，15.8 秒，状态「已找到相关背景」 | 2 个要点，18.4 秒 |
| project-knowledge-base | 5 个要点，21.6 秒，状态「已找到相关背景」 | 4 个要点，24.2 秒 |
| ai-coding-workflow | 6 个要点，25.1 秒 | 6 个要点，10.1 秒 |
| knowledge-engine | 4 个要点，11.4 秒，说明知识库记录的是相关的 `injectionKind` 及其默认值 | 0 个要点，如实回答来源不足，8.3 秒 |

- **真实页面**。在日用实例的检索页上用 MiniMax 走了一次，项目 ai-coding-workflow：状态行「智能检索 · 证据不完整 · 3 轮 · 15.4 秒 · 向量+词法」，第 1 轮拆出 4 个关键词命中 14 篇，第 2 轮读取 4 段，第 3 轮用新发现的名字再搜并读取 2 段；回答 6 个要点各带引用，点开引用打开 `modules/maintenance-plan-model-selection.md` 原文。截图在 `release-5.5.8-20261128/review/live-browser-minimax-5.5.12.png`。
- **GLM 回归**。同一份宿主代码在隔离实例里用真实浏览器配 glm-4.7 通过：智能检索，两个参数值都带引用，6.9 秒，5 次调用。
- **日用实例**。三次升级各中断约 2–3 分钟，每次先按数据目录停止、备份数据，再从官方 registry 安装、启动。升级前后配置文件的哈希一致，变化的只有进程号和启动时间。

### 与最初方案的差异

| 项 | 方案 | 实际 | 原因 |
|---|---|---|---|
| 模型调用上限 | 5 不变 | 最多 7 | 一轮花在重复读取，或收尾回复重问一次时各多一次 |
| 发布范围 | 不推送、不发布 | 发布到 `next`，升级日用实例 | 用户授权 |
| 深度检索时限上限 | 不变 | 60 秒提到 120 秒，默认不变 | 先思考再回答的模型在 60 秒内读不完文档多的问题 |
| 回复解析 | 有一点不合规即作废 | 取其中合规的部分 | MiniMax 的结论形状稳定地略有出入；每个字段在使用处另有核对 |
| Workflow 固定 | 不涉及 | 宿主 5.5.9 固定 0.4.6 | 另一项工作已把它装在日用实例上，升级时不把它退回 |
| 没读的命中文档 | 不涉及 | 规划器报缺口时以摘录交给归纳，引用到才列入来源 | 答案不再只取决于规划器挑读了哪几篇 |

### 两个会话并行发布时遇到的情况

- **版本号**。另一会话提交了宿主 5.5.8 和 5.5.10，本线用 5.5.9、5.5.11 和 5.5.12。截至本记录，registry 的 `next` 依次是 5.5.8、5.5.9、5.5.11、5.5.12，没有 5.5.10：另一会话为它起的发布运行在核对候选包那一步失败。因为共用一棵代码树，后一个版本总包含此前提交的全部内容，5.5.11 和 5.5.12 都带着 5.5.10 的改动。
- **日用实例被重启两次**。另一会话在 22:05 和 23:00 就地安装 Workflow 构建并重启。升级到 5.5.9 之前，先把它就地安装的 0.4.8（当时尚未发布）留存一份，装好 5.5.9 后原样放回，25 个文件逐一核对哈希，依赖声明与已发布的 0.4.6 一致。
- **CI 互相取消**。宿主 CI 对同一分支只保留最新一次运行，一次推送会取消上一次仍在运行的 CI。本线的一次推送取消了另一会话 5.5.10 提交的 CI；它随后自己重新触发并通过。此后推送前先确认没有别的运行在进行。
- **按分支触发的运行不说明它构建了什么**。另一个会话为它的 5.5.10 起的两次发布运行，记录的提交是本线刚推上去的 5.5.11。发布脚本原先按运行记录的提交找自己的候选包，会把别人的构建当成自己的，只靠后面的逐文件比对拦住。现在按候选包回执里的来源提交来认。
- **一次偶发的 CI 失败**。宿主 5.5.11 的 CI 在 Node 22 上因 `ai-team-page-registration-test.js` 等待注册表单超时而失败；同一提交在其他作业和此前两次运行都通过，只重跑失败的作业后通过。
- **一个读错的快照**。在隔离环境的 shell 里抓日用实例的快照，读到的是隔离目录，一度显示配置文件和启动时间都变了。在正常环境里重抓，与升级前相比只有进程号和启动时间不同。

### 限制

- 没有看到过 MiniMax 回复的原文，按设计日志不记内容。判断依据是不含内容的形态记录。
- 国际站文档 platform.minimax.io 从本机连接超时，依据的是国内站文档；`api.minimaxi.com` 接受 `output_config.effort: low` 是实测结论。
- glm-4.7 的答案各次运行有波动。vector-hub 的 `perProjectLimit` 默认值仍未找出。
- 效果范围是本机日用实例上的四个真实项目和合成夹具。M3 的三项阻塞不变。
