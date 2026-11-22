'use strict';
const { IntegrationManager } = require('./integration-installer');
const { IntegrationAutoRepair } = require('./integration-auto-repair');
process.once('message', async input => {
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => {
    if (process.connected) process.send({ kind: 'log', level, args });
  }]));
  try {
    const repair = new IntegrationAutoRepair({ dataDir: input.dataDir, logger,
      createManager: () => new IntegrationManager({ ...input.managerOptions, logger }) });
    const results = await repair.runOnce();
    process.send({ ok: true, results }, () => process.disconnect());
  } catch {
    process.send({ ok: false }, () => process.disconnect());
  }
});
