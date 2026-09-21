const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ui', 'app.css'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');

for (const contract of [
  'id="project-list"',
  'id="view-terminal"',
  'id="view-search"',
  'id="view-import"',
  'id="settings-drawer"',
  'data-settings="logs"',
  'id="delete-dialog"',
]) assert(html.includes(contract), 'missing v13 shell contract: ' + contract);

const desktopNav = html.slice(html.indexOf('<aside class="sidebar">'), html.indexOf('</aside>'));
assert(desktopNav.includes('data-go="terminal"') && desktopNav.includes('data-go="search"') && desktopNav.includes('data-go="import"'));
assert(!/开发对话|运行记录|系统日志/.test(desktopNav), 'conversation and logs must not be duplicated in main navigation');
assert(!html.includes('data-install-hook') && !html.includes('data-analyze') && !html.includes('data-simulate'), 'manual Hook/analysis controls are forbidden');

// 开发对话已迁移到 ai-coding-event-bridge 模块，设置抽屉不再保留该入口
assert(!html.includes('data-settings="conversation"') && !html.includes('settings-conversation') && !html.includes('conversation-project'), 'development-conversation settings entry must be absent (moved to event-bridge module)');

for (const required of ['logs-date', 'logs-project', 'logs-scope', 'logs-limit', 'logs-search', 'logs-export']) assert(html.includes(`id="${required}"`), 'missing logs toolbar control: ' + required);
for (const forbidden of ['pause-button', 'level-filter', 'setting-retention', 'setting-capacity', 'health-pill', 'data-log-table']) assert(!html.includes(forbidden), 'legacy logs-only control must be absent: ' + forbidden);
assert(!/>Level</i.test(html) && !/>级别</i.test(html.slice(html.indexOf('class="record-toolbar"'), html.indexOf('class="record-shell"'))), 'logs toolbar must not expose a level filter/column');

assert(css.includes('grid-template-columns:minmax(0,1fr) 88px') && css.includes('grid-template-columns:minmax(0,1fr) 76px'), 'desktop/mobile log row geometry is required');
assert(css.includes('.record-list{flex:1;min-height:0;max-height:none;overflow-y:auto;overflow-x:hidden}'), 'record list must own logs scrolling');
assert(!css.includes('max-height:520px'), 'fixed legacy record height is forbidden');
for (const level of ['warn', 'error', 'fatal']) assert(css.includes(`[data-level="${level}"]`), 'whole-row severity color missing: ' + level);
assert(css.includes('html[data-theme="dark"]') && css.includes('@media(max-width:760px)'), 'dark and responsive layouts are required');

assert(!script.includes('.innerHTML') && !script.includes('insertAdjacentHTML'), 'business data must never render through an HTML sink');
assert(script.includes('.textContent = record.message') && script.includes('.textContent = value'), 'logs must render as plain text');
assert(script.includes("stream.addEventListener('logs/appended'") && script.includes('state.newLogs += 1'), 'SSE append/new-record behavior is required');
assert(script.includes('window.__PK_APP__'), 'browser test surface is required');

console.log('workspace UI contract test PASS');
