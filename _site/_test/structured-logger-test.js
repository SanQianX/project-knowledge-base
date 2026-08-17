const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger, LogRepository } = require('../lib/structured-logger');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-logger-v2-'));
  const layout = new StorageLayout({ dataDir });
  const config = { levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], retentionDays: 365, maxTotalSizeMB: 10 };
  let stderr = '';
  const logger = new Logger({
    layout,
    settingsProvider: () => config,
    segmentMaxBytes: 600,
    secrets: ['known-secret-value'],
    stderr: { write(value) { stderr += String(value); } },
  });
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

  const files = fs.readdirSync(layout.getLogPath('project', 'project-a')).filter(file => file.endsWith('.jsonl'));
  assert(files.length >= 2, 'small threshold should rotate segments');
  const allText = files.map(file => fs.readFileSync(path.join(layout.getLogPath('project', 'project-a'), file), 'utf8')).join('');
  assert(!allText.includes('known-secret-value'));
  assert(!allText.includes('top-secret-token'));
  assert(!allText.includes('nested-token'));
  assert(allText.includes('[REDACTED]'));
  for (const line of allText.trim().split(/\r?\n/)) {
    const record = JSON.parse(line);
    assert.strictEqual(record.schema, 'log/v2');
    assert.strictEqual(record.projectId, 'project-a');
    assert.strictEqual(record.operationId, 'op-1');
    assert(record.id && record.ts && record.event);
  }

  const repository = new LogRepository({ layout, settingsProvider: () => config, secrets: ['known-secret-value'] });
  const first = repository.query({ from: '2000-01-01', to: '2999-12-31', pageSize: 2, projectId: 'project-a' });
  assert.strictEqual(first.entries.length, 2);
  assert(first.nextCursor);
  const second = repository.query({ from: '2000-01-01', to: '2999-12-31', pageSize: 2, projectId: 'project-a', cursor: first.nextCursor });
  assert.strictEqual(second.entries.length, 2);
  assert.notStrictEqual(first.entries[0].id, second.entries[0].id);
  assert.throws(() => repository.query({ from: '2000-01-01', to: '2999-12-31', pageSize: 3, projectId: 'project-a', cursor: first.nextCursor }), error => error.code === 'INVALID_ARGUMENT');

  const exportPath = path.join(dataDir, 'exports', 'diagnostics.jsonl');
  const exported = repository.exportToFile(exportPath, { from: '2000-01-01', to: '2999-12-31', projectId: 'project-a' });
  assert.strictEqual(exported.count, 6);
  assert(!fs.readFileSync(exportPath, 'utf8').includes('known-secret-value'));
  assert.strictEqual(stderr, '');

  const oldLog = path.join(layout.getLogPath('app'), '2020-01-01.jsonl');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, `${JSON.stringify({ schema: 'log/v2', id: 'old', ts: '2020-01-01T00:00:00.000Z', level: 'debug', component: 'test', event: 'old.debug', message: 'old', projectId: '', projectSlug: '', projectDisplayName: '', projectDeleted: false, operationId: '', jobId: '', runId: '', commitSha: '', phase: '', attempt: 0, durationMs: 0, error: null, context: {} })}\n`);
  const keptForever = repository.cleanup({ retentionDays: 0, maxTotalSizeMB: 10 });
  assert.strictEqual(keptForever.deleted.includes('app/2020-01-01.jsonl'), false);
  const removedExpired = repository.cleanup({ retentionDays: 1, maxTotalSizeMB: 10 });
  assert(removedExpired.deleted.includes('app/2020-01-01.jsonl'));

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
  await failing.error('logger.failure.test', 'known-secret-value', { error: new Error('known-secret-value') });
  assert.strictEqual(failing.getHealth().status, 'degraded');
  assert(stderr.includes('logger fallback'));
  assert(!stderr.includes('known-secret-value'));
  console.log('structured-logger-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
