# 5.0.17 网页加载、刷新与完整历史验收

## 发布状态

2026-10-15：候选验收和最终复核进行中，正式 `latest` 仍为 `5.0.16`。本文件不得被解读为正式版已发布。Electron、Windows 安装包和窄屏矩阵均不在本次范围；用户报告故障的另一台电脑尚需更新后回验。

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

真实 Edge 正常桌面视口 1436×756，无尺寸覆盖、无横向溢出。

- 源码受控五服务环境：八个真实标签页均加载工作台，每页 1 条 WebSocket / 2 个订阅；无同源六连接堵塞。
- npm 候选真实模型环境：上下滚动、输出期间暂停跟随、切页保留草稿、断网恢复、引用保持、单连接复用通过。滚动后内容高度由 2233 增至 4495，阅读位置仍停留较早内容，而非被拉到底部。
- 真实回答明确引用 `Knowledge has one writer: the engine promotion path. Preserve native workbench streaming and keep the product simple.`，不只匹配提交号。
- 截图：`project-knowledge-base/.local-test-data/ui-refresh-2026-10-15/rc1-real-workbench.jpg`。

## 性能与保留的首次失败

- 一个模块挂起时，聚合项目读取从约 12038ms 降至 2509ms；模块健康读取约 2014ms，均为本机受控测量，不是所有设备保证。
- 四个真实慢 CLI 子进程、最多两个并发时，轻量 HTTP P95 约 2.35–12.84ms；不再同步阻塞整个后台。
- 1000 个运行的摘要只返回 50 条且小于 10KB，详情仍保留证据。
- 初次候选 registry 尚在异步处理中时下载校验因 next 仍旧版本失败；等待 registry 可见后使用新的独立缓存下载通过，不覆盖原失败。
- 原全套回归暴露配置同步过程中知识根变化未再次下发；已修复合并任务的 dirty 循环，重测通过。
- GLM 的 TTL 20ms 墙钟测试在负载下偶发失效，改为注入时钟并全套复跑；不将测试竞态当产品回归。
- 诊断复核发现 runtime 同步旁路与 registry-only ZCode 遗漏；首个候选不晋升 latest，补测试和修复后重新验收。

## 最终放行

待补：最终候选的官方收据、正式包收据及安装版重测结果。未填写之前不报告正式交付完成。
