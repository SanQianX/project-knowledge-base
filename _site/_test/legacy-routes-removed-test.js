const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7833;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-routes-v2-'));

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const source = `${fs.readFileSync(path.join(ROOT, '_site', 'server.js'), 'utf8')}\n${fs.readFileSync(path.join(ROOT, '_site', 'lib', 'server-app.js'), 'utf8')}`;
  for (const removedSymbol of ['automation/simulate', 'automation/init', 'hook-install', 'hook-uninstall', 'dispatchProjectInit', 'DEFAULT_INIT_PROMPT_TEMPLATE', 'renderProjectInitPrompt', '/api/raw']) {
    assert(!source.includes(removedSymbol), `removed production symbol remains: ${removedSymbol}`);
  }

  const spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'routes-v2', extraEnv: { KB_SKIP_MIGRATION: '1' } });
  try {
    await waitForServer();
    const routes = [
      ['PUT', '/api/projects'],
      ['POST', '/api/projects/project-example/init'],
      ['POST', '/api/projects/project-example/automation/simulate'],
      ['POST', '/api/projects/project-example/automation/init'],
      ['GET', '/api/projects/project-example/hook-status'],
      ['POST', '/api/projects/project-example/hook-install'],
      ['POST', '/api/projects/project-example/hook-uninstall'],
      ['GET', '/api/raw?path=README.md'],
    ];
    for (const [method, pathname] of routes) {
      const response = await fetch(`${BASE}${pathname}`, { method });
      assert.strictEqual(response.status, 404, `${method} ${pathname} should be removed`);
    }
    console.log('legacy-routes-removed-test PASS');
  } finally {
    await spawned.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
