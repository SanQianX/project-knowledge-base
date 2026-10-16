'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../ui/product.js'), 'utf8');
const code = source.slice(source.indexOf('  function frameContext('), source.indexOf('  function setView('));
const messages = [], frame = { ready: false }, state = { epoch: 1, scope: 'project' };
const project = { projectId: 'a', workspacePath: '/workspace', modules: { terminal: { projectId: 'context-a' } } };
const ctx = vm.createContext({ state, frames: { terminal: frame }, activeProject: () => project,
  document: { documentElement: { dataset: { theme: 'light' } } }, frameVisible: () => true,
  post: (_key, message) => messages.push(message) });
vm.runInContext(code, ctx);
vm.runInContext('frameContext("terminal")', ctx);
assert.equal(messages.length, 0);
frame.ready = true;
vm.runInContext('frameContext("terminal"); frameContext("terminal")', ctx);
assert.equal(messages.filter(m => m.type === 'kb:select-project').length, 1, 'identical context receipts are not repeated');
state.epoch++;
vm.runInContext('frameContext("terminal")', ctx);
assert.equal(messages.filter(m => m.type === 'kb:select-project').length, 2, 'a real selection still reaches the iframe');
console.log('workbench-context-receipts-test PASS');
