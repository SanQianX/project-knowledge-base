const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopRoot, '..');
const bundleRoot = path.join(desktopRoot, 'out', 'Project Knowledge-win32-x64');
const executable = path.join(bundleRoot, 'Project Knowledge.exe');
const asarRoot = path.join(bundleRoot, 'resources', 'app.asar');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function probe(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: endpoint.host,
      port: endpoint.port,
      path: '/api/state',
      timeout: 2000,
    }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function waitForEndpoint(dataDir, timeoutMs = 60000) {
  const target = path.join(dataDir, 'runtime-endpoint.json');
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const endpoint = JSON.parse(fs.readFileSync(target, 'utf-8'));
      const state = await probe(endpoint);
      return { endpoint, state };
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  let log = '';
  try { log = fs.readFileSync(path.join(dataDir, 'desktop-backend.log'), 'utf-8'); } catch {}
  throw new Error(`packaged backend was not ready: ${lastError && lastError.message}\n${log}`);
}

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

(async () => {
  assert(process.platform === 'win32', 'packaged smoke test currently targets Windows x64');
  assert(fs.existsSync(executable), `packaged executable missing: ${executable}`);
  const unpackedPicker = path.join(
    bundleRoot,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'project-knowledge',
    '_site',
    'scripts',
    'folder-picker.ps1'
  );
  assert(fs.existsSync(unpackedPicker), 'PowerShell folder-picker fallback must be unpacked from ASAR');

  const squirrelRoot = path.join(desktopRoot, 'out', 'make', 'squirrel.windows', 'x64');
  const desktopVersion = require('../package.json').version;
  assert(fs.existsSync(path.join(squirrelRoot, 'RELEASES')), 'Squirrel RELEASES feed is missing');
  assert(fs.existsSync(path.join(squirrelRoot, `project_knowledge-${desktopVersion}-full.nupkg`)),
    'Squirrel full update package is missing');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-packaged-smoke-${process.pid}-`));
  const env = {
    ...process.env,
    KB_DATA_DIR: dataDir,
    KB_SKIP_MIGRATION: '1',
    KB_EMBEDDING_FAKE: '1',
  };
  // Isolate Electron's ProcessSingleton lock from an installed copy that the
  // developer may be actively using. The second process below intentionally
  // reuses this directory so single-instance behavior is still exercised.
  const electronUserData = path.join(dataDir, 'electron-user-data');
  const appArgs = [`--user-data-dir=${electronUserData}`];
  const app = spawn(executable, appArgs, { env, windowsHide: true, stdio: 'ignore' });
  let endpoint = null;
  try {
    const ready = await waitForEndpoint(dataDir);
    endpoint = ready.endpoint;
    assert(endpoint.mode === 'desktop', `expected desktop endpoint, got ${endpoint.mode}`);
    assert(endpoint.pid !== app.pid, 'desktop backend should run in a dedicated process');
    assert(ready.state && typeof ready.state === 'object', '/api/state should return JSON');

    const second = spawn(executable, appArgs, { env, windowsHide: true, stdio: 'ignore' });
    const secondExit = await Promise.race([
      new Promise(resolve => second.once('exit', code => resolve({ exited: true, code }))),
      sleep(5000).then(() => ({ exited: false })),
    ]);
    assert(secondExit.exited, 'second desktop instance should exit');
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-endpoint.json'), 'utf-8'));
    assert(after.pid === endpoint.pid, 'second instance must not replace the backend');

    const nativeTest = path.join(
      asarRoot,
      'node_modules',
      'project-knowledge',
      '_site',
      '_test',
      'knowledge-db-test.js'
    );
    const nativeResult = spawnSync(executable, [nativeTest], {
      cwd: projectRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf-8',
      timeout: 120000,
      windowsHide: true,
    });
    assert(nativeResult.status === 0,
      `packaged LanceDB test failed: ${nativeResult.stdout}\n${nativeResult.stderr}`);
    assert(/PASS/.test(nativeResult.stdout), 'packaged LanceDB test did not report PASS');

    const runtimeProbe = path.join(dataDir, 'vector-runtime-probe.cjs');
    fs.writeFileSync(runtimeProbe, `
      const assert = require('assert');
      const path = require('path');
      const { createRequire } = require('module');
      const appRequire = createRequire(path.join(process.argv[2], 'package.json'));
      const ort = appRequire('onnxruntime-node');
      const transformers = appRequire('@huggingface/transformers');
      assert.equal(typeof ort.InferenceSession, 'function');
      assert.equal(typeof transformers.pipeline, 'function');
      console.log('VECTOR_RUNTIME_PASS');
    `);
    const runtimeResult = spawnSync(executable, [runtimeProbe, asarRoot], {
      cwd: projectRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf-8',
      timeout: 120000,
      windowsHide: true,
    });
    assert(runtimeResult.status === 0,
      `packaged vector runtime failed: ${runtimeResult.stdout}\n${runtimeResult.stderr}`);
    assert(/VECTOR_RUNTIME_PASS/.test(runtimeResult.stdout),
      'packaged vector runtime did not load Transformers.js and ONNX Runtime');

    console.log(`packaged-smoke PASS (${endpoint.host}:${endpoint.port}, backend PID ${endpoint.pid})`);
  } finally {
    if (endpoint) stopTree(endpoint.pid);
    stopTree(app.pid);
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
