# Codex P0 Repair Entry Prompt

Repository: `SanQianX/project-knowledge-base`

请读取并严格执行：

`project-knowledge-v4.2.6-p0-repair-plan.md`

这是本轮唯一实施规范。

必须完成：

1. 先做本机数据只读事故调查，验证 v4.2.6 为什么 Projects、AI Profiles、模型/Embedding 配置、Knowledge Root 全部表现为空。
2. 不打印 API Key / Token。
3. 修复 Migration / Upgrade Safety；旧数据存在或迁移失败时绝不能静默初始化为 Fresh Install。
4. 删除 `startup -> Knowledge Analysis`。
5. 删除 `lastAnalyzedCommit/trackingStartCommit .. HEAD` 的隐含历史补偿；Hook 只处理 `event.head` 的明确 Commit。
6. Offline Commit 不分析，也不能在下一次在线 Hook 被补分析。
7. Bridge 可以在启动时同步 Conversation / Commit Boundary 事实，但不能触发 Knowledge Analysis；确保离线 B/C Conversation 不污染在线 D。
8. 按 Plan 中的 Commit 顺序执行，每阶段测试通过后再 Commit。
9. 运行 focused tests + `node _site/_test/run-all-tests.js`。
10. 不 push，不 reset 用户修改，不做与 P0 无关的重构。

最终报告必须给出：

- 数据事故 Root Cause 与证据
- 找到的旧数据位置及恢复结果
- 每个 Git Commit
- 修改文件
- Focused tests
- Full regression 结果
- 剩余风险
