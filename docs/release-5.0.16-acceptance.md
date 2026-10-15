# 5.0.16 修复与验收记录

## 当前结论

正式 `5.0.16` 已通过官方独立下载、30/30 核心门禁、真实二次开发闭环、本机保留数据升级及日常 latest 重装。npm 的 latest 与 next 均为 5.0.16，本机也运行正式 npm 包；保留候选与正式包首失败，不用候选通过冒充正式通过。

### 正式包验收

官方收据：`kb-registry-product-9bwo5b/registry-installation.json`，sourceCommit `3a2740b6467b8d26fa05cb494c85e396132b136b`。主包 integrity 为 `sha512-VztZ6sJAg6Th0B+Rn4prfjfIfyG6JxNFe/sEUIe2++xI5niP7+q1icqWplLMf3R48Ix554PWh0yKc8e7TgET6g==`；精确模块版本与下方 rc.8 表一致。正式包与候选的收据、运行结果分别绑定，未将旧同名报告计入正式通过。

| 范围 | 正式包证据与结果 |
|---|---|
| 源码 | 冻结外壳 3a2740b 在 Node 22/24 各 139/139；引擎测试辅助代码最终 f1248a6 各 182 通过、1 项 Windows 符号链接权限跳过，40 个发布运行文件与 vendored 7c6812f 完全相同；其余模块使用精确版本、精确提交的源码回归 |
| 安装版与故障 | GLM-5.3 独立运行 Node 22/24 正常网页、一次 profiles 503 恢复、故障与生命周期八项，全部通过；测试替身仅用于确定性故障，不冒称真实模型 |
| 真模型十项 | `scoped-memories/run-1792038371463/report.json`，fixture fcKCDT，真实 MiniMax 候选提取、分级确认编辑、范围隔离、UI/API/CLI/MCP、流式、单提交与跨项目重叠、重启保真 10/10 |
| 质量与性能 | 20 条固定留出问题 Recall@5=1、MRR=0.9667、拒答准确率=1；8 项目/1000 文档热查询 P95=699.9054ms，四次真实查询 embedding，1536 维非空索引；复用付费文档向量，无重建冒充 |
| 原生送达 | Claude Code、ZCode 真实用户配置通过；Codex Hook 原生 trusted、MCP 实际 initialize 为 5.0.16，首次真实 MiniMax 请求含当前事实及已确认产品记忆；OpenCode 实际 CLI 检索与引用通过，不宣称自动前置注入 |
| 工作台 | 真实网页发送、增量流式、最终持久化和右侧引用通过；回答实际引用单写者英文原文及完整提交，不只验证 SHA。1920×1080 截图已人工核对 |
| 连续开发 | `retrieval-formal-live-development24-1792038616093.json`：分析期间再提交、保留未提交草稿、同项目 FIFO、三次真实自动维护与页面自动刷新通过 |
| 二次开发 | `retrieval-formal-secondary24-1792039028998.json`：原任务真实 search/get 先于 Write，代码及测试通过，随后真实 Hook、冻结对话、晋升、索引、再次检索通过；恢复验收未手工改写原任务文件、引用或事件 |
| 本机保真升级 | `retrieval-formal-user-upgrade24-1792039474426.json`，备份 `user-upgrade-1792039475645`；原 7 项目、知识、历史、配置和记忆保留，593 个索引文件字节不变，实际位置仍为 `D:\SanQian.Xu\knowledge\.indexes`；全局运行文件与官方收据逐文件相同 |
| 本机接线 | 正式全局安装后的公开接线操作 `op-69195d8fbbc84e49b54875134ed2727f` 四客户端完成；临时验收目录的市场来源及运行绑定已切回全局 npm 包，第三方 Hook、通知和用户原生信任保留 |
| 真实用户环境 | `retrieval-formal-user-native24-1792039600245.json`：在实际 knowledge-engine 仓库、实际用户插件下，未提醒检索的普通只读任务，其首次真实模型请求收到本项目知识；工作树不变，不以受控 fixture 代替此项 |
| 日常 latest 安装 | `retrieval-formal-user-latest24-1792039770873.json`，详细记录 `daily-latest-1792039770931/result.json`：真实 stop、npm 官方 @latest 全局安装、版本检查、启动、受管进程退出、四模块恢复、原有数据与 593 个索引文件保真、官方包逐字节核对均通过，耗时 62.4 秒 |

正式核心汇总为 `knowledge-engine/.agent-state/acceptance/system-regression/retrieval-release-5.0.16.json`。30/30 与本机升级、日常安装、真实用户补验分别记录，不互相冒充。最终交付回执为同目录 `retrieval-system-5.0.16-final.json`，还会核对本说明提交后的实际自动维护、知识文件、索引和再次检索，以及 daily 重启后的真实原生读取。

#### 正式阶段保留的首失败

- 离线插件案例首次复用 rc.8 的隔离市场目录，因与正式包来源路径不同被保护逻辑拒绝；改用本轮全新 fcKCDT 隔离目录后，真实 Claude CLI 在 GitHub 不通条件下安装与幂等检查通过。一次 Leader 手工补验误指旧 rc.5 fixture（1792038460071）不计正式证据，正确正式补验为 1792038543299。
- 二次开发首失败 1792038714956：实际 seq18 查询、21 成功返回、108/111 get 成功、139 才 Write；旧测试错误要求 SHA 查询必须带向量命中标签，且不能解析跨 `//` 注释换行的完整 SHA。结构化项目/来源/完整提交/匹配 tool-id/写前顺序校验及解析回归已补齐，文本事实不冒称向量成功。原任务同文件恢复后通过，未重造原成功记录。重复无活动子进程的 teardown 也有独立回归，不能借此放行真正被中断的任务。修复仅在测试辅助代码（3eb54b4、f1248a6），未改正式包运行文件；GLM 独立复核 10 项定向测试通过。
- 本机首次 npm 升级 1792039147807 失败为 Windows `EBUSY`：本会话独立 MCP 子进程持有全局包的 LanceDB 原生文件。只在校验精确命令路径、父进程及 DLL 后关闭本产品 MCP 子进程，未关闭 Codex 应用或无关 Node；旧包逐文件完整性通过后恢复旧服务，再重做受保护升级。冷启动时两次过早读取引擎 API 的失败也保留；重试前已等待四模块归属及引擎 API 真正就绪。

Windows 日常 npm 更新前应先断开仍连接本产品 MCP 的编程会话；`stop` 管理主服务及其子进程，不意味着独立 IDE 的 MCP 连接已经关闭。遇到 EBUSY 不清空数据、不删除原生文件、不批量结束 Node。另一台电脑及其私有语料、本轮未操作的原生目录弹窗、不具备权限的 Windows 符号链接场景不计为自动通过。

### rc.8 候选验收

| 范围 | 实测结果 |
|---|---|
| 官方安装 | `kb-registry-product-0DPXUm/registry-installation.json`；5.0.16-rc.8，sourceCommit `2576e1f0b98fbfdd34183feeb01539a2024922fe`；305 个产品文件及包内四模块内容核对通过，独立缓存下载，无兄弟源码回退 |
| 精确模块 | Workbench 0.13.2-rc.13、vector-hub 1.0.8-rc.8、bridge 0.7.2、引擎 0.2.7-rc.9（vendored commit `7c6812ffab8320c2d835e7825abe275507d6b960`） |
| 源码 | Node 22/24：外壳各 139；引擎各 181 通过、1 项 Windows 符号链接权限跳过；未修改的已锁定 Workbench 365、vector 73、bridge 30 维持对应提交证据 |
| 安装桌面及故障 | 两个 Node 版本的正常页面、首次 profiles 503 后恢复、故障与生命周期共八项通过，均绑定本次 receipt；仅 1920×1080 桌面 |
| 真实模型 | MiniMax 真实提取、分级记忆确认编辑、实际流式、1536 维非空向量、单提交、双项目实际重叠和重启保真 10/10（Q22，fixture CiDegJ） |
| 检索质量／性能 | 20 条固定留出问题 Recall@5=1、MRR=0.9667、拒答准确率=1；8 项目／1000 文档热查询 P95=679.7145ms，四次真实查询 embedding；不代表私有语料普遍保证 |
| 原文送达 | npm 版 topic-context 与真实网页发送都包含策略原文及完整 SHA，真实回答引用原句；原始 9aec 失败语料另用官方安装包引擎库验证，知识不改写、两条记忆加事实 3601 字符，明确不将库级补验冒充原始 HTTP/UI 复测 |
| 原生客户端 | Claude Code、Codex、ZCode 使用实际用户接线，首次模型请求含当前事实与已确认产品记忆；真实代码／回答采用记忆。Codex MCP 版本为 rc.8、Hook 原生 trusted；OpenCode 实际 CLI 搜索及引用通过，不宣称自动前置注入 |
| 二次开发 | rc8-final-fixed：实际搜索和 get → 引用后写代码／运行测试 → commit `0ec95835f58b1a1b934955fb5cfaa1811fd3b817` → Hook／冻结对话／晋升／索引／再检索均通过；`retrieval-rc8-secondary24-1792037130380.json` |
| 本机升级 | 受保护备份 `user-upgrade-1792037257474`，从官方 npm 升级 rc.8（PID 36460）；原有 7 项目、知识、历史、记忆、配置保留，587 个付费索引文件字节不变，实际仍位于 `D:\SanQian.Xu\knowledge\.indexes`；四客户端修复操作 `op-0d5a7b0ef39c46779432e73cbf357f25` 完成 |

候选汇总为 `knowledge-engine/.agent-state/acceptance/system-regression/retrieval-release-5.0.16-rc.8.json`。源码、受控故障、真实模型和 npm 安装身份分别保留，非公开的凭据配置不进入交付记录。

Q24 首次二次开发失败保留（`retrieval-rc8-secondary24-1792036733022.json`）：GLM 启动的验收进程继承宿主 `KB_KNOWLEDGE_DATA_DIR`，CLI 在另一登记层返回 PROJECT_NOT_FOUND，随后超时；不是产品门禁通过。生产 supervisor 已设置正确映射，验收启动器补同一映射及稳定红／绿回归（测试提交 b255f9d），重跑新的 rc8-final-fixed 轮次后通过；未修改产品包、未重造首次成功记录。

用户首次口头回执与实际 trust 状态不符时暂停模型测试；用户实际审核后，rc.6 与 rc.8 原生哈希同为 a51a3b6f…，rc.8 保持 trusted，无需按版本号重复审核。信任是否失效以原生接口为准，不代写记录或使用绕过参数。

### rc.8 修复过程与保留失败

rc.7 已官方下载（`kb-registry-product-50eztE/registry-installation.json`，sourceCommit `043e7156fa55005e27f014e98179d5db110e59bf`），双 Node 外壳各 139 项、安装版八项和真实 MiniMax 记忆／并发十项通过。原始 `topic-context` 已通过，但加强的真实网页问法仍失败：返回了完整事实段落及其首句，随后交叉引用继续挤掉 Patch；失败收据 `retrieval-rc7-workbench24-1792024781524.json` 保留，不升级 latest。

rc.8 对同正文下的短子范围做包含判重；明确提交的小条目在原有 8000 字符及项目预算内完整注入，重新校验原文、分块版本哈希和归属，不修改知识文件、不重建付费向量。源码用真实索引和相同问法验证含原文、两条记忆，总计 3601 字符。防回归覆盖包含关系、未知／不同正文坐标、普通查询、大文件、变化文档、追问与归属竞态。首次红测、既有范围契约失败及修复后的重测分别保留。

rc.6 桌面回答的人工核对发现：已有文档 `changes/9aec087aa155.md` 含单写者 Patch 原文，但注入上下文只含标题和概述，旧验收只查 SHA 而漏报。GLM 独立复现；实际 rc.6 `topic-context` 失败记录保留。最小修复保持每文档两段和范围／正文安全校验：已识别 SHA 仅约束提交来源，不再参与主题词评分；该提交内按其余主题选择片段，并补中英引擎、晋升、单写者别名。新增发布必测 `topic-context24`；真实网页发送同时检查原始事实送达及真实回答引用该事实，不能只凭 SHA 判通过。候选现为 30 项门禁，rc.6 原 28 项通过不抵消新增的真实失败。

`5.0.16-rc.6` 已发布 npm `next`、官方下载并保留现有 v5 数据升级到本机。其四模块为 Workbench rc.13、引擎 rc.7、vector-hub rc.8、bridge 0.7.2。Codex 原生 Hook 审核后的模型送达仍未通过；正式包下载、正式升级和日常 `latest` 更新验收尚未完成。

本机运行 rc.6（PID 30924，5757），保真升级保留 7 个项目、既有历史、知识、记忆、配置及 D 盘索引，官方下载字节核对通过。实际“Agent 接入／修复”操作 `op-92a4925f9e904f7584fda255cf048a87` 成功接线四客户端。Codex 实际插件 MCP 已完成 initialize、版本与六工具检查；原生 Hook 为 modified，测试在模型调用之前停止，未代写信任记录。

### rc.6 已核对结果

| 范围 | 结果与证据 |
|---|---|
| 官方下载 | 收据 `kb-registry-product-pWscTw/registry-installation.json`；sourceCommit `0f052cf6d3e380dcc23a7bf6d8ec96daa4f7f7c4`；主包 305 文件；integrity `sha512-BsR64nrciugXOEkrnuXjG46ceX5kicqnHhjNZ6QbOTMZlamuF3SZvvhIEtcsCa30i9ToOreidigJMRMEkmTUbQ==` |
| 冻结源码 | 外壳 Node 22/24 各 139/139；引擎各 169 通过、1 项 Windows 符号链接权限跳过；Workbench 365、vector-hub 73、bridge 30 的已锁定同提交源码结果保持有效 |
| 安装版桌面 | 正常网页、一次 503 恢复、故障、生命周期共八项，Node 22/24，全部绑定 rc.6 收据；1920×1080 |
| 真模型记忆 | MiniMax 真实提取、项目／领域／全局范围、确认编辑、1536 维向量、流式回答、单／并发提交及重启保真 10/10；`scoped-memories/run-1792021974460/report.json` |
| 真向量质量与性能 | 固定合成留出集 Recall@5=1、MRR=0.9667；8 项目／1000 文档热查询 P95=669.0993ms，单独运行，四次查询 embedding；不等于另一台电脑私有语料验收 |
| 二次开发 | 实际 search/get → 修改前引用 → 小改动与测试 → 真实 commit → 自动晋升与索引 → 再检索通过；`retrieval-rc6-secondary24-1792022320274.json` |
| 真实页面与知识面 | UI 发送 → 真模型 → 28 条文本增量与引用 → 后端最终 turn；API／CLI／MCP 事实、引用一致；非空 embo-01 索引 1536 维 |
| 原生客户端 | Claude Code、ZCode 首次普通开发请求自动收到当前事实与产品记忆，实际代码采用记忆；Claude 提交后维护及下次检索通过。现有真实 knowledge-engine 项目 Claude 只读上下文通过、工作树保持不变。OpenCode 实际知识 CLI 调用与引用通过，不宣称自动前置注入 |
| Codex 安装器 | GLM 独立用 npm 包真实 installCodex 在隔离 CODEX_HOME 下验证 Node 22/24：scoped 路径、本地目录来源、幂等、版本及文件匹配通过；第三方与 trust 未改。该项不代替原生模型送达 |

收据根为 `knowledge-engine/.agent-state/acceptance/system-regression/`，候选汇总为 `retrieval-release-5.0.16-rc.6.json`。原生 Codex 首失败 `retrieval-rc6-codex-real24-1792022749447.json` 明确为 modified 而非 trusted，模型尚未调用。

OpenCode 首次失败保留：工具实际返回了权威的精确提交事实，但旧验收硬编码 `hybrid+markdown-truth`，并要求最新提交包含单写者规则。测试修正允许合法文本事实后端，改为摘要实际返回事实；同时加强 matching tool-id、顺序、项目、服务来源、完整 SHA 与路径检查。4000 字符显示截断仅接受已完整的第一条引用，不把文本检索称为向量成功；独立向量门禁不变。首次红测试与真实复测分别保存。

Leader 另有一次补验参数错误：`--verify-only` 未配 `--resume`，重置了受控 fixture 的提交验收报告，未改用户数据或知识。保留事故记录，重新用唯一 `rc6-leader1` 轮次执行三次真实提交，不重造原成功报告。原十项记忆报告及 GLM 证据仍保留。详情见 `glm-plan-5.0.16/rc6-leader-harness-incident.json`。

## 历史批次

rc.5 官方安装收据 `kb-registry-product-2PqRja/registry-installation.json` 已验证。五仓库冻结回归在 Node 22/24 均通过：外壳 138、Workbench 365、vector-hub 73、bridge 30；引擎 169 通过、1 项 Windows 符号链接权限跳过。安装版正常页面、一次 503 恢复、故障和生命周期八项均通过。真实 MiniMax 记忆、流式、单/并发提交、1536 维索引及重启 10 项通过；固定留出集 Recall@5=1、MRR=0.9667，单独热查询 P95=692.9615ms。

已通过保护备份与 npm 全局升级把本机安装为 rc.5，7 个现有项目、43 个历史文件、565 个 D 盘索引文件及配置保持不变，运行字节与官方下载包一致。首次本机客户端修复的 Codex 失败操作 `op-29b0bc154aa94f43aa2dc759cf898697` 保留：隔离原生 CLI 复现绝对路径中的 `@` 被当作 ref，目录内 `add .` 成功；随后仅通过原生命令恢复本产品市场，正常修复操作 `op-d6d22efd9e534b1f9d06cd0ba06680cb` 成功。未修改信任记录。

Codex 声明入口的真实 MCP initialize/六工具/resolve/search/get 已通过；该结果不等于 Codex 原生模型任务自动收到知识。当前 Hook 为 modified，尚未运行此模型门禁。Claude、ZCode、OpenCode 接线已完成，实际原生送达、二次开发及正式包验收仍需完成。用于实际 Codex 路径回归的 GLM 测试文件经 Leader 修正为跨平台唯一临时目录，避免共享目录清理；首次红测试保留。

2026-10-14 开始执行本轮计划。状态：**实施中，未完成系统验收，不更新 latest**。

2026-10-15 收敛到候选 `5.0.16-rc.5`，精确锁定 Workbench `0.13.2-rc.13`，其余模块保留 rc.4 的已验收运行文件。Leader 负责关键开发与交付，GLM 独立并行故障测试、回归和审查；不新增产品功能。

rc.4 官方安装收据 `kb-registry-product-NPyWjR/registry-installation.json` 已通过内容与 integrity 核对，真实向量热查询 P95 为 1083.6643ms，固定留出集 Recall@5 为 1、MRR 为 0.9667。真实 MiniMax 领域/项目/全局记忆、工作台流式回答、单提交、跨项目并发与重启保真共 10 项通过；这些结果不等于本机原生客户端接入或另一台电脑私有语料验收。

rc.4 首次 Node 22 网页失败的历史原因仍无法确定，后续正常路径重复通过。另以一次 `/profiles` HTTP 503 在真实 Workbench iframe 中稳定复现了「首次失败后模型列表一直为空且不再请求」；两次失败记录保留。Workbench rc.12 已修复这一缺陷类，Leader 冻结源码回归 Node 22/24 各 362/362；新整包必须通过同一故障注入用例才能计为恢复。

rc.4 阶段用户仍运行 rc.1。其六条索引失败已通过公开索引阶段重试恢复，知识正文、晋升时间和分析运行 ID 不变；原 `532d` 运行在操作前已成功，未重复分析。当时的候选安装、原生客户端、新版保真升级与正式发布门禁仍待完成。

GLM 独立审查复现 rc.12 连续保存供应商时复用保存前快照，Leader 修复为保存后等待旧读取结束、再发起可共享的新读取；普通菜单仍 single-flight。两条新竞态测试先失败后修复。菜单异步重绘清空过滤词属于已记录的低风险体验限制，未作为核心修复扩展。

rc.5 首次外壳 Node 22 回归为 134/137：工作台密集并发输出期间暂时不可达，三个隔离测试仍读取默认真实模块而超时，首次失败收据保留。测试服务器现在默认使用不可连接的本地端口 0，真实模块场景必须显式传入自有服务地址；三个失败用例定向复测通过，完整冻结回归仍须重跑。此修复不调整生产请求超时或测试断言。

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
