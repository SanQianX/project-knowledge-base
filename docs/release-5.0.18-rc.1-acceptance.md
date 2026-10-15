# 5.0.18-rc.1 候选发布记录（2026-10-16）

## 候选内容

- 三阶段改造：模块动态端口分配（c4afa63）、桌面薄壳重构（6ea83d5）、Agent 接入简化（b2da6dd）。
- W-1 修复：workbench 0.13.2-rc.18（b79e8bb）——四个 driver 的 turn-end 刷新内存 session.updatedAt，summary/恢复投影透出，service 投影优先取实时值；新增 session-updated-at 回归测试（2 用例），workbench 407/407 通过。
- 桌面图标与网页 favicon 同步为同一"折页 K"标识（0c38e98）。
- CI Node 矩阵对齐 engines >=22（22.x + 24.x；与外部会话同题提交在 rebase 中自动消解）。

## 发布状态（全部完成）

- @sanqianx/claude-ai-workbench@0.13.2-rc.18 → npm next（integrity sha512-TT7WZt…）。
- @sanqianx/project-knowledge@5.0.18-rc.1 → npm next（release:verify 全绿）。
- @sanqianx/project-knowledge-desktop@5.0.18-rc.1 → npm next（首个公开发布的桌面包）。
- GitHub：主仓库已推送（0dba0b0，经 rebase 合入外部 CI 修复）；workbench 仓库已推送（f12a437）。

## 候选验证（已完成的项）

- 隔离 prefix 全新安装 @sanqianx/project-knowledge@5.0.18-rc.1（313 包），CLI --version = 5.0.18-rc.1。
- 桌面包官方源全新安装（D:\SanQian.Xu\.pk-desktop-rc-smoke，326 包）：CLI --version/--help 正确；Electron 二进制经缓存就位。
- 已发布桌面包真实生命周期：隔离数据目录自启 rc.1 后台（endpoint mode=desktop，pid 20712），5757 被占自动回退 5758；硬杀 electron 后后台随 job object 回收，无孤儿。
- 已发布 rc.1 API 验收（隔离实例 5871）：/api/integrations/status 返回 intent/summary 新字段；POST install zcode 完整闭环 complete=true 且意图文件记录 connected（其余 client 迁移补记 disconnected）；POST uninstall 后意图翻转为 disconnected。
- 主仓库后端回归 137/137；浏览器 6/6；workbench 407/407。
- npmmirror 对 rc 版本同步有延迟（新包名 project-knowledge-desktop 同步更慢）；官方 registry 直装已验证可行。

## 待办（正式验收剩余门禁，未完成不宣称通过）

- [ ] 真实提交闭环（双项目晋升、索引、检索）+ 真实模型会话 + 真实向量查询（按 5.0.17 口径）
- [ ] 完整历史分页 / 刷新与滚轮 / 断网恢复浏览器矩阵
- [ ] 用户真实实例升级回验（当前 5757 实例仍为 5.0.17；升级前需用户确认时机）
- [ ] 正式 5.0.18 版本与 latest 放行（另走正式验收）
