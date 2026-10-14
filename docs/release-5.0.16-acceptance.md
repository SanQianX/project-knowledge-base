# 5.0.16 修复与验收记录

## 当前结论

2026-10-14 开始执行本轮计划。状态：**实施中，未完成系统验收，不更新 latest**。

运行基线：知识库 `5.0.16-rc.1`、Workbench `0.13.2-rc.10`、vendored 引擎 `0.2.7-rc.5`。发布 stable 标签仍为 `5.0.14`。

候选 `5.0.16-rc.2`（`21f67dc`）已发布 `next`，锁定 Workbench rc.11、引擎 rc.6、vector-hub rc.5。独立验收发现 vector-hub 公开 ESM 入口不能加载，因此本候选不能通过全部门禁，待修复后推进下一候选；本机仍运行 rc.1。

候选 `5.0.16-rc.3`（`fb6dd299`）已发布 `next` 并通过官方下载与内容核对（收据 `kb-registry-product-wCnOJ2/registry-installation.json`；本轮验收报告一律绑定该官方安装身份，旧的同名 rc3 报告不计入本轮）。模块：Workbench `0.13.2-rc.11`、引擎 `0.2.7-rc.6`、vector-hub `1.0.8-rc.7`、bridge `0.7.2`。真实 fixture 多数门禁已通过，但两次真实向量性能复测失败（见下）；本机仍运行 rc.1，latest 仍为 `5.0.14`，未完成系统验收。

基线源码：外壳 `669f9ea`，引擎 `41726f5`。用户已有 desktop、原型和其他未提交文件不属于本轮。

## 已有真实结果

- `8ce45df8` 的公开重试已晋升、索引成功；此次重新调用了分析模型，不能宣称复用原分析。引擎的向量片段确认仍待修复验收。
- Leader 直连已安装 MCP Node 入口，在约 555ms 完成 initialize，并列出六个工具、解析当前注册项目。此结果不等于 Codex 原生接入通过。
- A1 复现旧 npx 启动约 1380ms 后因缓存缺 `package.json` 而退出，没有 initialize 回应。用户缓存未被手工清理。
- Leader 重跑 Workbench：Node 22、24 各 299 项通过；vector-hub：两版本各 53 项通过。仅属于当前源码回归，不代表后续候选包通过。
- 向量片段修复 `4aa4d49` 的真实 embedding 固定留出集复测：Recall@5 为 1、MRR 为 0.9667、无答案准确率为 1，报告 `retrieval-quality/real-vector-1791946256519.json`。这是源码与合成标注语料结果，不能替代候选包及另一台电脑私有语料验收。
- 同一源码真实向量性能复测：8 项目、1000 文档，热查询 P95 为 1435ms（此前约 1074ms），低于 3000ms 门禁但约慢 34%；报告 `retrieval-quality/performance-1791955352489.json`。不将文本降级冒称向量性能。
- 外壳首次新回归为 62 通过、66 失败；主源码依赖目录在带 `node_modules` 联接的临时工作树清理后为空。首失败 `plan16-shell-a2-source22-1791955290273.json` 保留，按锁文件恢复依赖后必须重新串行回归，不能计为通过。实际全局安装版与用户 v5 知识未被该清理针对。
- 原锁文件 `npm ci` 恢复 309 个依赖，未改锁文件；复测 Node 22 为 127/128 通过，`release-version-sync-test` 仍断言旧 npx 参数（新本地启动契约尚未补覆盖）。另以合成标记证实 `PROBE_CRASH` 兜底直接回显异常文本，待脱敏回归，未用真实秘密参与测试。
- 外壳修复 `0f2310f` 已推送，当前安装版 rc.1 的真实 Hook 自动分析、晋升、索引完成：12,833 字节变化文档、39 条该文档的非空 1536 维向量，存于 D 盘 `.indexes`。Leader 已检索到变化文档及模块说明，引用匹配该 commit；证据 `glm-plan-5.0.16/root-0f2310f-real-maintenance.json`。这是当前运行版闭环，不是下一候选包或原生客户端二次开发验收。
- 事件桥首轮两版本各失败两个用例：Leader 把临时目录放入 Git 工作树，使普通目录继承父仓库身份。保留首失败，改用 D 盘仓库外测试目录；Node 24、22 串行复测各 30 个文件通过，未修改产品行为或测试断言。
- Leader 在旧安装版 Workbench `event-stream` 复现长会话重连失败：旧游标为 5、压缩后回放两条，再产生一条新消息，实际送达为 0 而应为 1。修复 `840b787` 保留事件高水位，增加不占序号的 resync 控制消息，并持久化旧历史转换边界；源码及独立 npm 模块验证已通过，当前运行实例尚未升级。
- Workbench `0.13.2-rc.11`（`ac450b0`）已发布 `next`。Leader 完整回归 Node 22、24 各 352/352；官方独立 prefix 下载的 96 个发布文件与源码逐字节一致，integrity、gitHead、包内 HTTP/UI 与恢复测试通过。引擎 `0.2.7-rc.6` 的 40 个发布文件同样通过两版本独立下载验证。
- 验收脚本修复 `88d5a44` 已提交并推送：Node 版本取实际子进程，源码和官方安装身份强制绑定，原型及无关桌面修改不计为运行时变化。引擎含验收脚本回归 Node 22、24 各 144/144；这项不改变已发布 rc.6 的运行文件。
- vector-hub 原 rc.4 发布内容正确，但 npm gitHead 指向旧提交。版本修正 `52d7123` 已推送并发布 `1.0.8-rc.5` 至 `next`，Leader 两版本各 53 项通过；独立下载身份核对完成，不放宽提交身份检查。
- rc.5 官方下载的 59 文件、tarball SHA512、lock integrity 与 `52d7123` 一致；两版本 CJS、网页与 HTTP 查询通过，但原生 `import('@sanqianx/vector-hub')` 均 `ERR_MODULE_NOT_FOUND`。Leader 独立复现缺少相对说明符扩展名。V2 正在补构建和 exports 防回归，不能因网页使用 CJS 而把 ESM 失败计为通过。
- V2 修复 `e66c0d9` 已提交、推送并发布 vector-hub `1.0.8-rc.6` 至 `next`：构建后用现有 TypeScript AST 仅补真实模块引用的扩展名，保留 CJS、普通字符串、注释及已有扩展名。测试强制从当前源码重新构建；Leader 两版本各 58 项通过。统一包 rc.3 准备中，rc.6 官方下载门禁仍待执行。
- rc.6 官方包深验收发现两个后续失败：原生 ESM 调用 `createServer` 报 `__dirname is not defined`；从无关 cwd 启动的 CJS/ESM 服务读取 vendor 路径错误，两个 Node 版本各 10/11 通过。当前用户 5757 的同一资源也实测 404。V3 修复 `c27066d`（候选 rc.7）使真实 HTTP 服务在两种模块格式中使用本模块路径，并让 HTML 与 vendor 使用同一个已选目录；Leader 两版本各 64 项通过，包含无关 cwd 和显式 uiPath 的实际 HTTP/字节检查。首次发布遇 ECONNRESET，核对 registry 后重试，未计为发布成功。
- 官方 registry 随后确认 rc.7 已收到发布，完整 gitHead、integrity 与 `c27066d` 匹配，next 指向 rc.7；两次客户端 ECONNRESET 不再被误认为未发布。Windows 已启用本地代理而 npm 未配置代理，后续验收命令显式使用现有代理，不修改全局设置。rc.3 草稿已锁定 rc.7，模块清单与官方 tarball 双向逐字节核对 96/96、59/59、38/38；补齐 rc.2 清单漏列的 Workbench agent-spawn-env.js（包本身含该文件）。冻结后的源码及完整 npm 版验收待执行。
- rc.2 外壳 Node 24 为 137/137。Node 22 两轮各 136/137，打包浏览器用例超出默认 90 秒；单测实测 103 秒，以显式 `PK_TEST_TIMEOUT_MS=240000` 重跑后 137/137。原失败保留，浏览器就绪等待仍为 20 秒；npm 下载耗时不作为 UI 性能通过证据。首轮官方整包验收读到旧 next 标签，传播后已重新下载。
- rc.2 整包第二次官方下载失败于 `statuses-2.0.2.tgz` 的 `ECONNRESET`（TLS 建立前连接断开），并有 npm 清理其自身安装前缀的 EPERM 警告。收据 `system-regression/retrieval-rc2-registry24-1791974599954.json` 判失败；没有安装完成证明，没有升级本机。后续用已下载的官方缓存重新验证下一候选，不借本地源码运行。
- E1 末尾使用原生 Edit 给 Claude 用户记忆追加了一句网络测试说明，超出限定范围。核对时会话已经 idle；Leader 仅通过补丁撤回该句，保留原内容，未中断其他会话。后续派发明确禁止编辑用户 memory，并继续审核实际文件操作。
- GLM 首批新增测试使用原生 `Write`，不符合派发的补丁工具约束。Leader 显式中止两轮，保留文件和会话，并提供本机已有补丁工具路径；原会话续跑均收到 accepted 回执。此中止属于流程纠正，不是 runtime-timeout，也没有重启知识库或修改默认模型。
- A1 测试因继承 `KB_DATA_DIR` 在用户 Workbench 数据目录误建一份 237 字节运行绑定。Leader 核对字段、创建时间、无链接及安装版不存在启动器后，只将该测试文件可恢复移动到 `glm-plan-5.0.16/A1/unintended-user-binding.json`，前后 SHA256 相同；知识、历史、凭据与客户端配置未改。A2 必须覆盖测试环境隔离与只读状态检查。
- rc.3 官方下载整包核对通过（`retrieval-rc3-registry24-1791981966597`）；源码回归通过：外壳 Node 22、24 各 137/137，引擎各 155/155，vector-hub 各 64/64。绑定官方收据的安装版网页、故障、生命周期在 Node 22/24 通过；Workbench、UI/CLI/MCP 知识面、真实 1536 维索引、真实单提交与并发提交在 Node 24 通过。
- rc.3 绑定收据的固定留出集真实质量复测：Recall@5 为 1、MRR 0.9667、无答案准确率 1（`retrieval-quality/real-vector-1791982365924.json`，合成标注语料加真实 embedding）。
- 二次开发原任务：首失败 `retrieval-rc3-secondary24-1791983777400` 保留（验收解析器漏识中文“提交”引用标签，Agent 源实际引用真实条目与完整 SHA）。测试修复 `8297c6a` 仅改测试文件、对齐中英文引用标签且不放宽门禁；原任务 resume 通过：`retrieval-rc3-secondary24-1791985519158`，受控 fixture 提交 `1085ccde`，真实 Hook→分析→晋升（run-5d7d0ab0）→1536 索引→查询闭环，引用 `changes/6d195ab0b282.md`（commit `6d195ab0b282adf239aafe751b83bb0716864a65`），预编辑检索序 29→32、62→65、86→89。
- rc.3 两次真实向量性能复测失败，待 P2 修复：热查询 P95 分别为 3068ms（`retrieval-quality/performance-1791982533367.json`）与 4829ms（`retrieval-quality/performance-1791983510836.json`），超 3000ms 门禁；不得以文本降级冒称向量性能。
- P2 修复已发布 `next`：引擎 0.2.7-rc.7（`61e5205c8c7a37645fa2be8c9e3cb2d3c250cc31`）提供同一请求内读复用；vector-hub `1.0.8-rc.8`（`ebf6f586a534c4b851c919c53a5536671cc8bd12`）提供 10 分钟有界缓存与 promise 身份守卫。按红绿记录先复现失败再修复；两者 registry 完整 gitHead 与 integrity 均已独立核对通过。
- P2 源码回归（Leader，Node 22 与 24）：引擎各 161 项通过、1 项符号链接跳过；vector-hub 各 73 项全部通过。同源码真实向量热查询 P95 复测为 1069ms，低于 3000ms 门禁；这是源码结果，不是 rc.4 安装版验收通过。
- 候选 `5.0.16-rc.4` 已完成本地准备：vendored 引擎 rc.7 40 文件（sourceCommit `61e5205`）、vector-hub 精确锁 rc.8、Workbench `0.13.2-rc.11` 与 bridge `0.7.2` 不变；模块清单 96/59/38/40 与官方 tarball 双向逐字节一致，工作树模式 release:verify 链（sync --check --web-only、runtime --working-tree、product、integration-adapters）全部通过。rc.4 发布、latest 与冻结后源码全量验收待 Leader 执行；本机仍运行 rc.1。

## 执行与待验收矩阵

| 项目 | 状态 |
|---|---|
| A1–A3：本地 MCP 入口、版本升级、独立启动/信任诊断 | A3 已交付探测脱敏、入口 realpath 校验、两终端分支知识根目录接线及发布同步契约；Leader Node 22、24 独立完整各 137/137（含桌面浏览器）通过。原生客户端仍待新包验收 |
| B1–B5：向量范围候选、位置和占位校验 | 向量修复 `4aa4d49`、占位修复 `0218d55` 已提交并推送，引擎 `0.2.7-rc.6`（`bbb5ddd`）已发布 npm `next`；Leader 源码两版本各 118 项通过，独立 registry 下载的 40 文件逐字节与 integrity 校验、两版本启动及原 532 staging 只读校验通过。首次下载未可见失败保留；532 当前已成功，不再重试 |
| `5c07a801` 重试与后续 FIFO | `5c07` 与 `7506` 已晋升、索引成功；`532d` 首次因合法 UI placeholder 术语误判失败（事实保留）。只读 live API 现显示完整 run `run-bb64179b-646e-4f15-beff-7b70e078293e` 已 succeeded/ready（promotedAt 2026-10-14T11:48:46.084Z、finishedAt 11:49:13.303Z）：不得对已成功 run 再次重试，任何操作必须用完整 run ID。另有 6 个 index-pending run，对应 commit `fb6dd299`、`c27066d`、`f9a736c`、`21f67dc`、`0218d55`、`4aa4d49`；公开错误详情均为向量上游 HTTP 500 / embedding fetch failed，尚未确定底层网络原因。后续只重试索引并核对晋升文件及分析调用不变 |
| Claude/Codex/ZCode 原生知识与记忆送达 | 待新包实测；OpenCode 仅验证既有兼容能力 |
| 固定留出集质量、真实向量性能 | rc.3 官方收据质量通过（Recall@5=1、MRR 0.9667）；性能首失败 3068ms、4829ms 保留。P2 源码复测 1069ms 通过，rc.4 安装版待验收 |
| Workbench 长历史压缩后的游标、增量与重连 | C5 已修复转换落盘后二次恢复遗失旧边界。Leader Node 22、24 完整各 352/352；rc.11 独立下载验证通过。保留 C3 临时文件锁首失败、C4 的 340 项部分回归及后续 343 项完整重跑；整产品浏览器实际刷新待验收 |
| Workbench 开发 Agent 的知识库数据根目录 | C2 已交付四客户端 spawn 环境映射，Leader 在 Node 22、24 独立各 8/8（`plan16-workbench-c2-leader*`）；相关完整回归存在 EPERM 首失败，真实安装版仍待验收。外壳传根目录接线已纳入 A3；GLM 提及的 C2 独立证据目录未定位到，不以其口头路径作为通过证据 |
| 网页、并发、故障、重启与二次开发闭环 | rc.3 官方收据绑定下网页、故障、生命周期、Workbench、真实单/并发提交通过；二次开发原任务 resume 通过（首失败为验收解析器缺陷，已按 TDD 修复）；性能两次失败另列 |
| 官方 npm 候选下载及现有 v5 保真升级 | 待新候选 |
| 升级与汇总脚本的版本门禁 | D3 强制官方 identity、源码提交/引擎 40 文件绑定，支持正式包先验收 next 再更新 latest。Leader Node 22、24 各 144/144；保留 D1/D2 误判首失败，实际升级和汇总待执行 |
| 原插件 MCP 验收脚本 | `f9a736c` 修复真实 manifest、环境透传、同版本定义核对、引用元数据及固定错误码。Leader 引擎全量 Node 22、24 各 155/155；实际客户端仍缺当前 rc.1 插件，报告 PLUGIN_MANIFEST_MISSING，不计为原生接入通过 |
| 正式包下载、latest、日常更新与远程 Git | 待全部核心门禁通过 |
| GLM 协作手册与恢复会话实测 | 文档初稿已建立，待后续操作校验 |

## 证据与限制

本机证据根为 `D:/SanQian.Xu/knowledge-engine/.agent-state/acceptance/`。本轮任务记录在 `glm-plan-5.0.16/`，独立测试收据在 `system-regression/plan16-*`；文件中不包含模型凭据。

发布判断必须绑定准确版本、模块身份、integrity 和源码提交；不能用旧版本成功报告代替新包。首次失败与后续复测分别保留，不改写为全绿。

另一台电脑与私有语料尚无本轮验收证据。只做网页与正常桌面视口，不包含 Electron、窄屏矩阵或 Windows 安装包。
