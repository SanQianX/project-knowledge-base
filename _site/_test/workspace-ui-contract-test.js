const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');

for (const contract of [
  'data-logging-app',
  'data-log-table',
  'data-level-filters',
  'data-hook-readonly',
  'id="operation-flow"',
  'id="structured-error"',
  'id="structured-error-stack"',
  'id="raw-log"',
  'id="health-pill"',
  'id="pause-button"',
  'id="export-button"',
  'id="settings-dialog"',
]) {
  assert(html.includes(contract), 'missing logging workspace contract: ' + contract);
}

const levels = [...html.matchAll(/class="level-filter"[^>]*data-level="([^"]+)"/g)].map(match => match[1]);
assert.deepStrictEqual(levels, ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], 'six level controls must be unique and ordered');
assert.strictEqual((html.match(/class="level-filter"/g) || []).length, 6, 'there must be exactly six level filters');
assert((html.match(/aria-pressed="true"/g) || []).length >= 6, 'level filters must expose pressed state');

for (const name of ['from', 'to', 'projectId', 'component', 'event', 'operationId', 'commitSha', 'q', 'pageSize']) {
  assert(html.includes('name="' + name + '"'), 'missing filter: ' + name);
}
assert(html.includes('localDateOffset(-6)') && html.includes('localDateOffset(0)'), 'default range must be local today minus six days through today');
assert(html.includes('cursorHistory') && html.includes('nextCursor') && html.includes('params.set("cursor"'), 'opaque cursor next/previous strategy is missing');
assert(html.includes('resetCursor();') && html.includes('scheduleFilterRefresh'), 'filter changes must reset cursor state');

assert(html.includes('fetchOperationFlow') && html.includes('operationId', html.indexOf('fetchOperationFlow')), 'operation flow must query by operationId');
assert(html.includes('structured.stack') && html.includes('JSON.stringify(entry, null, 2)'), 'structured error stack and raw JSON views are required');
assert(html.includes('copyText(state.selectedLog.operationId') && html.includes('copyText(JSON.stringify(state.selectedLog'), 'copy actions are required');

assert(!/id="setting-[^"]*root/i.test(html), 'logging root must not be configurable');
assert(!html.includes('name="rootPath"'), 'logging root field must not exist');
assert(!html.includes('retentionDays') && !html.includes('maxTotalSizeMB'), 'permanent logs expose no retention or capacity settings');

assert(!html.includes('.innerHTML') && !html.includes('insertAdjacentHTML'), 'log data must never render through an HTML sink');
assert(html.includes('.textContent = text(entry.message') || html.includes('create("span", "message", entry.message'), 'log messages must render as text');
assert(html.includes('html[data-theme="dark"]'), 'dark theme tokens are required');
assert(html.includes('@media (max-width: 620px)'), 'sub-620 responsive layout is required');

console.log('workspace UI contract test PASS');
