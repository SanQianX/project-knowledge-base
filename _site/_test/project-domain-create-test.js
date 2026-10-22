'use strict';
// PRJ-001: a domain groups knowledge; it is not a code project.
//
// The browser side of this case lives in product-import-ui-test.js. This file
// covers the product contract and the disk state: an empty name is refused,
// a named domain is persisted, and no Git project appears.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnServer } = require('./helpers/spawn-server');
const freePort = require('./helpers/free-port');

const ROOT = path.resolve(__dirname, '../..');

async function waitFor(fn, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prj-domain-'));
  const dataDir = path.join(fixture, 'data');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir, tag: 'project-domain-create' });
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await waitFor(async () => {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    }, 'isolated server');

    // An empty domain name is refused by the product, not only by the form.
    for (const name of ['', '   ', '\t\n']) {
      const refused = await api('POST', '/api/domains', { name });
      assert.equal(refused.status, 400, `an empty domain name must be refused: ${JSON.stringify(name)}`);
      assert.equal(refused.body.error.code, 'INVALID_ARGUMENT');
      assert.equal(refused.body.ok, false);
    }
    const tooLong = await api('POST', '/api/domains', { name: 'x'.repeat(101) });
    assert.equal(tooLong.status, 400, 'a domain name longer than 100 characters is refused');

    const created = await api('POST', '/api/domains', { name: '  研发领域  ' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.ok, true);
    assert.equal(created.body.domain.name, '研发领域', 'the stored domain name is trimmed');
    assert.match(created.body.domain.id, /^domain-[0-9a-f-]{36}$/);

    // The domain is persisted: in the API view and in the settings file.
    const settings = await api('GET', '/api/settings');
    assert.ok(settings.body.settings.brain.domains.some(domain => domain.id === created.body.domain.id && domain.name === '研发领域'), 'the domain is visible in the settings view');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.ok(onDisk.brain.domains.some(domain => domain.id === created.body.domain.id && domain.name === '研发领域'), 'the domain is persisted in settings.json');

    const duplicate = await api('POST', '/api/domains', { name: '研发领域' });
    assert.equal(duplicate.status, 409, 'a duplicate domain name is refused');
    assert.equal(duplicate.body.error.code, 'INVALID_ARGUMENT');

    // A domain never becomes a Git project.
    const aggregated = await api('GET', '/api/projects/aggregated');
    assert.equal(aggregated.body.projects.length, 0, 'a domain must not create a project');
    const registryPath = path.join(dataDir, 'projects.json');
    if (fs.existsSync(registryPath)) {
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects || {}).length, 0, 'the project registry stays empty');
    }
    const projectDir = path.join(dataDir, 'projects');
    if (fs.existsSync(projectDir)) {
      assert.deepEqual(fs.readdirSync(projectDir), [], 'no project metadata is written for a domain');
    }
    console.log('project-domain-create-test PASS (domain contract, disk persistence, no Git project)');
  } finally {
    await server.cleanup();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
