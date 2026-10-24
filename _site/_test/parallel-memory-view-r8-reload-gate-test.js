'use strict';
// _site/_test/parallel-memory-view-r8-reload-gate-test.js
//
// P-CI-MEMORY-VIEW-R8 focused case: the reload→navigate contract that CI
// 40062048045 broke in parallel-memory-source-test ("Timed out waiting for
// the memory view is open", test line 136).
//
// Root cause class (see the R8 probe evidence under
// qa-autopilot/artifacts/parallel-20261023/ci-memory-view-r8/): the shell's
// reload() used to gate ONLY on `document.readyState === 'complete'`, which
// proves neither WHICH document answered (Page.reload is acknowledged before
// the navigation commits; Runtime.evaluate can answer from the outgoing
// context on a congested renderer) nor that the product's interactive boot
// finished. A native nav click dispatched right after such a gate can land
// in the load/swap settle window and be dropped — reproduced 2/2 against the
// real page with a forced 600ms commit delay; the memory view then never
// activates (the exact CI never-true predicate).
//
// The fixed gate returns only when the answering document is provably FRESH
// (a marker set on the outgoing document is gone) AND the product's own boot
// evidence is present (.view.active — ui/product.js attaches its click
// delegation before the boot setView that marks the initial view active).
//
// This case proves that contract on the real page, offline from MEM-008:
//   1. reload() returns on the fresh, booted document (identity marker);
//   2. the golden path the CI failure broke — nativeClick nav memory right
//      after reload() — activates the memory view, and home navigation
//      still works;
//   3. back-to-back reloads keep the contract (the marker technique marks
//      each outgoing document, so consecutive reloads cannot pass on a
//      stale context);
//   4. the failure-diagnostics surface exists (navigationState).
//
// Real isolated product instance, real browser, real CDP input; the harness
// owns vector+bridge before the engine constructor and no live
// 5757/5790/8787/8790 endpoint is touched (parallel-memory-shell.js).

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

async function main() {
  const harness = await startHarness({ tag: 'memviewr8', evidenceDir: EVIDENCE || undefined });
  const proof = { startedAt: new Date().toISOString() };
  try {
    await harness.waitFor(
      () => harness.run("document.readyState === 'complete' && document.querySelector('.view.active') !== null"),
      'the initial page is booted',
      20000,
    );

    // ---- 1. reload() returns on the FRESH, booted document ----------------
    await harness.run('window.__pkR8Mark = "outgoing", true');
    await harness.reload();
    const fresh = await harness.run(`(() => ({
      mark: typeof window.__pkR8Mark,
      activeView: (document.querySelector('.view.active') || {}).id || null,
      readyState: document.readyState,
    }))()`);
    assert.equal(fresh.mark, 'undefined', 'reload() must return on the fresh document, never on the outgoing one (the marker exists only in the outgoing context)');
    assert.ok(fresh.activeView, 'the product boot finished before reload() returned (an initial view is active — the delegation-attached proof)');
    assert.equal(fresh.readyState, 'complete');
    assert.ok(harness.reloadLog.length >= 1, 'the reload gate records its small metadata');
    proof.freshDocumentGate = fresh;

    // ---- 2. the golden path the CI failure broke ---------------------------
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
      'the memory view is open',
      10000,
    );
    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-home').classList.contains('active')"),
      'the home view is open',
      10000,
    );
    proof.goldenPath = { memoryViewOpened: true, homeViewReopened: true };

    // ---- 3. back-to-back reloads keep the contract -------------------------
    await harness.run('window.__pkR8Mark = "outgoing-again", true');
    await harness.reload();
    await harness.reload();
    const twice = await harness.run(`(() => ({
      mark: typeof window.__pkR8Mark,
      activeView: (document.querySelector('.view.active') || {}).id || null,
    }))()`);
    assert.equal(twice.mark, 'undefined', 'after two consecutive reloads the gate still returned on the fresh document');
    assert.ok(twice.activeView, 'the boot evidence held through the second reload');
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
      'the memory view opens after back-to-back reloads',
      10000,
    );
    proof.backToBackReloads = { ...twice, memoryViewOpened: true };

    // ---- 4. the failure-diagnostics surface exists -------------------------
    const state = await harness.navigationState();
    assert.ok(state && typeof state === 'object' && !state.unreachable, `navigationState() must be reachable: ${JSON.stringify(state)}`);
    assert.equal(typeof state.readyState, 'string');
    assert.ok('activeView' in state && 'openDialogs' in state);
    proof.navigationStateShape = state;

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);
    proof.finishedAt = new Date().toISOString();
    proof.verdict = 'PASS';
    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'memviewr8-reload-gate.json'), `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    }
    console.log('parallel-memory-view-r8-reload-gate-test PASS');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
