# 5.0.18-rc.1 候选发布记录（2026-10-16）

## 候选内容

- 三阶段改造：模块动态端口分配（c4afa63）、桌面薄壳重构（6ea83d5）、Agent 接入简化（b2da6dd）。
- W-1 修复：workbench 0.13.2-rc.18（b79e8bb）——四个 driver 的 turn-end 刷新内存 session.updatedAt，summary/恢复投影透出，service 投影优先取实时值；新增 session-updated-at 回归测试（2 用例），workbench 407/407 通过。
- 桌面图标与网页 favicon 同步为同一"折页 K"标识（5d39e31）。
- CI Node 矩阵对齐 engines >=22（22.x + 24.x，88a62cc）。

## 发布状态

- @sanqianx/claude-ai-workbench@0.13.2-rc.18 → npm next（integrity sha512-TT7WZt…；发布后 registry 元数据传播延迟约 10 分钟，tarball 立即可用）。
- @sanqianx/project-knowledge@5.0.18-rc.1 → npm next（cbd61ed，release:verify 全绿）。
- @sanqianx/project-knowledge-desktop@5.0.18-rc.1 → npm next（123709d，薄壳测试 3/3；首个公开发布的桌面包）。

## 已完成的候选验证

- 隔离 prefix 全新安装 @sanqianx/project-knowledge@5.0.18-rc.1（313 包），CLI --version = 5.0.18-rc.1。
- 主仓库后端回归 137/137；浏览器 6/6；workbench 407/407。
- 桌面：真实 Electron 生命周期（复用/自有/单实例/无孤儿）在 5.0.17 阶段验证；rc.1 桌面待镜像同步后做全新安装冒烟。

## 待办（正式验收门禁，未完成不宣称通过）

- [ ] GitHub 推送（本地代理 127.0.0.1:7897 离线，6 个提交待推）
- [ ] 桌面包镜像可见后：独立 prefix 全局安装 @next，project-knowledge-desktop --version / status / 真实窗口冒烟
- [ ] 真实提交闭环 + 真实模型 + 真实向量 + 完整历史/刷新矩阵（按 5.0.17 验收口径）
- [ ] 故障电脑回验、正式 latest 放行（另走正式验收）
