# 05 — Mandatory Final Test and Acceptance Gates

No task is considered complete until all applicable gates are green.

## G00 — Repository hygiene

Run:

```bash
git status --short
git diff --check
```

Requirements:
- no unexplained generated files;
- no secrets/tokens;
- no unrelated mass formatting;
- no test disabling.

## G01 — Root test suite

Run:

```bash
npm test
```

Must exit 0.

If a test is platform-specific, it must skip only through an existing explicit platform capability contract, never because it is inconvenient.

## G02 — Desktop test suite

Run:

```bash
cd desktop
npm test
```

Must exit 0.

If packaging/runtime files changed, also run applicable package audit/smoke tests available in `desktop/package.json`.

## G03 — Fresh project E2E

Required flow:
1. start with empty Project-Knowledge data dir;
2. configure knowledge root;
3. configure AI fake/test profile;
4. import a Git project through same service used by UI;
5. verify hook healthy;
6. commit change;
7. verify one reconciliation;
8. verify Markdown knowledge updated;
9. verify index update/dirty semantics;
10. restart and verify no duplicate reanalysis.

PASS: final analyzed commit equals Git HEAD and no duplicate knowledge promotion occurs.

## G04 — Legacy v4.1.22 upgrade E2E

Required flow:
1. construct/use v4.1.22 data fixture;
2. include existing managed project, tracking state, profile data, and v1 hook;
3. upgrade/migrate with current runtime;
4. do NOT re-import project;
5. verify config/state preserved;
6. verify hook migrated/repaired;
7. commit change;
8. verify knowledge update;
9. restart;
10. verify idempotence.

PASS: user project continues functioning without manual reset.

## G05 — Missed hook/startup recovery E2E

1. backend offline/unreachable;
2. commit succeeds;
3. no knowledge update while offline;
4. restart backend;
5. startup reconciliation discovers commit;
6. knowledge updates.

PASS: Git history is the durable pending-work source.

## G06 — UI regression gate

Browser/CDP test must verify at minimum:
- project import flow;
- zh/en switch;
- knowledge language control;
- AI profile/default assignment view;
- prompt settings visible and preview works;
- Project Goal visible;
- Workbench permission Allow/Deny;
- GitHub integration status panel;
- Integration Setup panel;
- Hook health/repair panel.

The browser helper must fail fast with diagnostics and clean up child processes. No 300-second zombie timeout behavior.

## G07 — Protected architecture gate

Add/assert tests proving:
- Workbench input does not append Development Conversation;
- Knowledge Analyzer does not append Development Conversation;
- external bridge events can still be ingested;
- cross-repo conversation isolation remains intact;
- CommitConversationSnapshot remains immutable;
- IndexService remains only index writer;
- no `CLAUDE.md` manager is reintroduced.

## G08 — Manual acceptance checklist

The agent must produce a final table with PASS/FAIL and evidence for:

1. Existing imported project commit updates knowledge.
2. Fresh import works.
3. Backend-offline commit is recovered at startup.
4. Chinese/English UI switch works.
5. Knowledge output language setting works.
6. GitHub status/auth UI exists and behaves with test adapter.
7. Gitea status/auth restored or explicitly blocked with evidence.
8. Prompt settings persist and affect canonical prompt.
9. Project Goal editor works.
10. Workbench permissions work.
11. Integration Setup visible.
12. Hook health/repair visible.
13. Legacy project migration requires no re-import.
14. Full root tests green.
15. Desktop tests green.
16. No protected architecture invariant violated.

If any required item is FAIL, final result must be reported as INCOMPLETE, not "done".
