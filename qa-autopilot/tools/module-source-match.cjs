#!/usr/bin/env node
'use strict';
/**
 * B00-A · 模块源码来源校验（对应差异 C02）
 *
 * 目的：证明主项目 package.json / module-runtime-manifest.json / vendor-manifest.json 里
 * 锁定的模块版本，其**精确字节**来自哪个独立仓库的哪个 commit。
 *
 * 只读：只执行 git show / git ls-tree / 文件读取，不改任何仓库状态。
 *
 * 关键判据：
 *   - exact      ：仓库该 commit 的 blob 字节哈希 == 清单哈希
 *   - crlf-eq    ：把 blob 统一转成 CRLF 后哈希相同（Windows 打包行尾差异）
 *   - lf-eq      ：把双方行尾统一成 LF 后哈希相同（内容相同，行尾不同）
 *   - mismatch   ：内容实质不同
 *   - missing    ：该 commit 中不存在此路径
 *
 * 用法：node tools/module-source-match.cjs [--kb <主项目路径>] [--kb-rev <rev>] [--out <json 路径>]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const qaRoot = path.resolve(__dirname, '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }

const KB = arg('kb', 'D:/SanQian.Xu/project-knowledge-base');
const KB_REV = arg('kb-rev', 'origin/main');
const OUT = arg('out', path.join(qaRoot, 'reports', 'branches', 'MODULE_SOURCE_MATCH.json'));

/** 候选独立仓库：路径必须现场确认。 */
const CANDIDATES = [
  { key: 'terminal', repo: 'D:/SanQian.Xu/claude-ai-workbench', prefixes: [''], label: 'Claude-Ai-Workbench' },
  { key: 'vectorHub', repo: 'D:/SanQian.Xu/vector-hub', prefixes: [''], label: 'vector-hub' },
  { key: 'eventBridge', repo: 'D:/SanQian.Xu/ai-coding-event-bridge', prefixes: ['packages/console/'], label: 'ai-coding-event-bridge' }
];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}
function g(repo, rev, p) { return execFileSync('git', ['-C', repo, 'show', rev + ':' + p], { maxBuffer: 1 << 28 }); }
function tree(repo, rev) { return git(repo, ['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean); }
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const toLF = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
const toCRLF = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));

function classify(want, blob) {
  if (sha(blob) === want) return 'exact';
  if (sha(toCRLF(blob)) === want) return 'crlf-eq';
  if (sha(toLF(blob)) === want) return 'lf-eq';
  return 'mismatch';
}

function compare(label, repo, rev, files, prefixes, notes, worktreeRoot) {
  const result = { label, repo, rev, fileCount: Object.keys(files).length, prefixes, notes: notes || [], files: {}, counts: { exact: 0, 'crlf-eq': 0, 'lf-eq': 0, 'eol-mixed-eq': 0, mismatch: 0, missing: 0 } };
  if (!fs.existsSync(path.join(repo, '.git'))) { result.blocked = 'BLOCKED_LOCAL_REPO_PATH'; return result; }
  let paths;
  try { paths = tree(repo, rev); } catch (e) { result.blocked = 'REV_NOT_AVAILABLE'; result.error = String(e.message).split('\n')[0]; return result; }
  const pset = new Set(paths);
  for (const f of Object.keys(files)) {
    const want = files[f];
    let p = null, usedPrefix = null;
    for (const pre of prefixes) {
      const cand = pre + f;
      if (pset.has(cand)) { p = cand; usedPrefix = pre; break; }
    }
    if (!p) {
      const hits = paths.filter(x => x.endsWith('/' + f));
      if (hits.length === 1) { p = hits[0]; usedPrefix = '(suffix)'; }
    }
    if (!p) { result.counts.missing++; result.files[f] = { verdict: 'missing' }; continue; }
    let blob;
    try { blob = g(repo, rev, p); } catch (e) { result.counts.missing++; result.files[f] = { verdict: 'missing' }; continue; }
    let verdict = classify(want, blob);
    // 行尾混合场景：清单哈希取自主项目工作区字节，仓库 blob 可能行尾全 LF。
    // 逐行尾归一后比较内容是否一致（内容相同、字节不同）。
    if (verdict === 'mismatch' && worktreeRoot) {
      const wt = path.join(worktreeRoot, f);
      if (fs.existsSync(wt)) {
        const wtBytes = fs.readFileSync(wt);
        if (sha(wtBytes) === want && sha(toLF(wtBytes)) === sha(toLF(blob))) verdict = 'eol-mixed-eq';
      }
    }
    result.counts[verdict]++;
    result.files[f] = { verdict, repoPath: p, prefix: usedPrefix };
  }
  result.allBytesMatch = result.counts.exact + result.counts['crlf-eq'] === result.fileCount;
  result.contentMatchesIgnoringEol = result.counts.exact + result.counts['crlf-eq'] + result.counts['lf-eq'] + result.counts['eol-mixed-eq'] === result.fileCount;
  return result;
}

function main() {
  const out = { schema: 'qa-autopilot/module-source-match/v1', phase: 'B00-A', mode: 'READ_ONLY', generatedAt: new Date().toISOString(), kb: KB, kbRev: KB_REV, results: [], findings: [] };

  const mrmRaw = g(KB, KB_REV, 'module-runtime-manifest.json').toString();
  const mrm = JSON.parse(mrmRaw);
  out.moduleRuntimeManifest = { version: mrm.modules && mrm.modules.terminal && mrm.modules.terminal.version, modules: Object.fromEntries(Object.entries(mrm.modules || {}).map(([k, v]) => [k, { name: v.name, version: v.version, fileCount: Object.keys(v.files || {}).length }])) };

  for (const c of CANDIDATES) {
    const mod = mrm.modules && mrm.modules[c.key];
    if (!mod) continue;
    const refs = c.key === 'terminal' ? ['agent/sdk-productization', 'origin/agent/sdk-productization', 'main', 'origin/main']
      : c.key === 'eventBridge' ? ['feat/ai-coding-event-bridge', 'origin/feat/ai-coding-event-bridge', 'origin/main']
        : ['main', 'origin/main'];
    const attempts = [];
    for (const rev of refs) {
      let r;
      try { r = compare(c.label, c.repo, rev, mod.files, c.prefixes); }
      catch (e) { attempts.push({ rev, blocked: 'REV_NOT_AVAILABLE' }); continue; }
      attempts.push(r);
      if (r.counts.mismatch === 0 && r.counts.missing === 0) break;
    }
    out.results.push({ module: c.key, expectedVersion: mod.version, attempts });
    const best = attempts.find(a => !a.blocked && a.counts.mismatch === 0 && a.counts.missing === 0);
    if (best) out.findings.push({ module: c.key, expectedVersion: mod.version, matchedRev: best.rev, verdict: best.allBytesMatch ? 'ALL_BYTES_MATCH' : 'CONTENT_MATCH_EOL_ONLY', counts: best.counts });
    else out.findings.push({ module: c.key, expectedVersion: mod.version, matchedRev: null, verdict: 'NO_EXACT_REV_MATCH', counts: attempts[attempts.length - 1] && attempts[attempts.length - 1].counts });
  }

  // knowledge-engine：主项目内嵌副本 vs 独立仓库
  try {
    const vm = JSON.parse(g(KB, KB_REV, 'vendor-manifest.json').toString());
    const keFiles = (vm.modules && vm.modules['knowledge-engine'] && vm.modules['knowledge-engine'].files) || {};
    const keRepo = 'D:/SanQian.Xu/knowledge-engine';
    const keAttempts = [];
    const keWorktree = path.join(KB, '_modules', 'knowledge-engine');
    for (const rev of ['main', 'origin/main']) {
      let r;
      try { r = compare('knowledge-engine', keRepo, rev, keFiles, [''], [], keWorktree); }
      catch (e) { keAttempts.push({ rev, blocked: 'REV_NOT_AVAILABLE' }); continue; }
      keAttempts.push(r);
      if (r.counts.mismatch === 0 && r.counts.missing === 0) break;
    }
    out.results.push({ module: 'knowledge-engine', expectedVersion: vm.modules['knowledge-engine'].version, attempts: keAttempts });
    const best = keAttempts.find(a => !a.blocked && a.counts.mismatch === 0 && a.counts.missing === 0);
    out.findings.push({
      module: 'knowledge-engine', expectedVersion: vm.modules['knowledge-engine'].version,
      matchedRev: best ? best.rev : null,
      verdict: best ? (best.allBytesMatch ? 'ALL_BYTES_MATCH' : 'CONTENT_MATCH_EOL_ONLY') : 'NO_EXACT_REV_MATCH',
      counts: best ? best.counts : (keAttempts[keAttempts.length - 1] || {}).counts,
      note: 'knowledge-engine 以 _modules/ 内嵌副本交付，不是 npm 依赖；npm 上最高为 0.2.7-rc.9，内嵌为 0.2.7-rc.10。'
    });
  } catch (e) { out.findings.push({ module: 'knowledge-engine', blocked: 'VENDOR_MANIFEST_UNAVAILABLE', error: String(e.message).split('\n')[0] }); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ status: 'PASS', phase: 'B00-A', mode: 'READ_ONLY', output: OUT, findings: out.findings }, null, 2));
}
if (require.main === module) main();
module.exports = { compare, classify };
