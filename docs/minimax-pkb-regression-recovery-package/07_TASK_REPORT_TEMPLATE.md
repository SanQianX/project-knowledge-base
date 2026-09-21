# 07 — Required Task Report Template

MiniMax must output this after every task.

```text
TASK: Txx — <name>
STATUS: PASS | FAIL | BLOCKED

FILES INSPECTED:
- ...

FILES MODIFIED:
- ...

BASELINE BEHAVIOR (v4.1.22):
- ...

CURRENT PRE-TASK BEHAVIOR:
- ...

IMPLEMENTATION:
1. ...
2. ...

TESTS ADDED/CHANGED:
- ...

TEST COMMANDS RUN:
- command: ...
  result: PASS/FAIL
- command: ...
  result: PASS/FAIL

ACCEPTANCE CONDITIONS:
[PASS/FAIL] condition 1
[PASS/FAIL] condition 2
...

GLOBAL INVARIANTS CHECK:
[PASS/FAIL] Markdown authoritative
[PASS/FAIL] IndexService only index writer
[PASS/FAIL] no second analyzer queue
[PASS/FAIL] no CLAUDE.md manager restored
[PASS/FAIL] internal Workbench/Analyzer excluded from Development Conversation

GIT CHECK:
- git diff --check: PASS/FAIL
- unexpected files modified: NONE | list

OPEN ISSUES:
- none | exact issue

NEXT ACTION:
- Proceed to Txx | Stay on current task | Blocked pending product decision
```
