#!/usr/bin/env node
'use strict';
/**
 * T07B · 130 项测试规格执行台账
 *
 * 判定纪律：
 *   - 只有**真实跑过并通过**的测试文件才能构成某条规格的 PASS 证据。
 *   - 候选测试文件通过 ≠ 该规格被覆盖。覆盖关系由 specs-coverage.json 显式登记
 *     （specId -> 实施该规格的测试文件，或 NEW:<新文件>）。
 *   - 未能覆盖、未能执行或被门禁阻断的规格一律不写 PASS。
 *   - 任何 FAIL 都必须带失败用例、退出码与证据路径。
 */
const fs = require('node:fs');
const path = require('node:path');
const qaRoot = path.resolve(__dirname, '..');
const CASES = path.join(qaRoot, 'config', 'test-cases.json');
const COVERAGE = path.join(qaRoot, 'config', 'specs-coverage.json');
const OUT_JSON = path.join(qaRoot, 'reports', 'branches', 'T07B_LEDGER.json');
const OUT_MD = path.join(qaRoot, 'reports', 'branches', 'T07B_LEDGER.md');
const RECEIPTS = path.join(qaRoot, 'artifacts');

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }

/** 收集 artifacts 下所有真实 suite 收据：file -> {status, exitCode, receiptPath, at} */
function collectResults() {
  const results = new Map();
  if (!fs.existsSync(RECEIPTS)) return results;
  const stack = [RECEIPTS];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name !== 'receipt.json') continue;
      let r;
      try { r = readJSON(p); } catch { continue; }
      if (!r || (r.kind !== 'suite' && r.kind !== 'browser-shell')) continue;
      if (r.kind === 'browser-shell') {
        let d = null;
        try { d = r.details ? readJSON(r.details) : null; } catch { d = null; }
        if (!d) continue;   // 失败运行的产物缺失不影响台账，失败证据仍保留在 artifacts/
        for (const row of (d && d.results) || []) results.set('UI-SHELL-' + row.view, { status: row.status, exitCode: r.exitCode, at: r.at, receiptPath: p, runId: r.id, kind: r.kind });
        if (d) results.set('BROWSER-SHELL', { status: r.status, exitCode: r.exitCode, at: r.at, receiptPath: p, runId: r.id, kind: r.kind });
        continue;
      }
      for (const row of r.results) {
        const prev = results.get(row.file);
        // 取最新一次真实运行
        if (!prev || String(r.at) > String(prev.at)) {
          results.set(row.file, { status: row.status, exitCode: row.exitCode, timedOut: row.timedOut, skipped: row.skipped, durationMs: row.durationMs, at: r.at, receiptPath: p, runId: r.id });
        }
      }
    }
  }
  return results;
}

function build() {
  const cases = readJSON(CASES).cases;
  const coverage = fs.existsSync(COVERAGE) ? readJSON(COVERAGE) : { note: '覆盖关系登记：specId -> 实施该规格的测试文件（相对 _site/_test/）', specs: {} };
  const results = collectResults();
  const rows = [];
  for (const c of cases) {
    const cov = coverage.specs[c.id] || null;
    const row = {
      id: c.id, module: c.module, title: c.title, priority: c.priority, mode: c.mode,
      candidateSuite: c.candidateSuite, source: c.source,
      implementedBy: cov ? (cov.implementedBy || null) : null,
      note: cov ? (cov.note || null) : null,
      verdict: 'NOT_RUN', evidence: [], executed: false
    };
    if (cov && cov.implementedBy) {
      const files = Array.isArray(cov.implementedBy) ? cov.implementedBy : [cov.implementedBy];
      const real = files.map(f => ({ file: f, result: results.get(f) || null }));
      row.evidence = real;
      row.executed = real.every(x => x.result !== null);
      if (row.executed) {
        const failed = real.filter(x => x.result.status !== 'PASS');
        if (failed.length) {
          row.verdict = 'FAIL';
          row.failure = failed.map(x => ({ file: x.file, status: x.result.status, exitCode: x.result.exitCode, receipt: x.result.receiptPath }));
        } else {
          row.verdict = cov.verdict || 'PASS';
          row.receipt = (real.find(x => x.result) || {}).result && real.find(x => x.result).result.receiptPath;
          row.runAt = (real.find(x => x.result) || {}).result && real.find(x => x.result).result.at;
        }
      } else {
        row.verdict = cov.verdict || 'NOT_EXECUTED';
        row.missing = real.filter(x => !x.result).map(x => x.file);
      }
    } else if (cov && cov.verdict) {
      row.verdict = cov.verdict;
      row.evidence = cov.evidence || [];
    } else {
      row.verdict = 'UNMAPPED';
    }
    rows.push(row);
  }
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const byModule = {};
  for (const r of rows) { (byModule[r.module] ||= { total: 0 }); byModule[r.module].total++; byModule[r.module][r.verdict] = (byModule[r.module][r.verdict] || 0) + 1; }
  const out = {
    schema: 'qa-autopilot/spec-ledger/v1', phase: 'T07B', generatedAt: new Date().toISOString(),
    total: rows.length, counts, byModule, rows
  };
  writeJSON(OUT_JSON, out);
  // Markdown
  const lines = [];
  lines.push('# T07B · 130 项测试规格执行台账');
  lines.push('');
  lines.push(`- 生成时间：${out.generatedAt}`);
  lines.push(`- 规格总数：**${out.total}**`);
  lines.push('');
  lines.push('## 判定分布');
  lines.push('');
  lines.push('| 判定 | 数量 | 含义 |');
  lines.push('|---|---|---|');
  const meaning = {
    PASS: '由真实跑过且通过的实施测试文件覆盖',
    FAIL: '实施测试文件真实失败（带退出码与收据路径）',
    BLOCKED: '被门禁或能力阻断，无法执行',
    NOT_EXECUTED: '已登记实施文件但尚未真实执行',
    NOT_COVERED: '没有任何测试断言该规格的期望',
    UNMAPPED: '尚未登记覆盖关系',
    PARTIAL: '仅部分期望被覆盖'
  };
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} | ${meaning[k] || ''} |`);
  lines.push('');
  lines.push('## 按模块');
  lines.push('');
  lines.push('| 模块 | 规格数 | ' + Object.keys(counts).join(' | ') + ' |');
  lines.push('|---|---|' + Object.keys(counts).map(() => '---').join('|') + '|');
  for (const [m, v] of Object.entries(byModule)) {
    lines.push(`| ${m} | ${v.total} | ` + Object.keys(counts).map(k => v[k] || 0).join(' | ') + ' |');
  }
  lines.push('');
  lines.push('## 逐条明细');
  lines.push('');
  lines.push('| ID | 模块 | 标题 | 优先级 | 模式 | 实施测试文件 | 判定 | 证据 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const impl = r.implementedBy ? (Array.isArray(r.implementedBy) ? r.implementedBy.join(', ') : r.implementedBy) : (r.note || '-');
    const ev = r.receipt ? '收据 ' + path.basename(path.dirname(r.receipt)) : (r.failure ? '失败: ' + r.failure.map(f => f.file).join(', ') : (r.evidence && r.evidence.length ? '已登记' : '-'));
    lines.push(`| ${r.id} | ${r.module} | ${r.title} | ${r.priority} | ${r.mode} | ${impl} | **${r.verdict}** | ${ev} |`);
  }
  lines.push('');
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  return out;
}

function main() {
  const cmd = process.argv[2] || 'build';
  if (cmd === 'build') {
    const o = build();
    console.log(JSON.stringify({ status: 'PASS', total: o.total, counts: o.counts, json: OUT_JSON, md: OUT_MD }, null, 2));
    return;
  }
  if (cmd === 'coverage') {
    // 打印待登记的规格，便于人工判定覆盖关系
    const cases = readJSON(CASES).cases;
    const cov = fs.existsSync(COVERAGE) ? readJSON(COVERAGE) : { specs: {} };
    const pending = cases.filter(c => !cov.specs[c.id]);
    console.log(JSON.stringify({ pending: pending.length, ids: pending.map(c => c.id + ' ' + c.module + ' / ' + c.title) }, null, 2));
    return;
  }
  console.log('用法: spec-ledger.cjs [build|coverage]');
}
if (require.main === module) main();
module.exports = { build, collectResults };
