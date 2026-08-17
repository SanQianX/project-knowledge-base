const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger, LogRepository, redactValue, serializeError } = require('../lib/structured-logger');

(async () => {
  const secret = 'sk-secret-123456';
  const value = redactValue({
    apiKey: secret,
    headers: { authorization: 'Bearer ' + secret },
    url: 'https://user:' + secret + '@example.invalid/path?token=' + secret,
    nested: [{ clientSecret: secret }, { safe: 'visible' }],
  }, { secrets: [secret] });
  const text = JSON.stringify(value);
  assert(!text.includes(secret));
  assert(text.includes('visible'));

  const cause = Object.assign(new Error('cause ' + secret), { code: 'ECAUSE' });
  const error = Object.assign(new Error('Bearer ' + secret), { code: 'ETEST', cause });
  const serialized = JSON.stringify(serializeError(error, { secrets: [secret] }));
  assert(!serialized.includes(secret));
  assert(serialized.includes('ETEST'));
  assert(serialized.includes('ECAUSE'));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-dynamic-redaction-'));
  try {
    const layout = new StorageLayout({ dataDir });
    let currentSecret = 'dynamic-secret-one';
    const settings = { levels: ['info', 'error'], retentionDays: 365, maxTotalSizeMB: 10 };
    const secretsProvider = () => [currentSecret];
    const logger = new Logger({ layout, settingsProvider: () => settings, secretsProvider });
    await logger.info('secret.first', 'first ' + currentSecret, { context: { echoed: currentSecret } });
    currentSecret = 'dynamic-secret-two';
    await logger.error('secret.second', 'second ' + currentSecret, { error: new Error('failure ' + currentSecret) });
    await logger.close();

    const repository = new LogRepository({ layout, settingsProvider: () => settings, secretsProvider });
    const page = repository.query({ from: '2000-01-01', to: '2999-12-31' });
    const queried = JSON.stringify(page);
    assert(!queried.includes(currentSecret), 'current configured secret must be redacted during query');
    assert(!queried.includes('dynamic-secret-one'), 'write-time configured secret must be redacted before persistence');

    const exportPath = path.join(dataDir, 'export.jsonl');
    repository.exportToFile(exportPath, { from: '2000-01-01', to: '2999-12-31' });
    const exported = fs.readFileSync(exportPath, 'utf8');
    assert(!exported.includes('dynamic-secret-one'));
    assert(!exported.includes('dynamic-secret-two'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('log-redaction-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
