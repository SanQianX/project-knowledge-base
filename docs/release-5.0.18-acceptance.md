# 5.0.18 正式验收记录（2026-10-16）

## 版本链

rc.1（三阶段+桌面首发）→ rc.2（意图迁移修复）→ rc.3（四驱动 updatedAt）→ rc.4（claude detail 路径）→ **5.0.18 正式**。workbench 0.13.2-rc.18 → rc.20。

## 真实链路验收（全部通过，生产实例逐级升级实测）

1. **升级链**：5.0.17 → rc.1 → rc.2 → rc.3 → rc.4，安全停止协议 + 官方 registry 全新安装；数据、项目、会话、历史全程保留。
2. **动态端口**：生产实例四模块 source=dynamic 全 UP；桌面自有后台 5757 被占自动回退 5758。
3. **意图迁移缺陷发现与修复**：rc.1 真实环境暴露未完成扫描被误记 disconnected；rc.2 修复后生产验证：空扫描零落笔、稳定后四客户端正确补记 connected。
4. **W-1 端到端（真实 GLM-5.3）**：三轮真实对话驱动三轮修复（list 投影→四驱动 setState→claude detail getState）；rc.4 实测 updatedAt 从 15:18:35 前进至 18:17:06，detail/list 一致。会话 sess-305d493040cd。
5. **真实提交闭环**：adbfa2d（trigger=git-hook）→ 真实模型分析 → promotedAt 18:26:06 → indexState=succeeded；升级期积压 23 个排队 run 由重试解堵后自动消化。
6. **真实向量检索**：语义查询命中 match_channels=["lexical:bm25","index:vector-hub"]，vectorMode=verified-chunks（4 校验块、召回 11 行、calibration=validated），精确返回今日晋升知识段落。
7. **桌面发布包**：官方源 326 包全新安装、CLI、自启后台、端口回退、无孤儿、单实例、复用不停（详见前版记录）。
8. **回归**：主仓库后端 137/137、浏览器 6/6、workbench 407/407。

## 已知边界（如实记录，不阻塞）

- npmmirror 对 rc 版本/新包名同步延迟（官方 registry 直装已验证）。
- 浏览器完整历史/刷新矩阵沿用 rc 工作树 6/6 结果（UI 代码未再变更）。
- 本轮验收提交（50b447a 等）在维护队列中按序消化，不阻塞放行判断。
