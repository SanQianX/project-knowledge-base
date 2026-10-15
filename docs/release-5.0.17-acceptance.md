# 5.0.17 网页加载、刷新与完整历史验收

## 发布状态

2026-10-15：最终候选 `5.0.17-rc.3` 和正式 `5.0.17` 均已独立下载安装验收通过，官方 npm 的 `latest`、`next` 均为 `5.0.17`，`npm view ...@latest version --prefer-online` 已再次确认。Electron、Windows 安装包和窄屏矩阵不在本次范围；用户报告故障的另一台电脑尚需更新后回验。npm 内文档是打包时快照，正式包自己的验收结果在测试完成后追加到仓库当前文档，未重发或修改同版本 npm 包。

## 交付范围

- 首屏按区域独立加载、普通读取 3 秒超时，失败保留已有有效数据。
- Agent 异步扫描最多两个并发，单探测 5 秒、整次 12 秒，手动刷新绕过缓存。
- 嵌入工作台只初始化一次，切页、项目和重连通过已有消息/快照恢复，不重设 iframe 地址。
- 每标签一个同源 WebSocket，合并工作台、引擎及日志；独立模块保留 SSE。
- 引擎服务归属与项目接线分离，失败项目独立恢复；未完成安全接线的项目不执行写入。
- 运行摘要分页，完整提交证据延迟读取；配置指纹合并下发并防止模块重启后的迟到回执污染缓存。
- 工作中向上滚动立即暂停跟随；新增持久化完整会话历史与向前分页，旧 Claude 原生历史尽可能只读恢复。

旧会话若从未持久化且原生文件已经不存在，不能凭空恢复；页面明确显示历史不完整。新增完整归档不再依赖 5000 条驱动事件缓存。

## 源码及独立审查

| 范围 | 结果与证据 |
|---|---|
| Workbench 首批 | `c0ad1f4439cf9ddd81f1277924dd6a01ddd212aa`，400 项通过；134 个 JS 文件为后续补测后的数量，首批为 133 |
| 引擎 | `10c940a2425daaf27d24500c6f2ba21b79cb91d4`，185 通过、1 项既有跳过，不把跳过计为通过 |
| 外壳首批 | `17bab6279035b3120a4dfbbe998f7e7a53772094`，backend-only 133 通过；补 configuration-generation 后最终 134 项全部通过（233968ms）；浏览器测试排除不计通过，见下方真实桌面验收 |
| GLM-5.3 | Workbench 13 项定向审查；外壳 14 项当前通过，冻结基线 9 项预期失败。真实会话和报告位置见操作手册 |
| 诊断补漏 | `98258aa`：runtime 改走异步解析，doctor 与扫描共用 ZCode 注册表后备发现；新增三项先红后绿，Workbench 全套 403 通过 |
| 启动补漏 | `cbba73a`：GLM 同时指出任务与命令发现的同步 PATH 后备；改为一次异步解析，保留兼容同步导出，扫描中止信号传入子进程；新增先红后绿，Workbench 全套 404 通过 |
| 中止竞态 | `1b028da`：稳定复现异步初始化中止后仍启动 SDK；增加代次、权限和迟到结果防护，四种初始化中止/替换场景通过；Workbench 全套 405 通过，GLM 另独立复核 7 项通过 |

GLM 报告分别保存在两个仓库的 `.local-test-data/ui-refresh-2026-10-15/`，不是生产知识文档。Leader 独立执行安装、真实模型和浏览器验收。

## 首个候选 5.0.17-rc.1

官方独立缓存收据：`D:\SanQian.Xu\.pk-acceptance-temp\kb-registry-product-ErheAk\registry-installation.json`。

- 主包提交 `17bab6279035b3120a4dfbbe998f7e7a53772094`。
- integrity：`sha512-QdcreZSakB55UyBDJ1rCmULxwOxem5qmQYVWFDYXH+yzp9qceqJl+EsOeq2qOMLKW1oUIPPucB+oMWiRO5Vjdw==`。
- 精确模块：Workbench `0.13.2-rc.14`、vector-hub `1.0.8-rc.8`、bridge `0.7.2`、vendored engine `0.2.7-rc.10`。
- 包内四模块哈希及依赖官方 integrity 通过，不依赖兄弟源码运行。
- 四个真实受管模块退出后守护恢复、项目投影保留、CLI 大写 STOP 定向停止、所有受管子进程正常退出通过。证据在收据根目录 `acceptance-data/installed-*-acceptance.json`。

### 真实模型与向量

隔离环境：`D:\SanQian.Xu\.pk-acceptance-temp\智脑桌面验收-6PYtN8`，原供应商配置只读，隔离凭据目录受 ACL 保护。使用真实 MiniMax 对话与 embo-01，不使用模型/embedding 替身。

`real-agent-rc1-refresh-acceptance.json`：

- 单提交 `efb58c0cbe8b48dd5132b7ea1931b30d884a4d73` 晋升、索引及 commit 引用通过。
- 两项目提交 `334f69b08fb759e4cbfca3d8398a02ea74eff5ea`、`21706feebe3fb695ac1b9444bc2d9078cafbe994` 均完成。
- 分析区间分别为 12:23:29.417–12:23:54.088 UTC、12:23:30.428–12:24:03.577 UTC，确实重叠，不以两个排队状态冒充并发。
- 浏览器通过包内 Workbench 发送真实任务，会话 `sess-98c93fa8072c` 返回知识原文及对应 commit；两轮流式回答后自然 idle，不需手动中止。

### 桌面浏览器

真实 Edge 正常桌面视口：源码受控环境 1436×756、首个候选环境 1436×730，无尺寸覆盖、无横向溢出。

- 源码受控五服务环境：八个真实标签页均加载工作台，每页 1 条 WebSocket / 2 个订阅；无同源六连接堵塞。
- npm 候选真实模型环境：上下滚动、输出期间暂停跟随、切页保留草稿、断网恢复、引用保持、单连接复用通过。滚动后内容高度由 2233 增至 4495，阅读位置仍停留较早内容，而非被拉到底部。
- 真实回答明确引用 `Knowledge has one writer: the engine promotion path. Preserve native workbench streaming and keep the product simple.`，不只匹配提交号。
- 截图：`project-knowledge-base/.local-test-data/ui-refresh-2026-10-15/rc1-real-workbench.jpg`。
- 候选页面 DOMContentLoaded 149.7ms；明确置于前台后 10 次切页的下一帧反馈为 2.7–8.6ms，P95 8.6ms；DOM 投影为 1.2–2.8ms。此前未显式置前的样本约 1 秒，不能混作前台性能结果。重复切页后工作台 iframe 资源只加载一次，仍为 1 WebSocket / 2 订阅。

## 性能与保留的首次失败

- 一个模块挂起时，聚合项目读取从约 12038ms 降至 2509ms；模块健康读取约 2014ms，均为本机受控测量，不是所有设备保证。
- 四个真实慢 CLI 子进程、最多两个并发时，轻量 HTTP P95 约 2.35–12.84ms；不再同步阻塞整个后台。
- 1000 个运行的摘要只返回 50 条且小于 10KB，详情仍保留证据。
- 初次候选 registry 尚在异步处理中时下载校验因 next 仍旧版本失败；等待 registry 可见后使用新的独立缓存下载通过，不覆盖原失败。
- 原全套回归暴露配置同步过程中知识根变化未再次下发；已修复合并任务的 dirty 循环，重测通过。
- GLM 的 TTL 20ms 墙钟测试在负载下偶发失效，改为注入时钟并全套复跑；不将测试竞态当产品回归。
- 诊断复核发现 runtime 同步旁路与 registry-only ZCode 遗漏；首个候选不晋升 latest，补测试和修复后重新验收。
- `5.0.17-rc.2` 已官方独立下载及哈希验证（收据 `kb-registry-product-DTTWep/registry-installation.json`），但后续中止竞态测试失败，因此不作为最终候选放行；未将 latest 指向该版本。
- Node 22 的首次外壳回归为 133 通过、1 失败，控制台分段输出未保存完整失败详情。完整报告重跑仍为 133/1，稳定复现为 `package-boundary-test.js`：独立 Node 二进制旁没有 npm，未传 `npm_execpath` 时查找了不存在的 npm-cli.js。单独复现已确认，属验收启动环境而非产品启动失败；首失败报告保存在 `.local-test-data/ui-refresh-2026-10-15/node22-missing-npm-path-failure.md`。修正启动参数后再次全量验收，不将前两次算作通过。

## 最终放行

### 最终候选 5.0.17-rc.3

官方独立缓存收据 `D:\SanQian.Xu\.pk-acceptance-temp\kb-registry-product-2nbfre\registry-installation.json`；主包提交 `81e91a94a42d909b54acd6115a261b6b95581afd`；integrity `sha512-6gXEgElgtcTsLwk58ObZNGF5xYu7XCyH7WBH3PV7j2hpWLiQMVB56dxUPjdOHCy9kOTP/Er9VV2De9RQnj25Jg==`。Workbench 精确版本为 `0.13.2-rc.17`（`1b028da`），其余模块与 rc.1 一致。

| 门禁 | 结果 |
|---|---|
| 双 Node 源码 | Node 24：Workbench 405、外壳 134、引擎 185 通过/1 跳过；Node 22.23.3：Workbench 405、外壳 134、引擎 185 通过/1 跳过。外壳修正验收启动参数的全套为 221944ms，报告 `node22-final-pass.md` |
| 官方安装 | 主包和四模块精确版本、官方 integrity、产品资源哈希、vendored 40 文件通过，无兄弟源码兜底 |
| 生命周期 | `2nbfre/acceptance-data/installed-*-acceptance.json`：四模块守护重启、CLI 大写 STOP、全部受管子进程正常退出通过 |
| 真实维护 | 隔离根 `智脑桌面验收-6rT60F`，`real-agent-rc3-refresh-acceptance.json`：单提交 `5c247b6b198ee6a8c9743553cf62daa93ae7353b`，双项目 `082da6fa`、`bc41d83d` 均完成晋升/索引/检索，分析区间真实重叠 |
| 真向量 | 同一 npm 候选的实际语义查询返回 `hybrid+markdown-truth`，9 个校验向量片段，结果含 `index:vector-hub`；不是 SHA 文本命中冒充向量 |
| 真实网页任务 | MiniMax-M3.1-Flash-Preview，两轮以上真实输出，完整 SHA 与策略原文均引用；中止后同会话立即继续并自然 idle，后端核验 246 个文本增量事件；`real-workbench-acceptance.json` |
| 项目与刷新 | 真实任务中 A→B→A，B 无 A 会话，A 恢复原会话和未发送草稿；iframe 资源只加载一次，仍为 1 WebSocket/2 订阅，无横向溢出、控制台错误为空 |
| 工作中滚轮 | 长回答中向上滚动，随后内容高度增长至 5000、阅读位置仍为 2316，距底部超过 2000；回到底部入口出现，不再反复拉到底 |
| 完整历史 | 另一个明确的模型替身隔离环境 `智脑桌面验收-aKjUKi`：包内服务发送 25 轮，API 20+5，网页最终显示 01 至 25 全部记录；置顶自动补页先完成导致一次按钮定位失效，未冒称该次按钮点击成功；后台/DOM 结果均单独核验 |
| 截图 | `.local-test-data/ui-refresh-2026-10-15/rc3-real-workbench.jpg`、`rc3-complete-history.jpg` |

真实任务和替身长历史测试分开记录，不能将替身回答计入真实模型通过。原用户数据、供应商设置、5757 生产实例和第三方 Hook 未改动。

### 正式包

官方全新安装收据：`D:\SanQian.Xu\.pk-acceptance-temp\kb-registry-product-Vn5JOh\registry-installation.json`，源码提交 `7fac75f63bca0ca9d4c125cff8029c6e8822a4c1`，integrity `sha512-HhFfsEDF4UbZlbSmPyBbnAgvKGd2tgXmhPDXW3H5VGNRGmiN7DfXA2fmwVvqOr/Fe59d4KoQsrdEsOIpsmNJ5Q==`。Workbench `0.13.2-rc.17`、vector-hub `1.0.8-rc.8`、bridge `0.7.2`、vendored engine `0.2.7-rc.10`；包内内容和官方模块 integrity 均核对通过。

| 正式验收项 | 实际结果 |
|---|---|
| 源码冻结复跑 | 正式提交的 Node 24 外壳 134/134，215568ms；Node 22 134/134 记录保留。Workbench 双 Node 405，engine 双 Node 185 通过/1 跳过；未修改模块也补跑 vector-hub 73、bridge 30，均通过。浏览器自动脚本排除不计通过，真实浏览器另列 |
| 真进程生命周期 | 正式安装目录 `acceptance-data` 下的 startup/restart/shutdown JSON：四模块启动、独立退出后的守护恢复、大写 STOP、四个子进程正常关闭均通过 |
| 真实提交闭环 | `智脑桌面验收-E0OL29/real-agent-formal-refresh-acceptance.json`：单提交 `2769908ce00b6b8aeab178e83b6f1bbca0c16871`，双项目 `7f1c331d`、`f5870071` 均晋升、索引并可检索；并行分析区间实际重叠 |
| 真实向量 | 正式引擎的语义查询包含 10 个校验向量片段、`index:vector-hub` 命中和对应正式提交，不以文本降级冒充向量成功 |
| 真网页和模型 | 会话 `sess-001c5cbec432`，真实 MiniMax-M3.1-Flash-Preview，76 个文本增量，回答逐字引用新知识原文和完整提交；最后自然 idle、持久化 turn-end，通过后端独立核验 |
| 刷新与滚轮 | 工作中向上滚动后切到活动页，活动自动显示真实维护“已更新·可检索”；返回工作台内容增长至 2075，阅读位置仍为 0，未发送草稿保留，iframe 只加载一次 |
| 网络恢复 | 正式页面断网显示连接中断，恢复后重新读取状态，草稿、会话和引用仍存在；仍为 1 WebSocket / 2 订阅，桌面 1436×730、无横向溢出、浏览器控制台无错误 |
| 完整历史 | 独立替身环境 `智脑桌面验收-TIFVtg`，正式包后端新建 25 轮，分页 20+5；真实网页向上翻阅后 DOM 同时包含第 01 与第 25 轮，共 25 轮。仅此长历史项使用替身，不混入真实模型结果 |
| 正式发布 | 正式包先发 next，以上验收完成后才执行 dist-tag latest；第一次 npm view 仍命中旧元数据，保留该观察。dist-tag 官方端点随后已为 5.0.17，最后 npm view @latest 也确认为 5.0.17 |

最终证据副本集中在 `project-knowledge-base/.local-test-data/ui-refresh-2026-10-15/`：`formal-registry-installation.json`、`formal-installed-{startup,restart,shutdown}.json`、`formal-real-commits.json`、`formal-real-workbench.json`、`formal-complete-history.json`、`node24-formal-source-pass.md`、`node22-final-pass.md` 与 `glm-final-review.md`。两张正式桌面截图为 `formal-real-workbench.jpg`、`formal-complete-history.jpg`。

相关源码均已推送远程 Git；本轮未更新或重启原 5757 用户实例（仍为 5.0.16），没有修改用户知识、历史、凭据、原生 Hook 信任或第三方通知。请在实际出现故障的电脑按日常方式 stop、安装官方 @latest、检查版本并启动。Windows 若独立 IDE 的 MCP 持有原生库导致 EBUSY，应先退出相应会话后重试，不删除原生文件或清空数据。

本轮网页范围验收完成，不等于对其他设备、私有语料或未保存过的旧历史作无缺陷保证。Electron 与 macOS 原生安装未实施、不计为通过。
