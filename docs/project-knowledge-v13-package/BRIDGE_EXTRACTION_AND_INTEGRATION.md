# BRIDGE_EXTRACTION_AND_INTEGRATION.md

## 1. 审查结论

公共能力应从 `SanQianX/DevTask-Radar@33ab03a...` 抽离为独立 public repo `SanQianX/ai-coding-event-bridge`。禁止复制 connector 到 Project Knowledge，禁止 Project Knowledge 生产依赖 private DevTask-Radar。

当前可复用证据：Claude Code 已有 UserPromptSubmit/Stop hooks；Codex 有 notify + session-jsonl parser；OpenCode 有 plugin event bridge；EventNormalizer/TurnAggregator 已具备规范化雏形。当前不能原样搬出的部分：HTTP 8787 硬编码、silent catch、`unknown-session`、synthetic user prompt、Codex global latest-session、DevTask integration state/SQLite/analysis scheduler。

## 2. Repo / workspace layout

```text
SanQianX/ai-coding-event-bridge  (public)
├─ package.json                  # npm workspaces, private:true root
├─ packages/
│  ├─ core/                      # @sanqianx/ai-coding-event-bridge
│  │  ├─ src/core/
│  │  │  ├─ event-schema.js
│  │  │  ├─ repo-context.js
│  │  │  ├─ turn-identity.js
│  │  │  ├─ journal.js
│  │  │  ├─ consumer-registry.js
│  │  │  ├─ compaction.js
│  │  │  └─ dispatcher.js
│  │  ├─ src/connectors/{claude-code,codex,opencode}/
│  │  ├─ src/installers/{claude-code,codex,opencode}/
│  │  ├─ src/query/
│  │  ├─ bin/ai-coding-event-bridge.js
│  │  └─ package.json
│  └─ ui/                        # @sanqianx/ai-coding-event-bridge-ui
│     ├─ src/ConversationExplorer.js
│     ├─ src/TurnCard.js
│     ├─ src/ProjectDateToolbar.js
│     ├─ src/VirtualTurnList.js
│     ├─ src/host-adapter.js
│     ├─ dist/
│     └─ package.json
├─ test/fixtures/
└─ .github/workflows/{ci.yml,publish.yml}
```

Core engine `>=18`. Keep CommonJS-compatible core because both current repos are CommonJS; add conditional ESM/browser exports where needed. UI must be framework-neutral; do not introduce React solely for this component.


## 2A. Per-user stable runtime — single Hook owner

Installing the same npm dependency in two hosts is not sufficient. The installer materializes one user runtime:

```text
~/.ai-coding-event-bridge/
├─ bin/
│  └─ bridge-hook.cjs          # stable path written into AI client configs
├─ runtime/
│  └─ <version>/...            # atomically activated implementation
├─ active-runtime.json
├─ consumers.json
├─ journal/
└─ locks/install.lock
```

Both Project Knowledge and DevTask-Radar call `registerConsumer()` under the install lock. Claude/Codex/OpenCode managed entries always point to `bin/bridge-hook.cjs`, never into either host `node_modules`. Unregistering one host preserves hooks while another active consumer exists. Active runtime upgrades are monotonic within a compatible major; no automatic downgrade. Major conflicts are reported without overwriting hooks.

## 3. Durable event model

```text
ai-coding-event/v1
- eventId
- sequence               # monotonic across one Bridge journal
- source                 # claude-code|codex|opencode
- eventType
- role                   # user|assistant|null
- content                # only for controlled business data
- repoIdentity
- projectPath
- sessionId|null
- turnId|null
- identityConfidence     # exact|partial|unavailable
- branch|null
- headAtCapture|null
- capturedAt             # diagnostic only, NOT ordering authority
- captureStatus          # complete|partial|gap
```

No `unknown-session`; no synthetic user content. If a client does not provide reliable identity, preserve null/partial status and let consumers degrade rather than invent truth.

## 4. Atomic commit boundary — P0 invariant

Both AI events and Git boundaries use the same journal writer and cross-process lock:

```text
appendEvent(event):
  lock journal
  validate/normalize
  sequence++
  append JSONL + fsync
  update open-turn projection/checkpoint
  unlock

appendCommitBoundary(repoIdentity, gitFacts):
  lock SAME journal
  flush/serialize all prior appends
  read open-turn projection under lock
  sequence++
  append {
    eventType: git_commit_boundary,
    sequence,
    repoIdentity,
    commitSha,
    parents,
    branch,
    openTurnIdsAtCommit,
    previousRepoBoundarySequence
  } + fsync
  unlock
```

This is the only allowed way to freeze commit conversation membership. `timestamp` is never used to resolve an ordering race.

## 5. Two different freezes

1. **Commit membership freeze** at boundary: determines which user Turns can belong to C.
2. **Analysis evidence freeze** at Project Knowledge Claim creation: freezes the exact user/assistant events available to the Analyzer at that moment and records `analysisConversationSnapshotHash`.

If assistant Stop arrives after C but before Claim, it may be included as same-Turn tail evidence. If it arrives after Claim, it updates ConversationStore/UI audit but does not mutate the frozen Claim or trigger automatic re-analysis.

## 6. Per-client connector requirements

### Claude Code
- Use UserPromptSubmit exact prompt and Stop `last_assistant_message` when present.
- Preserve existing third-party hooks; install only Bridge-managed command blocks.
- Hook must fail open for Claude, but durable append failure must be diagnosable locally.
- Suppress internal Project Knowledge/DevTask analysis sessions using explicit metadata/environment marker; text pattern is fallback only.

### Codex
Current DevTask implementation selecting the newest JSONL by mtime is forbidden.
- `notify` is a wake-up/event signal, not proof that global newest session is the right turn.
- Keep per-session state: file identity, byte offset, last event key/turn id, cwd/repo identity.
- Incrementally read only appended bytes; handle partial last line.
- Prefer stable session/turn/cwd fields present in verified runtime fixtures.
- If one notify cannot uniquely identify a single session, do not guess by mtime. Record capture gap/partial identity and retry deterministic discovery; Project Knowledge binding treats unresolved identity as unavailable.
- State update atomic + file lock.

### OpenCode
- Remove 8787 hard coding.
- Normalize user/assistant lifecycle from official plugin events/fixtures.
- Tool/file/todo events may remain optional diagnostic events; mature Explorer defaults to user/assistant only.

## 7. Consumer model and compaction

Each consumer has independent cursor:

```text
consumer project-knowledge -> ack 5810
consumer devtask-radar      -> ack 5792
minAck = 5792
```

No time-based deletion of unacked data. Compaction can rewrite/checkpoint only prefix <= minAck under journal lock. A consumer stops blocking compaction only after explicit unregister. A temporarily offline consumer is not auto-evicted.

## 8. Query/UI contract

Core headless query can support rich internal filters, but default `bridge-ui` explorer exposes only:
- one project selector
- one date selector
- ordered user Prompt + AI Reply
- optional host annotation text

Project Knowledge host annotation maps frozen commit snapshots to `已提交 / 关联提交 / 未提交`. The UI never recomputes binding. DevTask-Radar may keep a separate admin Activity Feed with source/session/tool detail; do not put those controls into default Explorer.

## 9. Project Knowledge integration

Internal paths:

```text
~/.project-knowledge/projects/<projectId>/conversation-events.jsonl
~/.project-knowledge/projects/<projectId>/commit-boundaries.jsonl
~/.project-knowledge/projects/<projectId>/commit-conversations/<sha>.json
```

Bridge remains capture truth; Project Knowledge mirrors events needed for long-term audit. Git Hook synchronously performs only short local Bridge boundary append; HTTP notification is best-effort wake-up. Server/startup reconciliation reads durable Git + boundary facts.

## 10. DevTask-Radar migration

Compatibility window:
1. Add characterization tests around current UI/task analysis.
2. Consume Bridge public APIs while old connector remains fallback.
3. After Bridge package is published and both consumers pass E2E, remove DevTask-owned Claude/Codex/OpenCode managed hook code and 8787-specific ingest coupling.
4. Task analysis/SQLite/calendar remain in DevTask-Radar.
5. Shared mature Conversation Explorer can replace duplicate conversation renderer; existing advanced Activity Feed may remain product-specific.

## 11. Package/release

Development uses `npm pack` tarballs/fixtures; consumers do not pin nonexistent registry versions. Final Wave A publishes Bridge core+ui first. Only after `npm view @sanqianx/ai-coding-event-bridge@<version>` and a clean temp install pass may Project Knowledge/DevTask pin that exact version.
