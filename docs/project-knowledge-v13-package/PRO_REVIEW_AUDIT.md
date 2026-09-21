# PRO_REVIEW_AUDIT.md

## 1. Audit scope and source baselines

This review used the user-supplied v12 Plan, UI v10 preview, the requirements confirmed across this conversation, and source inspection at these repository heads:

- `SanQianX/project-knowledge-base` — `main@88e795df55eca26ce301e0e3c7615e894e7d0de8`, `project-knowledge@4.1.23`.
- `SanQianX/DevTask-Radar` — `main@33ab03a1de4fccb9b1b27610e6ff9e32d9b5e0d4`, `devtask-radar@0.1.4`, private at audit time.
- UI reference — user-supplied `project-knowledge-base-faithful-repair-ui-v10.html`.

Execution agents must re-resolve remote HEADs immediately before development. These SHAs are audit evidence, not permission to overwrite later changes.

## 2. Requirement coverage audit

| Conversation requirement | v13 contract | Architecture | Mechanical commits | Canonical tests / gate | Result |
|---|---|---|---|---|---|
| Only Git post-commit + startup analysis triggers | P-01/P-02, R-TRG | CommitReconciler | PK10/PK12/PK17 | TS-01..08, TS-11 | Covered; stale v12 “5 current triggers” corrected |
| Import never performs AI init analysis | P-03/P-04 | Lifecycle + tracking baseline | PK11/PK12 | TS-03/06 | Covered |
| Hook lifecycle automatic; no manual Hook controls | P-06..08 | HookManager/Lifecycle | PK05/PK11/PK17 | TS-12..18 | Covered |
| Stable projectId, per-project state/config, atomic writes | P-11/P-12 | Stores/AtomicFile | PK04/PK11 | TS-19..23 | Covered |
| Global root affects future projects only | P-13..16 | StorageLayout | PK11/PK17 | TS-24..37 | Covered |
| Exact user Prompt is Requirement Truth; AI reply is evidence | P-21..24 | Bridge + ConversationStore | BR03..08, PK04..06 | TS-10/41/51/52 | Covered |
| Do not rely on AI voluntarily calling MCP | R-REQ-01 | Native client capture | BR04/BR05/BR06 | TS-10/42 | Covered |
| Commit must not absorb Prompt sent after commit | P-23/P-24 | atomic Bridge boundary | BR02 + PK05/PK06 | TS-10 | Strengthened: boundary append made atomic |
| AI Stop may arrive after commit but stay on original Turn | P-24 | two-freeze model | BR03 + PK06 | TS-10 | Strengthened: before/after Claim semantics frozen |
| Shared-spanning Turn can relate to multiple commits | P-24 | snapshot annotations | PK06 | TS-10/52 | Covered |
| Different projects' conversations viewable | R-REQ-03 | headless query + Explorer | BR07/BR08 + PK13/PK15 | TS-52 | Covered |
| Development conversation UI in Settings, peer of Logs | R-UI-02 | host adapter | PK14/PK15 | TS-52 | Covered |
| Conversation UI only project + date; no source/session/search/view switch | P-25 | default Explorer | BR08/PK15 | TS-52 | Covered |
| Mature UI; no debug-style technical prose | P-37 | UI acceptance | PK14..16 | TS-52 | Strengthened: preview demo text is not mandatory copy |
| Logs detailed across whole runtime | R-LOG-01..05 | shared Logger + owner instrumentation | PK02/PK03/PK10..18 | TS-38..51 | Covered |
| Permanent project/day logs, no retention/segmentation | P-18 | Logger/LogRepository | PK02 | TS-43..50 | Covered; real current backend mismatch identified |
| Logs only in Settings; mature Run Records | R-UI-01 | Settings Logs | PK16 | TS-38/46/47/52 | Covered |
| Warn entire text yellow; error/fatal entire text red; no severity glyph | R-UI-01 | Run Records CSS | PK16 | TS-38/52 | Covered |
| Log body/time never overlap; full-height single scroll | R-UI-01 | fixed grid + flex chain | PK16 | TS-52 | Covered |
| >2 MiB Commit must keep exact Diff evidence | R-KNOW-01 | patch evidence bundle | PK07/PK10 | TS-41/42 | Covered |
| Existing knowledge uses same indexed retrieval direction as Search/Ask | P-09/P-16 | KnowledgeRetrievalService | PK08/PK09/PK17 | TS-09/41/42 | Covered |
| Dirty index must still see freshly promoted Markdown | R-KNOW-02 | stale-index + Markdown Delta Overlay | PK09 | TS-09/42 | Covered |
| Markdown authoritative; index derived | P-16 | retrieval/promotion/index | PK08..10 | TS-09/41/42 | Covered |
| Single writer assumption; no extra prompt-time OCC | approved constraint | Promotion | PK10 | TS-41/42 | Preserved |
| Reusable Bridge, no copied DevTask connector code | P-21/P-26 | public Bridge repo | BR01..10 + DR02 | TS-10/42/52 | Covered |
| One Hook owner for both products | P-38/P-39 | stable per-user Bridge runtime | BR02/BR04..06 | TS-10/42 | Newly strengthened: npm dependency alone was insufficient |
| Intermediate commits pushed, no intermediate tags | P-33..35 | commit/run/release runbooks | all | per-commit gate | Covered |
| Only final release tags trigger publish | P-34/P-35 | ordered release waves | BR10/PK21 | Release Gate | Clarified: independent Bridge needs its own final tag before consumer pin |
| UI compare against supplied HTML for every UI commit | UI acceptance | visual harness | PK14..16/DR03 | TS-52 | Covered |
| Overnight agent must stop on any failed test | Runbook | commit gate | all | universal gate | Covered |

## 3. Repository risk audit

### P0 — release blockers

#### AUD-BRIDGE-001 — non-atomic boundary race
- **Affected:** new Bridge design / Project Knowledge Git Hook.
- **Failure:** reading Bridge cursor/open turns and then writing a separate boundary allows a prompt event to interleave, assigning a post-commit requirement to the prior commit.
- **Fix:** `appendCommitBoundary()` uses exactly the same cross-process journal writer/lock/sequence as `appendEvent()`, and fsyncs before returning.
- **Tests:** controlled two-process interleaving fixture; journal sequence must be `R1 < C1 boundary < R2` regardless of timestamps.
- **Plan:** v13 P-23/P-27, BR02, PK05, TS-10.

#### AUD-BRIDGE-002 — two npm copies can still create two Hook owners
- **Affected:** Bridge installers in both host products.
- **Failure:** each host writes a Hook command pointing to its own `node_modules`; uninstalling/upgrading one host invalidates the other.
- **Fix:** stable per-user `~/.ai-coding-event-bridge/bin` shim + active runtime + consumer registry/install lock. AI client configs never point into host node_modules.
- **Tests:** install both hosts, uninstall either one, upgrade one, assert one managed Hook remains until last consumer unregisters.
- **Plan:** P-38/P-39, BR02/BR04..06, TS-10/42.

#### AUD-CODEX-001 — concurrent Codex sessions can cross-wire conversations
- **Affected:** DevTask `connectors/codex/notify-hook.js`.
- **Current root cause:** recursively selects the newest session JSONL by mtime, reads whole file, and stores a single local notify state.
- **Failure:** two Codex windows/projects are active; notify for A arrives after B file mtime changes, so A emits B’s user/assistant pair.
- **Fix:** per-session incremental offsets/turn state; prefer verified stable payload/session identity; ambiguous events become capture gap, never mtime guess.
- **Tests:** concurrent A/B sessions, interleaved notifications, partial JSONL line, restart state.
- **Plan:** P-29, BR05, TS-10/42.

#### AUD-BIND-001 — existing ancestry binder can consume later requirement
- **Affected:** Project Knowledge `_site/lib/requirement-binder.js`.
- **Failure:** R1 recorded at C0, commit C1, R2 recorded at C1 before C1 analysis; both C0 and C1 are ancestors of C1, so same-session grouping can bind both to C1.
- **Fix:** Bridge journal boundary sequence + frozen CommitConversationSnapshot; legacy ancestry remains compatibility only.
- **Tests:** R1→C1→R2 with delayed C1 analysis.
- **Plan:** PK06, TS-10.

#### AUD-DIFF-001 — large diff success without implementation truth
- **Affected:** `_site/lib/scanner.js`, `_site/lib/commit-prompt.js`.
- **Current root cause:** patch over threshold becomes null/omitted while analysis can continue with stats/file list.
- **Fix:** exact ordered patch chunks + manifest/hash/full coverage; evidence corruption blocks pointer advance.
- **Tests:** >2 MiB, chunk corruption/missing/order, merge/root/binary.
- **Plan:** PK07/PK10, TS-41/42.

### P1 — release blockers

#### AUD-KCTX-001 — existing knowledge degrades with repository scale
- **Affected:** `KnowledgeEvidenceReader` in `_site/lib/commit-prompt.js`.
- **Root cause:** lexical walk + maxFiles=24/maxBytes=256 KiB.
- **Fix:** shared KnowledgeRetrievalService using current LanceDB vector + FTS plus source path/symbol/tag/route signals, rerank, chunk/section budget and Markdown truth verification.
- **Plan:** PK08/PK09/PK17, TS-09/41/42.

#### AUD-LOG-001 — current log backend contradicts final product contract
- **Affected:** `_site/lib/structured-logger.js`, StorageLayout, settings/migration/server.
- **Current behavior:** 50 MiB segments, retention/capacity cleanup, app/hooks/project paths, child independent queue/health, whole-file query.
- **Fix:** shared core; system/projects day files; reverse byte chunks; no cleanup/settings; compatibility reader for legacy files.
- **Plan:** PK02/PK12/PK16, TS-38..50.

#### AUD-TASK-001 / AUD-CORR-001 — active task overwrite and broken operation correlation
- **Affected:** `_site/lib/server-app.js`, `_site/lib/commit-reconciler.js`.
- **Fix:** Map project→Map operation; root operationId is generated once and passed down; Commit adds runId only.
- **Plan:** PK03/PK10/PK12, TS-20/39..42.

#### AUD-DELETE-001 — partial project deletion
- **Affected:** `_site/lib/project-lifecycle-service.js`.
- **Failure:** Hook removal succeeds and registry removal succeeds, then metadata/knowledge deletion fails; restart sees inconsistent facts.
- **Fix:** delete transaction/tombstone + idempotent resume/recovery; default external knowledge preserved.
- **Plan:** PK11, TS-33/42.

#### AUD-RELEASE-001 — first remote release validation currently happens on tag
- **Affected:** `.github/workflows`.
- **Current fact:** npm publish and desktop release are tag-driven; no normal push/PR workflow was found at audited HEAD.
- **Fix:** PK01 non-release Linux/Windows CI, no publishing. Every later pushed commit waits for green required checks.
- **Plan:** P-33, PK01, release runbook.

#### AUD-PKG-001 — public consumer cannot depend on private DevTask source
- **Affected:** package architecture.
- **Fix:** standalone public Bridge repo/workspaces; development tarballs; Bridge publishes by protected no-tag workflow_dispatch before consumers exact-pin the registry version; the only Git tag is the final Project Knowledge release tag.
- **Plan:** P-26/P-34..36, BR01/BR10/PK20.

#### AUD-CAPTURE-001 / AUD-ID-001 — current DevTask capture is not durable enough for Requirement Truth
- **Affected:** shared hook client, EventNormalizer, TurnAggregator.
- **Current issues:** HTTP-only 8787 delivery with swallowed failure; shared `unknown-session`; synthetic prompt when user prompt missing.
- **Fix:** durable journal first, null/partial identity, no fabricated user evidence, independent consumer cursors.
- **Plan:** BR02/BR03, TS-10/42/51.

#### AUD-MIG-LOG-001 — legacy logging settings would reintroduce removed product controls
- **Affected:** Project Knowledge migration settings merge.
- **Fix:** retain old logging config only as compatibility/legacy metadata; new runtime ignores retention/capacity/level-enable settings.
- **Plan:** PK02/PK11, TS-47/50.

#### AUD-UI-001 — production UI remains logs-only/debug-oriented
- **Affected:** `ui/index.html`.
- **Fix:** restore current-API Control Center shell; Settings-only development conversation and mature logs views; visual/bounding-box tests.
- **Plan:** PK14..16, TS-52.

### P2

#### AUD-HOOK-001 — “non-blocking” Hook is actually synchronous up to HTTP timeout
- Current Hook always exits 0, so it cannot roll back an already-created commit, but its Node/HTTP notifier can delay the shell.
- v13 permits only short local durable Bridge boundary append on synchronous path; server wake-up is best-effort/bounded.

#### AUD-CLAUDE-001 — best-effort Workbench persistence can silently lose resume history
- Current session persistence directly writes JSON and suppresses errors.
- Use AtomicFile for resumable state and safe structured diagnostics; never fail the live AI response because history persistence failed.

## 4. Fixed historical bugs that must not be reimplemented

At the audited Project Knowledge HEAD, AI profile GET already uses a public/redacted view, and CORS uses an origin allow policy. v12 still described the historical wildcard/secret leak as current. v13 treats those as regression tests only. Likewise the current server no longer surfaced the old public simulate/manual-init routes during audit; T00 must inventory and delete residual dead code/tests rather than recreate old behavior simply to “fix” it later.

## 5. Plan quality verdict

v12 was directionally strong but not safe enough for an unattended overnight run because it left several cross-process and cross-repo deployment semantics implicit. v13 is materially safer because the ambiguous parts are now explicit invariants, all OPEN P0/P1 findings are release blockers, the implementation is split into 34 small cross-repo commits, and package/tag ordering is executable without locking a nonexistent npm version.
