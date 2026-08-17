const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const serverEntry = read('_site/server.js');
const server = read('_site/lib/server-app.js');
const automation = read('_site/lib/post-commit-automation.js');
const reconciler = read('_site/lib/commit-reconciler.js');
const contracts = read('_site/lib/contracts.js');
const logger = read('_site/lib/structured-logger.js');
const ui = read('ui/index.html');

assert(serverEntry.includes("require('./lib/server-app')"), 'server entry should remain thin');
for (const removed of ['/automation/simulate', '/automation/init', '/hook-install', '/hook-uninstall', '/api/raw', "'Access-Control-Allow-Origin': '*'"]) {
  assert(!server.includes(removed), `legacy server capability must be absent: ${removed}`);
}
for (const removed of ['dispatchProjectInit', 'renderProjectInitPrompt', 'DEFAULT_INIT_PROMPT_TEMPLATE', 'dispatchAutomation']) {
  assert(!automation.includes(removed), `legacy automation symbol must be absent: ${removed}`);
}
assert.strictEqual((automation.match(/handlePostCommitEvent/g) || []).length >= 1, true);
assert(reconciler.includes('validateTrigger(trigger)'));
assert(contracts.includes("Object.freeze(['git-hook', 'startup'])"), 'only the two approved analysis triggers should be accepted');
assert(logger.includes('LOG_LEVELS,') && logger.includes('new Set(LOG_LEVELS)'), 'the v2 logger must use the shared six-level contract');
assert(logger.includes('class LogRepository'));
assert(!ui.includes('tailwindcss.com'));
assert(!ui.includes('vue.global'));
assert.strictEqual((ui.match(/data-logging-app/g) || []).length, 1, 'production must contain one logging UI root');

console.log('refactor-characterization-test PASS');
