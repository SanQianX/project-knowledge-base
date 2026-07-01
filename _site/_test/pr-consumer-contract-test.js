// Final KB consumer contract test.
// Run: node _site/_test/pr-consumer-contract-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { validateKb, buildPrContextPack } = require('../lib/kb-validator');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '_site', 'server.js');
let PROJECTS_JSON; // assigned inside the IIFE after spawnServer
let DATA_DIR; // assigned inside the IIFE after spawnServer
const PORT = process.env.KB_PR_TEST_PORT || '7801';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEMP_SLUG = 'task-011-temp';

function assert(cond, msg) { if (!cond) throw new Error(msg); }

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

function writeHealthyKb(base) {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(base, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(base, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(base, 'README.md'), '# Test KB\n');
  fs.writeFileSync(path.join(base, 'GOAL.md'), '# Goal\n');
  fs.writeFileSync(path.join(base, 'ARCHITECTURE.md'), '# Architecture\n');
  fs.writeFileSync(path.join(base, 'modules', 'api.md'), '---\ntags: [api]\nsourcePaths: [src/api.js]\n---\n# API\n');
  fs.writeFileSync(path.join(base, 'changes', 'api-change.md'), '---\ntags: [api]\naffectedModules: [api]\ndevelopmentIntent: Add API memory.\n---\n# API change\n\n## Development Intent\nAdd API memory.\n\n## Implementation Result\nDone.\n\n## Evidence\n- src/api.js\n');
  const { regenerateIndexes } = require('../lib/index-builder');
  regenerateIndexes(base);
}

function cleanup() {
  const base = path.join(DATA_DIR, 'projects', TEMP_SLUG);
  fs.rmSync(base, { recursive: true, force: true });
  const cur = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
  if (cur[TEMP_SLUG]) {
    delete cur[TEMP_SLUG];
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
  }
}

(async () => {
  const healthy = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-final-'));
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-final-bad-'));
  try {
    writeHealthyKb(healthy);

    let r = validateKb(healthy);
    assert(r.ok, `healthy KB should validate: ${JSON.stringify(r.errors)}`);
    assert(r.info.frameworkSchema === 'minimal-kb/v1', 'framework schema should be reported');
    assert(r.info.trustedKnowledgeEntries >= 7, 'trusted markdown entries should be reported');

    let pack = buildPrContextPack(healthy);
    assert(pack.ok, 'healthy pack should be ok');
    assert(pack.pack.schema === 'pr-context-pack/v1', 'pack schema is v1');
    assert(pack.pack.frameworkSchema === 'minimal-kb/v1', 'pack framework schema');
    assert(pack.pack.goal && pack.pack.goal.path === 'GOAL.md', 'pack has goal');
    assert(pack.pack.architecture && pack.pack.architecture.path === 'ARCHITECTURE.md', 'pack has architecture');
    assert(pack.pack.indexes.modules && pack.pack.indexes.changes, 'pack has indexes');
    assert(pack.pack.trustedKnowledge.some(item => item.path === 'modules/api.md'), 'pack has module doc');
    assert(pack.pack.trustedKnowledge.some(item => item.path === 'changes/api-change.md'), 'pack has change doc');
    assert(!JSON.stringify(pack.pack).includes('_ai/'), 'pack must not include AI workspace paths');

    fs.mkdirSync(path.join(bad, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(bad, 'changes'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'README.md'), '# Bad\n');
    fs.writeFileSync(path.join(bad, 'GOAL.md'), '# Goal\n');
    fs.writeFileSync(path.join(bad, 'ARCHITECTURE.md'), '# Architecture\n');
    fs.writeFileSync(path.join(bad, 'kb-manifest.json'), '{}\n');
    r = validateKb(bad);
    assert(!r.ok, 'old framework artifact should fail validation');
    assert(r.errors.some(e => e.includes('kb-manifest')), 'should report old manifest');

    r = validateKb(path.join(__dirname, '__no_such_dir__'));
    assert(!r.ok && r.status === 400, 'non-existent kbPath should fail with 400');

    const _spawned = spawnServer({ root: ROOT, port: Number(PORT), tag: 'pr-consumer-contract',  });
  DATA_DIR = _spawned.dataDir;
  PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
  const child = _spawned.child;
    let serverOutput = '';
    child.stdout.on('data', d => { serverOutput += d.toString(); });
    child.stderr.on('data', d => { serverOutput += d.toString(); });

    try {
      cleanup();
      await waitForServer();
      const projKb = path.join(DATA_DIR, 'projects', TEMP_SLUG);
      writeHealthyKb(projKb);

      r = await json('PUT', '/api/projects', {
        slug: TEMP_SLUG,
        config: { displayName: 'TASK-011', localPath: ROOT, gitPath: ROOT, kbPath: projKb },
      });
      assert(r.res.ok, 'upsert should succeed');

      r = await json('POST', `/api/projects/${TEMP_SLUG}/validate-kb`, {});
      assert(r.res.ok && r.data.ok, `validate-kb should succeed: ${JSON.stringify(r.data)}`);

      r = await json('GET', `/api/projects/${TEMP_SLUG}/pr-context`);
      assert(r.res.ok && r.data.ok, 'pr-context should succeed');
      assert(r.data.pack.goal.path === 'GOAL.md', 'api pack goal path');

      r = await json('POST', '/api/projects/-bad-/validate-kb', {});
      assert(!r.res.ok && r.res.status === 400, 'bad slug should 400');
    } catch (e) {
      console.error('Final KB consumer server test failed:', e.message);
      if (serverOutput) console.error(serverOutput);
      process.exitCode = 1;
    } finally {
      cleanup();
      child.kill();
    }

    if (!process.exitCode) console.log('Final KB consumer contract test passed');
  } finally {
    fs.rmSync(healthy, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
})();
