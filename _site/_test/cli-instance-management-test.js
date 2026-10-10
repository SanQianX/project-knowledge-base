'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const endpoint = require('../lib/runtime-endpoint');
const control = require('../lib/runtime-control');
const packageRoot = process.env.KB_CLI_TEST_PACKAGE || path.resolve(__dirname, '../..');
const bin = path.join(packageRoot, 'bin/project-knowledge.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-instance-management-'));
const a = path.join(root, '知识库 A'), b = path.join(root, '知识库 B');
const temp = path.join(root, 'isolated-temp'); fs.mkdirSync(temp);
const env = { ...process.env, KB_DATA_DIR: a, TEMP: temp, TMP: temp, KB_MODULES_AUTOSTART: '0', AI_CODING_EVENT_BRIDGE_HOME: path.join(root, 'bridge') };
const pids = [];
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${stdout} ${stderr}`)); }, 25000);
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function usable(port) { try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }
let foreign;
(async () => {
  foreign = http.createServer((req, res) => { res.writeHead(404); res.end('not knowledge'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const foreignPort = foreign.address().port;
  fs.writeFileSync(path.join(temp, '.project-knowledge.pid'), `${process.pid}\n${foreignPort}`);
  for (const args of [['stoop'], ['STOP', 'unexpected'], ['stop', '--port', '12junk'], ['stop', '--port', '65536'], ['stop', '--port'], ['stop', '--all']]) {
    const result = await run(args); assert.equal(result.code, 1, JSON.stringify(result));
    assert(!/Already running|starting in background/.test(result.stdout));
  }
  assert.equal(fs.existsSync(a), false, 'invalid commands must not create data or services');
  const noInstance = await run(['STOP']); assert.equal(noInstance.code, 0); assert.match(noInstance.stdout, /No background/);
  assert.equal(await usable(foreignPort), false); assert(foreign.listening, 'shared legacy PID must not kill an unrelated process');
  const launchedA = await run(['START', '--no-open']); assert.equal(launchedA.code, 0, launchedA.stderr);
  const infoA = endpoint.readEndpoint(a); pids.push(infoA.pid); assert(await usable(infoA.port));
  const launchedB = await run(['start', '--data', b, '--no-open']); assert.equal(launchedB.code, 0, launchedB.stderr);
  const infoB = endpoint.readEndpoint(b); pids.push(infoB.pid); assert(await usable(infoB.port)); assert.notEqual(infoA.port, infoB.port);
  const status = await run(['STATUS']); assert.equal(status.code, 0); assert.match(status.stdout, new RegExp(`PID ${infoA.pid}`));
  const inventory = await run(['STATUS', '--all']); assert.equal(inventory.code, 0, inventory.stderr);
  assert.match(inventory.stdout, new RegExp(`PID ${infoA.pid}`)); assert.match(inventory.stdout, new RegExp(`PID ${infoB.pid}`));
  const wrongPort = await run(['STOP', '--port', String(foreignPort)]); assert.equal(wrongPort.code, 1); assert(foreign.listening);
  const conflict = await run(['stop', '--data', a, '--port', String(infoB.port)]); assert.equal(conflict.code, 1); assert(await usable(infoB.port));
  await assert.rejects(() => control.request(a, { action: 'stop', pid: infoA.pid + 1, port: infoA.port, startedAt: infoA.startedAt }), /身份/);
  assert(await usable(infoA.port));
  const stoppedA = await run(['STOP']); assert.equal(stoppedA.code, 0, stoppedA.stderr); assert.match(stoppedA.stdout, new RegExp(`:${infoA.port}`));
  assert.equal(await usable(infoA.port), false); assert(await usable(infoB.port), 'default stop must preserve a different data directory');
  const stoppedB = await run(['stop', '--port', String(infoB.port)]); assert.equal(stoppedB.code, 0, stoppedB.stderr); assert.equal(await usable(infoB.port), false);
  assert.equal((await run(['stop'])).code, 0, 'repeated stop is harmless');
  fs.writeFileSync(path.join(a, 'runtime-endpoint.json'), JSON.stringify({ schema: endpoint.SCHEMA, pid: process.pid, host: '127.0.0.1', port: foreignPort }));
  const stale = await run(['STOP']); assert.equal(stale.code, 1); assert.match(stale.stderr, /控制通道不可用/); assert(foreign.listening, 'a live but unrelated recorded PID is never signaled');
  const refused = await run(['start', '--no-open']); assert.equal(refused.code, 1); assert(foreign.listening);
  console.log('CLI instance management PASS: case, strict arguments, inventory, two directories, targeted stop, spoof protection, stale/shared PID safety');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  foreign?.closeAllConnections(); if (foreign?.listening) await new Promise(resolve => foreign.close(resolve));
  for (const data of [a, b]) try { const info = await control.request(data, { action: 'status' }, 500); await control.request(data, { action: 'stop', pid: info.instance.pid, port: info.instance.port, startedAt: info.instance.startedAt }); } catch {}
});
