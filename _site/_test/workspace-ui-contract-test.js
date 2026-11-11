'use strict';
// 迁移说明（2026-11 五页简化 UI）：
// - 导航契约：旧六页（含 work 导航按钮）→ 新五页 nav [data-view] =
//   home/memory/projects/search/activity，各出现一次；data-view 总数 6 → 5。
// - work 页已从导航移除，但 #view-work section 仍在 DOM 且永远 hidden，
//   内部 #workLayout（hidden）与 #workFrame iframe 保留为 Workbench 服务的
//   隐藏挂载点；改为断言「workFrame 隐藏挂载保留」（html 结构 + product.js
//   frames.terminal 挂到 workFrame 且 view 为空）。
// - 供应商管理入口：旧 work 页内 iframe 直达 → 新「系统抽屉可达」：
//   #openSystem（系统抽屉）→ #configureProviders（product.js 会
//   initializeFrame('terminal') 惰性挂载隐藏 workFrame 并 postMessage
//   kb:open-settings）。
// - 旧元素删除后不再断言：#vectorFrame（检索页去 iframe）；新增反向断言
//   #vectorFrame / #projectTree / #projectDetail 不复存在。
// - 模块消息合同：kb:scope 已删除（检索范围改为 #searchForm 表单字段），
//   合同列表换成 kb:theme / kb:select-project / kb:visibility / kb:knowledge /
//   kb:ready / kb:open-settings（隐藏挂载的供应商管理通路）。
// - 转义断言映射：esc(m.text) → esc(memory.text)（记忆详情全文）与
//   esc(clamp2(m.text)（列表预览）；esc(project.name) 保留。
// - 其余安全/时序断言（origin+source 校验、epoch 隔离、写后失效
//   refreshRegistry、导入可从设置返回、诊断惰性流式、CSS 契约）语义不变。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'ui/product.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui/product.css'), 'utf8');
// Five-page navigation contract: exactly one nav button per primary view.
for (const view of ['home', 'memory', 'projects', 'search', 'activity']) {
  assert.equal((html.match(new RegExp(`data-view="${view}"`, 'g')) || []).length, 1);
  assert.ok(html.includes(`id="view-${view}"`));
}
assert.equal((html.match(/data-view=/g) || []).length, 5, 'exactly five primary views; diagnostics must not become another primary product');
assert.ok(!html.includes('data-view="work"'), 'work is no longer a navigation target');
// The workbench frame survives as a hidden service mount: #view-work stays in
// the DOM (forever hidden) and keeps #workFrame for the Workbench service.
assert.match(html, /<section[^>]*id="view-work"[^>]*\bhidden\b>[\s\S]*?id="workLayout"[^>]*\bhidden\b[\s\S]*?<iframe id="workFrame"/, 'the workbench frame survives as a hidden mount inside the forever-hidden #view-work');
assert.match(script, /terminal: \{ id: 'workFrame'[^}]*view: ''/, 'the workbench frame is registered without a navigation view');
// Provider management stays reachable from the system drawer: #openSystem
// opens the drawer, #configureProviders forwards kb:open-settings into the
// hidden workFrame (lazily mounted).
assert.match(script, /on\('openSystem', 'click', openSystem\)/, 'the system drawer opens from the sidebar');
assert.match(script, /on\('configureProviders', 'click'[\s\S]*?initializeFrame\('terminal'\)[\s\S]*?kb:open-settings/, 'provider management reaches the hidden workbench mount from the system drawer');
assert.match(html, /<select\b[^>]*id="projectSelect"[^>]*\bdisabled\b/, 'project selection is disabled until the initial registry snapshot has loaded');
for (const id of ['workFrame', 'bridgeFrame', 'engineFrame', 'importDialog', 'importCode', 'importKnowledge', 'importDomain', 'setupImportRoot', 'createDomain', 'logsDialog', 'systemDrawer', 'openSystem', 'configureProviders', 'repairWiring', 'appDialog', 'unbindDialog', 'referenceDialog', 'copyReference']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
// Legacy one-frame-per-surface elements must not come back.
for (const gone of ['vectorFrame', 'projectTree', 'projectDetail']) assert.ok(!html.includes(`id="${gone}"`), `#${gone} was removed with the five-page UI`);
assert.ok(html.includes('data-action="import"') && html.includes('不分析全部历史'));
assert.ok(!html.includes('srcdoc') && !/data-simulate|data-analyze|data-install-hook/.test(html));
assert.equal((script.match(/\.src = /g) || []).length, 1, 'frames initialize once, not on project/theme/page changes');
for (const contract of ['kb:theme', 'kb:select-project', 'kb:visibility', 'kb:knowledge', 'kb:ready', 'kb:open-settings']) assert.ok(script.includes(contract));
assert.ok(script.includes('event.origin !== location.origin') && script.includes('contentWindow === event.source'), 'module messages must be from the expected frame and origin');
assert.ok(script.includes('state.epoch++') && script.includes('referenceEpoch') && script.includes('logEpoch'), 'late project/reference/log feedback must be isolated');
assert.match(script, /on\('domainForm'[\s\S]*?await refreshRegistry\(true\)/, 'domain writes must invalidate pre-mutation reads');
assert.match(script, /registered = true;[\s\S]*?await refreshRegistry\(true\)/, 'import must not reuse a pre-import snapshot');
assert.ok(script.includes("title: String(r.title || r.entryId || '')") && script.includes('esc(memory.text)') && script.includes('esc(clamp2(m.text)') && script.includes('esc(project.name)'));
assert.ok(script.includes('text.textContent = record.message') && script.includes("'logs/appended'"), 'diagnostics stay inert and stream live');
assert.ok(script.includes('URL.revokeObjectURL(url)') && script.includes('logStream?.close()'));
assert.ok(script.includes('resumeImport = true') && script.includes("$('importDialog').showModal()") && script.includes("p.code === 'KNOWLEDGE_ROOT_MISSING'"), 'first import can return from setup without resetting its input');
assert.ok(css.includes('height:100%') && css.includes('.view.module-view{padding:0;overflow:hidden}') && css.includes('overflow-wrap:anywhere'));
assert.ok(css.includes('html[data-theme=dark]') && css.includes('prefers-reduced-motion'));
assert.doesNotThrow(() => new Function(script));
console.log('workspace UI contract test PASS (source contract; not browser acceptance)');
