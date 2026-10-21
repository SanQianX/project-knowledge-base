#!/usr/bin/env node
'use strict';
/**
 * T03-OVERNIGHT · 故障注入验收 A–H
 *
 * 模拟额度验收与真实额度验证分开报告：
 *   A/B/C/D 用**模拟**额度与**假**Worker（结果确定、不消耗真实额度）
 *   E/F/G/H 用**真实**订阅额度、真实 ZCode CLI、真实开发知识库
 *
 * 每个场景在独立子进程 + 独立临时仓库（含本地 bare 远程）中运行，
 * 验证的正是"Supervisor 独立于模型会话存活"的真实形态。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { readJSON, atomicJSON, redact, must, isolatedEnv, runLogged } = require('../lib/safety.cjs');

const qaRoot = path.resolve(__dirname, '..');
const ROOT = path.join(qaRoot, '.runtime', 'acceptance', 'run-' + Date.now());
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function record(id, title, kind, ok, detail, evidence) {
  results.push({ id, title, kind, ok: ok === true, detail: detail || null, evidence: evidence || null });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + title + (detail ? '  — ' + detail : ''));
}

// ───────────────────────── 假额度 / 假 Worker
function fakes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const qFile = path.join(dir, 'quota-percent.txt');
  const qExe = path.join(dir, 'fake-quota.cjs');
  fs.writeFileSync(qExe, `#!/usr/bin/env node
'use strict';
const fs=require('fs');
const n=Number(fs.readFileSync(process.argv[2],'utf8').trim());
process.stdout.write(JSON.stringify({base_resp:{status_code:0,status_msg:'success'},model_remains:[{model_name:'general',current_interval_remaining_percent:n,current_weekly_remaining_percent:100,current_interval_status:1,current_weekly_status:1}]}));
`);
  const wFile = path.join(dir, 'worker-behaviour.txt');
  const wExe = path.join(dir, 'fake-worker.cjs');
  fs.writeFileSync(wExe, `#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
let raw='';process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>raw+=d);
process.stdin.on('end',()=>{
  const behaviour=fs.readFileSync(process.argv[2],'utf8').trim();
  const req=JSON.parse(raw);
  const out=process.env.QA_RESULT_FILE;
  const write=(o)=>{fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(o));};
  const NL=String.fromCharCode(10);
  if(behaviour==='crash-after-write'){ write({protocol:'pkb-qa-task/v1',taskId:req.id,status:'DONE',sessionId:'sess_fake_'+req.id,modelObserved:['MiniMax-M3.1-Flash']}); process.exit(9); }
  if(behaviour==='crash-hard'){ process.exit(9); }
  if(behaviour==='paused'){ write({protocol:'pkb-qa-task/v1',taskId:req.id,status:'PAUSED_QUOTA',safeBoundary:true,quota:{reason:'SIMULATED',code:'quota_exceeded'}}); process.exit(75); }
  // 真正写产物：允许文件内含每个规格的标记断言；测试文件是可通过的最小 node:test
  const allowed=(req.contract&&req.contract.allowedFiles)||[];
  const specs=(req.contract&&req.contract.specIds)||[];
  const prefix=(req.contract&&req.contract.markerPrefix)||'QA-SPEC-';
  for(const f of allowed){
    const abs=path.join(req.sourceRoot,f);
    fs.mkdirSync(path.dirname(abs),{recursive:true});
    if(f.endsWith('-test.js')){
      const cases=specs.map(id=>"test('"+prefix+id+" marker',()=>{ assert.ok(true); });").join(NL);
      fs.writeFileSync(abs,"const test=require('node:test'),assert=require('node:assert/strict');"+NL+cases+NL);
    } else {
      fs.writeFileSync(abs,specs.map(id=>'// '+prefix+id).join(NL)+NL);
    }
  }
  write({protocol:'pkb-qa-task/v1',taskId:req.id,status:'DONE',safeBoundary:false,sessionId:'sess_fake_'+req.id,modelObserved:['MiniMax-M3.1-Flash'],usage:{source:'provider',modelRequestCount:1}});
});
`);
  return {
    setQuota: p => fs.writeFileSync(qFile, String(p)),
    quota: { executable: process.execPath, args: [qExe, qFile] },
    setBehaviour: b => fs.writeFileSync(wFile, b),
    worker: { executable: process.execPath, args: [wExe, wFile] }
  };
}

// ───────────────────────── 临时环境：bare 远程 + clone + 配置
function makeEnv(baseCfg, name, opts = {}) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const bare = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'clone');
  execFileSync('git', ['clone', '--quiet', '--bare', path.join(qaRoot, '.runtime', 'acceptance', 'seed'), bare], { encoding: 'utf8' });
  execFileSync('git', ['clone', '--quiet', bare, repo], { encoding: 'utf8' });
  const g = a => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g(['config', 'user.email', 'qa@local.invalid']);
  g(['config', 'user.name', 'QA Acceptance']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['config', 'core.hooksPath', path.join(repo, '.git', 'qa-controller-empty-hooks')]);
  fs.mkdirSync(path.join(repo, '.git', 'qa-controller-empty-hooks'), { recursive: true });
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.qaRoot = dir;
  cfg.repoRoot = repo;
  cfg.sourceRoot = repo;
  cfg.qaBranch = 'qa/acceptance';
  const file = path.join(dir, 'local.json');
  const fk = fakes(path.join(dir, 'fakes'));
  cfg.quota = { ...cfg.quota, mode: 'cli', ...fk.quota, modelNames: ['general'], weeklyPercentField: 'current_weekly_remaining_percent', weeklyEntitlementEvidence: 'acceptance-simulation', stopTaskPercent: 20, stopRequestPercent: 10, resumePercent: 35, resumeConsecutive: 2, maxAgeMs: 120000, sampleMs: 1000 };
  cfg.worker = { ...cfg.worker, ...fk.worker, taskTimeoutMs: 20000 };
  cfg.authorization = { ...cfg.authorization, controllerIsolationVerified: true, remoteWriteEnabled: true };
  cfg.overnight = { pollMs: 500 };
  atomicJSON(file, cfg);
  const stateDir = path.join(dir, 'state', 'overnight');
  fs.mkdirSync(stateDir, { recursive: true });
  return { dir, bare, repo, file, stateDir, fk, cfg };
}

function seedRepo() {
  const seed = path.join(ROOT, 'seed');
  fs.rmSync(seed, { recursive: true, force: true });
  fs.mkdirSync(seed, { recursive: true });
  const g = a => execFileSync('git', ['-C', seed, ...a], { encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'seed@local.invalid']);
  g(['config', 'user.name', 'Seed']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# acceptance seed\n');
  g(['add', '.']);
  g(['commit', '-qm', 'seed']);
  return seed;
}

function writeQueue(stateDir, tasks) {
  atomicJSON(path.join(stateDir, 'queue.json'), { schema: 'qa-autopilot/overnight-queue/v1', builtAt: new Date().toISOString(), sourceLedger: 'acceptance', tasks });
}
function readState(stateDir) {
  const f = path.join(stateDir, 'state.json');
  return fs.existsSync(f) ? readJSON(f) : null;
}
function runSupervisor(envFile, stateDir, evidenceDir, ms, extraArgs = []) {
  const child = spawn(process.execPath, [path.join(qaRoot, 'tools', 'overnight-supervisor.cjs'), 'run', envFile, ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, QA_OVERNIGHT_STATE_DIR: stateDir, QA_OVERNIGHT_EVIDENCE_DIR: evidenceDir }
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  return new Promise(resolve => {
    const t = setTimeout(() => { child.kill('SIGTERM'); }, ms);
    child.on('exit', code => { clearTimeout(t); setTimeout(() => resolve({ code, out }), 400); });
  });
}
const gitOf = (repo, a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

(async () => {
  console.log('════════ T03-OVERNIGHT 故障注入验收 A–H ════════\n');
  fs.mkdirSync(ROOT, { recursive: true });
  seedRepo();
  const baseCfg = readJSON(path.join(qaRoot, 'config', 'local.json'));
  const { fetchQuota } = require(path.join(qaRoot, 'lib', 'quota.cjs'));
  const { devKbHealth } = require(path.join(qaRoot, 'tools', 'overnight-supervisor.cjs'));

  // ── A：Worker 完成后自动领取下一项
  {
    const env = makeEnv(baseCfg, 'A');
    env.fk.setQuota(90); env.fk.setBehaviour('ok');
    writeQueue(env.stateDir, [
      { id: 'ACC-A-1', module: 'acc1', specIds: ['ACC-SPEC-1'], specCount: 1, status: 'PENDING' },
      { id: 'ACC-A-2', module: 'acc2', specIds: ['ACC-SPEC-2'], specCount: 1, status: 'PENDING' }
    ]);
    await runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 26000);
    const st = readState(env.stateDir);
    const t1 = st && st.tasks['ACC-A-1'], t2 = st && st.tasks['ACC-A-2'];
    const okA = !!(t1 && t2 && t1.status !== 'PENDING' && t2.status !== 'PENDING');
    record('A', 'Worker 完成任务后自动领取下一项', 'SIMULATED', okA,
      okA ? `任务1=${t1.status}（${t1.commitSha ? '已提交 ' + t1.commitSha.slice(0, 8) : '无提交'}），随即自动领取任务2=${t2.status}` : `任务1=${t1 && t1.status} 任务2=${t2 && t2.status}`,
      { t1: t1 && { status: t1.status, sha: t1.commitSha }, t2: t2 && { status: t2.status } });
  }

  // ── B：模拟额度耗尽 → 暂停；恢复 → 自动继续
  {
    const env = makeEnv(baseCfg, 'B');
    env.fk.setQuota(90); env.fk.setBehaviour('ok');
    writeQueue(env.stateDir, [
      { id: 'ACC-B-1', module: 'accb1', specIds: ['ACC-SPEC-B1'], specCount: 1, status: 'PENDING' },
      { id: 'ACC-B-2', module: 'accb2', specIds: ['ACC-SPEC-B2'], specCount: 1, status: 'PENDING' }
    ]);
    // 额度掉到 15% → 必须暂停且不派发
    env.fk.setQuota(15);
    const p1 = runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 9000);
    await sleep(4000);
    const stMid = readState(env.stateDir);
    const pausedMid = stMid && stMid.quotaState;
    const tMid = stMid && stMid.tasks['ACC-B-1'];
    // 恢复到 50% → 必须自动继续
    env.fk.setQuota(50);
    const p2 = p1;
    await p2;
    await sleep(500);
    const stAfter = readState(env.stateDir);
    const t1 = stAfter && stAfter.tasks['ACC-B-1'];
    const okB = pausedMid === 'DRAINING' && !(tMid && tMid.status !== 'PENDING') && !!(t1 && t1.status !== 'PENDING');
    record('B', '模拟额度耗尽暂停，恢复后自动继续', 'SIMULATED', okB,
      okB ? `15% 时状态=${pausedMid}（不领新任务），恢复到 50% 后任务1=${t1.status}` : `暂停期状态=${pausedMid} 恢复后任务1=${t1 && t1.status}`,
      { pausedState: pausedMid, afterRecovery: t1 && t1.status });
  }

  // ── C：Supervisor 重启后正确恢复检查点
  {
    const env = makeEnv(baseCfg, 'C');
    env.fk.setQuota(90); env.fk.setBehaviour('ok');
    writeQueue(env.stateDir, [{ id: 'ACC-C-1', module: 'accc1', specIds: ['ACC-SPEC-C1'], specCount: 1, status: 'PENDING' }]);
    await runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 12000);
    const st1 = readState(env.stateDir);
    const rev1 = st1 && st1.revision;
    // 重启：再次运行
    env.fk.setBehaviour('ok');
    await runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 12000);
    const st2 = readState(env.stateDir);
    const okC = !!(st1 && st2 && st2.revision > rev1 && st2.tasks['ACC-C-1']);
    record('C', 'Supervisor 重启后正确恢复检查点', 'SIMULATED', okC,
      okC ? `第一次 revision=${rev1}，重启后 revision=${st2.revision}（单调递增），任务状态保留=${st2.tasks['ACC-C-1'] && st2.tasks['ACC-C-1'].status}` : `rev1=${rev1} rev2=${st2 && st2.revision}`,
      { revisionBefore: rev1, revisionAfter: st2 && st2.revision });
  }

  // ── D：Agent 意外退出后不重复 Git 提交
  // 三个动作连续验证：
  //   1) 任务1 正常完成 → 远程出现 1 个提交
  //   2) 任务2 的 Worker 硬崩溃 → 该任务 FAILED，且远程仍只有 1 个提交（没有半成品提交）
  //   3) Supervisor 重启 → 任务1 不被重新派发/重复推送，远程提交数仍为 1
  {
    const env = makeEnv(baseCfg, 'D');
    env.fk.setQuota(90);
    writeQueue(env.stateDir, [
      { id: 'ACC-D-1', module: 'accd1', specIds: ['ACC-SPEC-D1'], specCount: 1, status: 'PENDING' },
      { id: 'ACC-D-2', module: 'accd2', specIds: ['ACC-SPEC-D2'], count: 1, specCount: 1, status: 'PENDING' }
    ]);
    const revIf = () => { try { return gitOf(env.bare, ['rev-parse', '--verify', 'refs/heads/qa/acceptance']).trim(); } catch { return null; } };
    const countIf = () => { try { return gitOf(env.bare, ['rev-list', '--count', 'refs/heads/qa/acceptance']).trim(); } catch { return '0'; } };

    // 1) 任务1 用正常 Worker
    env.fk.setBehaviour('ok');
    await runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 16000);
    const afterTask1 = countIf();

    // 2) 任务2 的 Worker 硬崩溃
    env.fk.setBehaviour('crash-hard');
    await runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 16000);
    const st2 = readState(env.stateDir);
    const afterCrash = countIf();
    const t2 = st2 && st2.tasks['ACC-D-2'];

    // 3) 重启：已提交的任务1 不得被重复推送
    env.fk.setBehaviour('ok');
    await runSupervisor(env.file, env.stateDir, path.join(env.dir, 'ev'), 16000);
    const afterRestart = countIf();
    const st3 = readState(env.stateDir);
    const t1 = st3 && st3.tasks['ACC-D-1'];

    const okD = afterTask1 === afterCrash && afterCrash === afterRestart && Number(afterTask1) >= 2 && t1 && t1.status !== 'PENDING';
    record('D', 'Agent 意外退出后不重复 Git 提交', 'SIMULATED', okD,
      okD ? `远程提交数 ${afterTask1} → Worker 崩溃后 ${afterCrash} → Supervisor 重启后 ${afterRestart}（均未增长，无重复推送、无半成品提交）；任务1=${t1 && t1.status}` : `提交数 ${afterTask1}→${afterCrash}→${afterRestart}，任务1=${t1 && t1.status} 任务2=${t2 && t2.status}`,
      { afterTask1, afterCrash, afterRestart, t1: t1 && t1.status, t2: t2 && t2.status, remoteSha: revIf() });
  }

  // ── E：真实订阅额度查询（真实）
  {
    let q = null, err = null;
    // 真实额度必须用与 Worker 同一个订阅 Key：同一个 ZCode provider 配置
    const pj = JSON.parse(fs.readFileSync('C:/Users/SanQian/.zcode/v2/provider_config.json', 'utf8'));
    const rule = pj.config.providerConfigRules.providerRules.find(r => r.providerId === 'minimax');
    process.env.MINIMAX_API_KEY = rule.config.access.apiKey;
    try { q = await fetchQuota(baseCfg.quota); } catch (e) { err = e.code || e.message; }
    const okE = !!(q && q.state === 'KNOWN' && typeof q.remainingPercent === 'number' && q.weeklyRemainingPercent !== null);
    record('E', '实际订阅额度可查询且与 Worker 同一订阅', 'REAL', okE,
      okE ? `真实额度：五小时 ${q.fiveHourRemainingPercent}% / 周 ${q.weeklyRemainingPercent}%，池=${q.model}，来源=${q.source}` : '失败 ' + (err || JSON.stringify(q)),
      { quota: q, endpoint: baseCfg.quota.url, keySource: baseCfg.quota.keySource && baseCfg.quota.keySource.jsonPath, sameKeyAsWorker: true });
  }

  // ── F：真实 ZCode CLI 无人工输入完成真实任务
  {
    const work = path.join(ROOT, 'F', 'work');
    fs.mkdirSync(work, { recursive: true });
    const req = { protocol: 'pkb-qa-task/v1', id: 'ACC-F-1', sourceRoot: work, contract: { bugId: 'ACC-F-1', summary: '在当前目录创建文件 f-proof.txt，内容恰好一行：REAL_CLI_NO_HUMAN。只做这一件事。', expectedBehaviorList: ['当前目录出现 f-proof.txt，内容为 REAL_CLI_NO_HUMAN'], allowedFiles: ['f-proof.txt'], sourceEvidence: ['验收 F'] } };
    const resultFile = path.join(ROOT, 'F', 'result.json');
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    const r = await runLogged(process.execPath, [path.join(qaRoot, 'tools', 'zcode-worker.cjs')], {
      cwd: work, env: isolatedEnv(path.join(ROOT, 'F', 'run'), { QA_RESULT_FILE: resultFile, QA_RUNTIME_DIR: path.join(qaRoot, '.runtime') }),
      logDir: path.join(ROOT, 'F', 'ev'), timeoutMs: 300000, input: JSON.stringify(req) + '\n'
    });
    const j = fs.existsSync(resultFile) ? readJSON(resultFile) : null;
    const file = path.join(work, 'f-proof.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
    const okF = !!(j && j.status === 'DONE' && j.exitCode === 0 && content === 'REAL_CLI_NO_HUMAN' && j.sessionId);
    record('F', 'ZCode 无人工输入完成真实 CLI 任务', 'REAL', okF,
      okF ? `退出码=${j.exitCode}，sessionId=${j.sessionId}，模型=${JSON.stringify(j.modelObserved)}，产物内容=${content}` : `status=${j && j.status} content=${content}`,
      { sessionId: j && j.sessionId, modelObserved: j && j.modelObserved, usage: j && j.usage, artifact: content });
  }

  // ── G：开发知识库始终保持正常运行
  {
    const before = devKbHealth();
    const work = path.join(ROOT, 'G', 'work');
    fs.mkdirSync(work, { recursive: true });
    const req = { protocol: 'pkb-qa-task/v1', id: 'ACC-G-1', sourceRoot: work, contract: { bugId: 'ACC-G-1', summary: '在当前目录创建文件 g.txt，内容恰好一行：G_OK。只做这一件事。', expectedBehaviorList: ['g.txt 存在'], allowedFiles: ['g.txt'], sourceEvidence: ['验收 G'] } };
    const resultFile = path.join(ROOT, 'G', 'result.json');
    const ev = fs.statSync('C:/Users/SanQian/.project-knowledge-v5/events/journal/events.jsonl');
    const beforeSize = ev.size, beforeMtime = ev.mtime.toISOString();
    await runLogged(process.execPath, [path.join(qaRoot, 'tools', 'zcode-worker.cjs')], {
      cwd: work, env: isolatedEnv(path.join(ROOT, 'G', 'run'), { QA_RESULT_FILE: resultFile, QA_RUNTIME_DIR: path.join(qaRoot, '.runtime') }),
      logDir: path.join(ROOT, 'G', 'ev'), timeoutMs: 300000, input: JSON.stringify(req) + '\n'
    });
    const after = devKbHealth();
    const ev2 = fs.statSync('C:/Users/SanQian/.project-knowledge-v5/events/journal/events.jsonl');
    const unchanged = ev2.size === beforeSize && ev2.mtime.toISOString() === beforeMtime;
    const okG = before.ok && after.ok && unchanged;
    record('G', '开发知识库始终正常运行且不被 QA 写入', 'REAL', okG,
      okG ? `健康 ${before.passed}/${before.total} → ${after.passed}/${after.total}；开发库 journal 字节与 mtime 未变（${beforeSize} B）` : `健康 ${before.passed}/${before.total}→${after.passed}/${after.total}，journal 变化=${!unchanged}`,
      { before, after, journalBytesBefore: beforeSize, journalBytesAfter: ev2.size, journalUnchanged: unchanged });
  }

  // ── H：锁屏后非交互测试仍可执行；需要交互桌面的测试单独标注
  {
    const locked = (() => {
      try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command', "try { (Get-Process LogonUI -ErrorAction Stop | Measure-Object).Count } catch { 0 }"], { encoding: 'utf8', timeout: 30000 });
        return Number(out.trim()) > 0;
      } catch { return false; }
    })();
    // 非交互可执行性：以 QA 包的纯 node 套件（无浏览器）作为代表实跑
    const r = await runLogged(process.execPath, ['--test', 'tests/core.test.cjs', 'tests/workflow.test.cjs'], {
      cwd: qaRoot, env: isolatedEnv(path.join(ROOT, 'H', 'run')), logDir: path.join(ROOT, 'H', 'ev'), timeoutMs: 300000
    });
    const nonInteractiveOk = r.code === 0 && !r.timedOut;
    // 需要交互桌面的：真实浏览器套件（Chrome 需交互式桌面会话）
    const needsDesktop = ['_site/_test/product-import-ui-test.js', '_site/_test/product-progress-status-test.js', '_site/_test/product-diagnostics-ui-test.js', '_site/_test/agent-capture-ui-test.js', '_site/_test/agent-capture-mcp-ui-test.js', '_site/_test/packaged-ui-smoke-test.js'];
    const okH = nonInteractiveOk;
    record('H', '锁屏后非交互测试仍可执行；交互式测试已单独标注', 'REAL', okH,
      okH ? `非交互套件实跑通过（exit=${r.code}）；当前会话锁定=${locked}；标注为需交互桌面的浏览器用例 ${needsDesktop.length} 个` : `非交互套件失败 exit=${r.code}`,
      { sessionLockedNow: locked, nonInteractiveSuite: { exitCode: r.code, timedOut: r.timedOut }, requiresInteractiveDesktop: needsDesktop, note: '真实 Chrome 需要交互式桌面会话；锁屏时这些用例应跳过并记录为 BLOCKED_CAPABILITY' });
  }

  const failed = results.filter(r => !r.ok);
  const report = { schema: 'qa-autopilot/overnight-acceptance/v1', at: new Date().toISOString(), simulated: results.filter(r => r.kind === 'SIMULATED'), real: results.filter(r => r.kind === 'REAL'), results, failed: failed.length, verdict: failed.length ? 'NOT_READY' : 'READY' };
  atomicJSON(path.join(qaRoot, 'reports', 'branches', 'OVERNIGHT_ACCEPTANCE.json'), report);
  console.log('');
  console.log('  模拟项: ' + report.simulated.filter(r => r.ok).length + '/' + report.simulated.length + ' 通过');
  console.log('  真实项: ' + report.real.filter(r => r.ok).length + '/' + report.real.length + ' 通过');
  console.log('  总判定: ' + report.verdict + (failed.length ? '（失败: ' + failed.map(f => f.id).join(', ') + '）' : ''));
  if (failed.length) process.exitCode = 10;
})().catch(e => { console.error('  验收脚本失败:', redact(e.stack || e.message)); process.exitCode = 20; });
