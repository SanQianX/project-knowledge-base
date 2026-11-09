'use strict';
// Starts the four real npm services in an isolated installed prefix, without a model call.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createRequire } = require('node:module');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  if ([5757, 5760, 5790, 8787, 8790].includes(port)) throw Error('Protected port');
  return port;
}
async function main() {
  const core = path.resolve(process.argv[2] || '');
  const reportRoot = path.resolve(process.argv[3] || '');
  if (!process.argv[2] || !process.argv[3] || !path.isAbsolute(process.argv[2]) || !path.isAbsolute(process.argv[3])) throw Error('Pass absolute installed core and isolated report directories');
  const parts = core.split(path.sep);
  const index = parts.indexOf('node_modules');
  if (index < 0) throw Error('An installed npm prefix is required');
  const installRoot = parts.slice(0, index).join(path.sep);
  const protectedRoots = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), process.env.ProgramFiles, process.env.NPM_CONFIG_PREFIX].filter(Boolean);
  if (protectedRoots.some(root => core.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep))) throw Error('The live global installation is protected');
  fs.mkdirSync(reportRoot, { recursive: true });
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROCESSOR_ARCHITECTURE'].includes(key.toUpperCase())));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, system);
  for (const [key, folder] of Object.entries({ HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp', CODEX_HOME: 'codex', KB_DATA_DIR: 'data', KB_KNOWLEDGE_DATA_DIR: 'knowledge', AI_CODING_EVENT_BRIDGE_HOME: 'events' })) {
    process.env[key] = path.join(reportRoot, folder);
    fs.mkdirSync(process.env[key], { recursive: true });
  }
  const resolve = createRequire(path.join(core, 'package.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(core, 'module-runtime-manifest.json')));
  for (const module of Object.values(manifest.modules)) {
    if (!resolve.resolve(module.installName + '/package.json').startsWith(installRoot + path.sep)) throw Error('Module resolved outside the isolated install');
  }
  const modules = resolve('./_site/scripts/verify-product-runtime.js').verifyProductRuntime(core);
  if (fs.existsSync(path.join(core, '_modules/knowledge-engine'))) throw Error('Engine source is still bundled in the shell');
  const urls = {};
  for (const key of ['terminalUrl', 'vectorHubUrl', 'eventBridgeUrl', 'engineUrl']) urls[key] = 'http://127.0.0.1:' + await freePort();
  const errors = [];
  const logger = { info() {}, warn(event, message) { errors.push({ event, message }); }, error(event, message) { errors.push({ event, message }); } };
  const { ModuleBridge } = resolve('./_site/lib/module-bridge.js');
  const result = { status: 'PASS', installRoot, modules: Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, value.version])), cycles: [] };
  const kind = { terminal: 'terminal', 'vector-hub': 'vectorHub', 'event-bridge': 'eventBridge', 'knowledge-engine': 'engine' };
  for (let cycle = 0; cycle < 2; cycle++) {
    const bridge = new ModuleBridge({ ...urls, dataDir: process.env.KB_DATA_DIR, logger });
    try {
      await bridge.startSupervised();
      const specs = bridge._supervisedSpecs();
      if (specs.length !== 4) throw Error('All four installed module entry points are required');
      const deadline = Date.now() + 60000;
      let healthy = [];
      while (Date.now() < deadline) {
        healthy = await Promise.all(specs.map(spec => bridge._probeClass(spec.url, kind[spec.name])));
        if (healthy.every(value => value === 'module')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!healthy.every(value => value === 'module')) throw Error('Module health failed: ' + JSON.stringify({ healthy, errors }));
      result.cycles.push({ cycle: cycle + 1, healthy: specs.map(spec => spec.name) });
    } finally { await bridge.stopSupervised(); }
  }
  fs.writeFileSync(path.join(reportRoot, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
