'use strict';
// 索引失败展示契约（源码级守护）：运行详情里渲染的引擎错误明细必须逐字段
// esc() 转义，失败分类判定必须覆盖 failed 与 index-pending。
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
// - 运行详情（活动页 .run 展开块）现在渲染的明细字段是
//   upstreamMessage / failureKind / httpStatus / attempt，全部经
//   esc(r.error.details.<field>) 转义后进入 innerHTML。
// - 旧断言中的 upstreamCode / requestId / durationMs 已不再被 UI 渲染
//   （requestId 仅存在于面板/帧消息协议，不属于错误明细展示），按新结构
//   映射为只断言真实渲染的四个字段——渲染即转义的业务断言保持等价：
//   任何进入 innerHTML 的错误明细字段都不得绕过 esc()。
// - `['failed', 'index-pending'].includes(r.state)` 分类仍在（恢复标签、
//   issue 徽标与重试按钮的判定），断言保留。
// - 真实渲染/导出路径仍由 engine test:web:faults 覆盖（本测试只做源码
//   契约，不经浏览器）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../ui/product.js'), 'utf8');
for (const field of ['upstreamMessage', 'failureKind', 'httpStatus', 'attempt']) {
  assert.ok(source.includes(`esc(r.error.details.${field}`), `index detail must be escaped: ${field}`);
}
// The rendered failure classification must keep treating failed and
// index-pending as the failure states (recovery label, issue badge, retry).
assert.ok(source.includes("['failed', 'index-pending'].includes(r.state)"));
// Fields the five-page UI no longer renders must not silently come back as
// unescaped interpolations of r.error.details.
for (const field of ['upstreamCode', 'requestId', 'durationMs']) {
  assert.equal(source.includes(`r.error.details.${field}`), false, `retired detail field must not be interpolated unescaped: ${field}`);
}
console.log('index-error-display-contract-test PASS (real rendering/export covered by engine test:web:faults)');
