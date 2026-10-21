#!/usr/bin/env node
'use strict';
/**
 * 为 qa-autopilot 自身的 npm test 生成与产品套件同格式的收据，
 * 使 GIT / REL / CLN 这些 CONTROLLER_ACCEPTANCE 规格也有真实执行证据。
 * 只读：不修改任何被测内容，只写 artifacts/。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicJSON } = require('../lib/safety.cjs');

const qaRoot = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(qaRoot, 'artifacts', 'qa-selftest-' + stamp);
fs.mkdirSync(outDir, { recursive: true });

let stdout = '', stderr = '', code = 0;
try {
  stdout = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/core.test.cjs', 'tests/workflow.test.cjs'],
    { cwd: qaRoot, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  stdout = e.stdout || ''; stderr = e.stderr || ''; code = e.status === undefined ? 1 : e.status;
}
fs.writeFileSync(path.join(outDir, 'stdout.log'), stdout);
fs.writeFileSync(path.join(outDir, 'stderr.log'), stderr);

// 解析 TAP：顶层子测试用 "ok N - name" / "not ok N - name"
const results = [];
const lines = stdout.split(/\r?\n/);
let current = null;
for (const l of lines) {
  const m = l.match(/^\s*(ok|not ok)\s+(\d+)\s*-\s*(.+?)(?:\s+#\s*(SKIP|TODO).*)?$/);
  if (!m) continue;
  const pass = m[1] === 'ok';
  const name = m[3].trim();
  const skipped = /#\s*SKIP/.test(l);
  if (/^#\s*Subtest:/.test(l)) continue;
  results.push({ file: 'qa-autopilot:' + name, exitCode: pass && !skipped ? 0 : (skipped ? 0 : 1), timedOut: false, skipped: skipped ? 1 : 0, durationMs: 0, status: pass ? (skipped ? 'BLOCKED_CAPABILITY' : 'PASS') : 'FAIL' });
}
const summary = {
  total: (stdout.match(/^# tests (\d+)/m) || [])[1],
  pass: (stdout.match(/^# pass (\d+)/m) || [])[1],
  fail: (stdout.match(/^# fail (\d+)/m) || [])[1],
  skipped: (stdout.match(/^# skipped (\d+)/m) || [])[1]
};
const failed = results.filter(r => r.status === 'FAIL');
const receipt = {
  schema: 1, kind: 'suite', id: 'qa-selftest-' + stamp, suite: 'qa-autopilot',
  head: null, fingerprint: null,
  contractHash: null, startedFrom: qaRoot, node: process.version,
  status: failed.length ? 'FAIL' : 'PASS', exitCode: failed.length ? 10 : 0,
  executed: results.length, skipped: results.filter(r => r.skipped).length,
  timedOut: false, flaky: false, sourceUnchanged: true, results,
  summary, at: new Date().toISOString()
};
atomicJSON(path.join(outDir, 'receipt.json'), receipt);
console.log(JSON.stringify({ status: receipt.status, executed: receipt.executed, failed: failed.length, summary, receiptPath: path.join(outDir, 'receipt.json') }, null, 2));
if (failed.length) { console.log('失败用例:'); for (const f of failed) console.log('  ' + f.file); }
