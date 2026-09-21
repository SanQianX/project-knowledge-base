# GLM5.3 Development Conversation Refactor Package

本施工包用于把 `project-knowledge-base` 的 Development Conversation 从“捕捉 Project-Knowledge 内部 Claude Workbench 对话”修正为“捕捉用户在真实 Git 工作目录中使用 Claude Code / Codex / OpenCode 进行开发时产生的用户提示词与 AI 回复”。

## 目标仓库

- Host: `SanQianX/project-knowledge-base`
  - 审查基线：tag `v4.2.2`
- Capture bridge: `SanQianX/ai-coding-event-bridge`
  - 审查基线：branch `feat/ai-coding-event-bridge`

执行时必须以本地实际 checkout 的最新目标分支为准，但如果代码已经偏离本施工包描述，先记录差异，再按 `00-MASTER-EXECUTION-PROTOCOL.md` 的冲突处理规则执行；禁止自行重做架构。

## 文件说明

1. `00-MASTER-EXECUTION-PROTOCOL.md`
   - 全局目标、术语、不可违反的 invariant、Agent 行为规则、任务执行模板。
2. `01-CI-STABILIZATION-FIRST.md`
   - 必须最先执行的 CI/CDP 浏览器测试基础设施修复。
3. `02-DEVELOPMENT-CONVERSATION-REFRACTOR-PLAN.md`
   - 两个仓库从 Bridge contract 到 Project-Knowledge consumer、Commit 绑定、统一安装器的机械施工任务。
4. `03-ACCEPTANCE-GATES.md`
   - CCS/CCB 跨项目隔离、Claude/OpenCode/Codex、内部 Analyzer 排除、断网/重启/重复事件等发布 Gate。
5. `04-GLM53-START-PROMPT.md`
   - 可以直接作为 GLM5.3 智能体的开工提示词。
6. `FULL-PLAN.md`
   - 上述主要内容的合并版，适合一次性喂给只能接收单文件上下文的智能体。

## 最重要的产品边界

```text
真实外部开发环境
  Claude Code / OpenCode / Codex
              |
              v
    ai-coding-event-bridge
     global durable spool
              |
              v
     Project-Knowledge consumer
              |
      workspace identity match
              |
      +-------+--------+
      |                |
 imported repo     unimported repo
      |                |
 persist              skip + ACK
      |
 ConversationStore
      |
 Git commit boundary
      |
 drainThrough(boundary)
      |
 CommitConversationSnapshot
      |
 Knowledge Analyzer
      |
 Markdown Knowledge
```

Project-Knowledge 内部 Claude Workbench 与 Knowledge Analyzer 均属于内部 AI runtime，必须显式设置 capture-disable，永远不能写入 Development Conversation。

## 用户期望的安装体验

用户只在 Project-Knowledge 做一次 Integration Setup，不需要分别打开 Claude Code / Codex / OpenCode 手工安装 MCP。

同一个安装动作需要分别完成两类能力：

- Knowledge Integration：MCP / Skill / Plugin / Instructions，用于让外部 Agent 查询知识库。
- Development Capture：Bridge hook / Codex notify / OpenCode plugin，用于捕捉真实外部开发对话。

这两类能力必须分别显示状态，但由 Project-Knowledge 统一安装、修复和卸载。
