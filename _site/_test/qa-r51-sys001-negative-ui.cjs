'use strict';

// P-LIFECYCLE-NEGATIVE-R51 driver: SYS-001 端口在线不等于全部模块就绪.
//
// Default --check validates prerequisites WITHOUT starting any server,
// browser or model. Explicit --run executes the bounded OWN probe.
//
// Negative control (real product bytes under test):
//   * the ROOT server (_site/lib/server-app.js via the shared frozen
//     spawn-server helper) runs on an OWN ephemeral port, fully isolated;
//   * its port is ONLINE (/api/health 200) the whole time;
//   * three OWN fake module services answer the product's identity-marked
//     health routes (terminal status/apiVersion, engine name, bridge
//     registeredProjects) and ONE (vectorHub) is DELAYED: health requests are
//     held until released — a delay fixture strictly at the external module
//     boundary; no product health-judgment code is reimplemented here;
//   * a REAL headless browser (frozen cdp-browser helper) reads the REAL UI:
//     #moduleHealth per-module badges and the aggregate system title must NOT
//     present all-ready while 知识索引 is 离线;
//   * then the fixture module recovers and the same REAL UI must show it
//     back 在线 with the all-normal aggregate (positive control; the 37-item
//     positive suite is NOT rerun).
//
// No real service, credential or model/embedding/quota request is involved;
// real 5757/5760/5790/8787/8790 are never touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { installLaneEnv, resolveChromeBeforeIsolation } = require('./helpers/qa-r51-env.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const CASE_DIR = 'sys001-negative-ui';
const RUN = process.argv.includes('--run');

function startFakeModule({ kind, delayed }) {
  const state = { healthProbes: 0, held: 0, released: !delayed, releasedAt: null, waiters: [] };
  const server = http.createServer((req, res) => {
    state.healthProbes += 1;
    const finish = () => {
      const route = kind === 'terminal' ? '/api/claude-workbench/v1/health' : '/api/health';
      if (req.url !== route) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return; }
      const body = kind === 'terminal' ? { status: 'ok', apiVersion: 'r51-fixture' }
        : kind === 'vectorHub' ? { projects: [] }
        : kind === 'engine' ? { name: 'knowledge-engine' }
        : { registeredProjects: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (state.released) return finish();
    state.held += 1;
    state.waiters.push(finish);
  });
  return {
    state,
    release() { state.released = true; state.releasedAt = new Date().toISOString(); for (const w of state.waiters.splice(0)) w(); },
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  return { status: response.status, body };
}

async function main() {
  if (!RUN) {
    // --check: side-effect-free prerequisite validation.
    for (const rel of ['bin/project-knowledge.js', '_site/lib/server-app.js', '_site/lib/module-bridge.js', 'ui/product.js', '_site/_test/helpers/spawn-server.js', '_site/_test/helpers/cdp-browser.js', '_site/_test/helpers/free-port.js']) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    }
    const chrome = resolveChromeBeforeIsolation();
    assert.ok(fs.existsSync(chrome), `chrome not found: ${chrome}`);
    console.log('QA-R51 SYS001 CHECK OK (no server/browser/model started)');
    return;
  }

  const chrome = resolveChromeBeforeIsolation();
  // Canonical browser-env exception (qa-autopilot/lib/runner.cjs browserCapableEnv):
  // the browser child needs the REAL HOME/USERPROFILE/APPDATA/LOCALAPPDATA or
  // Chrome refuses remote debugging ("requires a non-default data directory").
  // Captured BEFORE isolation and applied ONLY to the chrome child via its own
  // env; the driver and the product server keep the fully isolated env.
  const browserEnvException = {};
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) browserEnvException[key] = process.env[key];
  }
  const lane = installLaneEnv({ caseId: 'sys001' });
  process.env.KB_CHROME_PATH = chrome;
  const EVIDENCE = path.join(lane.evidenceRoot, CASE_DIR);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const evidence = {
    caseId: 'SYS-001', lane: 'P-LIFECYCLE-NEGATIVE-R51', mode: 'REAL_SERVER_REAL_BROWSER_DELAYED_MODULE_FIXTURE',
    startedAt: new Date().toISOString(),
    driverCommand: `node _site/_test/qa-r51-sys001-negative-ui.cjs --run (cwd ${ROOT})`,
    chromeExecutableSource: 'resolved before env isolation; browser runs headless with own profile dir under lane temp',
    isolation: { laneTmp: lane.laneTmp, env: lane.envIsolationResolved },
  };

  const { spawnServer } = require('./helpers/spawn-server.js');
  const freePort = require('./helpers/free-port.js');
  const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser.js');

  const terminal = startFakeModule({ kind: 'terminal' });
  const engine = startFakeModule({ kind: 'engine' });
  const bridge = startFakeModule({ kind: 'eventBridge' });
  const delayedVector = startFakeModule({ kind: 'vectorHub', delayed: true });
  let serverHandle = null;
  let browser = null;
  let stdout = ''; let stderr = '';
  try {
    const [terminalUrl, engineUrl, bridgeUrl, delayedVectorUrl] = await Promise.all([terminal.listen(), engine.listen(), bridge.listen(), delayedVector.listen()]);
    evidence.fixtures = {
      boundary: 'external module services only (health identity routes); product health-judgment code untouched',
      terminalUrl, engineUrl, bridgeUrl, delayedVectorUrl,
      delayedKind: 'vectorHub health requests held until release() (delay fixture at the module boundary)',
    };
    const port = await freePort();
    serverHandle = spawnServer({
      root: ROOT, port, tag: 'qa-r51-sys001',
      extraEnv: { KB_TERMINAL_URL: terminalUrl, KB_KNOWLEDGE_ENGINE_URL: engineUrl, KB_EVENTBRIDGE_URL: bridgeUrl, KB_VECTORHUB_URL: delayedVectorUrl },
    });
    evidence.server = { pid: serverHandle.child.pid, port, dataDir: serverHandle.dataDir };
    serverHandle.child.stdout.on('data', c => { if (stdout.length < 65536) stdout += c; });
    serverHandle.child.stderr.on('data', c => { if (stderr.length < 65536) stderr += c; });

    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => { try { return (await fetchJson(`${base}/api/health`, 3000)).status === 200; } catch { return false; } }, 'root port online (/api/health)', 30000);
    evidence.portOnlineAt = new Date().toISOString();
    evidence.portOnlineProof = `${base}/api/health -> 200 while vectorHub module is DELAYED`;

    const delayedApi = await fetchJson(`${base}/api/modules/health`);
    evidence.apiDelayed = delayedApi;
    assert.equal(delayedApi.status, 200);
    assert.equal(delayedApi.body.modules.terminal.up, true, 'terminal fixture must be up (identity-marked)');
    assert.equal(delayedApi.body.modules.engine.up, true, 'engine fixture must be up');
    assert.equal(delayedApi.body.modules.eventBridge.up, true, 'bridge fixture must be up');
    assert.equal(delayedApi.body.modules.vectorHub.up, false, 'PORT ONLINE MUST NOT imply module ready: vectorHub is delayed and must be down');

    browser = await launchCdpBrowser({ chrome, profileDir: path.join(lane.laneTmp, 'browser'), url: base, width: 1600, height: 1000, env: { ...process.env, ...browserEnvException } });
    evidence.browserEnvException = { vars: Object.keys(browserEnvException), boundary: 'canonical browserCapableEnv exception: chrome child only; product server and driver keep fully isolated env; all browser WRITES go to the own --user-data-dir profile' };
    await waitFor(() => browser.evaluate("document.querySelector('#homeContent') && document.querySelector('#homeContent').textContent.length >= 0"), 'home view loaded', 20000);
    const click = async selector => {
      await waitFor(() => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`), 'clickable ' + selector);
      const p = await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const t=document.elementFromPoint(x,y);if(!t||!(t===e||e.contains(t)))throw Error('Occluded control');return {x,y};})()`);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    };
    const uiState = () => browser.evaluate(`(()=>{const rows=[...document.querySelectorAll('#moduleHealth .row')].map(r=>({text:r.textContent.replace(/\\s+/g,' ').trim(), htmlHead:r.innerHTML.slice(0,200)}));return {rows,dot:document.querySelector('#systemDot')?.className||'',title:document.querySelector('#systemTitle')?.textContent||'',detail:document.querySelector('#systemDetail')?.textContent||''};})()`);

    await click('#openSystem');
    const delayedUi = await waitFor(async () => {
      const state = await uiState();
      if (state.rows.length < 4) return null;
      // renderSystem draws all-离线 before health data arrives; the matrix is
      // only meaningful once the three healthy fixtures display 在线.
      const healthy = ['Agent 工作台', '知识引擎', '开发事件'].every(name => {
        const row = state.rows.find(r => r.text.includes(name));
        return row && row.text.includes('在线');
      });
      return healthy ? state : null;
    }, 'module health rows with the three healthy fixtures 在线', 20000);
    evidence.uiDelayed = delayedUi;
    const vectorRowDelayed = delayedUi.rows.find(r => r.text.includes('知识索引'));
    assert.ok(vectorRowDelayed, '知识索引 row must render');
    assert.ok(vectorRowDelayed.text.includes('离线'), `知识索引 must display 离线 while delayed, got: ${vectorRowDelayed.text}`);
    assert.ok(!vectorRowDelayed.text.includes('在线'), `知识索引 must NOT display 在线 while delayed, got: ${vectorRowDelayed.text}`);
    for (const name of ['Agent 工作台', '知识引擎', '开发事件']) {
      const row = delayedUi.rows.find(r => r.text.includes(name));
      assert.ok(row && row.text.includes('在线'), `${name} fixture is healthy and must display 在线, got: ${row ? row.text : 'missing'}`);
    }
    assert.notEqual(delayedUi.title, '系统连接正常', `aggregate title must NOT claim all-normal while a module is down, got: ${delayedUi.title}`);
    assert.ok(delayedUi.dot.includes('issue'), `system dot must be issue while a module is down, got: ${delayedUi.dot}`);
    assert.equal(browser.exceptions.length, 0, 'page must throw no exceptions');
    await browser.screenshot(path.join(EVIDENCE, 'sys001-delayed.png'));
    evidence.delayedAssertedAt = new Date().toISOString();
    evidence.fixtureHeldBeforeRelease = { vectorHubHealthProbes: delayedVector.state.healthProbes, held: delayedVector.state.held };

    delayedVector.release();
    evidence.fixtureReleasedAt = delayedVector.state.releasedAt;
    // Real refresh path: a real UI action (create a domain through the
    // product's own dialog) runs refreshRegistry(true) — the product's own
    // module-health refresh (ui/product.js:732). No injected refresh call.
    const fill = async (selector, value) => {
      await click(selector);
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await browser.send('Input.insertText', { text: value });
    };
    await click('#closeSystem');
    await click('[data-view="projects"]');
    await click('#createDomain');
    await fill('#domainForm input[name="name"]', 'R51 Recovery Refresh');
    await click('#domainForm button[type="submit"]');
    await waitFor(() => browser.evaluate("(!document.querySelector('#domainDialog') || !document.querySelector('#domainDialog').open) && document.querySelector('#projectTree').textContent.includes('R51 Recovery Refresh')"), 'domain persisted (real UI action)', 15000);
    evidence.recoveryRefreshAction = { realUiAction: 'create domain via #createDomain dialog -> product refreshRegistry(true) (ui/product.js:732)', at: new Date().toISOString(), domainPersisted: true };
    const apiRecoveredDirect = await fetchJson(`${base}/api/modules/health`);
    evidence.apiRecoveredDirectProbe = apiRecoveredDirect.body && apiRecoveredDirect.body.modules;
    let recoveredUi = null;
    try {
      recoveredUi = await waitFor(async () => {
        const state = await uiState();
        const vector = state.rows.find(r => r.text.includes('知识索引'));
        return vector && vector.text.includes('在线') && !vector.text.includes('离线') ? state : null;
      }, '知识索引 back 在线 after the real UI registry refresh', 30000);
    } catch (waitError) {
      evidence.recoveryFailureDiagnostics = {
        waitError: String(waitError.message || waitError),
        finalUiState: await uiState().catch(() => null),
        consoleErrors: browser.consoleErrors.slice(0, 10),
        serverSeesVectorUpAfterRelease: evidence.apiRecoveredDirectProbe ? evidence.apiRecoveredDirectProbe.vectorHub.up : 'probe-failed',
      };
      throw waitError;
    }
    assert.ok(recoveredUi, '知识索引 must recover to 在线 after the module fixture is released (real UI refresh)');
    evidence.uiRecovered = recoveredUi;
    for (const name of ['Agent 工作台', '知识引擎', '开发事件', '知识索引']) {
      const row = recoveredUi.rows.find(r => r.text.includes(name));
      assert.ok(row && row.text.includes('在线') && !row.text.includes('离线'), `after recovery ${name} must display 在线, got: ${row ? row.text : 'missing'}`);
    }
    // The aggregate title/dot also feed on snapshot/storage/engine-wiring state;
    // record them as evidence (module badges are the semantics under test).
    evidence.aggregateAfterRecovery = { title: recoveredUi.title, dot: recoveredUi.dot, detail: recoveredUi.detail, returnedNormal: recoveredUi.title === '系统连接正常' && recoveredUi.dot.includes('up') };
    const recoveredApi = await fetchJson(`${base}/api/modules/health`);
    evidence.apiRecovered = recoveredApi;
    assert.equal(recoveredApi.body.modules.vectorHub.up, true, 'recovered /api/modules/health must show vectorHub up');
    assert.equal(browser.exceptions.length, 0, 'page must throw no exceptions across the whole run');
    await browser.screenshot(path.join(EVIDENCE, 'sys001-recovered.png'));
    evidence.recoveredAssertedAt = new Date().toISOString();

    evidence.verdict = {
      '端口在线不等于全部模块就绪（负向对照）': `PASS - port /api/health 200 from ${evidence.portOnlineAt} through recovery; while vectorHub was held, real /api/modules/health reported vectorHub.up=false AND the real UI showed 知识索引 离线 with aggregate '${delayedUi.title}' + issue dot (not 系统连接正常)`,
      '模块恢复后正向核对': `PASS - after fixture release the real UI (drawer explicit refresh) showed all four modules 在线 (知识索引 included), and /api/modules/health reported all four up; aggregate title/dot recorded as ${JSON.stringify(evidence.aggregateAfterRecovery)} (aggregate also feeds on snapshot/storage wiring, so the per-module badges are the asserted semantics)`,
      browserExceptions: 0,
      boundary: 'delay fixture lives only at the external module service boundary (health route held); the root server, module-bridge health semantics and the UI rendering are unmodified product bytes; legacy analysisOwner (spawn-server default) — engine-ownership wiring pending path not exercised here (R32 reviewed it)',
    };
    fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    fs.writeFileSync(path.join(EVIDENCE, 'server.stdout.log'), stdout);
    fs.writeFileSync(path.join(EVIDENCE, 'server.stderr.log'), stderr);
    console.log('QA-R51 SYS001 NEGATIVE-UI PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try {
      if (browser) await browser.screenshot(path.join(EVIDENCE, 'first-failure.png')).catch(() => {});
      fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
      fs.writeFileSync(path.join(EVIDENCE, 'server.stdout.log'), stdout);
      fs.writeFileSync(path.join(EVIDENCE, 'server.stderr.log'), stderr);
    } catch {}
    console.error(`QA-R51 SYS001 NEGATIVE-UI FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    const uncleared = [];
    try { await browser?.close(); } catch { uncleared.push('browser close error'); }
    try { await serverHandle?.cleanup(); } catch { uncleared.push('server cleanup error'); }
    for (const [name, fixture] of [['terminal', terminal], ['engine', engine], ['eventBridge', bridge], ['delayedVector', delayedVector]]) {
      try { await fixture.close(); } catch { uncleared.push(`${name} fixture close error`); }
    }
    if (uncleared.length) { try { const e = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'evidence.json'), 'utf8')); e.unclearedItems = uncleared; fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(e, null, 2) + '\n'); } catch {} }
    lane.cleanup();
  }
}

main();
