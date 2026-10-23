'use strict';
// F-ENV-LEAK-001 canonical regression: a unit test and the suite runner are
// decided by their own fixtures, never by ambient module URLs or an ambient
// KB_KNOWLEDGE_DATA_DIR inherited from the developer shell. The read-only
// sentinel below stands in for the user's live instance: it records every
// request, so a leak is observable WITHOUT ever contacting a real instance,
// and it refuses every binding as foreign — exactly the protective 409 the
// real instance gave, which must surface, never be swallowed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { EngineKnowledgeClient } = require('../lib/engine-knowledge-client');

const MODULE_URL_VARS = ['KB_KNOWLEDGE_ENGINE_URL', 'KB_VECTORHUB_URL', 'KB_TERMINAL_URL', 'KB_EVENTBRIDGE_URL'];
const REPO = path.resolve(__dirname, '..', '..');

// The sentinel lives in THIS process, so children must be spawned
// asynchronously: a synchronous spawn would freeze the event loop and the
// sentinel could never answer (the leak-probe child would just time out).
function run(file, args, options, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(file, args, { ...options, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    const timer = setTimeout(() => { child.kill(); resolve({ status: null, timedOut: true, out, err }); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ status: null, error, out, err }); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, out, err }); });
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-isolation-'));
  const sentinelHits = [];
  const sentinel = http.createServer((req, res) => {
    sentinelHits.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ name: 'knowledge-engine', dataSchemaVersion: 3 }));
    if (req.url === '/api/projects') return res.end(JSON.stringify({ projects: [{ projectId: 'foreign', repoPath: path.join(root, 'foreign-repo'), knowledgePath: path.join(root, 'foreign-knowledge'), enabled: true }] }));
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, error: { code: 'ENGINE_IDENTITY_MISMATCH' } }));
  });
  await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
  const sentinelUrl = `http://127.0.0.1:${sentinel.address().port}`;
  const decoySite = path.join(root, 'decoy-site-data'), decoyKnowledge = path.join(root, 'decoy-knowledge-data');
  fs.mkdirSync(decoySite); fs.mkdirSync(decoyKnowledge);
  const polluted = {
    ...process.env,
    KB_KNOWLEDGE_ENGINE_URL: sentinelUrl, KB_VECTORHUB_URL: sentinelUrl, KB_TERMINAL_URL: sentinelUrl, KB_EVENTBRIDGE_URL: sentinelUrl,
    KB_DATA_DIR: decoySite, KB_KNOWLEDGE_DATA_DIR: decoyKnowledge,
  };
  try {
    // 1. Detector control: a client built WITHOUT an explicit engineUrl
    //    under the polluted env does reach the ambient address, and the
    //    identity guard refuses the foreign binding out loud.
    const leakProbe = path.join(root, 'leak-probe.js');
    fs.writeFileSync(leakProbe, `'use strict';
const { StorageLayout } = require(${JSON.stringify(path.resolve(__dirname, '../lib/storage-layout'))});
const { EngineKnowledgeClient } = require(${JSON.stringify(path.resolve(__dirname, '../lib/engine-knowledge-client'))});
(async () => {
  const layout = new StorageLayout({ dataDir: process.env.KB_DATA_DIR });
  const client = new EngineKnowledgeClient({ layout });
  try {
    await client.request('search', { query: 'probe' }, { projectId: 'foreign', repoPath: process.env.KB_DATA_DIR, knowledgePath: process.env.KB_DATA_DIR });
  } catch (error) {
    if (error.code !== 'ENGINE_IDENTITY_MISMATCH' || error.status !== 409) throw error;
    console.log('LEAK_REJECTED_ENGINE_IDENTITY_MISMATCH');
    return;
  }
  throw new Error('the sentinel must refuse the foreign binding');
})().catch(error => { console.error(error); process.exit(1); });
`);
    const leak = await run(process.execPath, [leakProbe], { env: polluted }, 30000);
    assert.equal(leak.status, 0, `detector control must fail loudly if broken: ${leak.err}`);
    assert.match(leak.out, /LEAK_REJECTED_ENGINE_IDENTITY_MISMATCH/);
    assert.ok(sentinelHits.length >= 1, 'the detector control must observe the leaked request');
    const hitsAfterControl = sentinelHits.length;

    // 2. The fixed canonical test under the same polluted env passes and
    //    sends not a single request to the ambient address.
    const canonical = await run(process.execPath, [path.resolve(__dirname, 'knowledge-engine-client-test.js')], { env: polluted }, 120000);
    assert.equal(canonical.status, 0, `canonical test must pass under a polluted environment: ${canonical.err}`);
    assert.equal(sentinelHits.length, hitsAfterControl, 'the canonical test must not contact an ambient module address');

    // 3. The runner scrubs its children: exclusive probe dir with the real
    //    (fixed) run-all-tests.js and one env-dump test file. The child of
    //    the runner must see no ambient module URL, must NOT see the decoy
    //    KB data dirs, and must get its own sandboxes instead.
    const probeOut = path.join(root, 'probe-env.json');
    const runnerDir = path.join(root, 'runner-probe', '_site', '_test');
    fs.mkdirSync(runnerDir, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, 'run-all-tests.js'), path.join(runnerDir, 'run-all-tests.js'));
    fs.writeFileSync(path.join(runnerDir, 'zz-env-probe-test.js'), `'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({
  ${MODULE_URL_VARS.map(name => `${name}: process.env.${name}`).join(', ')},
  KB_DATA_DIR: process.env.KB_DATA_DIR,
  KB_KNOWLEDGE_DATA_DIR: process.env.KB_KNOWLEDGE_DATA_DIR,
  AI_CODING_EVENT_BRIDGE_HOME: process.env.AI_CODING_EVENT_BRIDGE_HOME,
  KB_MODULES_AUTOSTART: process.env.KB_MODULES_AUTOSTART,
}));
`);
    const runner = await run(process.execPath, [path.join(runnerDir, 'run-all-tests.js'), '--no-report'], {
      cwd: REPO, env: { ...polluted, PROBE_OUT: probeOut },
    }, 120000);
    assert.equal(runner.status, 0, `runner probe must pass: ${runner.err}`);
    assert.match(runner.out, /1 passed, 0 failed/);
    const seen = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
    for (const name of MODULE_URL_VARS) assert.equal(seen[name], undefined, `runner children must not inherit ${name}`);
    assert.notEqual(seen.KB_DATA_DIR, decoySite, 'runner children must not inherit the ambient site data dir');
    assert.notEqual(seen.KB_KNOWLEDGE_DATA_DIR, decoyKnowledge, 'runner children must not inherit the ambient knowledge data dir');
    assert.ok(seen.KB_DATA_DIR && seen.KB_DATA_DIR.includes('kb-runall-data-'), 'site data must be a per-run sandbox');
    assert.ok(seen.KB_KNOWLEDGE_DATA_DIR && seen.KB_KNOWLEDGE_DATA_DIR.includes('kb-runall-knowledge-'), 'knowledge data must be a per-run sandbox');
    assert.ok(seen.AI_CODING_EVENT_BRIDGE_HOME, 'bridge home must stay sandboxed');
    assert.equal(seen.KB_MODULES_AUTOSTART, '0', 'module autostart must stay disabled');
    assert.equal(sentinelHits.length, hitsAfterControl, 'the runner child must not contact an ambient module address');

    // 4. Deliberate configuration is untouched: an explicit engineUrl still
    //    aims the client at the chosen address — proven by the sentinel hits
    //    this final control produces on purpose.
    const layout = new StorageLayout({ dataDir: path.join(root, 'site-data') });
    const deliberate = new EngineKnowledgeClient({ layout, engineUrl: sentinelUrl });
    await assert.rejects(
      deliberate.request('search', { query: 'probe' }, { projectId: 'foreign', repoPath: path.join(root, 'site-repo'), knowledgePath: path.join(root, 'site-knowledge') }),
      error => error.code === 'ENGINE_IDENTITY_MISMATCH' && error.status === 409,
      'an explicitly configured client still gets the identity refusal surfaced, never swallowed',
    );
    assert.ok(sentinelHits.length > hitsAfterControl, 'the deliberate configuration must actually reach its target');
    console.log('harness-isolation-test PASS (ambient module URLs and data dirs cannot decide tests; deliberate config and identity refusals stay loud)');
  } finally {
    sentinel.closeAllConnections();
    await new Promise(resolve => sentinel.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
