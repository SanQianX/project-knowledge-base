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
# 01 — CI STABILIZATION FIRST

## T00 — Fix the recurring Windows browser/CDP CI failure before feature work

### Why T00 is mandatory

Observed failing workflow:

- repository: `SanQianX/project-knowledge-base`
- workflow: `Non-release validation`
- run: `32155087359`
- branch: `refactor/project-knowledge-v13`
- commit: `497fd2f135fd0c05ff79d3ea64ef1ab00bbe429e`
- failed lane: `Core (web runtime) / Node 18.x / Windows`

The suite executed 73 tests:

```text
72 PASS
1 FAIL
```

Only failure:

```text
project-control-panel-task14-test.js
```

Observed failure:

```text
Error: Timed out waiting for Chrome debugging page:
connect ECONNREFUSED 127.0.0.1:10212
```

The test was reported as approximately:

```text
300013 ms
exit null
```

The same test on Windows Node 24 in the same workflow run passed in about 6 seconds.

This is primarily a **test infrastructure failure**, not a Knowledge Base functional failure.

Current `v4.2.2` workflow already removed the Windows Node 18 matrix and keeps Windows Node 24 only. Do not re-add Windows Node 18 as part of this feature refactor unless a separate compatibility requirement explicitly asks for it.

However, the underlying CDP helper bug still exists in `v4.2.2`, so T00 must fix it rather than merely relying on removal of the Node 18 Windows lane.

---

## T00.1 Root Cause Contract

Before editing, the agent must understand and preserve this diagnosis:

1. `_site/_test/helpers/cdp-browser.js` spawns Chrome/Edge.
2. It waits for `http://127.0.0.1:<port>/json`.
3. If Chrome never exposes CDP, the helper throws.
4. `launchCdpBrowser()` throws before returning the `browser` object.
5. Caller `project-control-panel-task14-test.js` only calls `browser.close()` when `browser` was successfully assigned.
6. Therefore the spawned Chrome process may remain alive on launch failure.
7. `_site/_test/run-all-tests.js` runs each test as a child process with a large outer timeout; the leaked Chrome/child handle can keep the failed test process alive until the outer timeout.
8. `stdio: 'ignore'` discards the most useful Chrome startup diagnostics.
9. Fixed PID-derived debug ports are an unnecessary collision/race risk.

The fix must address **failure cleanup + diagnostics + port discovery**, not just increase timeouts.

---

## T00.2 Files to inspect before editing

Project-Knowledge only:

```text
_site/_test/helpers/cdp-browser.js
_site/_test/helpers/find-chrome.js
_site/_test/project-control-panel-task14-test.js
_site/_test/run-all-tests.js
.github/workflows/ci.yml
package.json
```

Also search for every caller of:

```text
launchCdpBrowser
findChrome
requestJson
```

Do not assume only Task14 uses these helpers.

---

## T00.3 Required `cdp-browser.js` behavior

### A. Always-cleanup launch lifecycle

Refactor `launchCdpBrowser()` so any failure after `spawn()` executes cleanup before rethrow.

Required structure conceptually:

```js
let child = null;
try {
  child = spawn(...);
  // wait for browser / CDP
  // connect websocket
  // navigate page
  return browserHandle;
} catch (error) {
  await cleanupSpawnedBrowser(child, profileDir);
  throw enrichBrowserLaunchError(error, diagnostics);
}
```

No code path may leave the spawned browser alive after launch initialization fails.

### B. Child process diagnostics

Do not use:

```js
stdio: 'ignore'
```

for browser startup.

Capture stdout/stderr with bounded memory.

Recommended:

```js
stdio: ['ignore', 'pipe', 'pipe']
```

Keep only a bounded tail such as 16–32 KiB per stream.

Listen to:

- `error`
- `exit`
- `close`

If the browser exits before CDP becomes ready, fail immediately rather than waiting the full launch timeout.

Error message must include at least:

```text
browser executable path
PID if available
exit code
signal
stderr tail
selected user-data-dir
```

Do not leak full environment variables or secrets into logs.

### C. Use dynamic CDP port

Preferred implementation:

```text
--remote-debugging-port=0
```

Chrome writes the selected port to:

```text
<profileDir>/DevToolsActivePort
```

Algorithm:

1. spawn with port `0`;
2. wait for `DevToolsActivePort`;
3. parse first line as integer port;
4. poll `http://127.0.0.1:<port>/json/list` or `/json`;
5. connect page WebSocket.

If the installed Chrome/Edge version unexpectedly does not support this path, use a real free-port allocator. Do **not** return to `10100 + pid % 200` as the default.

### D. HTTP request timeout

`requestJson()` must have a short per-request timeout, e.g. 1000 ms.

It must destroy the request on timeout and reject with a useful error.

A single stuck socket must not consume the whole launch timeout.

### E. Launch timeout

Keep a bounded launch timeout, default around 15–20 seconds.

Expose through an optional parameter/env only if useful for CI diagnostics.

Do **not** solve the issue by making it 60/120/300 seconds.

### F. Windows process-tree cleanup

On Windows, `child.kill()` is not always sufficient if Chromium created children.

Implement a cleanup helper that attempts graceful kill then, if necessary, process-tree termination, e.g. `taskkill /PID <pid> /T /F`.

Requirements:

- cleanup is best effort;
- cleanup errors must not replace the original test failure;
- non-Windows path must remain portable.

### G. Profile cleanup

Delete profile directory on both successful `close()` and failed launch cleanup.

Use retries/best-effort on Windows file locking rather than leaking temp directories.

---

## T00.4 Required `find-chrome.js` behavior

Remove the personal hard-coded path:

```text
C:\Users\SanQian\AppData\Local\ms-playwright\...
```

Shared repository tests must not contain a developer-specific absolute browser path.

Candidate order should be:

1. `KB_CHROME_PATH`
2. standard Chrome installation paths
3. standard Edge installation paths
4. standard Linux Chromium/Chrome paths
5. standard macOS Chrome path

Optional but recommended diagnostics function:

```js
findChromeDetailed()
```

returning:

```js
{
  path,
  source
}
```

Do not shell-execute arbitrary candidate strings.

---

## T00.5 Required test-runner hardening

Inspect `_site/_test/run-all-tests.js`.

Requirements:

1. Make per-test timeout configurable, e.g.:

```text
PK_TEST_TIMEOUT_MS
```

2. Default should be materially lower than 300 seconds for ordinary tests, recommended 60–90 seconds unless an existing known test legitimately requires more.
3. Report timeout explicitly:

```text
TIMEOUT
```

instead of only:

```text
exit null
```

4. Include child `signal`, error code and output tail in failure report.
5. Do not kill the whole suite on first failure unless existing behavior requires it; continue collecting failures as current runner does.

Do not hide a real slow test by simply increasing the timeout.

---

## T00.6 New deterministic failure test

Create a helper regression test, suggested name:

```text
_site/_test/cdp-browser-failure-test.js
```

It must not depend on an actual broken GitHub runner.

Test scenario:

1. Launch `launchCdpBrowser()` with a fake executable or controlled helper process that exits immediately and never exposes CDP.
2. Assert the promise rejects quickly, target < 5 seconds for immediate-exit fixture.
3. Assert error contains early-exit diagnostic data.
4. Assert no spawned child remains alive.
5. Assert profile directory is cleaned.

Add a second scenario if practical:

- process stays alive but never exposes CDP;
- launch timeout occurs;
- cleanup kills it;
- total test duration stays bounded.

Do not mark test skipped on Windows.

---

## T00.7 Existing UI test verification

Run at least:

```text
node _site/_test/project-control-panel-task14-test.js
node _site/_test/ui-smoke-test.js
node _site/_test/task15-20-ui-flow-test.js
node _site/_test/cdp-browser-failure-test.js
```

Run each multiple times if feasible, especially the browser helper tests.

Then run full:

```text
npm test -- --no-report
```

---

## T00.8 Workflow policy

For current `v4.2.2` behavior:

- Linux Node 18 + 24 may remain as compatibility matrix.
- Windows web-runtime job may remain Node 24 only.
- Do not add unnecessary 4-way matrix expansion during this feature refactor.
- Do not use CI workflow changes as a substitute for fixing browser cleanup.

If a future requirement needs Windows Node 18, it can be reintroduced only after T00 helper tests prove deterministic failure behavior.

---

## T00.9 Acceptance Criteria

T00 PASS only if:

- [ ] Failed browser start leaves no Chrome/Edge child process.
- [ ] Failed browser start reports browser stderr/exit diagnostics.
- [ ] CDP port is dynamically allocated/discovered.
- [ ] HTTP polling has per-request timeout.
- [ ] No developer-specific hard-coded Chrome path remains.
- [ ] A deterministic failure test proves fast cleanup.
- [ ] Task14 browser test passes locally/CI target environment.
- [ ] Full PK test suite passes.
- [ ] `git diff --check` passes.
- [ ] CI helper failure can no longer consume the old ~300-second outer timeout under normal launch failure.

After T00 passes, proceed to Development Conversation tasks. Do not interleave T00 with Bridge architecture changes.
# 02 — DEVELOPMENT CONVERSATION EXTERNAL CAPTURE REFACTOR PLAN

This file begins only after T00 CI stabilization is complete and green.

---

# Stage A — ai-coding-event-bridge must become the canonical capture authority

## T01 — Baseline and scope freeze

Repository:

```text
SanQianX/ai-coding-event-bridge
```

### Inspect

At minimum:

```text
README.md
packages/core/package.json
packages/core/src/index.js
packages/core/src/core/event-schema.js
packages/core/src/core/repo-context.js
packages/core/src/core/normalizer.js
packages/core/src/core/turn-identity.js
packages/core/src/core/journal.js
packages/core/src/core/consumer-registry.js
packages/core/src/core/compaction.js
packages/core/src/core/runtime-home.js
packages/core/src/connectors/claude-code/hook-entry.js
packages/core/src/connectors/codex/hook-entry.js
packages/core/src/connectors/codex/session-parser.js
packages/core/src/connectors/codex/cursor-store.js
packages/core/src/connectors/opencode/hook-entry.js
packages/core/src/installers/claude-code/installer.js
packages/core/src/installers/codex/installer.js
packages/core/src/installers/opencode/installer.js
packages/core/src/query/conversation-query.js
packages/core/test/*-test.js
```

### Required action

Do not modify code yet.

Record:

- current exported public API
- current event schema
- current repoIdentity representation
- current turnId generation/closure behavior
- current installer registration behavior
- current compaction/ACK behavior

### Acceptance

Agent can explain current flow from external client event to durable journal without guessing.

---

## T02 — Canonical RepoIdentityV1

### Primary files

```text
packages/core/src/core/repo-context.js
packages/core/src/core/event-schema.js
packages/core/src/index.js
packages/core/test/event-schema-identity-test.js
```

Add new tests as required.

### Required contract

```js
RepoIdentityV1 = {
  schema: 'repo-identity/v1',
  workspaceId: 'sha256:<hex>',
  workspaceRoot: '<canonical real git top-level>',
  commonDir: '<canonical git common dir>' | null,
  remote: '<normalized remote>' | null
}
```

### Required algorithm

Given authoritative development cwd:

1. `git rev-parse --show-toplevel`
2. canonicalize/realpath top-level
3. normalize comparison form
4. hash normalized workspaceRoot into `workspaceId`
5. resolve `git rev-parse --path-format=absolute --git-common-dir`
6. resolve origin URL and normalize as metadata
7. return `identityConfidence=exact` only when workspaceRoot is authoritatively resolved from Git

### Windows path rule

Identity comparison must be case-insensitive on Windows.

Do not lower-case the display `workspaceRoot` if doing so harms presentation; use a separate comparison normalization internally.

### Non-Git cwd

Return:

```js
{
  repoIdentity: null,
  projectPath: canonical input path if available,
  identityConfidence: 'unavailable'
}
```

Do not create a fake workspaceId.

### Forbidden

- remote URL as primary identity
- cwd raw string as identity without Git top-level resolution
- commonDir alone as workspace identity
- implicit fallback to process.cwd when event supplied an authoritative cwd that simply failed Git resolution

### Mandatory tests

1. nested folder resolves to same workspaceId as repo root
2. two separate repos => different workspaceId
3. two clones with same origin => different workspaceId
4. Git worktrees sharing commonDir => different workspaceId
5. Windows case variation => same identity on Windows semantics
6. spaces/unicode path
7. no Git repo => unavailable
8. origin missing => workspace still exact, remote null

### Exit Gate

Run Bridge full tests before T03.

---

## T03 — Canonical TurnIdentity owned by Bridge

### Problem to remove

Current connectors can persist events whose `turnId` is null even when Bridge can later infer the turn in its projection. Project-Knowledge then cannot reliably group assistant events.

### Primary files

```text
packages/core/src/core/journal.js
packages/core/src/core/turn-identity.js
packages/core/src/core/normalizer.js
packages/core/src/core/event-schema.js
packages/core/test/*turn*test.js
packages/core/test/event-schema-identity-test.js
```

### Required rule

The **durable event record** must contain canonical `turnId` whenever it can be deterministically resolved at append time.

Projection-only inference is insufficient.

### Required append algorithm

Implement a canonical conversation append path, e.g.:

```js
Journal.appendConversationEvent(event)
```

or equivalent internal function under the existing journal lock.

#### user_prompt

If client supplied trustworthy turnId:

```text
use it
```

Else:

```text
generate Bridge-owned turn_<uuid>
```

Persist generated turnId in the durable event.

#### assistant_response

If client supplied turnId:

```text
validate and use it
```

Else if sessionId exists:

```text
find open turns for same workspaceId + sessionId
```

If exactly one:

```text
assign that turnId to durable assistant event
```

If zero or >1:

```text
turnId = null
identityConfidence <= partial
captureStatus = partial/gap
record diagnostic gap if appropriate
```

Never attach an assistant event to an open turn from another workspace.

#### session_end

May close all remaining open turns for exact same workspace/session but must not fabricate assistant content.

### Duplicate semantics

Canonicalization must be deterministic with respect to an already persisted source event or stable event key where possible. Avoid creating a new generated user turnId on duplicate reprocessing that would make dedup impossible.

If current connector does not provide stable source identity, define and test the exact dedup behavior instead of silently creating duplicates.

### Confidence

Bridge automatic values only:

```text
exact
partial
unavailable
```

### Mandatory tests

- user without turnId gets persisted generated turnId
- assistant without turnId but one open session turn gets same persisted turnId
- two open same-session turns => assistant remains ambiguous
- same sessionId in two workspaces never cross-binds
- restart/rebuild projection preserves same durable identities
- no synthetic prompts

---

## T04 — Claude Code connector correctness + capture-disable

### Files

```text
packages/core/src/connectors/claude-code/hook-entry.js
packages/core/src/core/normalizer.js
packages/core/src/installers/claude-code/installer.js
packages/core/test/claude-connector-fixture-test.js
```

### Required external capture

Claude hook sources:

```text
UserPromptSubmit -> user_prompt
Stop -> assistant_response when last_assistant_message exists
```

Use payload `cwd` as authoritative client cwd, then canonical RepoIdentityV1.

### Capture-disable guard

At the very beginning of connector execution, before normalization/repo Git calls/journal writes:

```js
if (process.env.AI_CODING_EVENT_BRIDGE_CAPTURE === '0') {
  return { status: 'ignored', reason: 'capture-disabled' };
}
```

Also allow an equivalent explicit payload/meta guard only if needed, but environment marker is required for Project-Knowledge internal SDK sessions.

### Required behavior

- fail-open on every Bridge error
- internal disabled session must not increment journal sequence
- no event must be created if raw hook type is unsupported
- assistant uses canonical durable turn assignment from T03

### Tests

- real user + Stop pair yields same turnId
- capture-disabled yields zero new journal records
- invalid cwd => event may be captured as unavailable but never guessed into a repo
- hook failure returns fail-open

---

## T05 — OpenCode connector correctness + capture-disable

### Files

```text
packages/core/src/connectors/opencode/hook-entry.js
packages/core/src/installers/opencode/installer.js
packages/core/test/*opencode*test.js
```

### Required capture

Only conversation truth for this refactor:

```text
user
assistant
```

Continue to ignore tool/file/todo lifecycle events unless a future task explicitly expands scope.

### Required workspace attribution

Use plugin event `cwd` / authoritative workspace value.

Resolve canonical RepoIdentityV1.

### Turn identity

If OpenCode did not supply turnId on user event, Bridge must generate canonical turnId through T03 path.

Assistant without turnId must use exact unambiguous session/workspace resolution.

### Capture-disable

Same first-line guard as Claude.

### Installer behavior

Installer writes managed user-level plugin file without opening OpenCode UI.

Do not modify unrelated OpenCode plugin files.

### Tests

- user+assistant same turn even without client turnId
- two OpenCode sessions do not cross
- two repos do not cross
- capture-disable writes nothing
- third-party plugins preserved

---

## T06 — Codex real workspace attribution + capture-disable

### Critical current bug

Do not infer repo by:

```js
resolveRepoContext(path.dirname(sessionFile))
```

The Codex rollout/session JSONL directory is Codex runtime storage, not the user's development repository.

### Files

```text
packages/core/src/connectors/codex/hook-entry.js
packages/core/src/connectors/codex/session-parser.js
packages/core/src/connectors/codex/cursor-store.js
packages/core/src/installers/codex/installer.js
packages/core/test/codex-capture-test.js
packages/core/test/fixtures/...codex...
```

### Authoritative cwd sources

Parser must inspect Codex rollout records and extract workspace cwd from session metadata.

Expected semantic sources include:

```text
session_meta.payload.cwd
turn_context.payload.cwd
```

A later verified `turn_context` cwd may update the active workspace for subsequent events if Codex supports cwd changes.

The `notify` payload is a wake-up signal; do not assume it always carries cwd.

### Required session parser output

Extend parser to expose metadata records separately from messages, or return a normalized stream such as:

```js
{
  kind: 'session_meta',
  cwd,
  ...
}

{
  kind: 'turn_context',
  cwd,
  ...
}

{
  kind: 'message',
  role,
  text,
  turnId,
  ...
}
```

### Cursor store

Persist verified session attribution:

```js
{
  sessionId,
  filePath,
  byteOffset,
  activeCwd,
  repoIdentity,
  lastRecordKey,
  ...
}
```

Never change workspace identity based on session-file location.

### If no authoritative cwd exists

Do not guess.

Persist capture gap such as:

```text
codex-workspace-unresolved
```

Message event may remain with repoIdentity null if useful for global diagnostic history, but it must not become Project-Knowledge project evidence.

### Capture-disable

Because notify shim may run as a child process, ensure the capture-disable environment propagates and the connector checks it before parsing/journal append.

### Required multi-repo test

Create real or fixture session streams:

```text
Session A: cwd = CCS
Session B: cwd = CCB
A user
B user
A assistant
B assistant
```

Assert:

- all A records = CCS workspaceId
- all B records = CCB workspaceId
- zero cross attribution
- no mtime-based selection

### Cwd change test

If `turn_context` changes cwd:

- subsequent event uses new authoritative workspace identity
- prior events remain unchanged
- behavior documented and deterministic

---

## T07 — Stable `createBridge()` public facade

### Problem

Project-Knowledge expects a stable Bridge facade, while current package public index mainly exposes lower-level classes/functions.

### Files

```text
packages/core/src/core/bridge.js        # create if absent
packages/core/src/index.js
packages/core/package.json
packages/core/test/*bridge*test.js
```

### Required facade

```js
const bridge = createBridge({ homeDir });
```

Required host-facing methods:

```js
getHighWatermark(context?)
readEvents({ fromSequence, toSequence, limit, filter? })
appendCommitBoundary({
  projectId,
  repoIdentity,
  commitSha,
  parentShas,
  branch,
  committedAt,
  operationId
})
registerConsumer(name, meta?)
getConsumer(name)
listConsumers()
ackConsumerCursor(name, sequence)
unregisterConsumer(name)
compact({ throughSequence? })
getHealth()
```

If method naming differs slightly, modify Project-Knowledge only after this contract is frozen. Do not expose callers directly to Bridge filesystem internals.

### Commit boundary semantics

`appendCommitBoundary` must remain atomic under the same journal sequence lock as events.

It must return at least:

```js
{
  sequence,
  bridgeCursorAtCommit: sequence,
  openTurnIdsAtCommit,
  previousRepoBoundarySequence,
  committedAt
}
```

`openTurnIdsAtCommit` must be limited to exact same workspace identity.

### Export installers

Public package should expose supported installer interfaces for all three clients, not only Claude.

Prefer an organized API, e.g.:

```js
installers: {
  claudeCode,
  codex,
  openCode
}
```

or named exports. Freeze and test it.

---

## T08 — Separate host consumer registration from connector installer lifecycle

### Current risk

Each client installer currently accepts `consumerName` and can unregister it. If Claude, Codex and OpenCode all represent the same Project-Knowledge host consumer, uninstalling only one connector must not unregister the host globally.

### Required ownership

Host-level:

```text
Project-Knowledge registers consumer "project-knowledge" once.
```

Connector-level:

```text
install Claude hook
install Codex notify
install OpenCode plugin
```

These must not own the lifetime of the global host consumer.

### Required API direction

Connector installers should support installation without automatically changing host consumer registration.

Backward compatibility may be kept if needed, but Project-Knowledge new integration path must explicitly own consumer registration.

### Uninstall behavior

```text
Disable Claude capture only:
  remove Claude managed hook
  KEEP project-knowledge consumer

Disable Codex capture only:
  remove managed notify
  KEEP project-knowledge consumer

Disable OpenCode capture only:
  remove managed plugin
  KEEP project-knowledge consumer

Disable all Project-Knowledge capture / uninstall host:
  after connector cleanup, unregister project-knowledge consumer
```

### Tests

- install three connectors + one consumer
- remove one connector -> consumer remains
- remove second -> remains
- disable host/all -> consumer removed
- other consumer (e.g. DevTask-Radar) prevents destructive shared runtime removal

---

## T09 — Bridge compaction and health API

### Files

```text
packages/core/src/core/consumer-registry.js
packages/core/src/core/compaction.js
packages/core/src/core/journal.js
packages/core/src/core/bridge.js
packages/core/test/consumer-cursor-compaction-test.js
```

### Required health

Return enough information for host UI/diagnostics:

```js
{
  journalSizeBytes,
  firstSequence,
  lastSequence,
  minConsumerAck,
  consumers: [
    { name, ack, lastSeenAt }
  ]
}
```

If practical:

```text
oldestUnackedAt
```

### Compaction rule

Only compact through:

```text
min(all registered consumer ack)
```

Never compact unacked records to satisfy size threshold.

### No-consumer behavior

Do not silently delete all journal data merely because zero consumers are registered. Preserve current conservative behavior unless explicitly designed otherwise.

### Suggested warning thresholds for Project-Knowledge UI

Not Bridge deletion policy:

```text
journal >= 256 MiB
or consumer lag >= 7 days
```

These values are warnings only and may be configurable.

### Stage A Gate

Run Bridge full suite:

```text
npm test
npm pack --workspace packages/core --dry-run
```

Do not proceed to Project-Knowledge if Bridge tests fail.

---

# Stage B — project-knowledge-base consumes Bridge and removes internal capture

## T10 — Add Bridge dependency and align BridgeAdapter

Repository:

```text
SanQianX/project-knowledge-base
```

### Inspect

```text
package.json
package-lock.json
_site/lib/bridge-adapter.js
_site/_test/bridge-adapter-test.js
_site/lib/contracts.js
```

### Required dependency

Add released/local-workspace compatible dependency on:

```text
@sanqianx/ai-coding-event-bridge
```

Do not invent a fake published version. During two-repo development use the package/workspace/file strategy intended by the development environment, then lock final release version only when available.

Update lockfile consistently.

### BridgeAdapter

Use `createBridge()` facade only.

Do not directly construct Bridge Journal or read its internal files.

Adapter should expose PK-facing methods such as:

```js
isAvailable()
getHighWatermark()
readEvents(...)
appendCommitBoundary(...)
registerConsumer(...)
getConsumer(...)
ackConsumerCursor(...)
compact(...)
getHealth()
```

Preserve fail-open/gap behavior around missing Bridge.

### RepoIdentity contract

Update PK contracts to accept RepoIdentityV1 object.

Do not continue generating a conflicting PK-only object shape.

Legacy stored `{commonDir}` values may require read compatibility/migration but new data must use v1.

### Tests

Contract tests must use the real facade shape rather than a mock with old mismatched semantics where possible.

---

## T11 — Create `BridgeConsumerService`

### Create

```text
_site/lib/bridge-consumer-service.js
```

### Wire into

```text
_site/lib/server-app.js
```

and relevant runtime startup/shutdown hooks.

### Required class API

```js
class BridgeConsumerService {
  start()
  stop()
  drain(reason)
  drainThrough(sequence, reason)
  status()
}
```

Consumer name:

```text
project-knowledge
```

### Exact drain algorithm

1. Read Project-Knowledge consumer registration/cursor from Bridge.
2. Determine Bridge high watermark.
3. Read records in ascending sequence, bounded batches.
4. Process each sequence exactly once logically; physical duplicates must be idempotent.
5. For a conversation event:
   - validate canonical schema;
   - if `repoIdentity.workspaceId` missing => deterministic non-project skip with diagnostic/gap as appropriate;
   - resolve registered Project-Knowledge project by exact workspaceId;
   - one match => durable `ConversationStore.appendBridgeEvent(projectId, record)`;
   - zero matches => `unregistered-workspace` deterministic skip;
   - multiple matches => configuration corruption/ambiguity; record gap and STOP ACK at this sequence until resolved. Do not randomly select one.
6. Commit-boundary records are not blindly copied into every project. Existing post-commit path owns project boundary freezing; consumer may observe/skip them as transport records according to final contract.
7. Advance consumer ACK only after a contiguous sequence is fully handled.
8. If event persistence fails, do not ACK beyond failed sequence.
9. After successful ACK, request safe Bridge compaction.
10. Notification callback only invokes `drain`; notification body is not conversation truth.

### Concurrency

`drain()` calls must coalesce/serialize.

Required properties:

- startup drain overlapping notification drain does not race
- duplicate notify does not duplicate event
- commit `drainThrough` can wait/join in-flight drain safely

### Project matching index

Do not repeatedly scan expensive Git state for every event if avoidable.

Build/refresh a map:

```text
workspaceId -> projectId
```

from imported Project configs/state.

If project path moves/rebinds, lifecycle service must update canonical identity deliberately.

### Logging

No full prompt bodies in normal structured logs.

Log hashes/ids/counts:

```text
sequence
workspaceId
projectId
source
eventId
contentHash
```

---

## T12 — Import establishes conversation baseline

### Inspect

```text
_site/lib/project-lifecycle-service.js
_site/lib/project-store.js
_site/lib/project-registry-store.js
_site/lib/bridge-adapter.js
relevant import tests
```

### Required import behavior

When a project is first imported:

1. inspect Git workspace canonical RepoIdentityV1;
2. read current Bridge high watermark;
3. persist workspace identity in project config/state;
4. persist:

```text
conversationBaselineCursor = current Bridge high watermark
```

5. do not import pre-baseline Bridge conversations;
6. do not trigger AI analysis just because project was imported;
7. do not write placeholder Development Conversation.

### Offline/unavailable Bridge

If Bridge unavailable at import:

- preserve current import success if product policy allows;
- record conversation capture baseline as unavailable/gap;
- on later recovery do not silently backfill arbitrary old global history.

Define deterministic recovery policy, recommended:

```text
first successful Bridge attachment establishes baseline at then-current high watermark
```

unless there is an already persisted trusted baseline.

### Tests

- import CCS after Bridge already contains old CCS events -> old events not projected
- new CCS event after import -> projected
- CCB events before/after -> skipped

---

## T13 — Commit boundary: append -> drainThrough -> bind -> freeze

### Inspect

```text
_site/lib/post-commit-automation.js
_site/lib/commit-reconciler.js
_site/lib/commit-conversation-binder.js
_site/lib/conversation-store.js
_site/lib/bridge-adapter.js
```

### Required ordering

For each commit:

```text
A. append atomic Bridge commit boundary
B. obtain boundary sequence/cursor
C. BridgeConsumerService.drainThrough(boundary sequence)
D. persist/freeze project boundary
E. CommitConversationBinder.bind()
F. freeze CommitConversationSnapshot
G. build analyzer evidence
H. run Knowledge Analyzer
```

Equivalent safe ordering is allowed only if it preserves the key invariant:

> Before snapshot binding, all Bridge event sequences <= boundaryEndCursor that belong to this project are either in ConversationStore or deterministically processed.

### Binder repo filter

`repoMatches()` must primarily compare:

```text
workspaceId
```

Legacy fallback only for old stored records and never for new automatic data.

### Binder confidence

Automatic direct events bind only if:

```text
identityConfidence === exact
```

Explicit fallback may bind if:

```text
identityConfidence === explicit
```

Read-compat for old `high` / `trusted` may translate to exact only for old known schema/version data.

### Sequence window

For normal direct turns:

```text
startCursor < user.sequence <= endCursor
```

For every event included in frozen snapshot, including assistant:

```text
event.sequence <= endCursor
```

This is mandatory.

### Open turn at commit

If user prompt began before/inside window and turn is still open at boundary:

- include user evidence up to boundary according to existing `shared-spanning` semantics;
- include assistant evidence only if it was already persisted at/before boundary;
- never add a future assistant reply later when reading an already frozen snapshot.

### No CCS conversation

If CCS commit has no valid same-workspace turn:

```text
no-new-user-prompt / unavailable / ambiguous
```

according to deterministic status.

Never substitute CCB or other repo conversation.

### Tests

- CCB event immediately before CCS commit not included
- assistant after commit boundary not included in CCS snapshot
- assistant before boundary included
- open spanning turn deterministic
- future prompts excluded
- restart preserves frozen snapshot hash

---

## T14 — Delete wrong embedded Workbench capture path

### Current wrong path to remove

In current `server-app.js` there is embedded capture code using concepts such as:

```text
recordEmbeddedClaudeInput
subscribeEmbeddedConversation
embeddedConversationCaptures
embeddedConversationSubscriptions
embedded-assistant-<requirementId>
rawEventType = embedded-claude-result
```

This is the wrong Development Conversation source.

### Files

```text
_site/lib/server-app.js
_site/lib/requirement-adapters.js
related Workbench tests
requirement tests
conversation tests
```

### Required behavior after change

Workbench request path:

```text
UI -> claudeCliRunner.sendInput()
```

It must not automatically call RequirementRecorder/ConversationStore merely because user sent a Workbench chat message.

### Keep

`RequirementRecorder` must remain for:

- explicit MCP fallback/supplement
- legacy requirement migration
- any explicitly requested record_requirement workflow

Do not delete RequirementRecorder broadly.

### Tests

- Workbench user message -> zero new Development Conversation events
- Workbench assistant result -> zero new events
- explicit record_requirement still works

---

## T15 — Explicitly disable Bridge capture for all internal Claude SDK sessions

### Files

```text
_site/lib/claude-cli-runner.js
_site/lib/server-app.js
knowledge analyzer runner/wrapper if separate
Workbench/analyzer tests
```

### Required environment markers

Every Project-Knowledge internal Claude Agent SDK invocation must receive:

```text
AI_CODING_EVENT_BRIDGE_CAPTURE=0
AI_CODING_EVENT_ORIGIN=project-knowledge-internal
```

Do not rely on global `process.env` mutation if concurrent external/other activity could be affected. Add these variables to the child/SDK environment for the specific internal session.

### Applies to

- first Workbench chat turn
- Workbench follow-up/resume
- manual analysis
- post-commit Knowledge Analyzer
- retries
- resumed analyzer sessions
- any other PK-owned Claude SDK session

### Tests

- internal SDK options contain markers
- Bridge hook fixture invoked with inherited marker returns ignored
- analyzer does not append Bridge journal event

---

## T16 — ConversationStore becomes project-scoped Bridge projection

### Files

```text
_site/lib/conversation-store.js
_site/lib/contracts.js
_site/lib/conversation-query-service.js
_site/lib/commit-conversation-binder.js
conversation tests
```

### Add API

```js
appendBridgeEvent(projectId, bridgeEvent)
```

Responsibilities:

1. require canonical Bridge event schema
2. preserve global Bridge `eventId`
3. preserve global Bridge `sequence`
4. preserve canonical RepoIdentityV1
5. compute/verify PK contentHash
6. idempotently deduplicate by eventId
7. if same eventId different content => DATA_CORRUPT

### Do not

- assign a new local sequence
- rewrite turnId
- rewrite repoIdentity based on projectId
- silently accept event for different workspace

### Project match assertion

If project config has canonical workspaceId and incoming exact event has a different workspaceId, append must reject rather than store contamination.

### Query

Conversation Explorer may continue reading project-scoped store. Do not make the UI scan the global Bridge journal directly.

---

## T17 — Legacy embedded Workbench data exclusion

### Goal

New behavior must be clean without silently destroying historical evidence files.

### Identify old internal capture

Known markers include:

```text
eventId = explicit-<requirementId>
eventId = embedded-assistant-<requirementId>
rawEventType = embedded-claude-result
legacyRequirementId
```

Inspect actual current records/schema before implementing.

### Required migration approach

Preferred:

```text
conversation-exclusions/v1
```

or equivalent explicit migration/exclusion manifest.

It should record event IDs excluded from future **Development Conversation presentation and new commit binding** because they were generated by the old embedded Workbench capture path.

### Do not

- rewrite existing immutable CommitConversationSnapshot
- delete historical JSONL lines in-place
- reinterpret old snapshots as if they had never happened

### New read API

Prefer a centralized function:

```js
readDevelopmentEvents(projectId)
```

that applies exclusions once, used by:

- ConversationQueryService
- future CommitConversationBinder

Do not duplicate filtering conditions in UI and binder separately.

### Explicit legacy requirement

Do not accidentally exclude genuine explicit MCP requirement records that were not part of an embedded Workbench pair.

Tests must distinguish them.

---

## T18 — Unified Project-Knowledge Integration Setup

### User experience requirement

User must NOT need to manually open Claude Code / Codex / OpenCode and install MCP/listener inside each UI.

The user performs one Project-Knowledge Integration Setup operation.

Project-Knowledge may invoke installed client CLIs or modify their supported user-level config files programmatically.

### Important separation

One UI action manages two separate capabilities:

#### Knowledge Integration

For external agent to query Project-Knowledge:

```text
MCP
Skill
plugin/instructions
```

#### Development Capture

For external conversation capture:

```text
Claude Code -> managed UserPromptSubmit + Stop hooks
Codex       -> managed notify shim
OpenCode    -> managed plugin
```

They must not be conflated in status/error reporting.

### Files

```text
_site/lib/integration-installer.js
bin/project-knowledge-integrations.js
server API routes for integrations
UI settings/integration status area
package.json/package-lock.json
related integration tests
```

### Required high-level API

Each client should expose status like:

```js
{
  client: 'claude',
  available: true,
  knowledgeIntegration: {
    installed: true,
    detail: '...'
  },
  developmentCapture: {
    installed: true,
    detail: '...'
  }
}
```

Global Bridge status:

```js
{
  consumerRegistered: true,
  bridgeHealthy: true,
  ...health
}
```

### Install All algorithm

1. Ensure Bridge runtime available.
2. Register host consumer `project-knowledge` once.
3. Detect installed clients.
4. For each selected/available client:
   - install/update Knowledge Integration
   - install/update Development Capture connector
5. Return per-component status.
6. Partial failure does not roll back unrelated third-party client settings.
7. A connector failure must not break the AI client itself.

### Claude

Programmatically install/update:

- existing Project-Knowledge plugin/MCP/Skill integration
- Bridge user-level hooks in `~/.claude/settings.json`

No user interaction inside Claude Code required.

### Codex

Programmatically install/update:

- Project-Knowledge integration
- Bridge notify in `~/.codex/config.toml`

If third-party `notify` already exists and Bridge installer cannot compose safely:

- report explicit conflict
- do not overwrite
- do not claim Development Capture installed
- keep Knowledge Integration independent

### OpenCode

Programmatically install/update:

- PK MCP/Skill/instructions
- Bridge managed OpenCode plugin

Preserve third-party config/plugins.

### Uninstall

Per-client uninstall removes only that client's PK integration/capture as requested.

Do not unregister host Bridge consumer merely because one connector is removed.

Global “disable Project-Knowledge development capture” may unregister host consumer after selected connector cleanup.

### Status UI

Show separately, e.g.:

```text
Claude Code
  Knowledge Integration   Installed
  Development Capture     Installed

Codex
  Knowledge Integration   Installed
  Development Capture     Conflict: third-party notify

OpenCode
  Knowledge Integration   Installed
  Development Capture     Installed

Bridge
  Consumer                project-knowledge
  Journal                 Healthy
```

---

## T19 — Capture health/status without UI redesign

### Scope

Do not redesign Workbench or Control Center.

Only add enough status to diagnose capture.

### Display/endpoint fields

Recommended:

```text
Bridge healthy/unavailable
journalSizeBytes
firstSequence
lastSequence
projectKnowledgeAck
minConsumerAck
consumerLag
lastDrainAt
lastDrainReason
lastDrainErrorCode
Claude capture installed
Codex capture installed/conflict
OpenCode capture installed
```

Prompt bodies must not appear in health endpoint/logs.

### Warnings

UI warning only, no destructive auto-delete:

```text
journal >= 256 MiB
or
consumer lag >= 7 days
```

---

# Stage C — mandatory gates

## T20 — CCS/CCB cross-repository isolation E2E

Implement tests exactly matching `03-ACCEPTANCE-GATES.md` GATE CROSS-REPO-001 and related cases.

No release if this gate fails.

---

## T21 — Claude / OpenCode / Codex E2E + restart behavior

At minimum cover:

- Claude external capture
- OpenCode external capture
- Codex external capture
- notification lost, startup drain recovers
- duplicate notify idempotent
- Bridge unavailable fail-open
- Project-Knowledge offline accumulation then drain
- unimported workspace deterministic skip
- internal Workbench excluded
- internal Knowledge Analyzer excluded
- frozen snapshot boundary exactness

---

## T22 — Final audit

### Both repos

Run full test suites.

Bridge:

```text
npm test
npm pack --workspace packages/core --dry-run
npm pack --workspace packages/ui --dry-run
```

Project-Knowledge:

```text
npm test -- --no-report
npm pack --dry-run --json
```

Also:

```text
git diff --check
```

### Audit checklist

Search final code for forbidden remnants:

```text
embedded-claude-result
subscribeEmbeddedConversation
recordEmbeddedClaudeInput
unknown-session
resolveRepoContext(path.dirname(filePath))   # Codex bad fallback
identityConfidence: 'high'                   # new automatic paths
identityConfidence: 'trusted'                # new automatic paths
```

Some strings may remain in migration/legacy tests; if so verify they are legacy-only.

Search for internal SDK capture markers and ensure all paths inherit them.

Inspect every changed file; remove accidental unrelated changes.

### Final report required from Agent

GLM must return:

1. final architecture summary
2. per-task PASS/FAIL table
3. files changed per repository
4. tests run and counts
5. explicit CCS/CCB gate result
6. explicit Workbench/Analyzer exclusion result
7. CI CDP fast-failure result
8. known residual risks
9. migration/backward-compat notes
10. exact commands required by maintainer to install/test integrations

Do not say “done” without this report.
# 03 — MANDATORY ACCEPTANCE GATES

No task may be declared complete only because unit tests pass. The following behavior gates are mandatory.

---

# GATE CI-001 — Browser/CDP failure must fail fast

## Setup

Use deterministic fake browser executable/process.

## Action

Call `launchCdpBrowser()` and make the fake process fail before exposing CDP.

## Assertions

- launch rejects quickly
- error explains browser exit/CDP startup failure
- stderr/exit diagnostics captured
- no child remains alive
- profile directory cleaned
- test does not wait for outer 300-second timeout

PASS required before all Development Conversation work.

---

# GATE CROSS-REPO-001 — CCS imported, CCB unimported

## Setup

Create two actual Git workspaces:

```text
/tmp-or-windows-temp/CCS
/tmp-or-windows-temp/CCB
```

They must have different workspaceId values.

Import **only CCS** into Project-Knowledge.

Record CCS conversation baseline after import.

## Phase A — develop in unimported CCB

Generate Bridge events equivalent to a real external client session:

```text
workspace = CCB
source = claude-code
user      = "Modify CCB parser"
assistant = "CCB parser modified"
```

Drain Project-Knowledge consumer.

## Assertions A

```text
CCS ConversationStore event count == 0
```

No Project-Knowledge CCB project conversation directory/store is created merely because Bridge observed CCB.

Bridge consumer ACK advances through deterministic skipped CCB events.

## Phase B — develop in imported CCS

Generate:

```text
workspace = CCS
user      = "Modify CCS autofocus"
assistant = "CCS autofocus modified"
```

Drain.

## Assertions B

```text
CCS ConversationStore contains exactly the CCS turn
CCS store does not contain "Modify CCB parser"
```

## Phase C — commit CCS

Create real CCS Git commit and append real commit boundary.

Drain through boundary then bind snapshot.

## Assertions C

Snapshot:

```text
projectId = CCS project id
repoIdentity.workspaceId = CCS workspaceId
contains "Modify CCS autofocus"
does not contain "Modify CCB parser"
```

Analyzer evidence must use this snapshot only.

## Phase D — second CCS commit without new CCS conversation

Optionally create new CCB conversation immediately before CCS commit.

Commit CCS again.

## Assertions D

New CCS snapshot must not pull recent CCB conversation as fallback.

Expected status may be:

```text
no-new-user-prompt
```

or another deterministic no-evidence status, but never CCB substitution.

---

# GATE CROSS-REPO-002 — same remote, different clones

Create:

```text
clone-A/CCS
clone-B/CCS
```

with same origin remote.

Assertions:

```text
workspaceId A != workspaceId B
```

Import only clone A.

Conversation in clone B must not enter clone A project.

Remote equality must not override workspace identity.

---

# GATE WORKTREE-001 — Git worktrees

Create one repository and two worktrees sharing commonDir.

Assertions:

```text
commonDir may be equal
workspaceRoot differs
workspaceId differs
```

Import one worktree only.

Conversation in the other worktree must not be auto-bound.

---

# GATE NESTED-CWD-001 — subdirectory inside same repo

Run external conversation from:

```text
CCS/modules/foo
```

where `foo` is not a nested Git repo.

Assertions:

```text
workspaceRoot == CCS root
workspaceId == imported CCS workspaceId
```

Conversation is correctly persisted to CCS.

---

# GATE CLIENT-CLAUDE-001 — external Claude Code

Simulate/use fixture for:

```text
UserPromptSubmit
Stop(last_assistant_message)
```

Assertions:

- source = claude-code
- exact workspace identity
- user has canonical turnId
- assistant has same durable turnId
- sequence user < assistant
- Project-Knowledge receives both for imported repo

---

# GATE CLIENT-OPENCODE-001 — external OpenCode without client turnId

Input OpenCode events:

```text
user: session S, turnId null
assistant: session S, turnId null
```

Assertions:

- Bridge generates canonical turnId for user
- Bridge assigns same turnId to assistant when unambiguous
- durable records contain resolved turnId
- Project-Knowledge groups as one turn

---

# GATE CLIENT-CODEX-001 — two concurrent Codex workspaces

Create rollout fixtures with authoritative metadata:

```text
Session A session_meta.cwd = CCS
Session B session_meta.cwd = CCB
```

Interleave:

```text
A user
B user
A assistant
B assistant
```

Assertions:

- A always CCS workspaceId
- B always CCB workspaceId
- session file location does not affect attribution
- mtime does not affect attribution

---

# GATE CLIENT-CODEX-002 — Codex workspace unresolved

Create Codex session where no authoritative cwd can be parsed.

Assertions:

- no guessed repoIdentity
- capture gap recorded
- event cannot be projected into imported CCS merely because CCS is current/last project
- consumer can deterministically skip/unassign according to contract

---

# GATE INTERNAL-001 — Project-Knowledge Workbench excluded

Start Project-Knowledge internal Workbench session.

Record Bridge last sequence before.

Send user input and obtain assistant result.

Assertions:

```text
Bridge last sequence unchanged by Workbench conversation
Project ConversationStore event count unchanged
```

Explicit RequirementRecorder is not called automatically by Workbench message.

---

# GATE INTERNAL-002 — Knowledge Analyzer excluded

Prepare imported CCS with one real external turn and one commit.

Trigger post-commit Knowledge Analyzer.

Record Bridge sequence just before analyzer starts and after it ends.

Assertions:

Analyzer itself produces zero new Development Conversation events.

Snapshot evidence remains external conversation + Git/retrieval evidence only.

---

# GATE BOUNDARY-001 — future assistant must not enter frozen snapshot

Sequence:

```text
100 user prompt
101 commit boundary
102 assistant response
```

Freeze commit snapshot after 102 exists globally to simulate delayed binder execution.

Assertion:

Snapshot may contain user event 100 according to binding rules, but MUST NOT contain assistant event 102 because:

```text
102 > boundaryEndCursor 101
```

This gate catches time-of-binding contamination.

---

# GATE BOUNDARY-002 — assistant before boundary may enter

Sequence:

```text
100 user
101 assistant
102 commit boundary
```

Snapshot may include both 100 and 101 if workspace/turn rules match.

---

# GATE BASELINE-001 — import does not backfill old global conversation

Before import:

```text
Bridge 1..20 includes CCS conversations
```

Import CCS at high watermark 20.

After import:

```text
Bridge 21 user CCS
Bridge 22 assistant CCS
```

Drain.

Assertions:

- PK store contains 21/22
- PK store does not backfill 1..20 by default
- baseline cursor persisted

---

# GATE OFFLINE-001 — Project-Knowledge offline

Stop/disable Project-Knowledge consumer process while Bridge remains installed.

Generate external imported-repo events.

Restart Project-Knowledge.

Assertions:

- startup drain recovers events from consumer ACK
- order preserved
- no duplicates
- no event loss caused by missed notification

---

# GATE NOTIFY-001 — notifications are wake-up only

Send duplicate/fake wake-up notifications without altering journal.

Assertions:

- no fabricated event is created from notification body
- consumer simply drains journal
- duplicate notification is idempotent

---

# GATE ACK-001 — contiguous ACK

Journal:

```text
100 persist success
101 forced persist failure
102 would succeed
```

Drain.

Assertion:

Consumer ACK must not advance beyond 100.

After removing failure and retrying:

ACK may advance through 102.

---

# GATE COMPACT-001 — multi-consumer safety

Consumers:

```text
project-knowledge ack = 200
devtask-radar    ack = 150
```

Compaction request through 200.

Assertion:

Only <=150 may be compacted.

After radar ACK 200, <=200 may compact.

---

# GATE INSTALL-001 — one Project-Knowledge setup, no manual client UI

Using isolated home/config fixtures:

Invoke Project-Knowledge Integration Setup.

Assertions:

### Claude

- knowledge integration installed/represented
- managed Bridge hooks written to Claude user config
- no manual Claude interactive step required

### Codex

- knowledge integration installed/represented
- managed notify written when no conflict
- no manual Codex interactive step required

### OpenCode

- PK MCP/Skill/instruction installed
- Bridge managed plugin installed
- no manual OpenCode interactive step required

### Status

Each client reports Knowledge Integration and Development Capture separately.

---

# GATE INSTALL-002 — third-party config preservation

Seed:

- Claude third-party hook
- OpenCode third-party plugin/instruction
- Codex third-party notify

Run install/update/uninstall.

Assertions:

- Claude third-party hook preserved
- OpenCode third-party files preserved
- Codex Bridge reports notify conflict and does not overwrite third-party notify
- Knowledge Integration may remain installed independently of Codex capture conflict

---

# GATE INSTALL-003 — consumer lifecycle

Register Project-Knowledge once and install all three connectors.

Uninstall only Claude connector.

Assertion:

```text
project-knowledge consumer still registered
```

Repeat for Codex/OpenCode.

Only global disable/uninstall of PK capture may unregister host consumer.

Other registered consumers must remain untouched.

---

# GATE LEGACY-001 — old Workbench data migration

Seed old project conversation with:

```text
explicit-REQ1
embedded-assistant-REQ1
rawEventType embedded-claude-result
```

Also seed a genuine explicit requirement not paired with embedded assistant.

Run migration/exclusion.

Assertions:

- old embedded Workbench pair excluded from new Development Conversation UI/binding
- genuine explicit requirement remains available as explicit evidence
- old frozen commit snapshot files are byte/hash unchanged unless explicit maintenance command is invoked

---

# FINAL RELEASE GATE

All mandatory gates plus both full test suites must pass.

Agent must output a table:

```text
Gate                  Result
CI-001                PASS
CROSS-REPO-001        PASS
...
LEGACY-001            PASS
```

Any missing mandatory gate = NOT DONE.
