# TEST_GATE_MATRIX.md

> Canonical IDs remain exactly TS-01 through TS-52. New audit cases are folded into these IDs; do not create new canonical IDs during this run.

## Universal commit gate

Every commit: syntax/lint → targeted unit → targeted integration → negative/fault → UI visual if applicable → relevant regression → diff review → commit → push → remote CI green. Any failure stops the run.

| Test ID | First implementation / owner | Mandatory regression rerun | Final gate |
|---|---|---|---|
| TS-01 | PK10 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-02 | PK10 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-03 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-04 | PK10 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-05 | PK10 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-06 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-07 | PK17 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-08 | PK10 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-09 | PK09 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-10 | BR02/BR03/BR04/BR05/BR06 + PK05/PK06 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-11 | PK17 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-12 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-13 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-14 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-15 | PK17 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-16 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-17 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-18 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-19 | PK03 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-20 | PK03 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-21 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-22 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-23 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-24 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-25 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-26 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-27 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-28 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-29 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-30 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-31 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-32 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-33 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-34 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-35 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-36 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-37 | PK11 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-38 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-39 | PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-40 | PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-41 | PK07/PK08/PK09/PK10/PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-42 | BR02/BR05 + PK09/PK11/PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-43 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-44 | PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-45 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-46 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-47 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-48 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-49 | PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-50 | PK02 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-51 | PK18 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |
| TS-52 | BR08 + PK14/PK15/PK16 | PK19; PK20 if Bridge-dependent; PK21 clean release validation | G5 / release blocker |

## New audit scenarios folded into canonical tests

- **TS-10:** atomic journal interleaving; late assistant before/after Claim; same repo previous-boundary on merge; no fake session/prompt; Claude/Codex/OpenCode real capture.
- **TS-20:** multi-operation activeTasks + root operationId continuity through reconciler/shutdown.
- **TS-33:** delete transaction every-stage fault/restart recovery.
- **TS-41:** exact large patch + large-KB retrieval relevance + frozen retrieval/conversation hashes.
- **TS-42:** Codex multi-session, Bridge fsync/cursor/boundary gap, delete/migration/index/promotion fault injection.
- **TS-52:** full shell + Settings-only conversation + mature logs visual/bounding-box/single-scroll tests.

## Remote CI gate

- After PK01, every Project Knowledge push must have non-release CI green before next commit.
- Bridge commits from BR01 onward must have Bridge CI green.
- DevTask commits must run repository smoke locally; once its CI is added/available, remote green is also required.
- A skipped/queued/cancelled required job is not PASS.

## Release clean-check gate

Run in fresh checkout/temp directories, not the dirty overnight worktree: npm ci; complete test suite; package dry-run/content audit; desktop tests/package smoke; migration upgrade fixture; real Hook/Bridge capture fixtures; security/redaction audit; UI screenshots; git status clean.