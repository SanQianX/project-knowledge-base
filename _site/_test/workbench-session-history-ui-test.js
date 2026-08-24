// Run: node _site/_test/workbench-session-history-ui-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, requestJson, waitFor } = require('./helpers/cdp-browser');
const { createLoggingUiFixture } = require('./helpers/logging-ui-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 8500 + (process.pid % 300);
const profileDir = path.join(os.tmpdir(), `pk-workbench-history-profile-${process.pid}`);

(async () => {
  const fixture = await createLoggingUiFixture({ totalLogs: 2 });
  const legacySlug = 'visual-project-legacy';
  const sessionId = 'sess-ui-historical';
  const configPath = fixture.layout.getProjectConfigPath(fixture.projectId);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.legacyExtensions = { ...(config.legacyExtensions || {}), slug: legacySlug };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const sessionDir = path.join(fixture.dataDir, '_ai', legacySlug, 'claude-workbench');
  fs.mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), `${JSON.stringify({
    schema: 'claude-workbench-session/v1',
    sessionId,
    projectSlug: legacySlug,
    projectPath: fixture.repo.path,
    kbPath: config.knowledgePath,
    promptKey: 'post-commit-automation',
    runner: 'sdk',
    state: 'idle',
    model: 'fixture-model',
    source: 'git-hook',
    automation: true,
    automationRunId: 'run-ui-historical',
    metadata: { source: 'git-hook', automationRunId: 'run-ui-historical' },
    permissionMode: 'acceptEdits',
    startedAt: timestamp,
    endedAt: timestamp,
    exitCode: 0,
    turns: 1,
    events: [
      { type: 'claude/user-prompt', text: '历史 Commit 分析提示词' },
      { type: 'claude/thinking-start', id: 'thinking-1' },
      { type: 'claude/thinking-delta', text: '正在检查提交证据。' },
      { type: 'claude/tool-use-start', id: 'tool-1', name: 'Read' },
      { type: 'claude/tool-use', id: 'tool-1', name: 'Read', input: { file_path: 'evidence/commit.json' } },
      { type: 'claude/text-delta', text: '分析完成。' },
      { type: 'claude/result', result: '历史知识分析结果', isError: false },
      { type: 'claude/state', state: 'idle' },
    ],
    updatedAt: timestamp,
  }, null, 2)}\n`, 'utf8');

  const server = spawnServer({ root: ROOT, port: sitePort, dataDir: fixture.dataDir, tag: 'workbench-history-ui', stdio: 'ignore' });
  let browser;
  try {
    await waitFor(() => requestJson(`http://127.0.0.1:${sitePort}/api/health`).then(payload => payload.ok), 'isolated server', 20000);
    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir, url: `http://127.0.0.1:${sitePort}/`, width: 1440, height: 900 });
    await waitFor(() => browser.evaluate(`window.__PK_APP__ && window.__PK_APP__.getState().sessionCount === 1 && window.__PK_APP__.getState().activeSessionId === '${sessionId}'`), 'historical session auto-restore', 20000);
    await waitFor(() => browser.evaluate(`document.getElementById('chat').innerText.includes('历史知识分析结果')`), 'historical event replay', 10000);

    const snapshot = await browser.evaluate(`(() => ({
      active: window.__PK_APP__.getState().activeSessionId,
      sessions: document.querySelectorAll('#wb-session option').length,
      selectedLabel: document.querySelector('#wb-session option:checked').textContent,
      text: document.getElementById('chat').innerText,
      tool: document.querySelector('.tool-card .tool-title')?.textContent || '',
      messageCount: Number(document.getElementById('msg-count').textContent)
    }))()`);
    assert.strictEqual(snapshot.active, sessionId);
    assert.strictEqual(snapshot.sessions, 2, 'new-session option plus one historical session');
    assert(snapshot.selectedLabel.includes('Commit 分析') && snapshot.selectedLabel.includes('历史数据'));
    assert(snapshot.text.includes('历史 Commit 分析提示词'));
    assert(snapshot.text.includes('思考过程') && snapshot.text.includes('正在检查提交证据。'));
    assert(snapshot.text.includes('历史知识分析结果'));
    assert(snapshot.tool.includes('Read'));
    assert(snapshot.messageCount >= 4);

    await browser.evaluate(`document.getElementById('wb-new-session').click()`);
    assert.strictEqual(await browser.evaluate(`window.__PK_APP__.getState().activeSessionId`), '');
    await browser.evaluate(`(() => { const select = document.getElementById('wb-session'); select.value = '${sessionId}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => browser.evaluate(`window.__PK_APP__.getState().activeSessionId === '${sessionId}' && document.getElementById('chat').innerText.includes('历史知识分析结果')`), 'manual historical session restore', 10000);
    assert.strictEqual(browser.exceptions.length, 0, `browser runtime exceptions: ${JSON.stringify(browser.exceptions)}`);
    console.log('workbench session history UI test PASS');
  } finally {
    if (browser) await browser.close();
    await server.cleanup();
    fixture.cleanup();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
