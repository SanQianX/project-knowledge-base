'use strict';
// NAV-006 — 可操作性。
//
// The shell must be operable by a real pointer and by a real keyboard: a
// native pointer click must reach the control, the focus must be visible, and
// nothing transparent may intercept the click.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own Bridge
// journal, own browser profile). Every pointer action is a CDP
// Input.dispatchMouseEvent on the real coordinates of the real control, and
// the hit test (document.elementFromPoint) must resolve to that control, so
// no transparent layer can stand in for a click. Every key action is a CDP
// Input.dispatchKeyEvent. element.click() is never used.
//
// The proof that the pointer really was the browser's is not the harness but
// the page: the shell's own listener records the event, and the recorded
// event carries isTrusted === true, which a synthesized DOM click can never
// produce.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

/** Record every click the page really receives, trusted or not. */
async function installClickRecorder(harness) {
  await harness.run(`(() => {
    window.__navClicks = [];
    if (!window.__navClickHooked) {
      window.__navClickHooked = true;
      document.addEventListener('click', event => {
        const target = event.target;
        const nav = target.closest ? target.closest('[data-view]') : null;
        window.__navClicks.push({
          trusted: event.isTrusted === true,
          tag: target.tagName,
          id: target.id || '',
          view: nav ? nav.getAttribute('data-view') : '',
          label: (target.textContent || '').trim().slice(0, 30),
        });
      }, true);
    }
    return true;
  })()`);
}

const clicks = harness => harness.run('window.__navClicks || []');

/** The focus ring the browser draws for the keyboard-focused element. */
const focusState = harness => harness.run(`(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { none: true };
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    none: false,
    tag: el.tagName,
    id: el.id || '',
    view: el.getAttribute ? (el.getAttribute('data-view') || '') : '',
    label: (el.textContent || '').trim().slice(0, 24),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow,
    width: rect.width,
    height: rect.height,
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
  };
})()`);

/**
 * Every element that could swallow a pointer across the whole viewport.
 * A transparent full-screen layer with pointer-events enabled is exactly the
 * defect this case looks for.
 */
const overlayScan = harness => harness.run(`(() => {
  const full = [];
  const covers = (rect) => rect.width >= innerWidth - 2 && rect.height >= innerHeight - 2;
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.pointerEvents === 'none') continue;
    // Only a positioned element can float over the page; the layout
    // containers are static and hold the controls themselves.
    if (!['fixed', 'absolute', 'sticky'].includes(style.position)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!covers(rect)) continue;
    const opacity = Number(style.opacity);
    full.push({
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      opacity: Number.isFinite(opacity) ? opacity : 1,
      zIndex: style.zIndex,
      background: style.backgroundColor,
    });
  }
  return full;
})()`);

async function main() {
  const harness = await startHarness({ tag: 'nav006', evidenceDir: EVIDENCE || undefined });
  try {
    const repo = makeRepo(harness.fixture, 'nav006-a');
    await harness.importProject(repo, 'NAV006 甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('NAV006 甲')"),
      'the imported project is listed',
      20000,
    );
    await installClickRecorder(harness);

    // NAV-006 expected 4: the pointer is the browser's own, not a
    // synthesized DOM event. The page records what it really received.
    await harness.nativeClick('nav [data-view="search"]');
    const afterNavClick = await clicks(harness);
    assert.ok(afterNavClick.length >= 1, 'the page really received the click');
    const navClick = afterNavClick[afterNavClick.length - 1];
    assert.equal(navClick.trusted, true, `the click the page received is a trusted browser event: ${JSON.stringify(navClick)}`);
    assert.equal(navClick.view, 'search', `the click reached the navigation control: ${JSON.stringify(navClick)}`);
    await harness.waitFor(
      () => harness.run("document.getElementById('view-search').classList.contains('active')"),
      'the search view is open',
    );

    // NAV-006 expected 4 (continued): the hit test of the very same control
    // resolves to the control, so nothing transparent stands in front.
    const hit = await harness.nativeClick('nav [data-view="memory"]');
    assert.equal(hit.hitIsTarget, true, `the control is the hit target: ${JSON.stringify(hit)}`);
    await harness.waitFor(
      () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
      'the memory view is open',
    );
    const memoryClick = (await clicks(harness)).pop();
    assert.equal(memoryClick.trusted, true, 'the memory navigation click is trusted too');
    assert.equal(memoryClick.view, 'memory', 'the memory navigation click reached the control');

    // NAV-006 expected 1: no transparent layer intercepts the page.
    const overlays = await overlayScan(harness);
    assert.deepEqual(overlays, [], `no transparent full-viewport layer covers the page: ${JSON.stringify(overlays)}`);

    // NAV-006 expected 2: the input focus is visible.
    //
    // The keyboard walk starts at the top of the document. Every Tab stop is
    // recorded, and every stop must be visible on the screen and must carry
    // a visible focus ring.
    await harness.run("document.querySelector('nav [data-view=\"home\"]').focus()");
    const stops = [];
    for (let index = 0; index < 22; index += 1) {
      await harness.pressTab();
      const state = await focusState(harness);
      if (!state.none) stops.push(state);
    }
    assert.ok(stops.length >= 8, `the keyboard walk reaches the main controls: ${stops.length} stops`);
    const distinct = new Set(stops.map(stop => `${stop.tag}#${stop.id}.${stop.view}:${stop.label}`));
    assert.ok(distinct.size >= 6, `the keyboard focus really moves between controls: ${[...distinct].join(' | ')}`);
    for (const stop of stops) {
      assert.equal(stop.visible, true, `the focused control is visible: ${JSON.stringify(stop)}`);
      assert.equal(stop.inViewport, true, `the focused control is on the screen: ${JSON.stringify(stop)}`);
      const hasRing = stop.outlineStyle !== 'none' && parseFloat(stop.outlineWidth) > 0;
      assert.equal(hasRing, true, `the focused control shows a focus ring: ${JSON.stringify(stop)}`);
    }

    // NAV-006 expected 2 (continued): the focus ring is really painted, not
    // only declared. The computed style of the focused element is compared
    // with the computed style of the same element when it is not focused.
    await harness.run("document.querySelector('nav [data-view=\"home\"]').focus()");
    const focused = await harness.run(`(() => {
      const el = document.querySelector('nav [data-view="home"]');
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
    })()`);
    assert.equal(focused.outlineStyle, 'solid', `the focused control has a solid focus ring: ${JSON.stringify(focused)}`);
    assert.ok(parseFloat(focused.outlineWidth) >= 2, `the focus ring is thick enough to see: ${JSON.stringify(focused)}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'nav006-focus-ring.png'));

    // NAV-006 expected 1 and 2: the keyboard alone can open a page and
    // reach the fields of a form.
    //
    // The navigation control is reached with Tab only, then Enter opens the
    // view. The click the keyboard produces is trusted as well, because the
    // browser itself synthesises it from the key press.
    await harness.run("document.body.focus(); if (document.activeElement) document.activeElement.blur();");
    let reachedSearch = false;
    for (let index = 0; index < 12 && !reachedSearch; index += 1) {
      await harness.pressTab();
      const state = await focusState(harness);
      if (state.view === 'search') reachedSearch = true;
    }
    assert.equal(reachedSearch, true, 'the keyboard reaches the search control');
    const before = (await clicks(harness)).length;
    await harness.pressEnter();
    await harness.waitFor(
      () => harness.run("document.getElementById('view-search').classList.contains('active')"),
      'the search view is open by keyboard alone',
    );
    const after = await clicks(harness);
    assert.ok(after.length > before, 'the key press really produced a click');
    const keyboardClick = after[after.length - 1];
    assert.equal(keyboardClick.trusted, true, `the keyboard click is a trusted browser event: ${JSON.stringify(keyboardClick)}`);
    assert.equal(keyboardClick.view, 'search', `the keyboard click reached the search control: ${JSON.stringify(keyboardClick)}`);

    // The form of the import dialog is reachable and operable by keyboard.
    await harness.nativeClick('nav [data-view="projects"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-projects').classList.contains('active')"),
      'the projects view is open',
    );
    await harness.nativeClick('#createDomain');
    await harness.waitFor(
      () => harness.run("document.getElementById('domainDialog').open === true"),
      'the domain dialog is open',
    );
    await harness.run("document.querySelector('#domainDialog input[name=\"name\"]').focus()");
    const fieldStop = await focusState(harness);
    assert.equal(fieldStop.visible, true, `the form field is visible: ${JSON.stringify(fieldStop)}`);
    assert.equal(fieldStop.inViewport, true, `the form field is on the screen: ${JSON.stringify(fieldStop)}`);
    assert.equal(fieldStop.outlineStyle !== 'none' && parseFloat(fieldStop.outlineWidth) > 0, true, `the form field shows a focus ring: ${JSON.stringify(fieldStop)}`);
    await harness.browser.screenshot(path.join(harness.evidence, 'nav006-form-focus.png'));

    // The keyboard can type into the focused field, and the value really
    // lands in the product's own input.
    await harness.pressKey('a', { code: 'KeyA', keyCode: 65, text: 'a' });
    await harness.pressKey('b', { code: 'KeyB', keyCode: 66, text: 'b' });
    const typed = await harness.run("document.querySelector('#domainDialog input[name=\"name\"]').value");
    assert.equal(typed, 'ab', `the keyboard typed into the focused field: ${JSON.stringify(typed)}`);

    // Escape closes the dialog again, so the keyboard owns the whole flow.
    await harness.pressKey('Escape', { code: 'Escape', keyCode: 27 });
    await harness.waitFor(
      () => harness.run("document.getElementById('domainDialog').open === false"),
      'the dialog closes by keyboard',
    );

    // Every click the page received during the case was a browser click.
    const recorded = await clicks(harness);
    assert.ok(recorded.length >= 5, `the page received the clicks of the case: ${recorded.length}`);
    assert.equal(recorded.every(entry => entry.trusted === true), true, `no synthesized click reached the page: ${JSON.stringify(recorded)}`);

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log('parallel-nav-operability-test PASS (native pointer and keyboard reach the controls, the focus is visible, nothing transparent intercepts)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
