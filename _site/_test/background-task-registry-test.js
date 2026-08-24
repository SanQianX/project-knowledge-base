const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activeTaskPromises, isProjectBusy, taskForProject } = require('../lib/server-app');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  const records = [];
  const runtime = {
    activeTasks: new Map(),
    logger: {
      async debug(event, message, context) { records.push({ level: 'debug', event, message, ...context }); },
      async error(event, message, context) { records.push({ level: 'error', event, message, ...context }); },
    },
  };
  const longGate = deferred();
  const long = taskForProject(runtime, 'project-a', 'op-long', () => longGate.promise, 'startup');
  const fast = taskForProject(runtime, 'project-a', 'op-fast', async () => { throw new Error('fast failure'); }, 'git-hook');
  assert.strictEqual(runtime.activeTasks.get('project-a').size, 2, 'overlapping operations must both remain registered');
  assert.strictEqual(activeTaskPromises(runtime.activeTasks).length, 2, 'shutdown snapshot must include every operation promise');
  assert.strictEqual(isProjectBusy('project-a', { readState: () => ({ analysis: { activeClaim: null } }) }, runtime.activeTasks), true);
  await assert.rejects(fast, /fast failure/);
  assert.strictEqual(runtime.activeTasks.get('project-a').size, 1, 'fast terminal must remove only its own operation');
  assert(runtime.activeTasks.get('project-a').has('op-long'));
  assert.strictEqual(activeTaskPromises(runtime.activeTasks).length, 1);
  longGate.resolve('done');
  assert.strictEqual(await long, 'done');
  assert.strictEqual(runtime.activeTasks.has('project-a'), false, 'empty project task map must be removed');
  assert(records.some(record => record.event === 'background.operation_failed' && record.operationId === 'op-fast'));
  assert(records.some(record => record.event === 'background.operation_completed' && record.operationId === 'op-long'));

  console.log('background-task-registry-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
