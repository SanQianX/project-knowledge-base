# qa-r44 canonical tooling

This lane (`P-WB-QA-CANONICAL-R44C`, finalized by `P-WB-QA-FINALIZE-R44D`) makes
the R44 permission / user-question lane (`P-WB-PERMISSION-QUESTION-R44`)
**portable**: it may be run from a clean tracked checkout with only its own six
files added, and it can be checked without spending a single model turn.

Nothing here re-runs the accepted R44 acceptance (WB-006 / WB-007). That
acceptance stays frozen; see `../artifacts/parallel-20261023/wb-permission-question-r44/`.

## The six files of the lane

| file | role |
| --- | --- |
| `_site/_test/helpers/qa-r44-env.js` | driver-level isolation: capture the real environment, harden the driver's own `process.env`, fail-closed assertion |
| `_site/_test/helpers/qa-r44-ui.js` | real UI actions on the product's own permission / question cards |
| `_site/_test/helpers/qa-r44-report.js` | the report builder (the R44 acceptance report and this lane's portability report) |
| `_site/_test/qa-r44-permission-question.js` | the WB-006 / WB-007 scenarios and the pure verdict function |
| `qa-autopilot/tools/product-probes/qa-r44-permission-question.js` | the canonical entry point |
| `qa-autopilot/tools/product-probes/qa-r44-report-regression.js` | the explicit zero-model regression probe (see below) |

Every other file the lane needs is **tracked by git** and shared read-only
with the other lanes. The require-closure is eleven files: the six above plus

- `_site/_test/helpers/parallel-workbench-integration-5025-runtime-harness.js`
- `_site/_test/helpers/parallel-workbench-integration-5025-fixture.js`
- `_site/_test/helpers/parallel-workbench-source-map.js`
- `_site/_test/helpers/find-chrome.js`
- `_site/_test/helpers/cdp-browser.js`

and, at run time only, the spawned helper
`_site/_test/helpers/parallel-workbench-host.js` (also tracked).

The lane deliberately does **not** depend on
`_site/_test/helpers/parallel-workbench-runtime-harness.js`: that file is an
untracked historical artifact of the R44 lane, and a canonical test must not
depend on an untracked intermediate product.

## The three modes

```bash
node qa-autopilot/tools/product-probes/qa-r44-permission-question.js            # --check (default)
node qa-autopilot/tools/product-probes/qa-r44-permission-question.js --check
node qa-autopilot/tools/product-probes/qa-r44-permission-question.js --report-only
PK_WB_ALLOW_PAID_TURNS=1 node qa-autopilot/tools/product-probes/qa-r44-permission-question.js --run
```

### `--check` (the default, zero model)

Starts **no** service, **no** browser, **no** product profile and sends **no**
model request. It only:

1. parses the six proposed files without executing them (`vm.compileFunction`),
2. resolves the relative `require()` closure of the six files and proves that
   every file of that closure which is not one of the six is tracked by git,
3. proves that the helper the harness spawns at run time is tracked too,
4. loads the three shared modules and proves they still expose the API the
   scenario uses,
5. compares `process.getActiveResourcesInfo()` before and after, to prove that
   the check started no socket, no server and no child process.

The result is written to `<evidence dir>/check.json`. A file that already
carries another schema is never overwritten: the mode refuses with exit `2`.

### `--run` (the paid acceptance)

Sends **real** model turns. It is refused with exit code `2` unless
`PK_WB_ALLOW_PAID_TURNS=1` is set explicitly, and the refusal happens before
anything is started:

```
REFUSED: --run sends REAL model turns. Set PK_WB_ALLOW_PAID_TURNS=1 to allow them.
Nothing was started: no service, no browser, no profile, no model request.
```

Every `--run` writes into its **own** directory,
`<evidence dir>/runs/<ISO-stamp>-<pid>/`, and appends itself to the
append-only `<evidence dir>/runs/index.json`. The first failure of the lane is
carried forward in the run history and is never replaced by a later run.

### `--report-only`

Rebuilds **only this lane's** portability report, from the recorded
`check.json` and the frozen R44 report. It sends no model request and re-runs
nothing. The report keeps the digests of the source that produced the R44
acceptance strictly separate from the digests of the packaging delivered here,
and it never presents the old model result as a model retest of the new
harness.

A recorded check is reused **only** when the bytes it ran against are still the
current bytes of the proposed files. When they are not, the mode refuses with
exit `2` and writes no report: a stale PASS is never reported as a current one.
With no check at all the mode writes an honest `BLOCKED` report and exits `3`.

## What the builder must never do

The report builder is **generic**. It reports the facts of the run it is given
and nothing else:

- it never narrates a past run — the historical facts of the accepted R44
  acceptance live in the frozen R44 report only;
- it never manufactures a `PASS` from an incomplete summary; the verdict comes
  from the scenario's own `evaluateCases`, and the cases that were not proven
  are listed in `runFacts.requiredCasesNotProven`;
- the portability report states that a clean checkout or a negative control was
  done **only** when it actually read the corresponding hashed files;
- the verdict is three-tier: `PASS` (evidence present and holds), `FAIL`
  (evidence present and does not hold), `BLOCKED` (evidence missing or stale).

## The required cases

`evaluateCases` in `_site/_test/qa-r44-permission-question.js` is a pure
function. The eleven essential cases include the two bypass cases:

- `R44.g-wb007-bypass-mode-does-not-release-the-question`
- `R44.j-wb007-the-bypass-mode-still-asks-the-question`

A result set that is missing either one, or in which either one is not
`PASS`, is `BLOCKED` — never `PASS`. A skipped or timed-out bypass turn is
recorded as `BLOCKED`, not silently dropped. The original three answer types,
the deny path and the `requestId` correlation assertions are unchanged.

## The regression probe

`qa-autopilot/tools/product-probes/qa-r44-report-regression.js` is an
**explicit, zero-model** probe. It is not wired into any CI; it is run
explicitly, by path. It proves the negative cases:

- a result set without `R44.g`, without `R44.j`, or with a `BLOCKED` `R44.j`
  is never a `PASS`;
- the builder source and the built report carry no historical narrative;
- an incomplete summary does not produce a `PASS` report, and the report names
  the required cases it did not prove;
- a check over the current bytes is fresh and a check over other bytes is not;
- `--run` without its gate is refused and starts nothing;
- `--report-only` without any data is an honest `BLOCKED`;
- a stale check is refused instead of reported;
- the frozen evidence of another lane is refused and stays byte-identical;
- the current `--check` still passes.

```bash
node qa-autopilot/tools/product-probes/qa-r44-report-regression.js
```

## Environment variables

All optional, all backwards compatible with the R44 lane.

| variable | meaning |
| --- | --- |
| `QA_R44_EVIDENCE_DIR` | the evidence directory of this lane |
| `QA_R44_TEMP_ROOT` | the lane temp root; it lives outside the repository |
| `QA_R44_WB_SOURCE_ROOT` | the read-only Workbench source checkout |
| `QA_R44_TRACKED_LIST` | a file with the repo-relative tracked file list, for a checkout that has no `.git` |
| `QA_R44_REGRESSION_OUT` | where the regression probe writes its JSON result |
| `PK_WB_ALLOW_PAID_TURNS` | must be exactly `1` for `--run` |
| `PK_WB_MODEL_PROFILE` / `PK_WB_MODEL_ID` / `PK_WB_TURN_TIMEOUT_MS` | the model selection of the paid run |

## Exit codes

| code | meaning |
| --- | --- |
| `0` | the mode succeeded |
| `1` | the tool itself failed (a check failed, or the evidence is present and does not hold) |
| `2` | the mode was refused (the paid acceptance without its explicit gate, a write into frozen evidence, a stale check, a foreign schema) |
| `3` | an honest BLOCKED (the evidence is missing or stale — nothing is disproved, nothing is proven) |

## Running the check from a clean checkout

A checkout that has no `.git` cannot answer "is this file tracked?". Hand the
tracked list in:

```bash
git ls-files > /tmp/tracked-list.txt
git archive --format=tar HEAD | tar -x -C /tmp/clean-tree
# overlay the six proposed files
QA_R44_TRACKED_LIST=/tmp/tracked-list.txt \
  node /tmp/clean-tree/qa-autopilot/tools/product-probes/qa-r44-permission-question.js --check
```

The clean checkout needs its npm dependencies: the tracked browser helper
requires the `ws` package, so run `npm ci` there, or point `NODE_PATH` at an
already installed dependency tree. Without them the module load fails with
`Cannot find module 'ws'` — a missing dependency of the checkout, not a
portability defect of the lane.

## What this tooling does **not** prove

The `--check` mode proves the dependency closure, the syntax, the module
loading and the API surface. It does **not** prove that the browser-driven
acceptance still passes on the delivered packaging. That needs an explicit
`--run` with `PK_WB_ALLOW_PAID_TURNS=1`, which sends real model turns.

**The packaging delivered by `P-WB-QA-FINALIZE-R44D` has not been model-retested.**
Its zero-model check, its refusals and its regression probe are proven; the
browser-driven acceptance of this packaging is not.
