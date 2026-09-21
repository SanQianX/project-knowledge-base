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
