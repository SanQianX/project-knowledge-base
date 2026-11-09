'use strict';
// qa-autopilot/tools/product-probes/parallel-capture-safety-r5.js
//
// Explicit entry point of the P-CAPTURE-SAFETY-R5 batch (tasks #39..#42).
//
// One-shot unified full-env retest of the three ACCEPTED R4 final flows.
// The R4 entry spawned its probes with the ambient environment, so every
// subprocess family inherited whatever the calling shell carried — the R4
// vectorhub incident (engine default vectorUrl -> live 8787 hub) and the
// mem005 fixture landing in the real user TEMP both trace to that premise.
// R5 fixes the premise itself instead of granting per-case exemptions:
//
//   * BEFORE anything is spawned, the wrapper captures read-only from the
//     REAL machine: the real home (the accepted workbench fixture captures it
//     at module load, before any child exists), real-home client-config and
//     client-tree digests (r3cap helpers, explicit homeDir), the real
//     Chrome/Edge binary (findChromeDetailed under the real env), and an
//     at-rest snapshot (directory names + mtimes ONLY, no content reads) of
//     the live vector hub index root.
//   * Every probe child runs with sanitizedEnv(isolationEnvMap(layout)):
//     HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/CODEX_HOME/CLAUDE_CONFIG_DIR/
//     APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR/KB_DATA_DIR/KB_KNOWLEDGE_DATA_DIR/
//     AI_CODING_EVENT_BRIDGE_HOME/AGENT_TERMINAL_DATA_DIR/
//     CLAUDE_AI_WORKBENCH_DATA_DIR all point into ONE lane-owned root outside
//     the repository; KB_MODULES_AUTOSTART=0; ambient module URLs and model
//     provider variables are deleted; KB_CHROME_PATH pins the pre-resolved
//     binary; PK_TEST_TEMP_ROOT keeps every mkdtemp fixture under the same
//     root; PK_CAPTURE_SAFETY_R5_REAL_HOME hands the R5 probe copies the real
//     home so their read-only comparisons never digest the isolated home
//     against itself (no fake-HOME proof).
//   * The three flows run ONCE each, in the R4 order, fully offline:
//     mem005 -> cap008e -> cap006r4. No expected value changed, no old
//     R1/R3/R4 entry is executed; the flows are the R5 prefix copies whose
//     only deltas vs the frozen R4 sources are in evidence/source-diffs/.
//   * Independent post-run gates: real-home config surface byte-identical;
//     real-home client trees leak-free (r3cap.compareRealTrees); the hub
//     index-root snapshot unchanged; zero leftover lane-attributable
//     processes (Win32_Process scan: creation time >= wrapper start AND
//     command line matches the lane markers, the wrapper itself excluded).
//
// The lane-owned layout root is deliberately KEPT after the run: the R5
// vectorhub investigation lost URI closure precisely because R4 fixture
// homes had been deleted. Deleting it is the Leader's call, not the lane's.
//
// Report: qa-autopilot/artifacts/parallel-20261023/capture-safety-r5/report.json
// Bindings (pure definitions, no outcome) are written separately by the lane.
//
// Exit codes: 0 = three real exits 0 AND every post-run gate green,
//             1 = any probe failure, timeout or gate violation.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// Required FIRST: module load captures REAL_HOME/REAL_USERPROFILE before any
// child exists. The wrapper itself never mutates process.env.
const wbf = require(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'parallel-workbench-drafts-r5-fixture.js'));
const r3cap = require(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'parallel-memory-capture-r3-cap-shell.js'));
const { findChromeDetailed } = require(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'find-chrome.js'));

const LANE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'capture-safety-r5');
const EVIDENCE_DIR = path.join(LANE_DIR, 'evidence');
const LOG_DIR = path.join(LANE_DIR, 'logs');
// At-rest root of the developer's live vector hub (incident investigation,
// evidence/vectorhub-incident). Names+mtimes only — never read content here.
const REAL_HUB_INDEXES_ROOT = 'D:\\SanQian.Xu\\knowledge\\.indexes';

const FLOWS = [
  { id: 'mem005', sub: 'mem005', script: '_site/_test/parallel-capture-safety-r5-mem005-health-test.js', timeoutMs: 15 * 60 * 1000 },
  { id: 'cap008e', sub: 'cap008e', script: '_site/_test/parallel-capture-safety-r5-cap008e-probe.js', timeoutMs: 25 * 60 * 1000 },
  { id: 'cap006r4', sub: 'cap006r4', script: '_site/_test/parallel-capture-safety-r5-cap006-probe.js', timeoutMs: 20 * 60 * 1000 },
];

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function rel(file) { return path.relative(REPO_ROOT, file).replace(/\\/g, '/'); }

// At-rest snapshot: directory names + mtimes of the live hub root. No content
// is opened — the read-only incident-investigation discipline applies to this
// gate too. The live desktop owns this tree; any delta is recorded verbatim
// for attribution, never cleaned up by the lane.
function snapshotHubIndexes() {
  if (!fs.existsSync(REAL_HUB_INDEXES_ROOT)) return { exists: false, count: 0, entries: [] };
  const entries = fs.readdirSync(REAL_HUB_INDEXES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const stats = fs.statSync(path.join(REAL_HUB_INDEXES_ROOT, entry.name));
      return { name: entry.name, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, count: entries.length, entries };
}

function diffSnapshots(before, after) {
  if (before.exists !== after.exists) return { unchanged: false, reason: `exists ${before.exists} -> ${after.exists}` };
  if (!before.exists) return { unchanged: true, reason: 'root absent on this machine' };
  const beforeMap = new Map(before.entries.map(entry => [entry.name, entry.mtimeMs]));
  const afterMap = new Map(after.entries.map(entry => [entry.name, entry.mtimeMs]));
  const delta = [];
  for (const [name, mtime] of afterMap) {
    if (!beforeMap.has(name)) delta.push({ name, state: 'created', mtimeMs: mtime });
    else if (beforeMap.get(name) !== mtime) delta.push({ name, state: 'modified', mtimeMs: mtime });
  }
  for (const name of beforeMap.keys()) if (!afterMap.has(name)) delta.push({ name, state: 'removed' });
  return { unchanged: delta.length === 0, delta };
}

// Leftover-process gate. The scan script lives under the lane artifacts dir
// with a name that itself matches neither lane marker, so the scanning
// powershell never matches its own command line. PSModuleAnalysisCachePath is
// forced to a lane file so the scan cannot write the repo-root cache.
function scanLeftoverProcesses(wrapperStartedMs, wrapperPid, layoutTemp) {
  const script = path.join(LANE_DIR, 'scan-leftover-processes.ps1');
  fs.writeFileSync(script, [
    'param([string]$SinceIsoUtc, [int]$ExcludePid)',
    '$since = [DateTime]::Parse($SinceIsoUtc).ToUniversalTime()',
    '$hits = Get-CimInstance Win32_Process | Where-Object {',
    '  $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $since -and $_.ProcessId -ne $ExcludePid -and $_.CommandLine -and ($_.CommandLine -match \'parallel-capture-safety-r5\' -or $_.CommandLine -match \'pk-cap-safety-r5-\')',
    '}',
    '$hits | ForEach-Object {',
    '  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; createdUtc = $_.CreationDate.ToUniversalTime().ToString(\'o\'); name = $_.Name; command = $_.CommandLine }',
    '} | ConvertTo-Json -Depth 3',
  ].join('\n'), 'utf8');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-File', script,
    '-SinceIsoUtc', new Date(wrapperStartedMs).toISOString(), '-ExcludePid', String(wrapperPid)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env, PSModuleAnalysisCachePath: path.join(layoutTemp, 'ps-module-cache-scan.json') },
  });
  const text = String(result.stdout || '').trim();
  if (!text) return { count: 0, entries: [], scanError: result.status === 0 ? null : String(result.stderr || '').slice(0, 2000) };
  let entries = null;
  try { const parsed = JSON.parse(text); entries = Array.isArray(parsed) ? parsed : [parsed]; } catch { entries = null; }
  if (!entries) return { count: null, entries: [], scanError: `unparseable scan output: ${text.slice(0, 500)}` };
  return { count: entries.length, entries, scanError: null };
}

function firstErrorLine(log) {
  const lines = log.split(/\r?\n/).filter(line => /\b(Error|AssertionError|FAIL)\b/.test(line));
  return lines.length ? lines[0].slice(0, 500) : null;
}

function childEnvFor(layout, chrome, evidenceSub) {
  return wbf.sanitizedEnv({
    ...wbf.isolationEnvMap(layout),
    KB_CHROME_PATH: chrome.path,
    PK_CAPTURE_SAFETY_R5_REAL_HOME: wbf.REAL_HOME,
    PK_TEST_TEMP_ROOT: layout.temp,
    PK_TEST_EVIDENCE_DIR: path.join(EVIDENCE_DIR, evidenceSub),
  });
}

(async () => {
  const wrapperStartedMs = Date.now();
  const wrapperStartedAt = new Date(wrapperStartedMs).toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // --- pre-switch captures (read-only, before any child exists) ------------
  const chrome = findChromeDetailed();
  const configBefore = r3cap.digestRealClientConfigs(wbf.REAL_HOME);
  const treesBefore = r3cap.digestRealClientTrees(wbf.REAL_HOME);
  const hubBefore = snapshotHubIndexes();
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'hub-indexes-snapshot-before.json'), JSON.stringify(hubBefore, null, 2), 'utf8');

  const layout = wbf.createIsolationLayout('pk-cap-safety-r5');

  // --- the three flows, once each ------------------------------------------
  const runs = [];
  for (const flow of FLOWS) {
    const evidenceSubDir = path.join(EVIDENCE_DIR, flow.sub);
    fs.mkdirSync(evidenceSubDir, { recursive: true });
    const env = childEnvFor(layout, chrome, flow.sub);
    const logFile = path.join(LOG_DIR, `${flow.id}.log`);
    const scriptAbs = path.join(REPO_ROOT, flow.script);
    const startedMs = Date.now();
    const child = spawn(process.execPath, [scriptAbs], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { output.stdout += chunk; });
    child.stderr.on('data', chunk => { output.stderr += chunk; });
    const run = {
      id: flow.id,
      script: flow.script,
      purpose: { mem005: 'MEM-005 健康页忽略持久性（UI 半边三道健康门）', cap008e: 'CAP-008 engine 模式同 basename canonical 身份隔离', cap006r4: 'CAP-006 显式 CODEX_HOME 隔离 + 三次真实接入/修复' }[flow.id],
      pid: child.pid,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      log: rel(logFile),
      evidenceDir: rel(evidenceSubDir),
      firstError: null,
    };
    runs.push(run);
    const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let timeoutHandle;
    const timer = new Promise(resolve => { timeoutHandle = setTimeout(() => resolve({ timeout: true }), flow.timeoutMs); });
    const outcome = await Promise.race([done, timer]);
    clearTimeout(timeoutHandle);
    if (outcome.timeout) {
      run.timedOut = true;
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      const forced = await done;
      run.exitCode = forced.code;
      run.signal = forced.signal;
    } else {
      run.exitCode = outcome.code;
      run.signal = outcome.signal;
    }
    run.endedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedMs;
    const fullLog = output.stdout + output.stderr;
    fs.writeFileSync(logFile, fullLog, 'utf8');
    run.firstError = run.exitCode === 0 ? null : firstErrorLine(fullLog);
    console.log(`[capture-safety-r5] ${flow.id}: exit=${run.exitCode} timedOut=${run.timedOut} durationMs=${run.durationMs}${run.firstError ? ` firstError=${run.firstError}` : ''}`);
  }

  // --- independent post-run gates ------------------------------------------
  const configAfter = r3cap.digestRealClientConfigs(wbf.REAL_HOME);
  const treesAfter = r3cap.digestRealClientTrees(wbf.REAL_HOME);
  const configComparison = r3cap.compareConfigSurface(configBefore, configAfter);
  const treeComparison = r3cap.compareRealTrees(treesBefore, treesAfter);
  const hubAfter = snapshotHubIndexes();
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'hub-indexes-snapshot-after.json'), JSON.stringify(hubAfter, null, 2), 'utf8');
  const hubDiff = diffSnapshots(hubBefore, hubAfter);
  const leftover = scanLeftoverProcesses(wrapperStartedMs, process.pid, layout.temp);

  const gates = {
    realHomeConfigSurfaceByteIdentical: configComparison.byteIdentical,
    realHomeClientTreesLeakFree: treeComparison.leaks.length === 0,
    hubIndexesUnchanged: hubDiff.unchanged,
    noLeftoverLaneProcesses: leftover.count === 0 && !leftover.scanError,
  };
  const flowsGreen = runs.every(run => run.exitCode === 0 && !run.timedOut);
  const overall = flowsGreen && Object.values(gates).every(Boolean);

  // --- source hashes + evidence manifest ------------------------------------
  const sourceFiles = [
    '_site/_test/parallel-capture-safety-r5-mem005-health-test.js',
    '_site/_test/parallel-capture-safety-r5-cap008e-probe.js',
    '_site/_test/parallel-capture-safety-r5-cap006-probe.js',
    '_site/_test/helpers/parallel-capture-safety-r5-memory-shell.js',
    '_site/_test/helpers/parallel-capture-safety-r5-cap-shell.js',
    'qa-autopilot/tools/product-probes/parallel-capture-safety-r5.js',
  ].map(file => ({ file, sha256: sha256File(path.join(REPO_ROOT, file)) }));

  const manifestFiles = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else manifestFiles.push(p);
    }
  })(EVIDENCE_DIR);
  for (const run of runs) manifestFiles.push(path.join(REPO_ROOT, run.log));
  // report.json cannot hash itself: embedding the manifest changes the file.
  const evidenceManifest = Object.fromEntries(
    manifestFiles.filter(file => fs.existsSync(file)).map(file => [rel(file), sha256File(file)]),
  );

  const gitHead = (() => {
    try { return spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim(); } catch { return null; }
  })();

  const isolationValues = wbf.isolationEnvMap(layout);
  const report = {
    schema: 'qa-autopilot/capture-safety-r5-lane-report/v1',
    lane: 'P-CAPTURE-SAFETY-R5',
    batch: 'parallel-20261023',
    generatedAt: new Date().toISOString(),
    wrapper: {
      pid: process.pid,
      startedAt: wrapperStartedAt,
      command: `node ${rel(__filename)}`,
      realHomeCapturedBeforeAnyChild: wbf.REAL_HOME,
      realUserProfileCaptured: wbf.REAL_USERPROFILE,
      repo: { root: REPO_ROOT.replace(/\\/g, '/'), gitHead, commitPolicy: '五仓 main 不 commit/push/npm/tag/version/pin/vendor/manifest；本线只写自己独占前缀' },
    },
    preSwitchCaptures: {
      chrome: { path: chrome.path, source: chrome.source, note: 'resolved under the REAL env before isolation; pinned into children as KB_CHROME_PATH' },
      realHomeConfigDigest: 'taken (see gates); digests kept in memory only, comparisons in postRunGates',
      hubIndexesSnapshot: { root: REAL_HUB_INDEXES_ROOT, count: hubBefore.count, evidence: 'evidence/hub-indexes-snapshot-before.json', method: 'directory names + mtimes only, no content reads' },
    },
    isolationEnvelope: {
      layoutRoot: layout.root,
      layoutKeptAfterRun: true,
      layoutKeptReason: 'R4 fixture homes were deleted and the vectorhub investigation lost URI closure; deletion is the Leader\'s call',
      envKeysPassedToEveryChild: Object.keys(childEnvFor(layout, chrome, '<flow>')).sort(),
      isolationValues,
      explicitPins: {
        KB_CHROME_PATH: chrome.path,
        PK_CAPTURE_SAFETY_R5_REAL_HOME: wbf.REAL_HOME,
        PK_TEST_TEMP_ROOT: layout.temp,
        PK_TEST_EVIDENCE_DIR: 'per-flow evidence/<sub>',
      },
      scrubbedBeforeChildren: {
        ambientModuleUrls: wbf.AMBIENT_MODULE_URLS,
        ambientModelEnv: wbf.AMBIENT_MODEL_ENV,
      },
      forbiddenPortsNeverBound: [...wbf.FORBIDDEN_PORTS],
      inheritanceNote: 'deeper subprocesses (product server, engine, console, Chrome, codex CLI, git hooks) inherit this same env from their probe; the probes add only lane-local endpoints via their own code',
    },
    flows: runs,
    postRunGates: {
      ...gates,
      detail: {
        configComparison: { byteIdentical: configComparison.byteIdentical, changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs },
        treeComparison: { leaks: treeComparison.leaks, configChangesCount: treeComparison.configChanges.length, runtimeChangesCount: treeComparison.runtimeChanges },
        hubIndexes: hubDiff,
        leftoverProcesses: leftover,
      },
    },
    laneOutcome: {
      allFlowsExitZero: flowsGreen,
      gatesGreen: Object.values(gates).every(Boolean),
      overall,
      note: 'lane-level result only: real exit codes + wrapper gates. Scoped claims, NOT a Leader PASS; Leader adjudicates per the original catalog.',
    },
    sourceFiles,
    sourceDiffsVsFrozenR4: fs.readdirSync(path.join(LANE_DIR, 'evidence', 'source-diffs')).map(name => `evidence/source-diffs/${name}`),
    incidentInvestigation: {
      report: 'evidence/vectorhub-incident/vectorhub-incident-investigation.json',
      summary: 'R4 第3/4轮 POST 与 mem005 server 路径曾触达本机 8787 实活向量 hub：3 项内容级证明（2 个测试集合 + 1 个真实集合 catalog 覆写）+ 6 项空集合时间归因；根因 engine 默认 vectorUrl / server module-bridge 默认 / TEMP 未隔离；R5 修复 = 引擎显式 lane vectorUrl + 全 env 隔离 wrapper；清理 proposal 留 Leader 决断。',
      quarantine: 'evidence/vectorhub-incident/quarantine/（10 集合 24 文件副本 + SHA256SUMS）',
    },
    constraintsHonored: [
      '三个最终流程各运行一次，未重跑任何旧 R1/R3/R4 入口，未改任何 expected',
      '全程离线：无模型、无额度；所有模块端点为 lane 自有端点',
      '未安装/替换/停止/重启真实桌面与模块；固定端口 5757/5760/5789/5790/8787/8790 全程未被本线触达',
      '真实 HOME / 真实知识 / memory / trust 零写入（postRunGates 独立复核）',
      '实活 hub 根只做目录名+mtime 快照比对，未读任何内容、未调 HTTP API、未删除条目',
      'Microsoft/ ModuleAnalysisCache 继续保全未删；本线 PowerShell 扫描强制 PSModuleAnalysisCachePath 指向 lane 文件',
    ],
    background: 0,
    state: 'idle',
    deliverables: {
      report: rel(path.join(LANE_DIR, 'report.json')),
      bindings: 'qa-autopilot/artifacts/parallel-20261023/capture-safety-r5/bindings.fragment.json（纯定义，另册写就）',
      evidence: Object.keys(evidenceManifest).filter(name => name.startsWith('evidence/')),
      logs: runs.map(run => run.log),
    },
    evidenceManifest,
  };

  fs.writeFileSync(path.join(LANE_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ report: rel(path.join(LANE_DIR, 'report.json')), laneOutcome: report.laneOutcome, gates, flows: runs.map(run => ({ id: run.id, exitCode: run.exitCode, timedOut: run.timedOut })) }, null, 2));
  process.exitCode = overall ? 0 : 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
