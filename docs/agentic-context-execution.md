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
