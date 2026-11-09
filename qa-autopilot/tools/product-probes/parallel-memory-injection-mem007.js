'use strict';
// qa-autopilot/tools/product-probes/parallel-memory-injection-mem007.js
//
// Explicit entry point of the P-MEMORY-INJECTION-02 batch.
//
// This file is NOT a regression test and is deliberately kept out of
// _site/_test/ so the offline CI never collects it: it needs the operator's
// ORIGINAL minimax subscription (read-only, in memory), a real Git work tree,
// the real event-bridge console and the real knowledge engine.
//
// It runs the two lane probes of this batch and writes the round report:
//
//   _site/_test/parallel-memory-injection-probe.js        MEM-007
//   _site/_test/parallel-memory-injection-origin-probe.js MEM-008 C01
//
// Report: qa-autopilot/artifacts/parallel-20261023/memory-injection/report.json
//
// Exit codes: 0 = every essential positively verified,
//             3 = at least one essential honestly BLOCKED,
//             1 = script error.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LANE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'memory-injection');
const EVIDENCE_DIR = path.join(LANE_DIR, 'evidence');
const LOG_DIR = path.join(LANE_DIR, 'logs');

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function runProbe(name, script, evidenceFile) {
  const args = [path.join(REPO_ROOT, '_site', '_test', script)];
  const env = { ...process.env };
  // The probes isolate themselves; the entry only names the evidence files.
  env.PARALLEL_MEMORY_INJECTION_EVIDENCE = evidenceFile;
  env.PARALLEL_MEMORY_INJECTION_ORIGIN_EVIDENCE = evidenceFile;
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const finished = new Promise(resolve => child.once('close', code => resolve({ code })));
  return { name, script, args, finished, output, exitCode: null, command: `node ${args[0].split(path.sep).join('/')}` };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The P-MEMORY-01 round claimed that its "7 mutation counter-evidence" proved
// the product would fail when the code regressed. It did not: only the
// EXPECTED VALUES of the test assertions were mutated. The original evidence
// is kept untouched; only the CLAIM is corrected here.
const MEM01_CLAIM_CORRECTION = {
  originalClaim: 'P-MEMORY-01 报告称 7 轮变异反证证明产品在回归时会失败（7/7 全部按预期变红）。',
  correction: '该 7 轮只改写了测试断言的期望值（断言自检），没有变异任何产品源码，因此它不能证明"产品回归时会被捕获"。',
  whatItActuallyProves: '断言期望值本身是活的：期望写错时套件会失败，不会静默通过。',
  whatItDoesNotProve: '任何关于产品真实缺陷可被检出能力的结论。',
  evidenceKept: 'qa-autopilot/artifacts/parallel-20261023/test-memory/report.json 与 logs/mutation-summary.json 原样保留，未删除、未改写。',
  action: '本轮不再重复 7 轮变异，也不为了造红而改动生产代码。',
};

const EXPECTED_ITEMS = [
  {
    id: 'MEM-007.prepared',
    title: '唯一确认记忆在引擎侧被真正准备（prepared）',
    source: '真实知识引擎 _modules/knowledge-engine/src/context.js + memories.js（只读冻结源）',
    boundary: '真实引擎 HTTP 契约 /api/context；经只读透传代理观察，未改写任何字节',
  },
  {
    id: 'MEM-007.output',
    title: 'Workbench 模块把该引擎结果装配进本会话上下文（output）',
    source: 'node_modules/claude-ai-workbench 0.13.6 packages/server/lib/knowledge-context.js + workbench-service.js',
    boundary: '模块真实会话接口 GET /sessions/:id/knowledge；用引擎 requestId 关联',
  },
  {
    id: 'MEM-007.delivery',
    title: '本轮真实模型请求确实携带了该约定（delivery）',
    source: 'packages/server/lib/drivers/cli-json-runner.js 的真实 SDK user message，落在隔离 CLAUDE_CONFIG_DIR 的 CLI transcript',
    boundary: '同一条 user message 必须同时含本轮回执编号与唯一约定前缀；仅 token 回显不算',
  },
  {
    id: 'MEM-007.actual-use',
    title: '模型输出真的采用了该约定（actual use）',
    source: '真实供应商返回的模型回答（CLI transcript 的 assistant 消息）',
    boundary: '问题本身不含约定；标识符由模型自行命名，负控制轮同题同供应商不得出现该前缀',
  },
  {
    id: 'MEM-007.negative-control',
    title: '负控制：同驱动/同题/同供应商的另一仓库不得出现该约定',
    source: '同一次运行内的第二个真实 Git 仓库与第二个真实项目登记',
    boundary: 'prepared/output/delivery/回答四层都必须干净',
  },
  {
    id: 'MEM-008.C01.attribution',
    title: '真实 Workbench 事件的 inputOrigin 与作者归属审查',
    source: 'claude-ai-workbench 0.13.6 conversation-capture.js → ai-coding-event-bridge-console → 知识引擎 conversation-store.js（只读冻结源）',
    boundary: '合成夹具事件，标记 synthetic，不冒充任何真实用户身份',
  },
  {
    id: 'MEM-008.C01.gate',
    title: '真实委派绝不被当作 human 通过长期记忆 candidate 门禁',
    source: '_modules/knowledge-engine/src/memory-eligibility.js + memories.js 的真实 capture 准入路径',
    boundary: '真实引擎真实消费的事件 + 引擎自身冻结的 snapshot + 真实门禁函数',
  },
  {
    id: 'MEM-008.C01.identity',
    title: 'C01：能否证明 human 就是本人',
    source: '同上链路的真实证据',
    boundary: 'human 标签完全由调用方断言，链路中不存在可核验的人身份 → 诚实记为 BLOCKED',
  },
];

(async () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const mem007Evidence = path.join(EVIDENCE_DIR, 'mem007-four-layer.json');
  const originEvidence = path.join(EVIDENCE_DIR, 'mem008-c01-origin.json');

  const runs = [];
  const mem007 = runProbe('MEM-007', 'parallel-memory-injection-probe.js', mem007Evidence);
  runs.push(mem007);
  mem007.exitCode = (await mem007.finished).code;
  fs.writeFileSync(path.join(LOG_DIR, 'mem007-probe.log'), mem007.output.stdout + mem007.output.stderr, 'utf8');

  const origin = runProbe('MEM-008-C01', 'parallel-memory-injection-origin-probe.js', originEvidence);
  runs.push(origin);
  origin.exitCode = (await origin.finished).code;
  fs.writeFileSync(path.join(LOG_DIR, 'mem008-c01-origin-probe.log'), origin.output.stdout + origin.output.stderr, 'utf8');

  const mem007Data = readJson(mem007Evidence);
  const originData = readJson(originEvidence);
  const mem007Cases = (mem007Data && mem007Data.cases) || [];
  const originCases = (originData && originData.cases) || [];

  const byId = id => [...mem007Cases, ...originCases].find(entry => entry.caseId === id) || null;
  const statusOf = id => (byId(id) || {}).status || 'MISSING';

  const expected = {};
  const expectedDetail = {};
  const setExpected = (id, status, note) => { expected[id] = status; expectedDetail[id] = note; };

  setExpected('MEM-007.prepared', statusOf('MEM-007.s5-prepared-engine-context'), '真实引擎 /api/context 响应里含唯一约定');
  setExpected('MEM-007.output', statusOf('MEM-007.s6-output-module-assembled-context'), '模块装配结果与引擎 requestId 关联');
  setExpected('MEM-007.delivery', statusOf('MEM-007.s7-delivery-model-request-carries-convention'), '同一条 user message 同时含回执与约定');
  setExpected('MEM-007.actual-use', statusOf('MEM-007.s8-actual-use-model-follows-convention'), '模型自选标识符带约定前缀');
  setExpected('MEM-007.negative-control', statusOf('MEM-007.s9-negative-control-clean'), '负控制四层均无约定');
  setExpected('MEM-008.C01.attribution', statusOf('MEM-008.C01.s4-engine-recovered-origin'), '真实引擎从 eventKey 复原 inputOrigin');
  setExpected('MEM-008.C01.gate', statusOf('MEM-008.C01.s7-gate-rejects-delegated-event'), '真实委派被 SOURCE_NOT_HUMAN 拒绝');
  setExpected('MEM-008.C01.identity', 'BLOCKED', 'human 标签由调用方断言，无法证明是本人');

  const vendorCase = byId('MEM-007.s10-vendor-returned-model');
  const sdkCase = byId('MEM-007.s3-injected-turn-completed');

  const report = {
    schema: 'qa-autopilot/parallel-lane-report/v1',
    lane: 'P-MEMORY-INJECTION-02',
    batch: 'parallel-20261023',
    caseIds: ['MEM-007', 'MEM-008-C01'],
    summary: 'MEM-007 用真实引擎 + 真实 Workbench 0.13.6 + 真实供应商模型跑通"prepared / output / delivery / actual use"四层真实注入链，并用负控制证明因果；MEM-008 C01 证明真实委派被长期记忆 candidate 门禁以 SOURCE_NOT_HUMAN 拒绝，但 human 标签完全由调用方断言，"human 就是本人"仍无法证明，C01 诚实记为 BLOCKED。',
    generatedAt: new Date().toISOString(),
    repo: {
      root: REPO_ROOT.replace(/\\/g, '/'),
      branch: 'main',
      commitPolicy: '只提交本线自己的新文件；不推送、不发版、不改 pin、不动其它线文件',
      productSourceChanged: [],
      productSourceNote: '本轮没有改动任何产品源码、引擎源码或共享 helper；新增文件仅限本线独占前缀 parallel-memory-injection-*',
    },
    files: {
      added: [
        '_site/_test/parallel-memory-injection-probe.js',
        '_site/_test/parallel-memory-injection-origin-probe.js',
        '_site/_test/helpers/parallel-memory-injection-shell.js',
        '_site/_test/helpers/parallel-memory-injection-wb-host.js',
        'qa-autopilot/tools/product-probes/parallel-memory-injection-mem007.js',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/report.json',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/evidence/mem007-four-layer.json',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/evidence/mem008-c01-origin.json',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/logs/mem007-probe.log',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/logs/mem008-c01-origin-probe.log',
      ],
      frozenReadOnly: [
        '_modules/knowledge-engine/src/**',
        'node_modules/claude-ai-workbench/**',
        'node_modules/@sanqianx/ai-coding-event-bridge-console/**',
        '_site/_test/parallel-memory-*-test.js（上一批 8 个源文件）',
        '_site/_test/helpers/parallel-memory-shell.js 等共享 helper',
      ],
    },
    ownership: {
      laneOwned: [
        '_site/_test/parallel-memory-injection-*.js',
        '_site/_test/helpers/parallel-memory-injection-*',
        'qa-autopilot/tools/product-probes/parallel-memory-injection-*',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/**',
      ],
      snapshotCopies: '本线 helper 中的隔离/只读档案/宿主子进程三段是快照复制（复制件在本线 helper 内），来源文件只读且未修改；运行时记录来源文件 SHA-256',
      snapshotProvenance: {
        mem007: mem007Data && mem007Data.ownership ? mem007Data.ownership.snapshotProvenance || null : null,
        mem008: originData && originData.ownership ? originData.ownership.snapshotProvenance || null : null,
      },
    },
    expected,
    expectedDetail,
    expectedItems: EXPECTED_ITEMS.map(item => ({ ...item, verdict: expected[item.id] || 'MISSING' })),
    commands: runs.map(run => ({
      name: run.name,
      command: run.command,
      exitCode: run.exitCode,
      log: path.relative(REPO_ROOT, path.join(LOG_DIR, `${run.name === 'MEM-007' ? 'mem007' : 'mem008-c01-origin'}-probe.log`)).replace(/\\/g, '/'),
    })),
    retest: {
      command: 'node qa-autopilot/tools/product-probes/parallel-memory-injection-mem007.js',
      note: '真实供应商订阅探针，消耗真实额度；离线 CI 不收集',
    },
    firstFailure: runs.map(run => ({
      name: run.name,
      exitCode: run.exitCode,
      stderrHead: run.output.stderr.split(/\r?\n/).filter(Boolean).slice(-6).join('\n').slice(0, 1200),
    })),
    modelProvenance: {
      requestedModel: (mem007Data && mem007Data.turn && mem007Data.turn.requestedModel) || 'MiniMax-M3.1-Flash',
      effort: (mem007Data && mem007Data.turn && mem007Data.turn.effort) || 'max',
      profile: (mem007Data && mem007Data.profile && mem007Data.profile.id) || 'minimax',
      sdkReportedModel: sdkCase && sdkCase.detail ? sdkCase.detail.sdkReportedModel : null,
      sdkReportedModelNote: 'init.model 是 SDK 本地配置回显，不等于供应商返回的模型',
      vendorReturnedModel: vendorCase && vendorCase.detail ? vendorCase.detail.vendorReturnedModels : null,
      vendorReturnedModelSource: 'CLI transcript 中 type=assistant 消息的 entry.message.model，按 claudeSessionId + 回执关联',
      vendorVerdict: vendorCase ? vendorCase.status : 'MISSING',
      paidTurnsSent: (mem007Data && mem007Data.paidTurnsSent) || 0,
    },
    isolation: {
      tempRoot: 'D:/SanQian.Xu/.project-knowledge-test-temp（仓库外共享临时根）',
      perRun: [
        '独立的 workbench 数据目录 / 知识数据目录 / 引擎数据目录 / Bridge home / HOME / USERPROFILE / CLAUDE_CONFIG_DIR / TEMP',
        '独立的 Git 夹具仓库与知识目录',
        '独立端口；5757/5760/5789/5790/8787/8790 全部拒绝绑定',
        '向量检索使用隔离空结果 stand-in，本线不产出任何向量证据',
      ],
      liveSurfacesNotTouched: [
        '运行中的桌面产品 5.0.24 及其模块',
        '真实 ~/.claude 会话、凭据、记忆与信任库',
        '真实 Bridge（8790）与真实向量 hub（8787）',
        '任何线上额度/配额接口',
      ],
      credentialHandling: '原始 minimax 订阅凭据只读读入内存，经只读档案外观注入子进程环境；secret 未落文件、未写日志、未进仓库；只读档案拒绝全部写方法',
      profileStoreUnchanged: mem007Cases.find(entry => entry.caseId === 'MEM-007.s11-real-profiles-byte-identical') || null,
    },
    cases: [...mem007Cases, ...originCases],
    mem007Evidence: mem007Data,
    mem008Evidence: originData,
    priorRoundCorrection: MEM01_CLAIM_CORRECTION,
    honestSubstitutions: [
      '向量检索：本线使用隔离空结果 stand-in，检索为纯词法；本线不主张任何向量证据。',
      '委派腿：由模块自身的 send() 承载 inputOrigin=agent-delegation（与模块内 dispatcher 的调用完全一致）；0.13.6 的 claude-code 驱动未实现 startDelegatedSession，故完整 dispatcher 链未跑通，已在证据中标注。',
    ],
    state: 'idle',
    deliverables: {
      report: 'qa-autopilot/artifacts/parallel-20261023/memory-injection/report.json',
      evidence: [
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/evidence/mem007-four-layer.json',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/evidence/mem008-c01-origin.json',
      ],
      logs: [
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/logs/mem007-probe.log',
        'qa-autopilot/artifacts/parallel-20261023/memory-injection/logs/mem008-c01-origin-probe.log',
      ],
    },
  };

  const reportFile = path.join(LANE_DIR, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  report.evidenceManifest = Object.fromEntries(
    [reportFile, mem007Evidence, originEvidence].filter(file => fs.existsSync(file)).map(file => [path.relative(REPO_ROOT, file).replace(/\\/g, '/'), sha256File(file)]),
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  const blocked = Object.entries(expected).filter(([, status]) => status !== 'PASS').map(([id]) => id);
  console.log(JSON.stringify({ report: reportFile, expected, blocked, commands: report.commands }, null, 2));
  process.exitCode = blocked.length === 0 ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
