'use strict';
// WB-QUOTA-01-R2 UI acceptance probe — EXPLICIT, never part of default CI.
//
// Isolated workbench server + isolated data dir + OFFLINE upstream mock
// (quotaFetch interception: the quota path never dials any real endpoint,
// zero real-account quota queries) + real headless Chrome on the real
// /profile-settings/ page. Proves the r2 fixes through the real entry:
//   R2-UI-1 null≠0 rendering + malicious modelCode rendered as TEXT only;
//   R2-UI-2 manual refresh keeps the last content, a failed refresh is
//         explicitly stale (never washed fresh), a real success recovers;
//   R2-UI-3 same-id provider switch through the REAL editor save flow drops
//         the old verdict, and a LATE old-provider answer can never win;
//   R2-UI-4 credentials (fake, probe-owned) never appear in any response
//         or rendered DOM; every upstream call is redirect:manual.
// Exit 0 = all proven; the process exits for real (probe exit discipline).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_ROOT = 'D:/SanQian.Xu/claude-ai-workbench';
const KB_ROOT = 'D:/SanQian.Xu/project-knowledge-base';
const ARTIFACT_DIR = path.join(KB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'model-quota-feature');
const { createWorkbenchServer } = require(path.join(MODULE_ROOT, 'packages', 'server'));
const { launchCdpBrowser } = require(path.join(KB_ROOT, '_site', '_test', 'helpers', 'cdp-browser'));
const { findChromeDetailed } = require(path.join(KB_ROOT, '_site', '_test', 'helpers', 'find-chrome'));
const { createFakeRunner } = require(path.join(MODULE_ROOT, 'tests', 'helpers', 'fake-runner'));

const GLM_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
const MINIMAX_URL = 'https://www.minimaxi.com/v1/token_plan/remains';
const FAKE_GLM_KEY = 'probe-fake-glm-key-123456';

const results = [];
const record = (caseId, status, detail) => {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail).slice(0, 260)}`);
};
const jsonRes = (status, body) => ({ status, text: async () => JSON.stringify(body) });

// Offline upstream mock: every quota request is held until the probe
// releases it with a scripted response. Nothing ever leaves the process.
const upstreamLog = [];
const heldQueue = [];
const mockQuotaFetch = (url, init) => {
  upstreamLog.push({ url, authorization: init?.headers?.Authorization, redirect: init?.redirect });
  return new Promise(resolve => heldQueue.push({ url, resolve }));
};
const releaseOldest = (response) => {
  const item = heldQueue.shift();
  if (!item) throw new Error(`releaseOldest: no pending upstream request (${upstreamLog.length} logged)`);
  item.resolve(response);
  return item.url;
};
// Releases a specific endpoint's held request (multiple endpoints can be
// held simultaneously during the late-loser scenario).
const releaseFor = (url, response) => {
  const index = heldQueue.findIndex(item => item.url === url);
  if (index < 0) throw new Error(`releaseFor: no pending request for ${url} (${heldQueue.length} held)`);
  const [item] = heldQueue.splice(index, 1);
  item.resolve(response);
};

const MALICIOUS_CODE = '<img src=x onerror="window.__r2Pwned=1">';
const MALICIOUS_SVG = '<svg onload="window.__r2PwnedSvg=1"></svg>';
const glmBody = (level, percentage) => ({ code: 200, success: true, data: { level, limits: [
  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: 1792765731899 },
  { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 0, currentValue: 0, remaining: 0, percentage: 0, nextResetTime: 1794901032984,
    usageDetails: [{ modelCode: MALICIOUS_CODE, usage: 5 }, { modelCode: MALICIOUS_SVG, usage: 3 }] },
] } });
const minimaxBody = (marker) => ({ model_remains: [{
  start_time: 1792738800000, end_time: 1792756800000, remains_time: 5727352,
  current_interval_total_count: 5, current_interval_usage_count: 2, model_name: 'general',
  current_weekly_total_count: 50, current_weekly_usage_count: 10,
  weekly_start_time: 1792339200000, weekly_end_time: 1792944000000, weekly_remains_time: 192927352,
  current_interval_status: 1, current_interval_remaining_percent: 60,
  current_weekly_status: 1, current_weekly_remaining_percent: 80,
}], base_resp: { status_code: 0, status_msg: marker } });

const panelText = (browser) => browser.evaluate("document.querySelector('#profileList')?.shadowRoot?.querySelector('.quota')?.innerText || ''");

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-quota-r2-'));
  const app = createWorkbenchServer({
    dataDir: path.join(root, 'data'), runner: createFakeRunner(),
    quotaFetch: mockQuotaFetch, serveHost: true,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = `${base}/api/claude-workbench/v1`;

  // Seed one glm profile (official https URL) with a probe-owned fake key in
  // the probe's OWN data dir. No real profile or credential is ever read.
  const put = (pathname, body) => globalThis.fetch(`${api}${pathname}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await put('/profiles/glm', { id: 'glm', name: 'GLM R2', provider: '智谱GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: { default: 'glm-4.6' } });
  assertOk((await put('/profiles/glm/credential', { secret: FAKE_GLM_KEY })).status === 204, 'credential seed failed');

  let browser = null;
  const evidence = { probe: 'parallel-model-quota-ui-r2-probe', ranAt: new Date().toISOString(), base, cases: results, upstreamCalls: upstreamLog };
  try {
    const chrome = findChromeDetailed().path;
    browser = await launchCdpBrowser({ chrome, profileDir: path.join(root, 'browser-profile'), url: 'about:blank', width: 1360, height: 900, launchAttempts: 2 });
    await browser.send('Page.navigate', { url: `${base}/profile-settings/` });
    await waitFor(browser, async () => (await browser.evaluate("document.querySelector('#profileList')?.shadowRoot?.querySelector('.row') ? 1 : 0")) === 1);

    // --- R2-UI-1: null≠0 + malicious modelCode as text -------------------
    await clickQuota(browser, 'glm');
    await waitFor(browser, async () => upstreamLog.length === 1);
    assertOk(upstreamLog[0].url === GLM_URL && upstreamLog[0].authorization === FAKE_GLM_KEY, 'first upstream call must be the official GLM URL with the fake key');
    assertOk(upstreamLog[0].redirect === 'manual', 'upstream call must never auto-follow redirects');
    releaseOldest(jsonRes(200, glmBody('R2-NULLS', null)));
    await waitFor(browser, async () => (await panelText(browser)).includes('R2-NULLS'));
    const text1 = await panelText(browser);
    assertOk(text1.includes('未提供'), `null fields must read 未提供: ${text1.slice(0, 160)}`);
    assertOk(/已用 0 \/ 0/.test(text1), `a genuine zero renders as 0: ${text1.slice(0, 160)}`);
    const dom1 = await browser.evaluate(`(() => {
      const all = [];
      const walk = (r) => { if (!r) return; for (const el of r.querySelectorAll('*')) { if (el.shadowRoot) { all.push(el.shadowRoot); walk(el.shadowRoot); } } };
      walk(document);
      return all.map(s => s.innerHTML).join('\\n');
    })()`);
    assertOk(!dom1.includes(MALICIOUS_CODE) || dom1.includes('&lt;img src=x onerror='), 'raw markup must be escaped in the DOM');
    assertOk(!(await browser.evaluate('window.__r2Pwned')) && !(await browser.evaluate('window.__r2PwnedSvg')), 'malicious modelCode must never execute');
    const noForeignNodes = await browser.evaluate(`(() => {
      const quota = document.querySelector('#profileList')?.shadowRoot?.querySelector('.quota');
      if (!quota) return false;
      if (quota.querySelectorAll('img,script,iframe,svg').length) return false;
      return ![...quota.querySelectorAll('*')].some(el => [...el.attributes].some(a => /^on/i.test(a.name)));
    })()`);
    assertOk(noForeignNodes, 'no injected elements and no inline handlers inside the quota panel');
    assertOk(text1.includes(MALICIOUS_CODE) && text1.includes(MALICIOUS_SVG), 'the malicious modelCodes survive as complete TEXT');
    record('R2-UI-1-null-not-zero-and-text-only', 'PASS', {
      planLevel: 'R2-NULLS', shows未提供: true, genuineZeroShown: /已用 0 \/ 0/.test(text1),
      executed: false, panelPreview: text1.slice(0, 220),
    });

    // --- R2-UI-2: refresh keeps content; failure is stale, never washed ---
    await clickRefresh(browser, 'glm');
    await waitFor(browser, async () => upstreamLog.length === 2 && (await panelText(browser)).includes('刷新中'));
    const duringWait = await panelText(browser);
    assertOk(duringWait.includes('R2-NULLS'), 'last successful content stays visible during the refresh');
    releaseOldest(jsonRes(500, {}));
    await waitFor(browser, async () => (await panelText(browser)).includes('已过期'));
    const staleText = await panelText(browser);
    assertOk(staleText.includes('R2-NULLS'), 'stale keeps the last successful content');
    assertOk(staleText.includes('刷新失败') || staleText.includes('HTTP 500'), `the failure meaning is explicit: ${staleText.slice(0, 200)}`);

    const cacheCheck = await (await globalThis.fetch(`${api}/profiles/glm/quota`)).json();
    assertOk(cacheCheck.stale === true && cacheCheck.lastError?.errorClass === 'http_error', 'a plain machine read within TTL also keeps stale+lastError (not washed)');
    assertOk(cacheCheck.checkedAt != null, 'checkedAt still reports the last successful check');

    await clickRefresh(browser, 'glm');
    await waitFor(browser, async () => upstreamLog.length === 3);
    releaseOldest(jsonRes(200, glmBody('R2-REFRESHED', 36)));
    await waitFor(browser, async () => (await panelText(browser)).includes('R2-REFRESHED'));
    const recovered = await panelText(browser);
    assertOk(!recovered.includes('已过期'), 'a real success clears the stale marking');
    assertOk(recovered.includes('36%'), 'a real percentage renders after recovery');
    record('R2-UI-2-refresh-keep-and-stale-honesty', 'PASS', {
      keptDuringWait: duringWait.includes('R2-NULLS'), staleKeptContent: staleText.includes('R2-NULLS'),
      machineReadStale: cacheCheck.stale === true, recovered: recovered.includes('R2-REFRESHED'),
    });

    // --- R2-UI-3: same-id provider switch via the REAL save flow + late loser ---
    await clickRefresh(browser, 'glm'); // held GLM request that will arrive LATE
    await waitFor(browser, async () => upstreamLog.length === 4);
    await openEditorAndSwitchToMinimax(browser);
    await waitFor(browser, async () => {
      const html = await browser.evaluate("document.querySelector('#profileList')?.shadowRoot?.innerHTML || ''");
      return html.includes('api.minimaxi.com') && !html.includes('class="quota"');
    });
    const afterSwitch = await browser.evaluate("document.querySelector('#profileList')?.shadowRoot?.innerHTML || ''");
    assertOk(!afterSwitch.includes('R2-REFRESHED'), 'the old provider verdict does not survive the switch');

    await clickQuota(browser, 'glm');
    await waitFor(browser, async () => upstreamLog.length === 5);
    assertOk(upstreamLog[4].url === MINIMAX_URL, 'the switched row queries the MiniMax official endpoint');
    releaseFor(MINIMAX_URL, jsonRes(200, minimaxBody('MINIMAX-CURRENT')));
    await waitFor(browser, async () => (await panelText(browser)).includes('模型族 general'));
    const minimaxText = await panelText(browser);

    releaseFor(GLM_URL, jsonRes(200, glmBody('GLM-LATE-MUST-NOT-WIN', 90))); // the late GLM answer
    await new Promise(resolve => setTimeout(resolve, 600));
    const finalText = await panelText(browser);
    assertOk(finalText.includes('模型族 general') && !finalText.includes('GLM-LATE-MUST-NOT-WIN'), 'a late old-provider answer can never overwrite the current verdict');
    assertOk(finalText === minimaxText, `panel stays exactly the MiniMax verdict: ${finalText.slice(0, 160)}`);
    record('R2-UI-3-same-id-switch-and-late-loser', 'PASS', {
      switchedTo: 'minimax', oldVerdictDropped: true, lateLoser: 'GLM-LATE-MUST-NOT-WIN', lateRejected: !finalText.includes('GLM-LATE-MUST-NOT-WIN'),
      upstreamSequence: upstreamLog.map(call => call.url.replace('https://', '').split('/')[0]),
    });

    // --- R2-UI-4: credentials never leak; every call was redirect:manual --
    const domText = await browser.evaluate(`(() => {
      const all = [document.documentElement.outerHTML];
      const walk = (root) => { if (!root) return; for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { all.push(el.shadowRoot.innerHTML); walk(el.shadowRoot); } } };
      walk(document);
      return all.join('\\n');
    })()`);
    assertOk(!domText.includes(FAKE_GLM_KEY), 'the (fake) credential never appears in the rendered DOM');
    const machineReads = [];
    machineReads.push(JSON.stringify(await (await globalThis.fetch(`${api}/profiles/glm/quota`)).json()));
    const refreshPromise = globalThis.fetch(`${api}/profiles/glm/quota?refresh=1`).then(response => response.json());
    await waitFor(browser, async () => upstreamLog.length === 6, 50);
    releaseFor(MINIMAX_URL, jsonRes(200, minimaxBody('MINIMAX-REFRESHED')));
    machineReads.push(JSON.stringify(await refreshPromise));
    assertOk(!machineReads.join('').includes(FAKE_GLM_KEY), 'no machine response echoes the credential');
    assertOk(upstreamLog.every(call => call.redirect === 'manual'), 'every upstream call used redirect:manual');
    assertOk(upstreamLog.every(call => call.authorization === FAKE_GLM_KEY || call.authorization === `Bearer ${FAKE_GLM_KEY}`), 'only the seeded fake key ever left the process (GLM raw, MiniMax Bearer)');
    record('R2-UI-4-no-leak-and-redirect-manual', 'PASS', {
      domScanned: domText.length, credentialInDom: false,
      upstreamCalls: upstreamLog.length, allRedirectManual: true,
    });

    evidence.summary = 'PASS: null≠0 + text-only rendering, honest stale, same-id switch + late loser rejected, no credential leak — all through the real /profile-settings/ entry with an offline upstream mock';
    evidence.exitCode = 0;
  } catch (error) {
    record('R2-UI-runtime', 'BLOCKED', { error: String(error && error.message || error), pendingHeld: heldQueue.length });
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
  evidence.upstreamCalls = upstreamLog;
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'ui-r2-probe.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`r2 ui evidence -> ${path.join(ARTIFACT_DIR, 'ui-r2-probe.json')}`);
  console.log(`parallel-model-quota-ui-r2-probe verdict=${evidence.summary}`);
  const exitCode = evidence.exitCode === 0 ? 0 : 3;
  setTimeout(() => process.exit(exitCode), 250).unref();
  process.exitCode = exitCode;
})().catch(error => {
  console.error(error);
  setTimeout(() => process.exit(1), 250).unref();
});

function assertOk(condition, message) { if (!condition) throw new Error(message); }
async function waitFor(browser, predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('waitFor: condition not met in time');
}
async function clickQuota(browser, id) {
  const clicked = await browser.evaluate(`(() => { const list = document.querySelector('#profileList'); const button = list.shadowRoot.querySelector('button[data-action="quota"][data-id="${id}"]'); if (!button) return false; button.click(); return true; })()`);
  assertOk(clicked === true, 'quota button not found');
}
async function clickRefresh(browser, id) {
  const clicked = await browser.evaluate(`(() => { const list = document.querySelector('#profileList'); const button = list.shadowRoot.querySelector('button[data-action="quota-refresh"][data-id="${id}"]'); if (!button) return false; button.click(); return true; })()`);
  assertOk(clicked === true, 'quota-refresh button not found');
}
async function openEditorAndSwitchToMinimax(browser) {
  const opened = await browser.evaluate(`(() => { const list = document.querySelector('#profileList'); const button = list.shadowRoot.querySelector('button[data-action="edit"][data-id="glm"]'); if (!button) return false; button.click(); return true; })()`);
  assertOk(opened === true, 'edit button not found');
  await waitFor(browser, async () => (await browser.evaluate("document.querySelector('#profileEditor')?.shadowRoot?.querySelector('.preset[data-preset=minimax]') ? 1 : 0")) === 1);
  await browser.evaluate(`(() => { const editor = document.querySelector('#profileEditor'); editor.shadowRoot.querySelector('.preset[data-preset="minimax"]').click(); return true; })()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  await browser.evaluate(`(() => { const editor = document.querySelector('#profileEditor'); editor.shadowRoot.querySelector('[data-action="save"]').click(); return true; })()`);
}
