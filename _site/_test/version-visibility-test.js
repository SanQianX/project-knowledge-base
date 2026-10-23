'use strict';
// FEATURE-VERSIONS-01-R2 offline acceptance — the simplified brand-tooltip
// contract (知识库 vX.Y.Z on hover, honest 版本未知 on failure) verified
// against the REAL product server and REAL ui/ assets, with the lane's full
// isolation fixture. The old R1 sidebar/module-aggregation surface
// (versionInfoButton / versionDialog / GET /api/system/versions) must stay
// absent from everything this test reads.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { coreVersionSnapshot } = require('../lib/public-version-info');
const {
  REPO_ROOT, createIsolationLayout, removeTree, startRootServer, stopRootServer, sanitizedEnv, applyIsolationEnv,
  startVersionBrokenUiServer,
} = require('./helpers/version-visibility-fixture');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  // --- unit: the snapshot reads the RUNNING package, never a guess ---------
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const snapshot = coreVersionSnapshot();
  assert.strictEqual(snapshot.ok, true);
  assert.strictEqual(snapshot.schema, 'system-version/v1');
  assert.strictEqual(snapshot.core.source, 'running-process-package');
  assert.strictEqual(snapshot.core.version, pkg.version, 'snapshot must match the real root package version');
  assert.strictEqual(snapshot.core.name, pkg.name);
  console.log(`ok unit coreVersionSnapshot -> v${snapshot.core.version}`);

  // --- real isolated product server ---------------------------------------
  const layout = createIsolationLayout();
  const explicit = { KB_MODULES_AUTOSTART: '0', KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:12345' };
  const isolated = sanitizedEnv(explicit, { PATH: process.env.PATH || '', OPENAI_API_KEY: 'fixture-only-sentinel', KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:5790' });
  assert.strictEqual(isolated.OPENAI_API_KEY, undefined, 'ambient provider credentials must not enter the fixture');
  assert.strictEqual(isolated.KB_MODULES_AUTOSTART, '0', 'explicit disabled autostart must survive sanitization');
  assert.strictEqual(isolated.KB_KNOWLEDGE_ENGINE_URL, explicit.KB_KNOWLEDGE_ENGINE_URL, 'explicit lane address must survive sanitization');
  applyIsolationEnv(layout);
  let server = null;
  let broken = null;
  try {
    server = await startRootServer(layout);
    const versionResponse = await fetch(`${server.base}/api/system/version`);
    assert.strictEqual(versionResponse.status, 200);
    const payload = await versionResponse.json();
    assert.strictEqual(payload.core.version, pkg.version, 'served version must equal the root package version');
    assert.strictEqual(payload.core.source, 'running-process-package');

    const htmlResponse = await fetch(`${server.base}/`);
    assert.strictEqual(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.ok(html.includes('id="brandVersion"'), 'brand span must exist in served HTML');
    assert.ok(html.includes('/version-info.css'), 'stylesheet must be referenced');
    assert.ok(html.includes('/version-info.js'), 'script must be referenced');
    assert.ok(!html.includes('versionInfoButton'), 'R1 sidebar button must stay reverted');
    assert.ok(!html.includes('versionDialog'), 'R1 module dialog must stay reverted');
    assert.ok(!html.includes('/api/system/versions"'), 'R1 aggregation endpoint must not be called by the UI');

    for (const asset of ['version-info.js', 'version-info.css']) {
      const served = Buffer.from(await (await fetch(`${server.base}/${asset}`)).arrayBuffer());
      const disk = fs.readFileSync(path.join(REPO_ROOT, 'ui', asset));
      assert.strictEqual(sha256(served), sha256(disk), `served ${asset} must be byte-identical to ui/`);
    }
    const favicon = await fetch(`${server.base}/favicon.svg`);
    assert.strictEqual(favicon.status, 200, 'existing brand assets must keep serving');
    console.log(`ok real server ${server.base} version=${payload.core.version} assets byte-identical`);

    // --- honest-unknown branch: version GET fails, HTML still real ---------
    broken = await startVersionBrokenUiServer(layout);
    const brokenVersion = await fetch(`${broken.base}/api/system/version`);
    assert.strictEqual(brokenVersion.status, 503, 'stub must simulate version read failure');
    const brokenHtml = await (await fetch(`${broken.base}/`)).text();
    assert.ok(brokenHtml.includes('id="brandVersion"'), 'broken stub still serves the real HTML shell');
    const stubAsset = await fetch(`${broken.base}/version-info.js`);
    assert.strictEqual(stubAsset.status, 200, 'stub still serves the real tooltip script');
    console.log(`ok broken-version stub ${broken.base} 503 + real shell`);
  } finally {
    if (broken) await new Promise(resolve => broken.server.close(resolve));
    await stopRootServer(server);
    removeTree(layout.root);
  }
}

main().then(() => {
  console.log('PASS version-visibility-test');
}, error => {
  console.error('FAIL version-visibility-test');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
