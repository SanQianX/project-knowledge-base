'use strict';
const { IntegrationManager } = require('./integration-installer');
process.once('message', async input => {
  try {
    const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => {
      if (process.connected) process.send({ kind: 'log', level, args: args.map(value => value instanceof Error ? { name: value.name, code: value.code, message: 'Integration command failed.' } : value) });
    }]));
    const manager = new IntegrationManager({ ...input.managerOptions, logger });
    const summary = await manager.statusAll(input.statusOptions);
    process.send({ ok: true, summary }, () => process.disconnect());
  } catch (error) {
    process.send({ ok: false, code: error.code || 'INTEGRATION_STATUS_FAILED' }, () => process.disconnect());
  }
});
