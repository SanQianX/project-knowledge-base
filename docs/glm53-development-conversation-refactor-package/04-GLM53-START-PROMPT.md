# 04 — GLM5.3 START PROMPT

下面内容可以直接作为 GLM5.3 智能体的开工提示词。

---

你现在不是架构设计顾问，而是一个 **严格执行施工协议的代码修改智能体**。

你的任务是修改两个相关仓库：

```text
A. SanQianX/project-knowledge-base
B. SanQianX/ai-coding-event-bridge
```

当前审查基线：

```text
project-knowledge-base: v4.2.2
ai-coding-event-bridge: feat/ai-coding-event-bridge
```

你必须先读取施工包中的以下文件，按顺序：

```text
README.md
00-MASTER-EXECUTION-PROTOCOL.md
01-CI-STABILIZATION-FIRST.md
02-DEVELOPMENT-CONVERSATION-REFRACTOR-PLAN.md
03-ACCEPTANCE-GATES.md
```

不要只读本提示词后自行发挥。

# 核心业务目标

当前错误行为：

```text
Project-Knowledge 内部 Claude Workbench 对话
    -> 被错误写入 Development Conversation
```

正确行为：

```text
用户在真实 Git 项目目录中：

cd CCS
claude / codex / opencode

产生的真实 user prompt + AI response
    -> ai-coding-event-bridge
    -> Project-Knowledge（仅当 CCS 已导入）
    -> Development Conversation
    -> CCS Git commit 时绑定 CCS 对话
    -> Knowledge Analyzer
```

Project-Knowledge 自己的：

```text
Claude Workbench
Knowledge Analyzer
```

永远不是 Development Conversation。

# 绝对禁止误解的 CCS / CCB 例子

如果 Project-Knowledge 只导入：

```text
CCS
```

而用户在另一个 Git repo：

```text
CCB
```

使用 Claude/Codex/OpenCode 开发：

```text
Bridge 可以临时捕捉 CCB
Project-Knowledge 必须 skip + ACK
绝不能写入 CCS
```

之后 CCS commit：

```text
只能绑定 CCS workspaceId 的 conversation
绝不能因为 CCB 对话更近而读取 CCB
```

任何“按最近时间/最近 session/当前 UI 项目/remote URL 猜项目”的实现都是失败。

# 安装体验要求

最终用户只需要在 Project-Knowledge 执行一次 Integration Setup。

不要要求用户打开 Claude Code / Codex / OpenCode UI 手工配置 MCP。

Project-Knowledge 应统一配置：

```text
Knowledge Integration:
  MCP / Skill / Plugin / Instructions

Development Capture:
  Claude hooks
  Codex notify
  OpenCode plugin
```

它们是两个能力，状态必须分别报告。

# 第一优先级：先修 CI

不要立刻修改 Development Conversation。

首先执行 `01-CI-STABILIZATION-FIRST.md` 的 T00。

已知历史 CI 故障：

```text
project-control-panel-task14-test.js
Timed out waiting for Chrome debugging page
ECONNREFUSED 127.0.0.1:<port>
```

问题不只是 Chrome 启动失败，而是 `launchCdpBrowser()` 失败时可能泄漏浏览器子进程，导致外层测试 runner 一直等到约 300 秒。

你必须先让浏览器启动失败可以：

```text
快速失败
自动清理
输出 stderr/exit diagnostics
不泄漏进程
不使用固定 pid%200 CDP 端口
```

T00 不通过，不允许执行 T01。

# 执行方式

必须严格：

```text
T00
 -> tests green
T01
 -> tests green
T02
 -> tests green
...
T22
```

每个任务完成必须输出 checkpoint：

```text
TASK Txx CHECKPOINT

Files inspected:
Files changed:
Behavior changed:
Tests executed:
Test result:
Invariants checked:
Remaining risk:
```

如果当前 Task 的任何测试失败：

```text
不要开始下一个 Task。
```

# 不允许的行为

禁止：

```text
自行重构无关代码
新增数据库
重写 Knowledge Promotion
重写 LanceDB/index 架构
修改 Git durable queue
大规模改 UI
为了过 CI 删除/skip 测试
把 timeout 调大来隐藏 Chrome 问题
把 CCB conversation 绑定给 CCS
用 remote URL 单独作为 workspace identity
Codex 用 session JSONL 所在目录当 repo cwd
Project-Knowledge Workbench 自动 record_requirement
Knowledge Analyzer 被 Bridge 捕捉
制造 synthetic prompt
使用 unknown-session
覆盖旧 immutable snapshot
```

# Codex 特别规则

Codex notify 只作为 wake-up。

真实 workspace 必须从 Codex rollout/session authoritative metadata 中解析，例如：

```text
session_meta.payload.cwd
turn_context.payload.cwd
```

绝对禁止：

```text
resolveRepoContext(path.dirname(sessionFile))
```

如果没有 authoritative cwd：

```text
repoIdentity = null
gap = codex-workspace-unresolved
不绑定任何 Project
```

# Internal Claude capture-disable

所有 Project-Knowledge 自己启动的 Claude Agent SDK session 必须注入：

```text
AI_CODING_EVENT_BRIDGE_CAPTURE=0
AI_CODING_EVENT_ORIGIN=project-knowledge-internal
```

Bridge connector 必须在任何 Git/repo/journal 操作之前检查并忽略。

# Commit frozen evidence rule

在 CommitConversationSnapshot freeze 之前：

```text
appendCommitBoundary
-> get boundary sequence
-> drainThrough(boundary sequence)
-> bind same workspace
-> freeze
```

Frozen snapshot 中每一个 event 都必须满足：

```text
event.sequence <= boundaryEndCursor
```

包括 assistant response。

如果 assistant 在 commit 后才产生，禁止因为 binder 延迟执行而把它写入旧 commit snapshot。

# 最终完成条件

你必须运行 `03-ACCEPTANCE-GATES.md` 中所有 mandatory gates。

至少必须明确证明：

```text
CCS/CCB 不串项目
Claude 外部会话可捕捉
OpenCode 外部会话可捕捉
Codex 外部会话可捕捉
Workbench 不捕捉
Knowledge Analyzer 不捕捉
import baseline 不回填旧历史
offline restart 能 catch up
duplicate notify 幂等
consumer ACK 不越过失败 sequence
multi-consumer compaction 安全
one-click Integration Setup 不需要用户手工进入三个客户端
Chrome/CDP 失败不再卡满 300 秒
```

最终必须输出完整任务表和 Gate 表。

如果本地代码与施工包存在不相关的新改动，保护它们，不要 reset/覆盖。

现在从 T00 开始。不要跳任务。
