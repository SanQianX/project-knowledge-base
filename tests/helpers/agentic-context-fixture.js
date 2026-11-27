'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const corpus = require('../fixtures/agentic-context-corpus.json');

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup({ createEngineServer, vectorUrl, configure, dataDir, engineOptions = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-agentic-context-'));
  const repo = path.join(root, 'repo');
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(knowledge, 'modules'), { recursive: true });
  const git = args => execFileSync('git', ['-C', repo, '-c', `core.hooksPath=${path.join(root, 'hooks')}`, ...args], { stdio: 'ignore', windowsHide: true });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'route.js'), 'module.exports = () => null;\n');
  git(['add', 'route.js']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'Initial source']);
  for (const item of corpus.cases) {
    fs.writeFileSync(path.join(knowledge, 'modules', `${item.id}.md`), `# ${item.topic}\n\nThe active ${item.topic} decision is maintained under the handoff identifier ${item.alias}. Look up that identifier for the approved value.\n`);
    fs.writeFileSync(path.join(knowledge, 'modules', `${item.alias.toLowerCase()}.md`), `# ${item.alias}\n\nThe approved value for ${item.alias} is \"${item.value}\". This is authoritative for the current handoff.\n`);
  }
  const offline = http.createServer((req, res) => res.writeHead(503).end());
  const unavailable = await listen(offline);
  const token = require('node:crypto').randomBytes(24).toString('hex');
  const engine = createEngineServer({ ...engineOptions, dataDir: dataDir || path.join(root, 'engine'), consume: false, runtimeToken: token, vectorUrl: vectorUrl || unavailable, bridgeUrl: unavailable });
  const close = async () => {
    await engine.close();
    offline.closeAllConnections();
    await new Promise(resolve => offline.close(resolve));
  };
  try {
    await engine.ready;
    const endpoint = await listen(engine.server);
    const request = async (route, body, signal) => {
      const response = await fetch(new URL(route, endpoint), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: signal || AbortSignal.timeout(70000) });
      const value = await response.json();
      assert.ok(response.ok, `${route} -> ${response.status}: ${value.error || 'error'}`);
      return value;
    };
    const projectId = 'agentic-fixture';
    await request('/api/projects', { projectId, repoPath: repo, knowledgePath: knowledge, vectorProjectId: projectId });
    await request('/api/scopes', { scopes: [{ id: 'brain-default', kind: 'brain', brainId: 'brain-default', name: 'Fixture', knowledgePath: path.join(root, 'brain') }] });
    const members = [];
    for (const item of corpus.cases) {
      const { memory } = await request('/api/memories', { brainId: 'brain-default', title: item.topic, text: item.memory });
      members.push(memory.id);
    }
    const { group } = await request('/api/memory-groups', { brainId: 'brain-default', name: 'Fixture conventions' });
    await request(`/api/memory-groups/${group.id}/project-bindings`, { addProjectIds: [projectId] });
    await request(`/api/memory-groups/${group.id}/members`, { addMemoryIds: members });
    const fixture = { root, repo, projectId, knowledge, endpoint, request, close, engine, members };
    await configure?.(fixture);
    return fixture;
  } catch (error) {
    await close();
    throw error;
  }
}

function evaluate(result, item) {
  const facts = result.facts || [];
  const memories = (result.memories || []).map(memory => memory.text);
  return {
    necessaryFacts: 2,
    facts: Number(facts.some(fact => fact.entryId === `modules/${item.id}.md` && fact.text?.includes(item.alias)))
      + Number(facts.some(fact => fact.entryId === `modules/${item.alias.toLowerCase()}.md` && fact.text?.includes(`"${item.value}"`))),
    relevantMemory: Number(memories.includes(item.memory)),
    irrelevantMemories: memories.filter(memory => memory !== item.memory).length,
    memories: memories.length,
    chars: (result.prompt || '').length,
    bytes: Buffer.byteLength(result.prompt || ''),
    durationMs: result.durationMs,
    backend: result.backend,
  };
}

module.exports = { corpus, evaluate, listen, setup };
