// Run: node _site/_test/runtime-endpoint-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../lib/runtime-endpoint');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-runtime-endpoint-${process.pid}-`));

try {
  assert(runtime.readEndpoint(dataDir) === null, 'missing endpoint should read as null');

  const written = runtime.writeEndpoint(dataDir, {
    pid: process.pid,
    host: '127.0.0.1',
    port: 5761,
    mode: 'desktop',
  });
  assert(written.schema === runtime.SCHEMA, 'endpoint schema should be current');
  assert(written.mode === 'desktop', 'endpoint should preserve runtime mode');
  assert(runtime.readLiveEndpoint(dataDir).pid === process.pid, 'current process endpoint should be live');

  runtime.clearEndpoint(dataDir, { pid: process.pid + 1 });
  assert(runtime.readEndpoint(dataDir) !== null, 'a different process must not clear the endpoint');
  runtime.clearEndpoint(dataDir, { pid: process.pid });
  assert(runtime.readEndpoint(dataDir) === null, 'owner should clear the endpoint');

  const claim = runtime.claimEndpoint(dataDir, {
    pid: process.pid,
    host: '127.0.0.1',
    port: 5762,
    mode: 'cli',
  });
  assert(claim.claimed === true, 'first process should claim an empty endpoint');
  const duplicate = runtime.claimEndpoint(dataDir, {
    pid: process.pid + 1,
    host: '127.0.0.1',
    port: 5763,
    mode: 'desktop',
  });
  assert(duplicate.claimed === false, 'second process must not replace a live endpoint');
  assert(duplicate.endpoint.pid === process.pid, 'duplicate should discover the owner');
  runtime.clearEndpoint(dataDir, { pid: process.pid });

  runtime.writeEndpoint(dataDir, { pid: 2147483646, host: 'localhost', port: 5757 });
  assert(runtime.readLiveEndpoint(dataDir) === null, 'dead process endpoint should be rejected');
  assert(!fs.existsSync(runtime.endpointPath(dataDir)), 'dead process endpoint should be removed');

  fs.writeFileSync(runtime.endpointPath(dataDir), JSON.stringify({
    schema: runtime.SCHEMA,
    pid: process.pid,
    host: 'example.com',
    port: 5757,
  }), 'utf-8');
  assert(runtime.readEndpoint(dataDir) === null, 'remote hosts must never be accepted');

  console.log('runtime-endpoint-test PASS');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
