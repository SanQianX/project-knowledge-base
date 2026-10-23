'use strict';
// FEATURE-VERSIONS-01-R2 manual browser acceptance — real Chrome (CDP) drives
// the REAL product page from the isolated root server and checks the whole
// simplified tooltip contract: default hidden with no reserved space, hover
// shows 知识库 vX.Y.Z, move-away hides, focus shows/blur hides, exactly one
// version fetch (no polling), dark theme + narrow viewport still work, and a
// failing version GET honestly yields 知识库 版本未知. Chrome was resolved from
// the real machine at fixture load; every process below (Chrome included) then
// runs under the lane's isolation env and repo-external temp layout. Each case
// records its own pass/fail; cleanup failures become warnings, never a mask.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchCdpBrowser } = require('./helpers/cdp-browser');
const {
  REPO_ROOT, CHROME_PATH,
  createIsolationLayout, applyIsolationEnv, startRootServer, stopRootServer,
  startVersionBrokenUiServer, removeTree,
} = require('./helpers/version-visibility-fixture');

const ARTIFACT_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'version-visibility');
const SHOT_DIR = path.join(ARTIFACT_DIR, 'screenshots');

const results = [];
const warnings = [];
function record(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
  console.log(`${pass ? 'ok' : 'FAIL'} ${name} — ${detail}`);
}
async function runCase(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error && error.message ? error.message : String(error));
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForEval(browser, expression, label, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await browser.evaluate(expression);
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function hoverPoint(browser, x, y) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
}

const BRAND_CENTER = `(() => { const r = document.querySelector('.brand').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 24)) }; })()`;
const TOOLTIP_STATE = `(() => { const el = document.getElementById('brandVersion'); const cs = getComputedStyle(el); return { visibility: cs.visibility, opacity: cs.opacity, position: cs.position, text: el.textContent }; })()`;
const TOOLTIP_SHOWN = `(() => { const cs = getComputedStyle(document.getElementById('brandVersion')); return Number(cs.opacity) === 1; })()`;
const TOOLTIP_HIDDEN = `(() => { const cs = getComputedStyle(document.getElementById('brandVersion')); return Number(cs.opacity) === 0; })()`;

async function pressTab(browser) {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
}

async function hoverTooltipVisible(browser) {
  const point = await browser.evaluate(BRAND_CENTER);
  await hoverPoint(browser, point.x, point.y);
  const state = await waitForEval(browser, `${TOOLTIP_SHOWN} ? (${TOOLTIP_STATE}) : null`, 'tooltip shown on hover');
  await hoverPoint(browser, point.x, point.y);
  return state;
}

// Chrome's crashpad handler outlives the browser briefly and keeps locks on the
// isolated layout (it does not match the helper's chrome.exe filter), so sweep
// every process whose command line references this run's temp root, then retry.
function sweepLayoutProcesses(root) {
  const command = "$root = $env:PK_LAYOUT_ROOT; "
    + "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'crashpad_handler.exe' OR Name = 'GoogleCrashHandler.exe' OR Name = 'GoogleCrashHandler64.exe'\" "
    + "| Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } "
    + "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: 'ignore', timeout: 10000, windowsHide: true,
      env: { ...process.env, PK_LAYOUT_ROOT: root },
    });
  } catch {}
}

function removeTreeRetry(root, attempts = 6, delayMs = 700) {
  const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < attempts; i++) {
    try { removeTree(root); if (!fs.existsSync(root)) return; } catch (e) {
      if (i === attempts - 1) warnings.push(`cleanup: could not remove ${root}: ${e.message}`);
    }
    sweepLayoutProcesses(root);
    sleepSync(delayMs);
  }
}

async function main() {
  const rootVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const layout = createIsolationLayout();
  // From here on, EVERY child this probe spawns — servers and Chrome alike —
  // inherits the isolated home/data/temp env (Chrome itself gets the isolated
  // --user-data-dir from the CDP helper plus this env for its default paths).
  applyIsolationEnv(layout);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  let browser = null;
  let server = null;
  let broken = null;
  const startedAt = new Date().toISOString();
  try {
    server = await startRootServer(layout);
    browser = await launchCdpBrowser({
      chrome: CHROME_PATH,
      profileDir: path.join(layout.root, 'chrome-profile'),
      url: `${server.base}/`,
      width: 1360,
      height: 900,
    });
    // Headless pages report document.hasFocus() === false, so script .focus()
    // would never match the real :focus CSS. CDP focus emulation restores the
    // genuine focused-page state a real keyboard user has.
    await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForEval(browser, `(() => { const t = document.getElementById('brandVersion'); return t && t.textContent && !t.textContent.includes('读取中') ? t.textContent : null; })()`, 'version text settles');

    await runCase('default-hidden', async () => {
      const state = await browser.evaluate(TOOLTIP_STATE);
      if (Number(state.opacity) !== 0) throw new Error(`opacity=${state.opacity} visibility=${state.visibility}`);
      return `opacity=${state.opacity} (invisible by default)`;
    });
    await runCase('no-reserved-space', async () => {
      const state = await browser.evaluate(TOOLTIP_STATE);
      if (state.position !== 'absolute') throw new Error(`position=${state.position}`);
      return `position=${state.position} (absolute tooltip never adds layout space)`;
    });
    await runCase('no-r1-sidebar-or-dialog', async () => {
      const absent = await browser.evaluate(`!document.getElementById('versionInfoButton') && !document.getElementById('versionDialog') && !document.querySelector('[data-view="versions"]')`);
      if (!absent) throw new Error('an R1 version surface leaked into the page');
      return 'versionInfoButton/versionDialog/versions nav all absent';
    });
    await runCase('hover-shows-version', async () => {
      const state = await hoverTooltipVisible(browser);
      if (state.text !== `知识库 v${rootVersion}`) throw new Error(`text="${state.text}" expected="知识库 v${rootVersion}"`);
      await browser.screenshot(path.join(SHOT_DIR, 'hover-light.png'));
      return `text="${state.text}"`;
    });
    await runCase('move-away-hides', async () => {
      await hoverPoint(browser, 1200, 500);
      const hidden = await waitForEval(browser, TOOLTIP_HIDDEN, 'tooltip hidden after move-away');
      if (!hidden) throw new Error('still shown after pointer left brand');
      return 'opacity=0 after pointer leaves brand';
    });
    await runCase('focus-shows', async () => {
      // The real keyboard path: brandVersion is the first Tab stop in the DOM;
      // a genuine Tab keypress must focus it and reveal the tooltip.
      await pressTab(browser);
      const state = await waitForEval(browser, `(() => { const el = document.activeElement; return el && el.id === 'brandVersion' && ${TOOLTIP_SHOWN} ? ({ text: el.textContent, matchesFocus: el.matches(':focus') }) : null; })()`, 'tooltip shown on Tab focus');
      return `first Tab stop focused, text="${state.text}", :focus=${state.matchesFocus}`;
    });
    await runCase('blur-hides', async () => {
      await pressTab(browser);
      const hidden = await waitForEval(browser, `(() => { const el = document.activeElement; return el && el.id !== 'brandVersion' && ${TOOLTIP_HIDDEN}; })()`, 'tooltip hidden after focus moves on');
      if (!hidden) throw new Error('still shown after focus moved on');
      return 'focus moved on, opacity=0';
    });
    await runCase('no-polling', async () => {
      await sleep(2500);
      const fetchCount = await browser.evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes('/api/system/version')).length`);
      if (fetchCount !== 1) throw new Error(`${fetchCount} request(s) to /api/system/version after idle`);
      return `${fetchCount} network request(s) to /api/system/version after idle`;
    });
    await runCase('dark-theme-hover', async () => {
      await browser.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
      const state = await hoverTooltipVisible(browser);
      const colors = await browser.evaluate(`(() => { const cs = getComputedStyle(document.getElementById('brandVersion')); return { background: cs.backgroundColor, color: cs.color }; })()`);
      if (state.text !== `知识库 v${rootVersion}`) throw new Error(`text="${state.text}"`);
      await browser.screenshot(path.join(SHOT_DIR, 'hover-dark.png'));
      return `text="${state.text}" bg=${colors.background} fg=${colors.color}`;
    });
    await runCase('narrow-viewport-hover', async () => {
      await browser.setViewport(390, 760);
      const state = await hoverTooltipVisible(browser);
      if (state.text !== `知识库 v${rootVersion}`) throw new Error(`390px viewport text="${state.text}"`);
      await browser.screenshot(path.join(SHOT_DIR, 'hover-narrow.png'));
      await browser.setViewport(1360, 900);
      return `390px viewport text="${state.text}"`;
    });
    await runCase('version-unknown-branch', async () => {
      broken = await startVersionBrokenUiServer(layout);
      await browser.send('Page.navigate', { url: `${broken.base}/` });
      await waitForEval(browser, `document.readyState === 'complete'`, 'broken page load');
      const text = await waitForEval(browser, `(() => { const t = document.getElementById('brandVersion'); return t && t.textContent === '知识库 版本未知' ? t.textContent : null; })()`, 'honest unknown text');
      const state = await hoverTooltipVisible(browser);
      if (Number(state.opacity) !== 1) throw new Error('unknown tooltip not shown on hover');
      await browser.screenshot(path.join(SHOT_DIR, 'hover-unknown.png'));
      return `text="${text}" when version GET fails`;
    });

    const pass = results.every(r => r.pass);
    const evidence = {
      lane: 'FEATURE-VERSIONS-01-R2',
      probe: 'version-visibility-browser-probe',
      startedAt,
      finishedAt: new Date().toISOString(),
      rootPackageVersion: rootVersion,
      chrome: CHROME_PATH,
      serverBase: server.base,
      brokenBase: broken ? broken.base : null,
      verdict: pass ? 'PASS' : 'FAIL',
      cases: results,
      warnings,
      screenshots: ['hover-light.png', 'hover-dark.png', 'hover-narrow.png', 'hover-unknown.png'],
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'browser-probe.json'), JSON.stringify(evidence, null, 2));
    console.log(pass ? 'PROBE-PASS version-visibility-browser-probe' : 'PROBE-FAIL version-visibility-browser-probe');
    process.exitCode = pass ? 0 : 1;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { warnings.push(`browser close: ${e.message}`); } }
    if (broken) { try { await new Promise(resolve => broken.server.close(resolve)); } catch (e) { warnings.push(`broken server close: ${e.message}`); } }
    try { await stopRootServer(server); } catch (e) { warnings.push(`server stop: ${e.message}`); }
    sweepLayoutProcesses(layout.root);
    removeTreeRetry(layout.root);
  }
}

main().then(() => {
  // CDP sockets can keep the loop alive; every child is closed in finally.
  process.exit(process.exitCode || 0);
}, error => {
  console.error('PROBE-FAIL version-visibility-browser-probe');
  console.error(error && error.stack ? error.stack : error);
  const evidence = {
    lane: 'FEATURE-VERSIONS-01-R2',
    probe: 'version-visibility-browser-probe',
    finishedAt: new Date().toISOString(),
    verdict: 'FAIL',
    error: String(error && error.message ? error.message : error),
    cases: results,
    warnings,
  };
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'browser-probe.json'), JSON.stringify(evidence, null, 2));
  } catch {}
  process.exit(1);
});
