# 04 — Advanced Feature Restoration Pipeline (T20–T24)

Do not begin these tasks until P0/P1 pipeline is green. These are valuable, but they must not destabilize the primary commit workflow.

---

## T20 — Restore advanced AI Profile management and profile test

### Goal
Restore user control that existed in v4.1.22 while keeping current profile schema.

### Restore where supported
- provider/vendor;
- model;
- API base URL;
- API key update/remove semantics;
- context/model-specific options already present in schema/runtime;
- default profile selection;
- per-project assignment;
- connection/profile test using a deterministic test seam in automated tests.

### Do not
Invent fields no longer supported by the actual runtime.

### Critical
T01 effective resolver remains single source of profile selection truth.

---

## T21 — Restore Embedding configuration/status/download UX

### Goal
Restore management of the current local embedding service.

### Current architecture constraints
- use current `LocalEmbeddingService` / current settings schema;
- do not restore removed standalone `embedding-config.js` merely for nostalgia;
- model cache path must follow current StorageLayout/cache conventions.

### UI/API capabilities where supported
- model ID;
- remote host;
- local model path;
- local-files-only/offline;
- model availability/status;
- explicit download/prepare operation;
- clear errors.

### Tests
Use fake/local fixture; no network in standard unit tests.

---

## T22 — Restore Knowledge Store Git options if compatible

### Goal
Restore remote/branch/autoCommit/autoPush management only if it still applies to the current authoritative knowledge root design.

### Required evaluation first
Determine whether current `StorageLayout` and user-selected knowledge root still safely support this feature.

If yes, restore using current root and safe Git operations.

If no, mark this capability as intentionally redesigned/blocked and document exact reason. Do not add an unrelated second clone/repository.

### Tests if implemented
local bare remote only; no internet.

---

## T23 — Restore Maintenance UX on new architecture

### Goal
Restore useful maintenance capabilities without resurrecting old DB ownership.

### Allowed operations
- audit Markdown knowledge structure;
- report project/file issues;
- create explicit backups before destructive maintenance;
- rebuild derived LanceDB index through `IndexService` only;
- retry dirty indexes;
- display index dirty/healthy status.

### Forbidden
- direct LanceDB writes outside `IndexService`;
- old vector migration service if it bypasses new index ownership;
- silent rewriting of immutable commit snapshots.

### Tests
- Markdown audit read-only;
- rebuild uses IndexService;
- failed rebuild leaves Markdown untouched and dirty state observable;
- backup/restore boundaries safe.

---

## T24 — Restore Desktop update controls and optional Workbench conveniences

### Goal
Restore remaining low-risk product conveniences.

### Desktop update UI
Reconnect existing Desktop preload/app-updater capabilities:
- current version;
- check update;
- available version;
- download/install actions where current desktop service supports them;
- web mode shows not available instead of broken buttons.

### Workbench conveniences
Only if current Claude runner exposes reliable data:
- session restore/list;
- token usage;
- slash commands.

Do not invent fake UI data.

### Tests
- Desktop IPC fake tests;
- web mode capability detection;
- no update operation in unit tests reaches internet.
