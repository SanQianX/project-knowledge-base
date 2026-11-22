'use strict';
// 迁移说明（2026-11-15 六页主导航：新增 AI 团队）：
// - 导航契约：五页 home/memory/projects/search/activity → 六页，在 home 后
//   插入 team（AI 团队）。team 页是独立工作流模块的同源 iframe 挂载
//   （/workflow-ui/ 页面代理），不是 shell 业务代码；诊断仍不得成为主导航。
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
const root = require("./paths").ROOT;
const html = fs.readFileSync(path.join(root, 'resources/ui/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'resources/ui/product.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources/ui/product.css'), 'utf8');
// Six-page navigation contract (2026-11 adds AI 团队): exactly one nav button
// per primary view, in the fixed order home/team/memory/projects/search/
// activity. The original purpose survives: diagnostics and module consoles
// still must not become another primary product.
for (const view of ['home', 'team', 'memory', 'projects', 'search', 'activity']) {
  assert.equal((html.match(new RegExp(`data-view="${view}"`, 'g')) || []).length, 1);
  assert.ok(html.includes(`id="view-${view}"`));
}
assert.equal((html.match(/data-view=/g) || []).length, 6, 'exactly six primary views; diagnostics must not become another primary product');
const navOrder = [...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(navOrder, ['home', 'team', 'memory', 'projects', 'search', 'activity'], 'six-page navigation order is fixed');
// The AI team page is an embedded module surface, not shell business code:
// an iframe mount plus the /workflow-ui/ proxy, and nothing else in shell UI.
assert.match(html, /<section[^>]*id="view-team"[^>]*>\s*<div class="frame-container"><iframe id="workflowFrame"/, 'team view is a module iframe mount');
assert.match(script, /workflow: \{ id: 'workflowFrame', url: '\/workflow-ui\/\?embed=1&apiBase=\/api\/workflow'/, 'the team frame targets the workflow-ui proxy');
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
