'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnServer } = require('./helpers/spawn-server');
const freePort = require('./helpers/free-port');
const { readEndpoint } = require('../lib/runtime-endpoint');

(async () => {
  const port = await freePort();
  const spawned = spawnServer({ root: path.resolve(__dirname, '../..'), port, tag: 'graceful-cleanup' });
  let stopped = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const endpoint = readEndpoint(spawned.dataDir);
      if (endpoint && (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.ok) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(readEndpoint(spawned.dataDir)?.pid, spawned.child.pid);
    let output = '';
    spawned.child.stderr.on('data', bytes => { output += bytes; });
    await spawned.cleanup(); stopped = true;
    assert.notEqual(spawned.child.exitCode, null, output);
    assert.equal(spawned.child.signalCode, null, 'normal cleanup must drain the server instead of force killing it');
    assert.equal(spawned.child.exitCode, 0, output);
    assert.ok(!fs.existsSync(spawned.dataDir));
    assert.ok(!fs.existsSync(spawned.bridgeHome));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    console.log('test-server-cleanup-test PASS (verified graceful shutdown before fixture removal)');
  } finally { if (!stopped) await spawned.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
