const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-claude-runner-v2-'));
process.env.KB_DATA_DIR = path.join(temp, 'data');
require('../lib/data-dir')._resetCache();
const runner = require('../lib/claude-cli-runner');

(async () => {
  const projectPath = path.join(temp, 'repo');
  const kbPath = path.join(temp, 'knowledge');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(kbPath, { recursive: true });
  const slug = 'chat-runner-v2';

  try {
    const started = runner.startSession({
      slug,
      projectPath,
      kbPath,
      promptKey: 'initial-analysis',
      aiProfile: { id: 'test-profile', implementation: 'claude-code-agent', mainModel: 'test-model' },
      vars: { SLUG: slug, PROJECT_PATH: projectPath, KNOWLEDGE_LANGUAGE: 'zh-CN' },
    });
    assert(started.sessionId);

    const source = fs.readFileSync(path.join(ROOT, '_site', 'lib', 'claude-cli-runner.js'), 'utf8');
    assert(/normalizePermissionMode\(opts\.permissionMode \|\| session\.permissionMode \|\| 'default'\)/.test(source));
    assert(/type === 'claude\/usage' && ev\.usage/.test(source));
    assert(/input_tokens/.test(source) && /output_tokens/.test(source) && /cache_creation_input_tokens/.test(source));
    assert(/spawnClaude is no longer supported/.test(source));
    assert(/type:\s*'claude\/retry'/.test(source) && /maxSdkRetries\(\)/.test(source));

    const fresh = runner.getSessionTokenUsage(started.sessionId);
    assert.strictEqual(fresh.used, 0);
    assert.strictEqual(fresh.hasUsage, false);
    assert(fresh.total > 0);

    const liveSession = runner.getSession(started.sessionId);
    liveSession.contextWindow = 1048576;
    assert.strictEqual(runner.getSessionTokenUsage(started.sessionId).total, 1048576);
    liveSession.contextWindow = null;
    assert.strictEqual(runner.getSessionTokenUsage(started.sessionId).total, 200000);

    const overrides = runner.buildSdkOverridesFromProfile({});
    assert(overrides.systemPrompt && overrides.systemPrompt.preset === 'claude_code');
    const env = runner.buildClaudeEnvFromProfile({
      apiKey: 'sk-plaintext',
      baseUrl: 'https://example.test/anthropic',
      mainModel: 'main',
      thinkingModel: 'think',
      haikuModel: 'hk',
      sonnetModel: 'sn',
      opusModel: 'op',
      timeoutMs: 1234,
    });
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-plaintext');
    assert.strictEqual(env.ANTHROPIC_MODEL, 'main');
    assert.strictEqual(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'hk');
    assert.strictEqual(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sn');
    assert.strictEqual(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'op');
    assert.strictEqual(env.ANTHROPIC_DEFAULT_THINKING_MODEL, 'think');
    assert.strictEqual(env.API_TIMEOUT_MS, '1234');
    assert.strictEqual(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert(runner.isTransientClaudeError(new Error('429 too many requests')));
    assert(!runner.isTransientClaudeError(new Error('model does not exist')));

    const server = fs.readFileSync(path.join(ROOT, '_site', 'lib', 'server-app.js'), 'utf8');
    assert(server.includes('body.permissionMode'));

    const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
    assert(html.includes('id="view-workbench"') && html.includes('id="chat-input"'));
    assert(html.includes('id="wb-session"') && html.includes('id="wb-new-session"') && html.includes('id="wb-stop-session"'));
    assert(app.includes('/api/claude/sessions') && app.includes('/events'));
    assert(app.includes('/api/claude/sessions-stream') && app.includes('loadClaudeSessions') && app.includes('attachSession'));
    assert(app.includes("'claude/thinking-delta'") && app.includes("'claude/text-delta'") && app.includes("'claude/tool-use'") && app.includes("'claude/permission-request'"));
    assert(/hookAutomation[\s\S]+event\.kind === 'create'/.test(app), 'new Hook automation sessions must become visible immediately');

    runner.deleteSession(started.sessionId);
    console.log('chat runner contract test PASS');
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
