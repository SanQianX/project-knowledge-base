// TASK-005: AI profile and adapter test
// Run: node _site/_test/ai-profile-test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
// Pre-create a temp data dir and seed it BEFORE requiring any lib modules
// that capture getDataDir() at module load. Both the test process and
// the spawned server will use this dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-ai-profile-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{}\n', 'utf-8');
try { fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json')); } catch {}
let PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const AI_PROFILES_PATH = path.join(DATA_DIR, 'ai-profiles.json');
const BASELINE_AI_PROFILES = {
  schema: 'ai-profiles/v1',
  profiles: [{
    id: 'minimax-m3',
    name: 'MiniMax M3',
    provider: 'MiniMax',
    enabled: true,
    implementation: 'claude-code-agent',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiKey: 'test-key',
    mainModel: 'MiniMax-M3',
    thinkingModel: 'MiniMax-M3',
    haikuModel: 'MiniMax-M3',
    sonnetModel: 'MiniMax-M3',
    opusModel: 'MiniMax-M3',
    contextWindow: 1000000,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    model: 'MiniMax-M3',
  }],
};
// Seed the test's data-dir profile file directly. Runtime ai-profiles.json is
// user-specific and must not be required in the source checkout.
fs.writeFileSync(AI_PROFILES_PATH, JSON.stringify(BASELINE_AI_PROFILES, null, 2) + '\n', 'utf-8');
const PORT = process.env.KB_AI_TEST_PORT || '7795';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-005-temp';

const { spawnServer } = require('./helpers/spawn-server');
const {
  ADAPTERS, getAdapter, listAdapters,
  validateCommitBatchOutput,
} = require('../lib/ai-adapter');
const { readConfig: readLlmConfig } = require('../lib/llm-client');
const { buildClaudeEnvFromProfile } = require('../lib/claude-cli-runner');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function startFakeAnthropicServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model || 'fake-model',
        content: [{ type: 'text', text: 'fake model ok' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/anthropic`,
      });
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) { lastError = e; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw lastError || new Error('server did not start');
}

async function json(method, url, body) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { res, data };
}

async function cleanup() {
  const base = path.join(DATA_DIR, 'projects', TEMP_SLUG);
  fs.rmSync(base, { recursive: true, force: true });
  const cur = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
  if (cur[TEMP_SLUG]) {
    delete cur[TEMP_SLUG];
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
  }
  fs.writeFileSync(AI_PROFILES_PATH, JSON.stringify(BASELINE_AI_PROFILES, null, 2) + '\n', 'utf-8');
}

(async () => {
  // 1. Static / unit tests on the adapter
  assert(fs.existsSync(AI_PROFILES_PATH), 'test ai-profiles.json should exist in the data dir');
  const cfg = JSON.parse(fs.readFileSync(AI_PROFILES_PATH, 'utf-8'));
  assert(cfg.schema === 'ai-profiles/v1', 'ai-profiles schema should be v1');
  assert(Array.isArray(cfg.profiles), 'profiles should be an array');

  const adapters = listAdapters();
  assert(adapters.length >= 1, 'at least one adapter');
  assert(!adapters.find(a => a.id === 'mock-agent'), 'mock-agent must not be listed');
  const cca = getAdapter('claude-code-agent');
  assert(cca, 'claude-code-agent adapter should be available');
  assert(typeof cca.analyzeCommitBatch === 'function', 'analyzeCommitBatch should be a function');
  assert(typeof cca.validateOutput === 'function', 'validateOutput should be a function');

  // 2. Invalid output is rejected
  const bad = validateCommitBatchOutput({});
  assert(!bad.valid, 'empty output should be rejected');
  const bad2 = validateCommitBatchOutput({ changes: [{ commit: 'a' }] });
  assert(!bad2.valid, 'incomplete change entry should be rejected');

  // 3. Unknown adapter id
  assert(!getAdapter('nope'), 'unknown adapter should return null');
  assert(!getAdapter('mock-agent'), 'mock-agent adapter must be removed');

  // 6. Server tests
  assert(fs.existsSync(SERVER), 'server.js missing');
  const fakeAnthropic = await startFakeAnthropicServer();
  const _spawned = spawnServer({ root: ROOT, port: Number(PORT), dataDir: DATA_DIR, tag: 'ai-profile' });
  const child = _spawned.child;
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    await cleanup();
    await waitForServer();

    // 7. GET /api/ai-profiles
    let r = await json('GET', '/api/ai-profiles');
    assert(r.res.ok, 'GET ai-profiles should return 200');
    assert(r.data.ok, 'response should be ok');
    assert(r.data.config && r.data.config.schema === 'ai-profiles/v1', 'config should be returned');
    assert(Array.isArray(r.data.adapters) && r.data.adapters.length >= 1, 'adapters should be listed');

    // 8. PUT /api/ai-profiles with invalid profile id → 400
    r = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1',
      profiles: [{ id: 'nope', name: 'nope', implementation: 'nope' }],
    });
    assert(!r.res.ok && r.res.status === 400, 'invalid profile id should 400');
    assert(Array.isArray(r.data.errors), 'should return errors list');

    // 9. PUT /api/ai-profiles with valid config
    r = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1',
      profiles: [
        {
          id: 'minimax-m3',
          name: 'MiniMax M3',
          provider: 'MiniMax',
          enabled: true,
          implementation: 'claude-code-agent',
          baseUrl: fakeAnthropic.baseUrl,
          apiKey: 'test-key',
          mainModel: 'test-main-model',
          haikuModel: 'test-haiku-model',
          sonnetModel: 'test-sonnet-model',
          opusModel: 'test-opus-model',
          timeoutMs: 7654,
        },
      ],
    });
    assert(r.res.ok, 'valid profile config should be accepted');

    const llmCfg = readLlmConfig({ profileId: 'minimax-m3' });
    assert(llmCfg.baseUrl === fakeAnthropic.baseUrl, 'llm client should read baseUrl from profile');
    assert(llmCfg.apiKey === 'test-key', 'llm client should read apiKey from profile');
    assert(llmCfg.model === 'test-main-model', 'llm client should read mainModel from profile');
    assert(llmCfg.timeoutMs === 7654, 'llm client should read timeoutMs from profile');

    const claudeEnv = buildClaudeEnvFromProfile({
      apiKey: 'test-key',
      baseUrl: fakeAnthropic.baseUrl,
      mainModel: 'test-main-model',
      haikuModel: 'test-haiku-model',
      sonnetModel: 'test-sonnet-model',
      opusModel: 'test-opus-model',
      timeoutMs: 7654,
    });
    assert(claudeEnv.ANTHROPIC_AUTH_TOKEN === 'test-key', 'claude env should set auth token');
    assert(claudeEnv.ANTHROPIC_BASE_URL === fakeAnthropic.baseUrl, 'claude env should set base URL');
    assert(claudeEnv.ANTHROPIC_MODEL === 'test-main-model', 'claude env should set main model');
    assert(claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'test-haiku-model', 'claude env should map haiku alias');
    assert(claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL === 'test-sonnet-model', 'claude env should map sonnet alias');
    assert(claudeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL === 'test-opus-model', 'claude env should map opus alias');
    assert(claudeEnv.API_TIMEOUT_MS === '7654', 'claude env should set timeout');
    assert(claudeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1', 'claude env should disable nonessential traffic');

    // 9b. Profile tests make a live Anthropic-compatible Messages API request.
    r = await json('POST', '/api/ai-profiles/test', {
      profileId: 'minimax-m3',
      prompt: 'what model are you?',
    });
    assert(r.res.status === 200, `claude-code-agent profile test should return 200, got ${r.res.status}`);
    assert(r.data.ok === true, 'claude-code-agent profile test should report ok=true');
    assert(r.data.profileId === 'minimax-m3', 'test response should echo profileId');
    assert(r.data.mode === 'live-model-call', 'test response should identify live model test mode');
    assert(r.data.text === 'fake model ok', 'test response should include model response text');

    // 9c. Disabling a profile makes it unusable
    r = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1',
      profiles: [
        {
          id: 'minimax-m3',
          name: 'MiniMax M3',
          enabled: false,
          implementation: 'claude-code-agent',
          baseUrl: fakeAnthropic.baseUrl,
          apiKey: 'test-key',
          mainModel: 'test-model',
        },
      ],
    });
    assert(r.res.ok, 'disabling profile should be accepted');
    r = await json('GET', '/api/state');
    assert(r.data.setup && r.data.setup.required === true, 'setup should be required when no usable AI profile exists');

    // 10. Per-project ai profile selection
    r = await json('PUT', '/api/projects', {
      slug: TEMP_SLUG,
      config: { displayName: 'TASK-005' },
    });
    assert(r.res.ok, 'upsert should succeed');
    assert(r.data.repoStatus !== undefined, 'repoStatus should be returned');

    r = await json('PUT', `/api/projects/${TEMP_SLUG}/ai-profile`, { aiProfileId: 'minimax-m3' });
    assert(!r.res.ok && r.res.status === 400, 'disabled ai profile should not be assignable');

    // Re-enable so we can assign
    r = await json('PUT', '/api/ai-profiles', {
      schema: 'ai-profiles/v1',
      profiles: [
        {
          id: 'minimax-m3',
          name: 'MiniMax M3',
          enabled: true,
          implementation: 'claude-code-agent',
          baseUrl: fakeAnthropic.baseUrl,
          apiKey: 'test-key',
          mainModel: 'test-model',
        },
      ],
    });
    assert(r.res.ok, 're-enable profile should succeed');
    r = await json('GET', '/api/state');
    assert(r.data.setup && r.data.setup.required === false, 'setup should not be required when a usable AI profile exists');

    r = await json('PUT', `/api/projects/${TEMP_SLUG}/ai-profile`, { aiProfileId: 'minimax-m3' });
    assert(r.res.ok, 'set ai profile should succeed');
    assert(r.data.aiProfileId === 'minimax-m3', 'aiProfileId should be set');

    r = await json('PUT', `/api/projects/${TEMP_SLUG}/settings`, {
      aiProfileId: 'minimax-m3',
      knowledgeLanguage: 'en-US',
    });
    assert(r.res.ok, 'set project settings should succeed');
    assert(r.data.aiProfileId === 'minimax-m3', 'settings should return aiProfileId');
    assert(r.data.knowledgeLanguage === 'en-US', 'settings should return knowledgeLanguage');

    r = await json('PUT', `/api/projects/${TEMP_SLUG}/settings`, { knowledgeLanguage: 'fr-FR' });
    assert(!r.res.ok && r.res.status === 400, 'invalid knowledgeLanguage should 400');

    r = await json('PUT', `/api/projects/${TEMP_SLUG}/ai-profile`, { aiProfileId: 'nope' });
    assert(!r.res.ok && r.res.status === 400, 'unknown profile should 400');

    r = await json('PUT', `/api/projects/${TEMP_SLUG}/ai-profile`, { aiProfileId: null });
    assert(r.res.ok, 'restoring default ai profile should be allowed');
    assert(r.data.aiProfileId === 'minimax-m3', 'null aiProfileId should restore the default profile');

    r = await json('GET', '/api/projects');
    assert(r.data[TEMP_SLUG].aiProfileId === 'minimax-m3', 'default aiProfileId should be persisted');
    assert(r.data[TEMP_SLUG].knowledgeLanguage === 'en-US', 'knowledgeLanguage should be persisted');

    console.log('TASK-005 AI profile test passed');
  } catch (e) {
    console.error('TASK-005 AI profile test failed:', e.message);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    await cleanup().catch(() => {});
    child.kill();
    fakeAnthropic.server.close();
  }
})();
