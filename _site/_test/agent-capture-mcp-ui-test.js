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

const HOSTILE_DETAIL = '<img src=x onerror="window.__kbXssProbe=1"> INJECT-STATUS-MARKER sk-abcdef123456';

function clientFixture(client, label) {
  const mcpCapable = client === 'claude' || client === 'codex';
  return {
    client, label, available: false, configFound: false,
    knowledgeIntegration: { ok: true, state: 'installed' },
    automaticContext: { supported: client !== 'opencode', configured: false, state: 'check-failed', detail: HOSTILE_DETAIL },
    developmentCapture: { ok: true, state: 'installed', installed: true, detail: HOSTILE_DETAIL },
    mcpStartup: mcpCapable ? { state: 'failed', checkedAt: new Date().toISOString(), scope: 'client:' + client, code: 'PROBE_TIMEOUT', expectedVersion: '9.9.9-test', detail: HOSTILE_DETAIL } : undefined,
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-mcp-ui-'));
  const dataDir = path.join(temp, 'data');
  const homeDir = path.join(temp, 'home');
  const eventsHome = path.join(dataDir, 'events');
  const offline = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: 'offline stub' } })); });
  await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
  const offlineUrl = 'http://127.0.0.1:' + offline.address().port;
  const runtime = createRuntime({ dataDir, analysisOwner: 'engine', bridgeAdapter: new BridgeAdapter({ dataDir, bridgeHomeDir: eventsHome }), moduleBridge: new ModuleBridge({ terminalUrl: offlineUrl, engineUrl: offlineUrl, eventBridgeUrl: offlineUrl, vectorHubUrl: offlineUrl }) });
  await initializeRuntime(runtime);
  const server = http.createServer(createRequestHandler(runtime, { integrationOptions: { homeDir, env: {}, commandResolver: () => '' } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const payload = JSON.stringify({ bridge: { ok: true }, scan: { state: 'ready' }, clients: [clientFixture('claude', 'Claude Code'), clientFixture('codex', 'Codex'), clientFixture('zcode', 'ZCode'), clientFixture('opencode', 'OpenCode')] });
  let browser;
  try {
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(temp, 'browser'), url: base, width: 1440, height: 900 });
    const run = expression => browser.evaluate(expression);
    const click = selector => run('document.querySelector(' + JSON.stringify(selector) + ').click()');
    await run('(() => { const original = window.fetch; window.__originalFetch = original; window.fetch = (input, init) => { const url = String(input && input.url || input); if (url.includes(\'/api/integrations/status\')) { return Promise.resolve({ ok: true, json: async () => (' + payload + ') }); } return original(input, init); }; })()');
    await click('#openSystem');
    await waitFor(() => run("document.querySelectorAll('#agentCaptureList .agent-capture-row').length === 4"), 'capture rows render');
    assert(await run("document.getElementById('agentCaptureList').textContent.includes('PROBE_TIMEOUT')"), 'the MCP startup failure code must be rendered for MCP-capable clients');
    const claudeRowHtml = await run("document.querySelector('#agentCaptureList .agent-capture-row').innerHTML");
    assert(claudeRowHtml.includes('&lt;img'), 'hostile mcpStartup detail must be HTML-escaped, got: ' + claudeRowHtml.slice(0, 300));
    assert(!claudeRowHtml.includes('<img'), 'no raw hostile markup may reach the DOM');
    assert.equal(await run('window.__kbXssProbe'), undefined, 'the hostile onerror must never execute');
    const smalls = await run("[...document.querySelectorAll('#agentCaptureList small')].map(el => el.textContent).join('|')");
    assert(smalls.split('|').some(text => text.startsWith('MCP')), 'the MCP diagnostic is its own line item, got: ' + smalls);
    assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
    console.log('agent-capture-mcp-ui-test PASS (MCP line rendered separately; hostile detail escaped; no XSS execution)');
  } finally {
    runtime.integrationStatusScan?.close();
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    offline.closeAllConnections(); await new Promise(resolve => offline.close(resolve)); await runtime.logger.close();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('kb-agent-mcp-ui-'));
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
