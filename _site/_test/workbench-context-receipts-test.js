'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../ui/product.js'), 'utf8');
const code = source.slice(source.indexOf('  function postTheme('), source.indexOf('  function setView('));
const messages = [], frame = { ready: false }, workflow = { ready: true };
const state = { epoch: 1, scope: 'project' };
const project = { projectId: 'a', workspacePath: '/workspace', modules: { terminal: { projectId: 'context-a' } } };
const ctx = vm.createContext({ state, frames: { terminal: frame, workflow }, activeProject: () => project,
  document: { documentElement: { dataset: { theme: 'light' } } },
  getComputedStyle: () => ({ getPropertyValue: name => name === '--accent' ? ' #3a775a ' : '' }),
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
assert.ok(messages.filter(m => m.type === 'kb:theme').every(message => !message.palette), 'terminal theme message preserves its fields');
vm.runInContext('frameContext("workflow"); frameContext("workflow")', ctx);
assert.equal(messages.filter(m => m.palette?.accent === '#3a775a').length, 1, 'Workflow receives the palette with its context once');
console.log('workbench-context-receipts-test PASS');
