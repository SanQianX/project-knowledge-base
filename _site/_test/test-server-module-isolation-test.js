'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helper = path.join(__dirname, 'helpers/spawn-server.js');
const calls = [];
const moduleObject = { exports: {} };
const inherited = {
  KB_TERMINAL_URL: 'http://127.0.0.1:5760',
  KB_VECTORHUB_URL: 'http://127.0.0.1:8787',
  KB_EVENTBRIDGE_URL: 'http://127.0.0.1:8790',
  KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:5790',
};
vm.runInNewContext(fs.readFileSync(helper, 'utf8'), {
  module: moduleObject,
  require(id) {
    if (id === 'child_process') return { spawn: (...args) => { calls.push(args); return { pid: 1 }; } };
    if (id === 'fs') return { mkdtempSync: prefix => prefix + 'owned' };
    if (id === '../../lib/runtime-control' || id === '../../lib/runtime-endpoint') return {};
    return require(id);
  },
  process: { execPath: process.execPath, pid: process.pid, env: inherited },
});
const spawnServer = moduleObject.exports.spawnServer;
spawnServer({ root: path.resolve(__dirname, '../..'), port: 0, dataDir: 'isolated-data' });
const defaults = calls[0][2].env;
for (const key of Object.keys(inherited)) assert.equal(defaults[key], 'http://127.0.0.1:0', key + ' must not consult a live user module');
assert.equal(defaults.KB_DATA_DIR, 'isolated-data');
assert.equal(defaults.KB_MODULES_AUTOSTART, '0');
assert.equal(defaults.KB_MODULES_REGISTER, '0');
assert.notEqual(defaults.AI_CODING_EVENT_BRIDGE_HOME, process.env.AI_CODING_EVENT_BRIDGE_HOME);
const ownUrls = Object.fromEntries(Object.keys(inherited).map(key => [key, 'http://127.0.0.1:12345']));
spawnServer({ root: path.resolve(__dirname, '../..'), port: 0, dataDir: 'isolated-data', extraEnv: ownUrls });
for (const key of Object.keys(inherited)) assert.equal(calls[1][2].env[key], ownUrls[key], 'explicit owned fixture remains supported');
console.log('test-server-module-isolation-test PASS');
