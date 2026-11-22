# 数据目录迁移后的维护恢复计划

GLM 接手此任务时，先在隔离实例复现旧路径错误，再实现修复并交付回归证据。目标是让搬迁前创建的维护任务在新数据目录下使用原来的冻结证据继续运行，并修复其他会在重启或重试时读到旧路径的入口。

## 现场和完成条件

当前实例为 Project Knowledge 5.1.3 和 knowledge-engine 0.3.1。提交 `23b0b4b7` 于 11 月 13 日首次分析超时。11 月 19 日重试时，任务快照仍指向 `~/.project-knowledge-v5`，而数据已搬到 `~/.project-knowledge`。按快照里的旧路径校验，打开 `patch-manifest.json` 会得到 `ENOENT`。按新目录校验，同一证据包的补丁与清单哈希均匹配。冻结的检索清单也有相同的路径问题。该记录为 `data-failed`，`nextRetryAt` 为空。当时同项目有 26 条后续提交处于 `waiting-previous`。

验收时，由旧版生成的失败任务在改名后的数据目录中，通过原来的「重试失败阶段」入口使用同一个分析 run 和同一份证据完成维护，后续任务按顺序继续。真正缺失、损坏或越界的文件仍应阻止维护，并在界面显示实际原因和恢复状态。

## 1. 修复知识引擎的冻结输入定位

在独立的 `knowledge-engine` 源码仓库实施。入口是 `src/runtime/commit-reconciler.js` 的 `prepareClaim`，涉及 `src/runtime/{layout,scanner,evidence-bundle,commit-prompt}.js` 和 `src/headless-analyzer.js`。

1. **从已校验的项目 ID 和分析 run ID 重算当前路径。** 当前根目录取运行中的 `RuntimeLayout`。使用活跃 claim 的 `claim.runId`，它对应活动记录的 `analysisRunId`。证据根为 `<engineDataDir>/runtime/runs/<projectId>/<claim.runId>/input/evidence`，其中有 `commit.json`、`patch-manifest.json` 和 `patches/`。检索清单为同一 run 的 `input/retrieval/manifest.json`。首次准备、失败重试和恢复使用同一套构造规则。校验路径段、普通文件类型及真实路径边界，覆盖父目录上的符号链接和 Windows junction。旧目录即使存在，也由当前实例的目录决定实际读取位置。
2. **兼容原有任务，新增记录只持久化定位所需的 ID。** 读取旧 `commit-claim-snapshot/v1` 时先完成原有身份和哈希检查，把快照里的绝对路径视为历史信息，再为本次执行构造新的内存对象。保留旧快照文件。新快照格式增加明确的版本并双读，记录可和活跃 claim 互证的 run ID 及原有校验元数据，路径在运行时派生。保持公开 run API、现有证据哈希算法和历史记录可读。
3. **验证同一份历史证据。** 对新目录的清单、提交元数据和补丁分片做现有完整校验，再把 `commit.json` 中的提交 SHA 和磁盘上的清单哈希与 claim 对比。读取新目录检索清单，继续核对清单哈希及冻结知识片段哈希。保留提交 SHA、冻结对话、原始提示及其哈希。缺文件、哈希不符、项目或 run 不匹配和真实路径越界应各有可定位的错误类别。沿现有日志和 API 的错误结构传递资源类型与失败原因。
4. **给大补丁的分析进程交付可读路径。** `commit-prompt.js` 的分片分支会把 `patchManifestPath` 写入提示。新提示使用相对证据根的文件名。旧提示先按原字节验哈希并保留在冻结证据区，随后在执行合同中明确给出当前清单的绝对路径，指定分析进程从该处读取分片。旧提示中的定位只作为历史证据。工具权限与合同使用同一当前证据根，写权限维持在本次 staging。验收要覆盖分析进程真实读取清单和分片，并核对交付给分析进程的实际清单路径。

主仓库的 `_site/lib/{storage-layout,commit-reconciler,scanner,evidence-bundle,commit-prompt,knowledge-promotion}.js` 还有 legacy 执行路径。对仍受支持的重试与恢复按同一规则修复，并保持 legacy 的孤立 claim 恢复语义。正常运行的产品通过 npm 引用知识引擎，源码改动和发布产物归属各自仓库。

## 2. 修复晋升中断后的恢复

`knowledge-engine/src/runtime/knowledge-promotion.js` 的 `prepareJournal` 把绝对 `backupPath` 写入晋升日志。`rollbackJournal` 会在重启后直接读取它。只改 claim 的定位会漏掉这个入口。

- 恢复时根据已校验的项目 ID、分析 run ID 和操作原顺序，从当前 `layout.getRecoveryPath('promotions', …)` 定位备份。将日志中的知识相对路径解析到**当前已登记且和日志身份匹配的知识目录**。新增日志保存相对引用或序号，读取现有 `promotion-journal/v1` 时兼容原字段。
- 回滚写入前完成必要备份和目标的预检，核对备份内容与 `originalHash`，检查目标是否仍是该次晋升写入的版本。路径、目标用户改动或备份损坏导致的冲突应保留现场，并进入可诊断的恢复状态。已完成一部分回滚时，按目标哈希和操作状态识别已恢复项，允许安全重复进入。
- 用现有写锁与原子写。验证「部分应用后回滚」和「全部应用但游标尚未推进」两条路径。后者验证已晋升文件后推进原状态，同一 run 只晋升一次。完成记录和索引阶段保持原有恢复方式。

## 3. 修复其他模块的同类入口

| 入口与源码 | 已确认的路径用途 | 实现与验收 |
| --- | --- | --- |
| 主包受管 Git Hook、客户端 Hook 和 MCP。 `_site/lib/{hook-manager,server-app,capture-hook-config,integration-installer}.js`、`_site/scripts/hook-trigger.js` | 受管 Git Hook 写入 `--data-dir`、`--bridge-home` 和启动文件路径。引擎模式启动已有 v2 Hook 重装逻辑，`9b92fa6` 已处理已知旧默认客户端接线。legacy 的「已迁移」标记可能跳过路径核对。通知在端点缺失时会回落到默认端口。 | 复用安装和修复入口，验证受管 Hook 是否绑定当前实例并回读验证。验证旧 v2 Hook、显式 `--data`、启动器换位置与带空格路径。验证过期绑定不会在旧目录建新日志或通知另一实例，正常离线的有效绑定仍可落盘，恢复后只消费一次。遇到第三方 Hook 或另一实例的绑定时报告冲突并保留原文件。 |
| Event Bridge。 `ai-coding-event-bridge/packages/console/src/bridge/core/{project-registry,journal-router}.js`，以及 `packages/console/src/server.js` | `addProject` 会把默认的 `<bridgeHome>/projects/<name>` 写成绝对 `store`。事件路由、消费以及 commit seal 都从该字段派生路径。主包通常显式登记 `<knowledgePath>/dev-conversations`，本机该登记目前指向独立知识目录。 | 给默认受管 store 持久化相对于 Bridge home 的定位，保留 API 返回的有效路径。旧版记录只在能确认旧受管 home、精确目录布局以及新目录已有原 journal 时重定位。已知旧默认 home 可用这条迁移规则，自定义的旧 home 需要明确来源映射。旧新版注册可共存。所有读取和写入入口复用同一解析规则，保持项目 ID、journal ID、事件序号与消费水位。歧义或缺失时报告冲突，避免在旧址新建空 journal。显式外部 store 继续按原登记处理。 |
| vector-hub。 `vector-hub/src/server/{manager,server}.ts`、`src/core/kb-sync.ts`、主包 `_site/lib/module-bridge.js` | `sourceDir` 登记以及文档 URI 使用绝对路径，`indexIdentity` 包含索引根。根迁移触发重建时，重建会复用保存的 `sourceDir`。本机这里的源目录不在改名的应用目录内。 | 托管模式先以主包的有效项目和共享知识绑定核对源，再允许路径变更后的同步或重建。在原项目名下更新确实需要更新的登记，复用现有写锁和索引重建；源缺失或绑定冲突时保留旧索引并报告原因。测试「只搬索引根」和「权威源地址经受控更新」两种情况。验证当前路径下的检索命中，同时保留既有模型／索引身份隔离。 |
| Workbench 与 AI Coding Workflow | 已核对 Workbench 的附件以文件名、会话以当前 Workbench 数据根定位，`storeId` 由磁盘中的 ID 文件提供。Workflow 从当前 `--data` 推导 `workflow/state.json`，任务中的 `repoPath` 是外部工作区绑定。 | 做集成迁移冒烟，覆盖已有会话、附件、任务和审查记录。若发现受管路径被持久化后用于重新打开文件，提交对应回归和局部修复。保留用户指定的代码库、知识库、共享知识、原生会话和外部模块目录。 |

实现时复查各模块的持久化写入及重启读取调用，尤其是名称含 `Path`、`Dir`、`root`、`store`、`uri` 的字段。用「是否由模块在自己的数据根下创建、之后是否被用于实际文件操作」判断是否属于迁移修复。运行时控制端点按既有实例身份校验，显式配置继续由原配置入口管理。

## 4. 让状态显示与实际恢复行为一致

- `ui/product.js` 的 `recoveryLabel` 让 `data-failed` 落进了「自动恢复中」。首页待办、活动明细及筛选使用同一判断。数据错误、无待执行恢复或耗尽预算时显示「需要处理」，配置问题显示「等待配置」。已有下一次恢复安排才显示自动恢复和下次时间。与 `knowledge-engine/src/{coordinator,retry-scheduler}.js` 的调度状态对齐，保留索引阶段的独立恢复。
- `recovery.attempts` 是本轮计数，手动重试会重置。若展示次数，标明「本轮」。重试 API 接单后提示「已提交重试」，最终结果由运行状态反馈。证据错误在详情里显示具体资源和原因，沿用真正的失败 run。UI 测试覆盖无下一次重试的 `data-failed`，以及仍有下一次重试的暂时性失败。

## 5. 测试与验收

先用旧版在隔离目录 A 生成**真实格式**的 claim、证据、日志和模块数据，模拟一次分析超时。停止该测试实例，将完整测试数据目录移到 B，确认 A 不存在。从 B 启动修复版并通过 `POST /api/engine/runs/:runId/retry` 重试。另做一次 B 启动时 A 还存在的测试，在 A 留下不同内容，以证明读的是 B。测试路径含空格，Windows 与 Linux 均覆盖。

| 场景 | 验收证据 |
| --- | --- |
| 改名后重试小补丁与分片补丁 | 同一提交、run、分析 run、补丁清单、对话和检索哈希。分析进程从新目录实际读取证据，最终晋升与索引完成，各只执行一次。下一条排队提交继续运行。 |
| 缺清单、缺分片、哈希不符、跨 run、越界链接 | 受控失败，日志能定位资源和类别。无知识写入、无处理水位推进，无不实的恢复状态。 |
| 新格式再次搬迁、历史未搬迁、显式旧路径仍为有效配置 | 三种情况均可读取和重试。重启与重复点击沿用同一任务，已完成提交保持去重。 |
| 晋升故障注入后改名 | 部分应用回滚使用新目录的正确备份。全部应用后恢复只推进状态。篡改备份或用户改过目标时报告冲突。 |
| Hook、Event Bridge、vector-hub、Workbench、Workflow | Hook 产生一次事件，Bridge 读取原 journal 并从原水位继续，向量索引能同步和检索，原有会话、附件、团队任务可读取。显式外部路径的夹具保持原绑定。 |
| 产品 UI | 「需要处理」「自动恢复中」「等待配置」及筛选结果一致。点击原任务进入准确的 run。索引待修复用例保持只重试索引。 |

引擎复用 `test/layout.test.js`、`test/frozen-live-development.test.js`、`test/maintenance-status.test.js` 和 `test/ui-retry.test.js` 所用的测试设施。主包复用 `_site/_test/` 下的 `knowledge-promotion-recovery-test.js`、`orphaned-claim-recovery-test.js`、`hook-status-repair-api-test.js`、`capture-hook-dedup-test.js`、`qa-r45-offline-backfill-test.js` 和 `parallel-nav-home-issues-test.js`。提交能捕获本故障的新测试及所需的合成夹具。提供候选 npm 包集成结果，验证依赖版本、合成数据迁移前后摘要、模块健康和实际读取路径。

## 6. 执行约束与本机恢复

按各仓库的 `AGENTS.md` 在 `main` 实施。测试使用单独的安装前缀、数据／知识目录、模块状态、HOME、浏览器配置和端口。对测试启停显式指定测试数据目录，前后只读核对日常实例及各模块的进程、监听端口和健康状态，清理时只操作本次测试创建且已验证归属的进程。真实数据留在日常实例，回归使用合成数据。

GLM 交付源码改动、可复验测试结果和本地候选包。主项目继续使用精确固定的 npm 模块版本。需要发布的模块及主包等用户明确授权后，再按既有流程更新依赖、锁文件和运行时清单。日常实例升级和重启同样由用户单独授权。

批准应用修复后，确认实例使用 `~/.project-knowledge`，在活动记录中对 `23b0b4b7` 点击一次「重试失败阶段」。核对它使用原分析 run 进入分析，随后完成晋升和索引，并观察后续队列推进。若出现新的模型或索引故障，按实际错误定位该阶段。已有快照、日志与知识文件用作核查依据。
