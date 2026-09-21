# MiniMax 流水线开发包使用说明

推荐使用方式：

1. 把整个 ZIP 解压到 MiniMax 能读取的位置。
2. 第一条消息直接喂 `06_MINIMAX_START_PROMPT.zh-CN.md`。
3. 同时要求它完整读取本目录所有文件。
4. 不要让它先“重新设计一个更好的方案”，直接要求按 T00 开始施工。
5. 每完成一个 Task，必须按 `07_TASK_REPORT_TEMPLATE.md` 汇报并等待该 Task 自检通过后继续。

如果 MiniMax 上下文不方便读取多个文件，则直接提供 `FULL_PLAN.md`，再补充 `06_MINIMAX_START_PROMPT.zh-CN.md`。

本包核心原则：恢复 v4.1.22 的成熟产品能力，但保留当前 4.2.x 的 CommitReconciler、Promotion、IndexService、StorageLayout v2、Bridge、Development Conversation 外部捕捉等新架构。
