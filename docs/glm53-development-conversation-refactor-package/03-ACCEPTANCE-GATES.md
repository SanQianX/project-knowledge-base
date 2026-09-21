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
