'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const coreRoot = path.resolve(process.env.KB_CAPTURE_TEST_CORE_ROOT || path.join(__dirname, '../..'));
const fromCore = createRequire(path.join(coreRoot, 'package.json'));
const { createRuntime, initializeRuntime, createRequestHandler } = fromCore('./_site/lib/server-app');
const { BridgeAdapter } = fromCore('./_site/lib/bridge-adapter');
const { ModuleBridge } = fromCore('./_site/lib/module-bridge');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { Journal } = fromCore('@sanqianx/ai-coding-event-bridge-console/src/bridge');
const { spawnSync } = require('node:child_process');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-capture-ui-'));
  const dataDir = path.join(temp, 'data');
  const homeDir = path.join(temp, '用户 空格');
  const eventsHome = path.join(dataDir, 'events');
  const configFile = path.join(homeDir, '.zcode', 'cli', 'config.json');
  const intentFile = path.join(dataDir, 'integration-intent.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ provider: { name: 'retain' } }));
  const offline = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: '本轮测试中非采集模块离线' } })); });
  await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
  const offlineUrl = `http://127.0.0.1:${offline.address().port}`;
  const runtime = createRuntime({ dataDir, analysisOwner: 'engine', bridgeAdapter: new BridgeAdapter({ dataDir, bridgeHomeDir: eventsHome }), moduleBridge: new ModuleBridge({ terminalUrl: offlineUrl, engineUrl: offlineUrl, eventBridgeUrl: offlineUrl, vectorHubUrl: offlineUrl }) });
  await initializeRuntime(runtime);
  const server = http.createServer(createRequestHandler(runtime, { integrationOptions: { homeDir, env: {}, commandResolver: () => '' } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(temp, 'browser'), url: base, width: 1920, height: 1080 });
    await browser.setViewport(1920, 1080);
    const run = expression => browser.evaluate(expression);
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await click('#openSystem');
    await waitFor(() => run("document.querySelectorAll('#agentCaptureList .agent-capture-row').length === 4"), 'four capture statuses');
    // Single-switch rows: claude undetected -> disabled switch; zcode configured -> enabled, badge 未接入.
    assert.equal(await run("document.querySelector('[data-agent-client=claude][data-agent-switch]').disabled"), true);
    assert.equal(await run("document.querySelector('[data-agent-client=zcode][data-agent-switch]').disabled"), false);
    await waitFor(() => run("document.querySelector('[data-agent-client=zcode]').closest('.agent-capture-row').textContent.includes('未接入')"), 'zcode badge settles to disconnected');
    assert(await run("document.getElementById('agentCaptureList').textContent.includes('检测到配置')"));
    assert.equal(await run("document.querySelector('[data-agent-client=zcode]').closest('.agent-capture-row').querySelector('details.agent-detail').open"), false, 'details must be collapsed by default');
    assert.equal(await run("document.getElementById('refreshAgentCapture')"), null, 'manual status button removed');
    // Switch ON: full install (knowledge + capture), real config written.
    await click('[data-agent-client=zcode][data-agent-switch=install]');
    await waitFor(() => run("document.querySelector('[data-agent-client=zcode][data-agent-switch=uninstall]') !== null"), 'connected status reloaded from backend');
    assert(await run("document.querySelector('[data-agent-client=zcode]').closest('.agent-capture-row').textContent.includes('已接入')"));
    const config = JSON.parse(fs.readFileSync(configFile));
    assert.equal(config.hooks.enabled, true);
    const intent = JSON.parse(fs.readFileSync(intentFile));
    assert.equal(intent.clients.zcode, 'connected', 'successful install records intent');
    const env = { ...process.env }; delete env.AI_CODING_EVENT_BRIDGE_HOME; delete env.AI_CODING_EVENT_BRIDGE_CAPTURE;
    // Full install wires every UserPromptSubmit hook (context pre-read first,
    // capture second) — run them all like the real client does.
    for (const hook of config.hooks.events.UserPromptSubmit.flatMap(entry => entry.hooks)) {
      const child = spawnSync(process.execPath, hook.args, { env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'ui-zcode-session', cwd: temp, prompt: '从网页接入后写入真实 journal' }), encoding: 'utf8', timeout: 15000 });
      assert.equal(child.status, 0, child.stderr);
    }
    const events = await new Journal(path.join(eventsHome, 'journal')).readEvents({});
    assert.equal(events.length, 1); assert.equal(events[0].source, 'zcode');
    assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false);
    const artifacts = path.resolve(process.env.KB_CAPTURE_TEST_ARTIFACTS || path.join(__dirname, '../..', '.agent-state/acceptance/agent-capture'));
    await browser.screenshot(path.join(artifacts, '1920-light.png'));
    await click('#closeSystem'); await click('#themeToggle'); await click('#openSystem');
    await waitFor(() => run("document.querySelector('[data-agent-client=zcode][data-agent-switch=uninstall]') !== null"), 'theme retains capture status');
    await browser.screenshot(path.join(artifacts, '1920-dark.png'));
    // Broken config: the single switch acts as the explicit repair path.
    fs.writeFileSync(configFile, '{invalid JSON');
    await click('#closeSystem'); await click('#openSystem');
    await waitFor(() => run("(() => { const b = document.querySelector('[data-agent-client=zcode][data-agent-switch=install]'); return b !== null && !b.disabled; })()"), 'capture row settled before invalid config');
    await click('[data-agent-client=zcode][data-agent-switch=install]');
    await waitFor(() => run("document.getElementById('agentCaptureFeedback').textContent.includes('操作未完成')"), 'partial failure rendered');
    assert(await run("document.getElementById('agentCaptureFeedback').classList.contains('issue')"));
    const logs = (await (await fetch(base + '/api/logs?event=integration.capture.failed')).json()).entries;
    assert(logs.length > 0 && logs[0].error.message.includes('valid JSON'));
    fs.writeFileSync(configFile, JSON.stringify(config));
    await click('#closeSystem'); await click('#openSystem');
    await waitFor(() => run("document.querySelector('[data-agent-client=zcode][data-agent-switch=uninstall]') !== null"), 'switch repair succeeds');
    // Switch OFF: removal keeps third-party config and prior evidence.
    await click('[data-agent-client=zcode][data-agent-switch=uninstall]');
    await waitFor(() => run("!document.querySelector('[data-agent-client=zcode][data-agent-switch]').disabled && document.querySelector('[data-agent-client=zcode][data-agent-switch=uninstall]') === null"), 'removed capture status');
    assert.equal(JSON.parse(fs.readFileSync(configFile)).provider.name, 'retain');
    assert.equal(JSON.parse(fs.readFileSync(intentFile)).clients.zcode, 'disconnected', 'uninstall records disconnected intent');
    assert.equal((await new Journal(path.join(eventsHome, 'journal')).readEvents({})).length, 1, 'removal retains prior evidence');
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    console.log(`agent-capture-ui-test PASS (1920x1080; single-switch install/repair/Hook/journal/error logs/intent/removal/light+dark; core=${coreRoot})`);
  } finally {
    runtime.integrationStatusScan?.close();
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    offline.closeAllConnections(); await new Promise(resolve => offline.close(resolve)); await runtime.logger.close();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('kb-agent-capture-ui-'));
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
