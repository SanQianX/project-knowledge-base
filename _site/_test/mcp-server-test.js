// Run: node _site/_test/mcp-server-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { KnowledgeDatabase } = require('../lib/knowledge-db');
const { EMBEDDING_DIMENSIONS } = require('../lib/knowledge-schema');

const ROOT = path.resolve(__dirname, '..', '..');
const MCP_BIN = path.join(ROOT, 'bin', 'project-knowledge-mcp.js');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `project-knowledge-mcp-${process.pid}-`));
const DATA_DIR = path.join(TEMP, 'data');
const REPO = path.join(TEMP, 'source');
const VECTOR_REPO = path.join(TEMP, 'vector-source');
const KB = path.join(TEMP, 'knowledge');
const STORE_ROOT = path.join(TEMP, 'store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function git(args, cwd = REPO) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function fakeVector(text) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (let i = 0; i < String(text).length; i++) vector[String(text).charCodeAt(i) % vector.length] += 1;
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map(item => item / norm);
}

async function main() {
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(VECTOR_REPO, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  git(['init']);
  git(['init'], VECTOR_REPO);
  write(path.join(REPO, 'README.md'), '# MCP fixture\n');
  fs.mkdirSync(path.join(REPO, 'nested'), { recursive: true });
  write(path.join(KB, 'README.md'), '# Demo knowledge\n\nThis project uses rotating refresh tokens.\n');
  write(path.join(KB, 'modules', 'auth.md'), '# Authentication\n\nRefresh tokens rotate after every successful renewal.\n');
  write(path.join(KB, 'changes', '2026-07-auth.md'), '# Authentication update\n\nIntroduced rotating refresh tokens.\n');
  write(path.join(DATA_DIR, 'projects.json'), `${JSON.stringify({
    demo: {
      displayName: 'Demo',
      enabled: true,
      localPath: REPO,
      gitPath: REPO,
      kbPath: KB,
      knowledgeBackend: 'markdown',
    },
    vector: {
      displayName: 'Vector',
      enabled: true,
      localPath: VECTOR_REPO,
      gitPath: VECTOR_REPO,
      kbPath: path.join(TEMP, 'vector-knowledge'),
      knowledgeBackend: 'lancedb',
      primarySpaceId: 'project:vector',
    },
  }, null, 2)}\n`);
  write(path.join(DATA_DIR, 'knowledge-store.json'), `${JSON.stringify({
    schema: 'knowledge-store/v1',
    rootPath: STORE_ROOT,
    configured: true,
    git: { enabled: false, remoteUrl: '', branch: 'main', autoCommit: false, autoPush: false },
  }, null, 2)}\n`);
  const database = new KnowledgeDatabase({ dbPath: path.join(STORE_ROOT, '.project-knowledge', 'knowledge.lancedb') });
  await database.replaceEntry('project:vector', 'modules/payments.md', [{
    chunkOrder: 0,
    title: 'Payment tokens',
    chunkText: 'Payment tokens expire after fifteen minutes.',
    vector: fakeVector('payment tokens'),
    sourceCommit: 'abc123',
  }]);
  await database.ensureSearchIndexes();
  await database.close();

  const child = spawn(process.execPath, [MCP_BIN], {
    cwd: REPO,
    env: {
      ...process.env,
      KB_DATA_DIR: DATA_DIR,
      KB_SKIP_MIGRATION: '1',
      KB_EMBEDDING_FAKE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let stdoutBuffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (!pending.has(message.id)) continue;
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    }
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${stderr}`));
      }, 15_000);
      pending.set(id, {
        resolve: message => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const initialize = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'project-knowledge-test', version: '1.0.0' },
  });
  assert(initialize.result?.serverInfo?.name === 'project-knowledge', 'initialize should return the MCP server identity');
  assert(/read-only/i.test(initialize.result?.instructions || ''), 'initialize should return read-only workflow instructions');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const listed = await request('tools/list');
  assert(Array.isArray(listed.result?.tools) && listed.result.tools.length === 5, 'tools/list should expose five focused tools');
  assert(listed.result.tools.some(tool => tool.name === 'project_knowledge_resolve'), 'resolve tool should be listed');

  const resolve = await request('tools/call', {
    name: 'project_knowledge_resolve',
    arguments: { repoPath: path.join(REPO, 'nested') },
  });
  assert(resolve.result?.structuredContent?.projectSlug === 'demo', 'resolve should match a path inside the registered Git project');
  assert(resolve.result?.structuredContent?.readOnly === true, 'resolve should declare the integration read-only');

  const search = await request('tools/call', {
    name: 'project_knowledge_search',
    arguments: { repoPath: REPO, query: 'refresh tokens', limit: 3 },
  });
  assert(search.result?.structuredContent?.backend === 'markdown', 'legacy Markdown projects should use the MCP fallback');
  assert(search.result?.structuredContent?.results?.some(item => item.entry_id === 'modules/auth.md'), 'search should return the relevant Markdown entry');

  const vectorSearch = await request('tools/call', {
    name: 'project_knowledge_search',
    arguments: { project: 'vector', query: 'payment tokens', limit: 3 },
  });
  assert(vectorSearch.result?.isError !== true, 'LanceDB search should succeed through MCP');
  assert(vectorSearch.result?.structuredContent?.results?.some(item => item.entry_id === 'modules/payments.md'), 'MCP should use the configured LanceDB storage location');

  const get = await request('tools/call', {
    name: 'project_knowledge_get',
    arguments: { project: 'demo', entry: 'modules/auth.md' },
  });
  assert(/rotate/i.test(get.result?.structuredContent?.chunks?.[0]?.chunk_text || ''), 'get should return the complete scoped entry');

  const history = await request('tools/call', {
    name: 'project_knowledge_history',
    arguments: { project: 'demo' },
  });
  assert(history.result?.structuredContent?.results?.[0]?.entry_id === 'changes/2026-07-auth.md', 'history should read Markdown change entries');

  const traversal = await request('tools/call', {
    name: 'project_knowledge_get',
    arguments: { project: 'demo', entry: '../outside.md' },
  });
  assert(traversal.result?.isError === true, 'get should reject paths outside the resolved knowledge base');

  child.stdin.end();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server did not exit after stdin closed\n${stderr}`));
    }, 5000);
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`MCP server exited with ${code}\n${stderr}`));
    });
  });
  console.log('mcp-server-test PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});
