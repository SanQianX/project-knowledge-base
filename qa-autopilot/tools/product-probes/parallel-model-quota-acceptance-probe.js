'use strict';
// WB-QUOTA-01 acceptance probe — EXPLICIT, never part of default CI.
//
// One isolated workbench server (own data dir, ephemeral loopback port)
// whose ProfileStore READS the real workbench profile files through a
// write-refusing proxy, then:
//   1. real-key API: GET /profiles/{glm,minimax}/quota through the real
//      HTTP route (official endpoints, credential in server memory only);
//   2. SDK parity: the same verdict through createClaudeWorkbenchClient;
//   3. real browser: real headless Chrome opens the real /profile-settings/
//      page, clicks 额度 on the GLM row and reads the panel the product
//      renders — UI text and machine data must agree;
//   4. no secret ever appears in any response or in the rendered DOM.
//
// Exit code 0 = every case proven. The process exits for real (CDP socket
// closed, server closed, forced exit) — a printed verdict alone is HUNG.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MODULE_ROOT = 'D:/SanQian.Xu/claude-ai-workbench';
const KB_ROOT = 'D:/SanQian.Xu/project-knowledge-base';
const ARTIFACT_DIR = path.join(KB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'model-quota-feature');
const { createWorkbenchServer, ProfileStore } = require(path.join(MODULE_ROOT, 'packages', 'server'));
const { createClaudeWorkbenchClient } = require(path.join(MODULE_ROOT, 'packages', 'client'));
const { launchCdpBrowser } = require(path.join(KB_ROOT, '_site', '_test', 'helpers', 'cdp-browser'));
const { findChromeDetailed } = require(path.join(KB_ROOT, '_site', '_test', 'helpers', 'find-chrome'));
const { createFakeRunner } = require(path.join(MODULE_ROOT, 'tests', 'helpers', 'fake-runner'));

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail).slice(0, 300)}`);
}
function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-accept-'));
  const dataDir = path.join(root, 'data');
  const realProfileDir = process.env.PK_WB_REAL_PROFILE_DIR
    ? path.resolve(process.env.PK_WB_REAL_PROFILE_DIR)
    : path.join(os.homedir(), '.project-knowledge-v5', 'workbench');
  const profileFile = path.join(realProfileDir, 'profiles.v2.json');
  const credentialFile = path.join(realProfileDir, 'credentials.v1.json');
  const realCredentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8')).credentials;
  const secrets = Object.values(realCredentials).filter(value => typeof value === 'string' && value.length >= 8);
  const secretsDigestBefore = crypto.createHash('sha256').update(fs.readFileSync(credentialFile)).digest('hex');

  // Read-only facade over the REAL profile files: identical pattern to the
  // QA fixture — every write method throws, so this probe cannot mutate the
  // user's configuration even if a UI interaction misfires.
  const WRITE_METHODS = new Set(['save', 'delete', 'setCredential', 'setEmbeddingConfig', 'setMaintenanceDefault', 'importLegacy', 'importEmbedding']);
  const roProfiles = new Proxy(new ProfileStore({ dataDir, profileFile, credentialFile }), {
    get(target, property) {
      if (WRITE_METHODS.has(property)) {
        return () => { throw Object.assign(new Error('read-only profile store'), { status: 409 }); };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const app = createWorkbenchServer({ dataDir, profiles: roProfiles, runner: createFakeRunner(), serveHost: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = `${base}/api/claude-workbench/v1`;
  let browser = null;
  let browserProfileDir = null;

  const evidence = { probe: 'parallel-model-quota-acceptance-probe', ranAt: new Date().toISOString(), base, cases: results };
  try {
    // --- 1. real-key HTTP route -------------------------------------------
    const read = async (url, init) => {
      const response = await fetch(url, init);
      return { status: response.status, body: await response.json() };
    };
    const glm = await read(`${api}/profiles/glm/quota`);
    assertTrue(glm.status === 200 && glm.body.status === 'ok', `glm quota not ok: ${JSON.stringify(glm).slice(0, 200)}`);
    assertTrue(glm.body.provider === 'glm' && Array.isArray(glm.body.windows) && glm.body.windows.length >= 2, 'glm windows missing');
    const glmFive = glm.body.windows.find(window => window.duration?.unit === 'hours' && window.duration?.number === 5);
    assertTrue(glmFive && glmFive.resetAt > 1e12 && glmFive.resetAtUnit === 'ms', 'the real 5h window must carry a ms reset time');
    assertTrue(glmFive.used == null && glmFive.total == null, 'TOKENS_LIMIT counts must stay null (not provided), never 0');
    record('QUOTA-ACC-1-real-key-http', 'PASS', {
      provider: 'glm', status: glm.body.status, windows: glm.body.windows.length,
      planLevel: glm.body.scope?.planLevel, checkedAt: glm.body.checkedAt,
      fiveHourWindow: { usedPercent: glmFive.usedPercent, remainingPercent: glmFive.remainingPercent, resetAt: glmFive.resetAt, resetAtUnit: glmFive.resetAtUnit },
    });

    const minimax = await read(`${api}/profiles/minimax/quota`);
    assertTrue(minimax.status === 200 && minimax.body.status === 'ok', `minimax quota not ok: ${JSON.stringify(minimax).slice(0, 200)}`);
    const kinds = minimax.body.windows.map(window => window.kind).sort();
    assertTrue(kinds.includes('interval') && kinds.includes('weekly'), 'minimax must expose interval and weekly windows');
    assertTrue((minimax.body.extras || []).every(item => item.unit === 'unknown'), 'remains_time extras must be flagged unknown');
    record('QUOTA-ACC-2-real-key-http', 'PASS', {
      provider: 'minimax', status: minimax.body.status, kinds,
      modelFamily: minimax.body.scope?.modelFamily,
      intervalResetAt: minimax.body.windows.find(window => window.kind === 'interval').resetAt,
      extras: minimax.body.extras,
    });

    // Cache + manual refresh through the real route.
    const cached = await read(`${api}/profiles/glm/quota`);
    assertTrue(cached.body.servedFromCache === true && cached.body.checkedAt === glm.body.checkedAt, 'second read must come from cache with the same checkedAt');
    const refreshed = await read(`${api}/profiles/glm/quota?refresh=1`);
    assertTrue(refreshed.body.stale === false && refreshed.body.servedFromCache === undefined, 'refresh=1 must bypass the cache');
    record('QUOTA-ACC-3-cache-and-manual-refresh', 'PASS', {
      cachedCheckedAt: cached.body.checkedAt, refreshCheckedAt: refreshed.body.checkedAt,
    });

    // --- 2. SDK parity ------------------------------------------------------
    const client = createClaudeWorkbenchClient({ apiBase: api });
    const sdk = await client.getProfileQuota('glm');
    assertTrue(sdk.status === 'ok' && sdk.windows.length === glm.body.windows.length, 'SDK and HTTP must return the same verdict shape');
    const sdkFresh = await client.getProfileQuota('glm', { refresh: true });
    assertTrue(sdkFresh.checkedAt >= sdk.checkedAt, 'SDK refresh must produce a fresh check');
    client.destroy();
    record('QUOTA-ACC-4-sdk-parity', 'PASS', {
      windowsViaSdk: sdk.windows.length, windowsViaHttp: glm.body.windows.length,
      sdkRefreshCheckedAt: sdkFresh.checkedAt,
    });

    // --- 3. real browser, real /profile-settings/ page ----------------------
    const chrome = findChromeDetailed().path;
    browserProfileDir = path.join(root, 'browser-profile');
    browser = await launchCdpBrowser({ chrome, profileDir: browserProfileDir, url: 'about:blank', width: 1360, height: 900, launchAttempts: 2 });
    await browser.send('Page.navigate', { url: `${base}/profile-settings/` });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await browser.evaluate("document.readyState === 'complete' && !document.querySelector('#profileList')?.classList.contains('is-hidden') && document.querySelector('#profileList')?.shadowRoot?.querySelector('.row')")) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const rows = await browser.evaluate("(() => { const list = document.querySelector('#profileList'); return list.shadowRoot.querySelectorAll('.row').length; })()");
    assertTrue(rows >= 2, `the real page must list the saved profiles (rows=${rows})`);

    const clicked = await browser.evaluate("(() => { const list = document.querySelector('#profileList'); const button = list.shadowRoot.querySelector('button[data-action=\"quota\"][data-id=\"glm\"]'); if (!button) return false; button.click(); return true; })()");
    assertTrue(clicked === true, 'the 额度 button of the glm row was not found');
    let panelText = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      panelText = await browser.evaluate("document.querySelector('#profileList')?.shadowRoot?.querySelector('.quota')?.innerText || ''");
      if (panelText.includes('检查于') && (panelText.includes('窗口'))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assertTrue(panelText.includes('检查于'), 'the quota panel did not render a check time');
    assertTrue(panelText.includes('周窗口') || panelText.includes('小时'), `the panel must show the real windows: ${panelText.slice(0, 160)}`);
    assertTrue(panelText.includes('重置于'), 'the panel must show reset times');
    const resetDate = new Date(glmFive.resetAt);
    const expectedTime = `${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`;
    assertTrue(panelText.includes(expectedTime), `the rendered reset time (${expectedTime}) must come from the API data; panel: ${panelText.slice(0, 200)}`);
    record('QUOTA-ACC-5-real-browser-panel', 'PASS', {
      page: '/profile-settings/', rows,
      panelPreview: panelText.slice(0, 400),
      fiveHourResetLocalHHMM: expectedTime,
      sdkUsedPercent: glmFive.usedPercent,
      panelShowsPercent: panelText.includes('%'),
    });

    // Manual refresh button inside the panel.
    await browser.evaluate("(() => { const list = document.querySelector('#profileList'); list.shadowRoot.querySelector('button[data-action=\"quota-refresh\"][data-id=\"glm\"]')?.click(); return true; })()");
    let refreshedText = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      refreshedText = await browser.evaluate("document.querySelector('#profileList')?.shadowRoot?.querySelector('.quota')?.innerText || ''");
      if (refreshedText && refreshedText !== '查询中…' && refreshedText.includes('检查于')) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assertTrue(refreshedText.includes('检查于'), 'manual refresh did not re-render the panel');
    record('QUOTA-ACC-6-manual-refresh-in-ui', 'PASS', { panelPreview: refreshedText.slice(0, 200) });

    // --- 4. no secret anywhere ----------------------------------------------
    const domText = await browser.evaluate(`(() => {
      const all = [document.documentElement.outerHTML];
      const walk = (root) => {
        if (!root) return;
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) { all.push(element.shadowRoot.innerHTML); walk(element.shadowRoot); }
        }
      };
      walk(document);
      return all.join('\\n');
    })()`);
    const quotaResponses = JSON.stringify({ glm: glm.body, minimax: minimax.body, sdk, sdkFresh });
    const leaked = secrets.filter(secret => domText.includes(secret) || quotaResponses.includes(secret));
    assertTrue(leaked.length === 0, 'a credential leaked into the DOM or the API responses');
    const secretsDigestAfter = crypto.createHash('sha256').update(fs.readFileSync(credentialFile)).digest('hex');
    assertTrue(secretsDigestAfter === secretsDigestBefore, 'the real credential file changed during the probe');
    record('QUOTA-ACC-7-no-secret-leak', 'PASS', {
      domScanned: domText.length, responsesScanned: quotaResponses.length,
      realCredentialFileByteIdentical: secretsDigestAfter === secretsDigestBefore,
    });

    evidence.summary = 'PASS: real-key HTTP + SDK parity + real browser panel agreement, no secret leak';
    evidence.exitCode = 0;
  } catch (error) {
    record('QUOTA-ACC-runtime', 'BLOCKED', { error: String(error && error.message || error) });
    evidence.summary = `BLOCKED: ${String(error && error.message || error)}`;
    evidence.sceneKept = root;
    evidence.exitCode = 3;
  } finally {
    try { if (browser) await browser.close(); } catch { /* disposable */ }
    try { await app.service.destroy(); } catch {}
    try { app.server.closeAllConnections && app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); } catch {}
    if (evidence.exitCode === 0) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.log(`SCENE KEPT ${root}`);
    }
  }

  evidence.cases = results;
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'acceptance-probe.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`acceptance evidence -> ${path.join(ARTIFACT_DIR, 'acceptance-probe.json')}`);
  console.log(`parallel-model-quota-acceptance-probe verdict=${evidence.summary}`);
  const exitCode = evidence.exitCode === 0 ? 0 : 3;
  setTimeout(() => process.exit(exitCode), 250).unref();
  process.exitCode = exitCode;
})().catch(error => {
  console.error(error);
  setTimeout(() => process.exit(1), 250).unref();
});
