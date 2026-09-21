# 00 — MASTER EXECUTION PROTOCOL

## 0.1 Mission

本次任务只做两件核心事情：

1. 修复当前 CI 浏览器测试基础设施，使一个 Chrome/CDP 启动失败不会再让单个测试卡满 300 秒，也能留下足够诊断信息。
2. 重构 Development Conversation 数据来源：
   - 自动捕捉外部 Claude Code / Codex / OpenCode 在真实 Git workspace 中产生的用户提示词和 AI 回复；
   - Project-Knowledge 只长期保存已导入项目的数据；
   - Commit 只绑定同一个 workspace 的对话；
   - Project-Knowledge 自己的 Workbench / Knowledge Analyzer 对话永远排除。

本任务 **不是** 全项目架构重写，不允许重做 Knowledge Promotion、Git durable queue、LanceDB、Markdown 权威知识、AI profile 或 UI 框架。

---

## 0.2 Definitions

### External Development Session
用户在真实源码工作目录中直接运行：

- Claude Code
- Codex
- OpenCode

产生的真实开发会话。

### Development Conversation
External Development Session 中可验证的：

- user prompt
- assistant response

当前版本不要扩展为完整 tool trace。Tool/file/todo 生命周期不是本次 Development Conversation 的事实主体。

### Internal AI Session
Project-Knowledge 自己启动的 Claude Agent SDK session，包括：

- Claude Workbench / terminal UI
- manual knowledge analysis
- post-commit Knowledge Analyzer
- analyzer follow-up / resume

它们不是 Development Conversation。

### Bridge Journal
`ai-coding-event-bridge` 的 per-user durable journal。

它的身份是：

> global short-term durable transport spool

不是永久保存全电脑所有 AI 对话的产品数据库。

### Project ConversationStore
Project-Knowledge 对 Bridge Journal 的 project-scoped durable projection。

只长期保存 **已导入项目** 的 Development Conversation。

### Workspace Identity
用于判断“这个 AI 对话属于哪个真实 Git working tree”的 canonical identity。

远程 URL 不等于 workspace identity。

---

## 0.3 Non-Negotiable Invariants

GLM 每开始一个任务和完成一个任务都必须重新检查这些规则。

### I-01 External Source Only
Development Conversation 的自动来源只能是 `ai-coding-event-bridge` 捕捉的外部 Claude Code / Codex / OpenCode。

### I-02 Workbench Exclusion
Project-Knowledge Workbench 的任何 user/assistant 消息都不得自动写入 Development Conversation。

### I-03 Analyzer Exclusion
Knowledge Analyzer 的任何 prompt / response 都不得进入 Development Conversation 或 Bridge durable journal。

### I-04 Imported Projects Only
Project-Knowledge 只长期保存已导入 project 的 conversation。

### I-05 Unimported Workspace Skip
未导入 workspace 的 Bridge event 可以被读取并 ACK，但禁止写入任意 Project-Knowledge project。

### I-06 Workspace First
Commit 自动绑定 conversation 时必须先 exact-match canonical `workspaceId`，再使用 sequence window。

### I-07 No Guessing
严禁通过以下方法猜 conversation 所属项目：

- 时间接近
- 当前 UI 选中的项目
- 最近一次 session
- 最新 session 文件 mtime
- remote URL 相同
- session JSONL 文件所在目录
- 当前 Project-Knowledge cwd

### I-08 Ambiguous Repo = Gap
无法确定真实 workspace 时必须保留 gap/partial/unavailable 状态，不得猜测绑定。

### I-09 Ambiguous Turn = Gap
无法确定 turn identity 时必须保留 partial/gap；禁止生成虚假 prompt 或共享 `unknown-session`。

### I-10 Bridge Is a Spool
Bridge Journal 不是永久聊天数据库。数据只有在所有注册 consumer ACK 后才允许 compact。

### I-11 Immutable Snapshots
已有 `CommitConversationSnapshot` 不允许静默覆盖或重写。

### I-12 Capture Fail-Open
Bridge 捕捉失败永远不能阻塞 Claude Code / Codex / OpenCode 正常开发。

### I-13 Frozen Snapshot Boundary
Frozen CommitConversationSnapshot 中不允许出现 `sequence > boundaryEndCursor` 的任何 user 或 assistant event。

### I-14 Import Baseline
项目首次导入时从当前 Bridge high watermark 建立 conversation baseline。默认不回填导入前的全局历史对话。

### I-15 Consumer Lifecycle Is Host-Level
`project-knowledge` Bridge consumer 是 host 级注册，不能因为卸载 Claude/Codex/OpenCode 中某一个 connector 就注销整个 consumer。

### I-16 Notification Is Wake-up Only
Connector notification 只能用于唤醒 consumer。事件正文必须从 Bridge durable journal 读取。

### I-17 Contiguous ACK
Consumer cursor 只能推进到一个连续区间，其内每个 sequence 都已经：

- durable persisted；或
- 被确定性 skip。

任意 sequence 处理失败时禁止越过它 ACK。

### I-18 No Synthetic Evidence
禁止 fake prompt、`unknown-session`、无来源 placeholder 进入 analyzer evidence。

### I-19 Same Workspace Across Commit
CCS Commit 只能绑定 CCS workspace 的对话；CCB 即使刚刚发生也不得混入。

### I-20 Preserve Core Knowledge Semantics
不得修改：

- Markdown authoritative knowledge 模型
- Git history durable pending-commit queue
- oldest-first commit reconciliation
- Knowledge Promotion journal/manifest/hash 语义
- Index dirty/rebuild 语义
- LanceDB 作为可重建派生索引的定位

---

## 0.4 Canonical Final Architecture

```text
EXTERNAL DEVELOPMENT

User
 |
 +--> cd D:/Projects/CCS -> Claude Code
 |
 +--> cd D:/Projects/CCS -> OpenCode
 |
 +--> cd D:/Projects/CCS -> Codex
                              |
                              v
                  ai-coding-event-bridge
                  ----------------------
                  canonical RepoIdentity
                  canonical TurnIdentity
                  durable global Journal
                  consumer cursors
                              |
                              | wake-up + journal drain
                              v
                Project-Knowledge BridgeConsumerService
                              |
                    exact workspaceId lookup
                       +------+------+
                       |             |
                  imported       unimported
                       |             |
                   persist        skip + ACK
                       |
                 ConversationStore
                       |
                       +--------------------> Conversation Explorer
                       |
Git Commit ------------+
       |
       v
Bridge appendCommitBoundary
       |
       v
Project-Knowledge drainThrough(boundarySequence)
       |
       v
CommitConversationBinder
       |
       v
CommitConversationSnapshot (immutable)
       |
       v
Knowledge Analyzer [CAPTURE DISABLED]
       |
       v
Markdown Knowledge
```

Internal path:

```text
Project-Knowledge Workbench
Project-Knowledge Knowledge Analyzer
          |
          v
Claude Agent SDK
          |
          +-- AI_CODING_EVENT_BRIDGE_CAPTURE=0
          +-- AI_CODING_EVENT_ORIGIN=project-knowledge-internal
          |
          X  Bridge durable capture
```

---

## 0.5 Canonical Repository Identity Contract

Target schema:

```js
{
  schema: 'repo-identity/v1',
  workspaceId: 'sha256:...',
  workspaceRoot: 'D:\\Projects\\CCS',
  commonDir: 'D:\\Projects\\CCS\\.git',
  remote: 'github.com/SanQianX/CCS'
}
```

Required semantics:

- `workspaceRoot`
  - source: `git rev-parse --show-toplevel`
  - resolve to real path when possible
  - normalize separators/comparison semantics
- `workspaceId`
  - deterministic hash of canonical workspaceRoot
  - Windows identity comparison must be case-insensitive
  - stable across process restart
- `commonDir`
  - source: `git rev-parse --path-format=absolute --git-common-dir`
  - metadata/supporting identity only
- `remote`
  - normalized origin URL
  - metadata only
  - MUST NOT be primary automatic binding key

Required distinctions:

1. `D:\repo1\CCS` and `D:\repo2\CCS` with same remote => different workspaceId.
2. Git worktrees sharing commonDir => different workspaceId.
3. `CCS\modules\foo` nested cwd => same workspaceId as CCS root.
4. CCB separate repository => different workspaceId.

---

## 0.6 Canonical Conversation Event Rules

Bridge owns automatic identity.

Project-Knowledge must not re-invent automatic turn identity.

Target automatic event contract:

```js
{
  schema: 'ai-coding-event/v1',
  eventId,
  sequence,
  source: 'claude-code' | 'codex' | 'opencode',
  eventType: 'user_prompt' | 'assistant_response' | 'session_end',
  role: 'user' | 'assistant' | null,
  content,
  sessionId,
  turnId,
  repoIdentity: RepoIdentityV1 | null,
  projectPath,
  branch,
  headAtCapture,
  capturedAt,
  identityConfidence: 'exact' | 'partial' | 'unavailable',
  captureStatus: 'complete' | 'partial' | 'gap',
  rawEventType,
  meta
}
```

Project-Knowledge explicit fallback evidence may use:

```text
identityConfidence = explicit
```

Legacy read compatibility may translate old `high` / `trusted` to `exact`, but new automatic data must never create those old values。

---

## 0.7 Storage Ownership

### Layer A — Bridge
Default home:

```text
~/.ai-coding-event-bridge/
```

Contains global transient durable transport state.

### Layer B — Project-Knowledge ConversationStore
Contains only imported project data.

### Layer C — Commit Snapshot
Frozen per-commit evidence.

Do not create a second global permanent conversation database in Project-Knowledge.

---

## 0.8 Agent Execution Rules

### DO NOT

- redesign unrelated modules
- introduce a new database
- replace JSONL append-only Bridge journal
- replace Git history as durable commit queue
- redesign Knowledge Promotion
- redesign LanceDB/indexing
- rewrite UI except required capture health/status
- delete existing immutable snapshots
- add TODO placeholder as final implementation
- add production fake/mock path
- weaken, skip or delete a failing test only to make CI green
- bind by time proximity
- bind by remote URL alone
- bind Codex using session file directory
- capture internal Workbench
- capture internal Knowledge Analyzer
- silently swallow ambiguous repo/turn attribution
- change public behavior that is outside this plan

### REQUIRED CONFLICT RULE

If existing code conflicts with this plan:

1. follow this plan for the explicitly covered behavior;
2. preserve unrelated existing behavior;
3. if a required fact cannot be authoritatively resolved, persist/report a gap instead of inventing a fallback;
4. document the unresolved fact in task output.

---

## 0.9 Task Execution Template

Every task T00–T22 MUST follow exactly this loop:

```text
STEP 1  Read task and invariants.
STEP 2  Inspect all "files to inspect" before editing.
STEP 3  Record current behavior in short notes.
STEP 4  Modify only allowed scope.
STEP 5  Add/modify task-specific tests before declaring success.
STEP 6  Run task-specific tests.
STEP 7  Run tests for every touched module.
STEP 8  Run git diff --check.
STEP 9  Inspect git diff for accidental unrelated files.
STEP 10 Re-check I-01 ... I-20.
STEP 11 If anything fails, fix current task. Do not start next task.
STEP 12 Emit task checkpoint summary:
        - files changed
        - behavior changed
        - tests run/results
        - remaining risk
```

Never batch several failing tasks and defer verification until the end.

---

## 0.10 Two-Repository Execution Order

Must be staged:

### Stage 0
CI stabilization in Project-Knowledge.

### Stage A
Finish Bridge contract and connector correctness first:

- RepoIdentity
- TurnIdentity
- Claude connector
- OpenCode connector
- Codex connector
- public facade
- consumer/compaction API
- installer lifecycle

Bridge tests must be green before Stage B.

### Stage B
Then modify Project-Knowledge:

- dependency + BridgeAdapter
- BridgeConsumerService
- import baseline
- commit drain/freeze
- remove internal Workbench capture
- internal SDK capture-disable
- ConversationStore compatibility
- legacy exclusions
- IntegrationManager
- UI health

### Stage C
Cross-repository E2E and regression.

---

## 0.11 Definition of Done

Task is NOT complete unless all are true:

1. External Claude Code conversation in imported CCS is visible in CCS Development Conversation.
2. External OpenCode conversation in imported CCS is visible in CCS Development Conversation.
3. External Codex conversation in imported CCS is visible in CCS Development Conversation.
4. External CCB conversation never appears in CCS.
5. If CCB is unimported, Project-Knowledge does not create CCB project conversation storage.
6. CCS commit snapshot never contains CCB conversation.
7. Internal Workbench conversation does not increment Bridge/Development Conversation evidence.
8. Internal Knowledge Analyzer conversation does not increment Bridge/Development Conversation evidence.
9. Frozen snapshot contains no event beyond commit boundary sequence.
10. Notification loss is recovered by startup/catch-up drain.
11. Duplicate notifications/events are idempotent.
12. Bridge can compact only fully ACKed prefix.
13. Chrome/CDP test failure exits quickly with diagnostics instead of hanging ~300 seconds.
14. Both repositories' full test suites are green.
15. Package/dry-run checks pass.
16. `git diff --check` passes in both repositories.
