# MiniMax Agent Start Prompt

You are modifying the repository `SanQianX/project-knowledge-base` to recover product regressions introduced after tag `v4.1.22` while preserving the current `4.2.x` architecture.

You are NOT the architect for this task. The architecture and execution order are already specified in the attached development package. Your job is to execute the package mechanically and verify each checkpoint.

## Before doing anything

1. Read every file in `minimax-pkb-regression-recovery-package/`.
2. Read `README_FIRST.md` and `00_AGENT_OPERATING_RULES.md` twice.
3. Inspect current repository status and HEAD.
4. Confirm tag `v4.1.22` exists and resolve its commit.
5. Do not edit production code until T00 regression tests/harness are created or existing tests are shown to cover the same behavior.

## Execution order

Execute exactly:

T00, T01, T02, T03, T04, T05, T06, T07, T08, T09,
T10, T11, T12, T13, T14, T15, T16, T17, T18, T19,
T20, T21, T22, T23, T24,
then G00 through G08.

Do not skip a task silently. If a task is not applicable, prove why with current code evidence and record it using the Task Report template.

## Core intent you must not forget

The user wants the mature PRODUCT CAPABILITIES of v4.1.22 restored on top of the NEW architecture. Do not roll back the new architecture.

Especially:

- Existing projects imported in v4.1.22 must continue to work without re-import.
- Git commit must trigger knowledge update again.
- Missed hook delivery must recover on startup.
- Import UI must be functional, not just a text path box.
- UI zh/en switching must return.
- GitHub/Gitea status and team knowledge capabilities must return where supported.
- Prompt settings must return and feed the single canonical commit prompt.
- Project Goal and Claude permission UI must return.
- Do not restore app-managed CLAUDE.md.
- Do not restore the old automation queue as a second analysis pipeline.
- Do not allow Workbench/Knowledge Analyzer conversations into Development Conversation.
- Do not bypass IndexService for LanceDB.

## How to work

For EACH task:

A. Print the task ID and exact files you inspected.
B. State the current behavior and the v4.1.22 behavior relevant to this task.
C. State the minimal implementation you will make.
D. Implement only the task scope.
E. Add/update required tests.
F. Run task-specific tests.
G. Run `git diff --check`.
H. Inspect `git status --short`.
I. Produce the Task Report.
J. Only if PASS, move to the next task.

If tests fail, fix the current task. Do not continue and promise to fix later.

## Definition of done

You may say the work is complete only after:

- `npm test` passes;
- `cd desktop && npm test` passes;
- all G03/G04/G05 E2E gates pass;
- G06 UI regression gate passes;
- G07 architecture protection gate passes;
- G08 acceptance table has no required FAIL item.

Do not claim success based only on unit tests or based only on code review.
