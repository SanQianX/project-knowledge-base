const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');

const ROOT = path.resolve(__dirname, '..', '..');
const MCP_BIN = path.join(ROOT, 'bin', 'project-knowledge-mcp.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-mcp-v2-'));
const dataDir = path.join(temp, 'data');
const repo = path.join(temp, 'repo');
const vectorRepo = path.join(temp, 'vector-repo');
const markdownKb = path.join(temp, 'knowledge-markdown');
const vectorKb = path.join(temp, 'knowledge-vector');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function fakeVector(text) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (let index = 0; index < String(text).length; index += 1) vector[String(text).charCodeAt(index) % vector.length] += 1;
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map(item => item / norm);
}

async function createMcpClient() {
  const child = spawn(process.execPath, [MCP_BIN], {
    cwd: repo,
    env: { ...process.env, KB_DATA_DIR: dataDir, KB_SKIP_MIGRATION: '1', KB_EMBEDDING_FAKE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry) { entry(message); pending.delete(message.id); }
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}\n${stderr}`)); }, 15_000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  return { child, request, stderr: () => stderr };
}

(async () => {
  for (const cwd of [repo, vectorRepo]) {
    fs.mkdirSync(cwd, { recursive: true });
    git(cwd, ['init', '--initial-branch=main']);
    git(cwd, ['config', 'user.email', 'mcp@example.test']);
    git(cwd, ['config', 'user.name', 'MCP Test']);
    write(path.join(cwd, 'README.md'), '# source\n');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['commit', '-m', 'baseline']);
  }
  write(path.join(markdownKb, 'README.md'), '# Demo knowledge\n\nThis project uses rotating refresh tokens.\n');
  write(path.join(markdownKb, 'modules', 'auth.md'), '# Authentication\n\nRefresh tokens rotate after every successful renewal.\n');
  write(path.join(markdownKb, 'changes', 'auth.md'), '# Authentication update\n\nIntroduced rotating refresh tokens.\n');
  write(path.join(vectorKb, 'modules', 'payments.md'), '# Payment tokens\n\nPayment tokens expire after fifteen minutes.\n');
  fs.mkdirSync(vectorKb, { recursive: true });

  const layout = new StorageLayout({ dataDir });
  const settingsStore = new SettingsStore({ layout });
  const registryStore = new ProjectRegistryStore({ layout });
  const projectStore = new ProjectStore({ layout });
  await settingsStore.initialize({ knowledge: { rootPath: path.join(temp, 'future-root') } });
  await registryStore.initialize();
  await projectStore.create('project-demo', { displayName: 'Demo', storageName: 'demo', repoPath: repo, knowledgePath: markdownKb, legacyExtensions: { slug: 'demo' } }, { trackingStartCommit: git(repo, ['rev-parse', 'HEAD']), index: { dirty: true, generation: 1 } });
  await registryStore.add('project-demo', { displayNameSnapshot: 'Demo' });
  await projectStore.create('project-vector', { displayName: 'Vector', storageName: 'vector', repoPath: vectorRepo, knowledgePath: vectorKb, legacyExtensions: { slug: 'vector' } }, { trackingStartCommit: git(vectorRepo, ['rev-parse', 'HEAD']) });
  await registryStore.add('project-vector', { displayNameSnapshot: 'Vector' });

  const database = new KnowledgeDatabase({ dbPath: layout.getIndexPath(), maintenancePath: layout.getRuntimePath('index-maintenance.json') });
  await database.replaceEntry('project:project-vector', 'modules/payments.md', [{ chunkOrder: 0, title: 'Payment tokens', chunkText: 'Payment tokens expire after fifteen minutes.', vector: fakeVector('payment tokens'), sourceCommit: 'abc123' }]);
  await database.ensureSearchIndexes();
  await database.close();

  const client = await createMcpClient();
  try {
    const listed = await client.request('tools/list');
    assert.strictEqual(listed.result.tools.length, 6);
    assert(listed.result.tools.some(tool => tool.name === 'project_knowledge_record_requirement'));

    let response = await client.request('tools/call', { name: 'project_knowledge_resolve', arguments: { repoPath: repo } });
    assert.strictEqual(response.result.structuredContent.projectId, 'project-demo');
    assert.strictEqual(response.result.structuredContent.knowledgePath, markdownKb);
    assert.strictEqual(response.result.structuredContent.indexPath, layout.getIndexPath());

    response = await client.request('tools/call', { name: 'project_knowledge_search', arguments: { projectId: 'project-demo', query: 'refresh tokens' } });
    assert.strictEqual(response.result.structuredContent.source, 'knowledge-retrieval-service');
    assert.strictEqual(response.result.structuredContent.backend, 'hybrid+markdown-truth');
    assert(response.result.structuredContent.results.some(result => result.entry_id === 'modules/auth.md'));

    response = await client.request('tools/call', { name: 'project_knowledge_search', arguments: { project: 'vector', query: 'payment tokens' } });
    assert.strictEqual(response.result.structuredContent.source, 'knowledge-retrieval-service');
    assert.strictEqual(response.result.structuredContent.backend, 'hybrid+markdown-truth');
    assert(response.result.structuredContent.results.some(result => result.entry_id === 'modules/payments.md'));

    response = await client.request('tools/call', { name: 'project_knowledge_get', arguments: { projectId: 'project-demo', entry: 'modules/auth.md' } });
    assert.match(response.result.structuredContent.chunks[0].chunk_text, /rotate/i);
    response = await client.request('tools/call', { name: 'project_knowledge_history', arguments: { projectId: 'project-demo' } });
    assert.strictEqual(response.result.structuredContent.results[0].entry_id, 'changes/auth.md');

    const stateBefore = fs.readFileSync(layout.getProjectStatePath('project-demo'), 'utf8');
    response = await client.request('tools/call', { name: 'project_knowledge_record_requirement', arguments: { projectId: 'project-demo', repoPath: repo, client: 'codex', sessionId: 'session-mcp', text: 'Keep refresh token rotation documented.' } });
    assert.strictEqual(response.result.structuredContent.projectId, 'project-demo');
    assert.strictEqual(projectStore.readRequirements('project-demo').length, 1);
    assert.strictEqual(fs.readFileSync(layout.getProjectStatePath('project-demo'), 'utf8'), stateBefore, 'requirement tool must not trigger analysis or mutate state');
    assert(!fs.existsSync(layout.getRuntimePath('staging')));

    response = await client.request('tools/call', { name: 'project_knowledge_get', arguments: { projectId: 'project-demo', entry: '../settings.json' } });
    assert.strictEqual(response.result.isError, true);
    console.log('mcp-server-test PASS');
  } finally {
    client.child.stdin.end();
    await new Promise(resolve => client.child.once('exit', resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
