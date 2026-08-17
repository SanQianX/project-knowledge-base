const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger, LogRepository } = require('../lib/structured-logger');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-log-repository-'));
  const layout = new StorageLayout({ dataDir });
  const settings = { levels: ['debug', 'info', 'warn', 'error', 'fatal'], retentionDays: 365, maxTotalSizeMB: 10 };
  const logger = new Logger({ layout, settingsProvider: () => settings });
  await logger.info('app.started', 'Started', { component: 'server', operationId: 'op-a' });
  await logger.info('app.completed', 'Completed', { component: 'server', operationId: 'op-a', durationMs: 12 });
  await logger.warn('project.deleted', 'Deleted project snapshot', { component: 'lifecycle', projectId: 'project-a', projectDisplayName: 'A', projectDeleted: true });
  await logger.error('commit.analysis.failed', 'Failed', { component: 'commit-reconciler', projectId: 'project-a', operationId: 'op-b', commitSha: 'deadbeef', error: Object.assign(new Error('failure'), { code: 'ETEST' }) });
  await logger.close();

  const repository = new LogRepository({ layout, settingsProvider: () => settings });
  const result = repository.query({ from: '2000-01-01', to: '2999-12-31', levels: ['error'], projectId: 'project-a', component: 'commit-reconciler', commitSha: 'deadbeef' });
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].operationId, 'op-b');
  assert.strictEqual(result.entries[0].error.code, 'ETEST');
  assert.strictEqual(repository.findOrphanedOperations({ from: '2000-01-01', to: '2999-12-31' }).length, 0);

  await logger.info('migration.started', 'Migration started', { component: 'migration', operationId: 'op-orphan' });
  await logger.close();
  assert.strictEqual(repository.findOrphanedOperations({ from: '2000-01-01', to: '2999-12-31' }).length, 1);

  const legacyRoot = layout.getLogPath('app');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, '2020-01-01.log'), `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', level: 'info', source: 'legacy', event: 'legacy.event', message: 'old' })}\n`);
  assert.strictEqual(repository.query({ from: '2019-01-01', to: '2021-01-01', event: 'legacy.event' }).entries.length, 1);

  console.log('logging-api-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
