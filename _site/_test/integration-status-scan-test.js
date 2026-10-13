'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { IntegrationStatusScan } = require('../lib/integration-status-scan');
async function main() {
  const scan = new IntegrationStatusScan({ workerFile: path.join(__dirname, 'fixtures/integration-busy-worker.cjs'), timeoutMs: 5000 });
  try {
    const before = Date.now();
    const first = await scan.read({ rootDir: path.resolve(__dirname, '../..') }, { clients: ['claude'] }, { waitMs: 50 });
    assert.equal(first.scan.state, 'checking'); assert.ok(Date.now() - before < 500);
    const again = await scan.read({ rootDir: path.resolve(__dirname, '../..') }, { clients: ['claude'] }, { waitMs: 10 });
    assert.equal(first.scan.generation, again.scan.generation); assert.equal(scan.children.size, 1);
    let ticked = false; await new Promise(resolve => setTimeout(() => { ticked = true; resolve(); }, 20));
    assert.equal(ticked, true, 'a blocked probe cannot freeze the HTTP event loop');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const ready = await scan.read({ rootDir: path.resolve(__dirname, '../..') }, { clients: ['claude'] });
    assert.equal(ready.scan.state, 'ready'); assert.equal(ready.clients[0].available, true);
    console.log('Isolated status scan, coalescing and nonblocking snapshot passed.');
  } finally { scan.close(); }
  const logs = [], timed = new IntegrationStatusScan({ workerFile: path.join(__dirname, 'fixtures/integration-busy-worker.cjs'), timeoutMs: 100 });
  try {
    const result = await timed.read({ rootDir: path.resolve(__dirname, '../..'), operationId: 'status-timeout-test', logger: { warn: (...args) => logs.push(args) } }, { clients: ['claude'] }, { waitMs: 500 });
    assert.equal(result.error.code, 'INTEGRATION_STATUS_TIMEOUT');
    assert.equal(result.clients[0].automaticContext.state, 'check-failed');
    assert.equal(logs[0][0], 'integration.status.timeout');
    assert.equal(logs[0][2].operationId, 'status-timeout-test');
  } finally { timed.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
