const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 迁移说明（五页简化 UI，静态契约解析部分）：
// - workFrame 断言保留：#view-work/#workFrame 仍在 DOM，但只作为隐藏服务
//   挂载（供应商/维护模型配置经 #configureProviders 驱动）。
// - 检索页不再内嵌 vectorHub：#vectorFrame 已删除，改为断言 #view-search
//   存在、产品走服务端检索（/api/engine/search）且 HTML 不再含 vectorFrame。
// - 导航结构：nav 恰好五个 data-view（home/memory/projects/search/
//   activity），不含 work。
// - 嵌入协议：kb:sidebar（折叠栏）已随 work 导航页删除，改断言隐藏挂载
//   的驱动消息 kb:open-settings；kb:select-project/kb:knowledge/
//   initializeFrame 与「会话生命周期只属于 terminal 模块」的负断言保留。

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
    const app = fs.readFileSync(path.join(ROOT, 'ui', 'product.js'), 'utf8');
    // T2: 内嵌终端取代旧 workbench 聊天面板 —— 壳经 kb:* 协议与会话/事件交互。
    // work 不再是导航页，但 workbench 帧保留为隐藏服务挂载。
    assert(html.includes('id="view-work"') && html.includes('id="workFrame"'));
    assert(html.includes('hidden><div class="work-layout" id="workLayout" hidden>'), 'the workbench mount stays hidden');
    // 五页导航：恰好 home/memory/projects/search/activity，不含 work。
    const nav = /<nav aria-label="主要导航">([\s\S]*?)<\/nav>/.exec(html);
    assert(nav, 'the navigation block exists');
    const navViews = [...nav[1].matchAll(/data-view="([a-z]+)"/g)].map(match => match[1]);
    assert.deepStrictEqual(navViews, ['home', 'memory', 'projects', 'search', 'activity'], 'the navigation offers exactly the five pages');
    // 检索页不再内嵌 vectorHub：服务端检索取代 vectorFrame。
    assert(html.includes('id="view-search"') && !html.includes('id="vectorFrame"'));
    assert(app.includes("'/api/engine/search'"), 'the search page drives the server-side engine search');
    assert(app.includes("'kb:select-project'") && app.includes("'kb:knowledge'") && app.includes('initializeFrame'));
    assert(app.includes("'kb:open-settings'"), 'embed protocol wiring must still reach the hidden workbench mount');
    // 会话生命周期（archive/restore）只属于 terminal 模块，壳保持只读投影
    assert(!app.includes("'kb:archive-session'") && !app.includes("'kb:restore-session'"), 'session lifecycle wiring must stay terminal-module-only');

    runner.deleteSession(started.sessionId);
    console.log('chat runner contract test PASS');
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
