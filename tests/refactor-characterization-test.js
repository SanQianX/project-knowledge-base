const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = require("./paths").ROOT;
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const serverEntry = read('src/server.js');
const server = read('src/server/server-app.js');
const automation = read('src/automation/post-commit-automation.js');
const reconciler = read('src/automation/commit-reconciler.js');
const contracts = read('src/common/contracts.js');
const logger = read('src/common/structured-logger.js');
const ui = read('ui/index.html');

// 入口薄壳断言跟随域布局：server 域承接 server-app。/ The thin-entry
// assertion follows the domain layout: the server domain hosts server-app.
assert(serverEntry.includes("require('./server/server-app')"), 'server entry should remain thin');
for (const removed of ['/automation/simulate', '/automation/init', '/hook-install', '/hook-uninstall', '/api/raw', "'Access-Control-Allow-Origin': '*'"]) {
  assert(!server.includes(removed), `legacy server capability must be absent: ${removed}`);
}
for (const removed of ['dispatchProjectInit', 'renderProjectInitPrompt', 'DEFAULT_INIT_PROMPT_TEMPLATE', 'dispatchAutomation']) {
  assert(!automation.includes(removed), `legacy automation symbol must be absent: ${removed}`);
}
assert.strictEqual((automation.match(/handlePostCommitEvent/g) || []).length >= 1, true);
assert(reconciler.includes('validateTrigger(trigger)'));
assert(contracts.includes("Object.freeze(['git-hook'])"), 'git-hook must be the only analysis trigger');
assert(!server.includes("reconcileProjectCommits(projectId, 'startup'"), 'startup must not submit commit analysis');
assert(!automation.includes('dispatchPendingAutomations'), 'pending startup dispatcher must be deleted');
assert(reconciler.includes('processCommitEvent'), 'Hook events must have an explicit commit processor');
assert(!reconciler.includes('this.scanner.scan('), 'knowledge analysis must not scan baseline..HEAD');
assert(logger.includes('LOG_LEVELS,') && logger.includes('new Set(LOG_LEVELS)'), 'the v2 logger must use the shared six-level contract');
assert(logger.includes('class LogRepository'));
assert(!ui.includes('tailwindcss.com'));
assert(!ui.includes('vue.global'));
assert.strictEqual((ui.match(/class="app"/g) || []).length, 1, 'production must contain one full product shell');
assert.strictEqual((ui.match(/id="logsDialog"/g) || []).length, 1, 'production must contain one diagnostics view');

console.log('refactor-characterization-test PASS');
