// Run: node _site/_test/recovery-label-contract-test.js
// 与 retry-scheduler 的调度状态对齐：只有已有下一次自动恢复安排的运行才显示
// 「自动恢复中」；data-failed（从不安排 nextRetryAt）、无恢复计划、暂停或预算
// 耗尽显示「需要处理」；配置问题显示「等待配置」。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'product.js'), 'utf8');

const match = app.match(/const recoveryLabel = (run => \{[\s\S]*?\n  \});/);
assert(match, 'product.js must still define recoveryLabel');
const recoveryLabel = eval(`(${match[1]})`);

const cases = [
  ['data-failed without nextRetryAt reads as needing attention', { state: 'failed', recovery: { kind: 'data-failed', attempts: 1, nextRetryAt: null } }, '需要处理'],
  ['data-failed with explicit budget exhaustion still needs attention', { state: 'failed', recovery: { kind: 'data-failed', attempts: 4, budgetExhaustedAt: '2026-11-13T00:00:00.000Z' } }, '需要处理'],
  ['transient failure with a scheduled retry is auto-recovering', { state: 'failed', recovery: { kind: 'transient', attempts: 1, nextRetryAt: '2026-11-20T00:00:10.000Z' } }, '自动恢复中'],
  ['rate-limit failure with a scheduled retry is auto-recovering', { state: 'failed', recovery: { kind: 'rate-limit', attempts: 2, nextRetryAt: '2026-11-20T00:01:00.000Z' } }, '自动恢复中'],
  ['config-blocked waits for configuration', { state: 'failed', recovery: { kind: 'config-blocked', attempts: 1 } }, '等待配置'],
  ['exhausted budget needs attention even for transient failures', { state: 'failed', recovery: { kind: 'transient', attempts: 3, budgetExhaustedAt: '2026-11-19T00:00:00.000Z' } }, '需要处理'],
  ['paused recovery needs attention', { state: 'failed', recovery: { kind: 'transient', attempts: 1, paused: true } }, '需要处理'],
  ['a failed run with no recovery plan has nothing scheduled', { state: 'failed' }, '需要处理'],
  ['index-pending without a recovery plan is not silently auto-recovering', { state: 'index-pending' }, '需要处理'],
  ['index-pending with a scheduled retry is auto-recovering', { state: 'index-pending', recovery: { kind: 'transient', attempts: 1, nextRetryAt: '2026-11-20T00:00:10.000Z' } }, '自动恢复中'],
  ['succeeded runs carry no recovery label', { state: 'succeeded', recovery: null }, ''],
];
for (const [label, run, expected] of cases) {
  assert.strictEqual(recoveryLabel(run), expected, label);
}

// The needs/recovering filters key off the same label, so a data-failed run
// must now surface under「需要处理」instead of hiding inside auto-recovery.
assert(app.includes("state.activityFilter === 'needs' && ['failed', 'index-pending'].includes(r.state) && recoveryLabel(r) !== '自动恢复中'"), 'needs filter still uses recoveryLabel');
assert(app.includes("state.activityFilter === 'recovering' && recoveryLabel(r) === '自动恢复中'"), 'recovering filter still uses recoveryLabel');
// attempts are a per-round counter: manual retry resets them.
assert(app.includes('本轮已尝试'), 'attempt count must be labeled as the current round');
// The retry entry only acknowledges acceptance; the run state reports outcome.
assert(app.includes('已提交重试'), 'retry button toast must acknowledge submission, not completion');
// Evidence failures render their concrete resource.
assert(app.includes('失败资源：'), 'evidence failures must show the concrete resource');

const coverageRenderer = app.match(/function gitEvidenceCoverage\(coverage\) \{[\s\S]*?\n  \}/);
assert(coverageRenderer, 'activity must explain the evidence coverage for oversized commits');
const renderCoverage = new Function('esc', 'return (' + coverageRenderer[0] + ')')(String);
assert.strictEqual(renderCoverage(null), '');
assert.match(renderCoverage({ kind: 'text-patch' }), /完整文本差异.*二进制 Git 对象标识/);
assert.match(renderCoverage({ kind: 'selected-file-patches', textPathCount: 3 }), /3 项文本补丁/);
assert.match(renderCoverage({ kind: 'selected-file-patches', textPathCount: 1, preflightSkippedPaths: 2 }), /2 项在生成补丁前已仅归档对象标识/);
assert.match(renderCoverage({ kind: 'file-object-list' }), /补丁未收录/);
assert(app.includes('${gitEvidenceCoverage(r.patchCoverage)}'), 'activity cards must use the reported evidence coverage');

console.log('recovery-label-contract-test PASS');
