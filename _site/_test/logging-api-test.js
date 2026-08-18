const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger, LogRepository, localDay, normalizeRecord } = require('../lib/structured-logger');

function line(entry) {
  return `${JSON.stringify(normalizeRecord(entry))}\r\n`;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-log-repository-'));
  const layout = new StorageLayout({ dataDir });
  const settings = { levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] };
  const logger = new Logger({ layout, settingsProvider: () => settings });
  await logger.info('app.started', 'Started', { component: 'server', operationId: 'op-a' });
  await logger.info('app.completed', 'Completed', { component: 'server', operationId: 'op-a', durationMs: 12 });
  await logger.warn('project.deleted', 'Deleted project snapshot', { component: 'lifecycle', projectId: 'project-a', projectDisplayName: 'A', projectDeleted: true });
  await logger.error('commit.analysis.failed', 'Failed', { component: 'commit-reconciler', projectId: 'project-a', operationId: 'op-b', commitSha: 'deadbeef', error: Object.assign(new Error('failure'), { code: 'ETEST' }) });
  await logger.close();

  const repository = new LogRepository({ layout });
  const result = repository.query({ levels: ['error'], projectId: 'project-a', component: 'commit-reconciler', commitSha: 'deadbeef' });
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].operationId, 'op-b');
  assert.strictEqual(result.entries[0].error.code, 'ETEST');
  assert.strictEqual(result.pageSize, 500, 'today query must default to 500 records');
  assert.strictEqual(repository.query({ pageSize: 999999 }).pageSize, 5000, 'display limit must be capped at 5000');
  assert.strictEqual(repository.findOrphanedOperations().length, 0);

  await logger.info('migration.started', 'Migration started', { component: 'migration', operationId: 'op-orphan' });
  await logger.close();
  assert.strictEqual(repository.findOrphanedOperations().length, 1);

  const legacyRoot = layout.getLogPath('app');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, '2020-01-01.log'), `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', level: 'info', source: 'legacy', event: 'legacy.event', message: 'old' })}\n`);
  assert.strictEqual(repository.query({ from: '2019-01-01', to: '2021-01-01', event: 'legacy.event' }).entries.length, 1, 'legacy app/hooks logs remain read-only query sources');

  const date = localDay();
  const mergeA = path.join(layout.getLogPath('project', 'merge-a'), `${date}.jsonl`);
  const mergeB = path.join(layout.getLogPath('project', 'merge-b'), `${date}.jsonl`);
  fs.mkdirSync(path.dirname(mergeA), { recursive: true });
  fs.mkdirSync(path.dirname(mergeB), { recursive: true });
  const longMessage = `long-${'界'.repeat(70000)}`;
  const longRecord = { ...normalizeRecord({ id: 'a-1', ts: `${date}T01:00:00.000Z`, level: 'info', event: 'merge.a1', message: 'placeholder', projectId: 'merge-a' }), message: longMessage };
  fs.writeFileSync(mergeA,
    `${JSON.stringify(longRecord)}\r\n`
    + line({ id: 'a-2', ts: `${date}T03:00:00.000Z`, level: 'warn', event: 'merge.a2', message: 'newer a', projectId: 'merge-a' })
    + '{bad-tail',
    'utf8');
  fs.writeFileSync(mergeB,
    line({ id: 'b-1', ts: `${date}T02:00:00.000Z`, level: 'error', event: 'merge.b1', message: 'middle b', projectId: 'merge-b' }),
    'utf8');

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function guardedRead(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.startsWith(path.join(dataDir, 'logs')) && /\.(?:jsonl|log)$/.test(filePath)) {
      throw new Error('LogRepository must not read an entire log file');
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  let merged;
  try {
    merged = repository.query({ event: '', q: 'merge.', pageSize: 3 });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.deepStrictEqual(merged.entries.map(entry => entry.id), ['a-2', 'b-1', 'a-1'], 'all-project query must k-way merge by timestamp and skip malformed tail data');
  const long = repository.query({ projectId: 'merge-a', event: 'merge.a1' });
  assert.strictEqual(long.entries.length, 1);
  assert(long.entries[0].message.startsWith(`long-${'界'.repeat(100)}`), 'reverse chunk reader must parse lines larger than one chunk');
  assert(long.entries[0].message.includes('[truncated:'), 'public query must still apply field size bounds');

  const cursorPage = repository.query({ q: 'merge.', pageSize: 1 });
  assert(cursorPage.nextCursor);
  fs.unlinkSync(mergeB);
  assert.throws(
    () => repository.query({ q: 'merge.', pageSize: 1, cursor: cursorPage.nextCursor }),
    error => error.code === 'LOG_CURSOR_EXPIRED' && error.retryable === true,
    'manually deleted cursor source must return a typed restart error',
  );

  console.log('logging-api-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
