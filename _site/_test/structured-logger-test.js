const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger, LogRepository, localDay } = require('../lib/structured-logger');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-logger-v3-'));
  const layout = new StorageLayout({ dataDir });
  const config = { levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] };
  let stderr = '';
  const logger = new Logger({
    layout,
    settingsProvider: () => config,
    secrets: ['known-secret-value'],
    stderr: { write(value) { stderr += String(value); } },
  });
  const published = [];
  logger.subscribe(record => published.push(record));
  logger.subscribe(() => { throw new Error('subscriber failure must be isolated'); });
  const child = logger.child({ component: 'commit-reconciler', projectId: 'project-a', operationId: 'op-1', runId: 'run-1', commitSha: 'abc' });
  const cause = new Error('cause known-secret-value');
  cause.code = 'ECAUSE';
  const failure = new Error('Bearer top-secret-token');
  failure.code = 'ETEST';
  failure.cause = cause;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    await child[level](`test.${level}`, `${level} message`, {
      phase: 'test',
      error: level === 'error' ? failure : null,
      context: { apiKey: 'known-secret-value', nested: { authorization: 'Bearer nested-token', safe: 'kept' } },
    });
  }
  await logger.close();

  const projectDirectory = layout.getLogPath('project', 'project-a');
  const files = fs.readdirSync(projectDirectory).filter(file => file.endsWith('.jsonl'));
  assert.deepStrictEqual(files, [`${localDay()}.jsonl`], 'one project/day must use exactly one file');
  assert(!files.some(file => /\.\d{3}\.jsonl$/.test(file)), 'v13 writer must never create size segments');
  const allText = fs.readFileSync(path.join(projectDirectory, files[0]), 'utf8');
  assert(!allText.includes('known-secret-value'));
  assert(!allText.includes('top-secret-token'));
  assert(!allText.includes('nested-token'));
  assert(allText.includes('[REDACTED]'));
  assert.strictEqual(published.length, 6, 'each durable append must publish exactly once');
  assert.deepStrictEqual(published.map(record => record.level), ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  for (const line of allText.trim().split(/\r?\n/)) {
    const record = JSON.parse(line);
    assert.strictEqual(record.schema, 'log/v2');
    assert.strictEqual(record.projectId, 'project-a');
    assert.strictEqual(record.operationId, 'op-1');
    assert(record.id && record.ts && record.event);
  }

  await logger.info('system.completed', 'System record', { component: 'server', operationId: 'op-system' });
  await logger.close();
  assert(fs.existsSync(path.join(layout.getLogPath('system'), `${localDay()}.jsonl`)), 'unscoped logs belong to system/day');

  const repository = new LogRepository({ layout, secrets: ['known-secret-value'] });
  const first = repository.query({ pageSize: 2, projectId: 'project-a' });
  assert.strictEqual(first.entries.length, 2);
  assert(first.nextCursor);
  const second = repository.query({ pageSize: 2, projectId: 'project-a', cursor: first.nextCursor });
  assert.strictEqual(second.entries.length, 2);
  assert.notStrictEqual(first.entries[0].id, second.entries[0].id);
  assert.throws(
    () => repository.query({ pageSize: 3, projectId: 'project-a', cursor: first.nextCursor }),
    error => error.code === 'LOG_CURSOR_EXPIRED',
  );

  const exportPath = path.join(dataDir, 'exports', 'diagnostics.jsonl');
  const exported = repository.exportToFile(exportPath, { projectId: 'project-a' });
  assert.strictEqual(exported.count, 6);
  assert(!fs.readFileSync(exportPath, 'utf8').includes('known-secret-value'));
  assert.strictEqual(stderr, '');
  assert.strictEqual(typeof repository.cleanup, 'undefined', 'production log cleanup API must not exist');

  const blocker = path.join(dataDir, 'not-a-directory');
  fs.writeFileSync(blocker, 'blocker');
  const failingLayout = {
    getDataDir() { return dataDir; },
    getLogPath() { return path.join(blocker, 'logs'); },
  };
  const failing = new Logger({
    layout: failingLayout,
    settingsProvider: () => config,
    secrets: ['known-secret-value'],
    stderr: { write(value) { stderr += String(value); } },
  });
  const failingChild = failing.child({ component: 'failure-test' });
  await failingChild.error('logger.failure.test', 'known-secret-value', { error: new Error('known-secret-value') });
  assert.strictEqual(failing.getHealth().status, 'degraded', 'parent and child must share logger health');
  assert.strictEqual(failingChild.getHealth().status, 'degraded');
  assert(stderr.includes('logger fallback'));
  assert(!stderr.includes('known-secret-value'));
  console.log('structured-logger-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
