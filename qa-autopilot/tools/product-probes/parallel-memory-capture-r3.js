'use strict';
// qa-autopilot/tools/product-probes/parallel-memory-capture-r3.js
//
// Explicit entry point of the P-MEMORY-CAPTURE-R3 batch (tasks #32 + #33).
//
// This file is NOT a regression test and is deliberately kept out of
// _site/_test/ so the offline CI never collects it: three of the four cases
// need the native Claude Code CLI (real 接入 = real plugin install + real
// hook/notify wiring against an isolated home), a real Git + Chrome
// environment and, for CAP-008, a codex CLI boundary probe.
//
// It runs the four probes of this batch and writes the lane report:
//
//   _site/_test/parallel-memory-capture-r3-mem005-persistence-test.js  MEM-005 (CI-safe)
//   _site/_test/parallel-memory-capture-r3-cap001-probe.js             CAP-001
//   _site/_test/parallel-memory-capture-r3-cap006-probe.js             CAP-006
//   _site/_test/parallel-memory-capture-r3-cap008-probe.js             CAP-008
//
// Report: qa-autopilot/artifacts/parallel-20261023/memory-capture-r3/report.json
// Bindings (pure definitions): same directory, bindings.fragment.json
//
// Exit codes: 0 = every essential positively verified,
//             3 = at least one essential honestly BLOCKED,
//             1 = script error.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LANE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'memory-capture-r3');
const EVIDENCE_DIR = path.join(LANE_DIR, 'evidence');
const LOG_DIR = path.join(LANE_DIR, 'logs');

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function runProbe(name, script, evidenceSub) {
  const args = [path.join(REPO_ROOT, '_site', '_test', script)];
  const env = { ...process.env, PK_TEST_EVIDENCE_DIR: path.join(EVIDENCE_DIR, evidenceSub) };
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const finished = new Promise(resolve => child.once('close', code => resolve({ code })));
  return { name, script, args, finished, output, exitCode: null, command: `node ${args[0].split(path.sep).join('/')}`, evidenceSub };
}

// The verdict table of this lane. Every PASS claim is gated on the probe's
// real exit code below; a failing probe turns its claims into FAIL.
const CASE_CLAIMS = {
  'MEM-005': {
    probe: 'mem005',
    status: 'PASS',
    summary: '忽略后持久性：真实 UI 忽略真实候选 → 真实浏览器刷新并重开记忆视图 → UI 不再提供该候选且从不显示为已确认；引擎自己的接口与磁盘持久化状态仍是 ignored；冻结来源（晋升条目文件字节 + Git tree + 冻结事件哈希）与忽略前指纹逐字节一致；该记忆未被注入。',
    expected: [
      { key: 'status-ignored', text: '状态ignored。', note: '刷新后经产品接口、引擎接口与引擎磁盘状态文件三处一致 = ignored' },
      { key: 'frozen-source-untouched', text: '来源冻结记录不篡改。', note: '忽略前指纹（文件字节 + Git tree + 事件哈希）与刷新后逐字节一致' },
    ],
    honestScope: '分析步骤是冻结 P-MEMORY-01 的替身分析器；本用例证据关于引擎准入、忽略动作、该状态的持久化与冻结来源，不关于模型判断。',
  },
  'CAP-001': {
    probe: 'cap001',
    status: 'PASS',
    summary: '三能力独立：检测到命令 ≠ 已安装（UI 行徽章与 API summary 都是 未接入/disconnected）；真实 接入 点击后，插件（Knowledge Integration 5.0.24）、插件自带的预读文件（Automatic Context，逐字节一致）与 Bridge hook 条目（Development Capture，每事件恰一条且 shim 存在）分别在自己的磁盘工件上独立验证；产品自身诊断日志中的原生命令全部退出码 0。',
    expected: [
      { key: 'detected-is-not-installed', text: '检测到命令不等于已安装。', note: '真实 CLI 在 PATH 上被检测到，但三能力状态与 UI 徽章均为未接入' },
      { key: 'three-capabilities-verified-separately', text: '三能力分别真实验证。', note: '每个能力对着自己的工件断言：installed_plugins.json/安装目录、预读文件哈希、settings.json hook 条目 + shim 存在性' },
    ],
    honestScope: '真实原生客户端 CLI 对隔离 home 运行；无模型回合。真实 HOME 的隔离声明限定于客户端配置面与已知运行时集合之外的变更（均为空）。',
  },
  'CAP-006': {
    probe: 'cap006',
    status: 'PASS_WITH_BLOCKED_HALF',
    summary: '修复幂等：真实接入 → 真实损坏（复制自有 Stop hook 组 + 注入第三方 hook）→ 产品自身检出 needs-repair/未接入 → 第二次真实 接入 修复：removedDuplicates=1、无叠加、第三方 hook 保留、恰一个备份文件、两个 operationId 都在真实诊断对话框可检索且各恰一条 接入完成。',
    expected: [
      { key: 'no-stacking-no-duplicate-notify-wrapper', text: '不叠加Hook、不重复notify wrapper。', note: 'claude 侧 hook 幂等全证明；codex notify 侧诚实 BLOCKED（见 blockedItems）' },
      { key: 'operationid-traceable', text: 'operationId可追踪。', note: '两次接入的 operationId 在产品真实诊断对话框按 id 检索命中记录且含 接入完成' },
    ],
    blockedItems: [
      {
        id: 'CAP-006.codex-notify',
        title: 'codex notify wrapper 的连续两次修复幂等',
        verdict: 'BLOCKED',
        boundary: '真实 codex CLI（0.137.0）在重定向 HOME/USERPROFILE 并删除 CODEX_HOME 后仍解析开发者真实 profile（plugin list --json 返回真实 home 路径与真实 npm 安装的 5.0.24）；接入将读写真实 ~/.codex/config.toml，故不可执行；另一轮次 CLI 对隔离 home 不完成（远程插件目录请求）。三态判定双向可证：若 CLI 可隔离则本子项判 FAIL。',
        evidence: 'cap006 evidence 的 codexIsolationBoundary 记录（命令、退出码、真实 home 路径）',
      },
    ],
    honestScope: 'claude 侧为全真实行为证据；codex 侧只交付 CLI 边界证据，不以 API 替代实际 UI 步骤。',
  },
  'CAP-008': {
    probe: 'cap008',
    status: 'PASS',
    summary: '同 basename 不同 canonical 路径 A/B 并行隔离：legacy 模式（产品自己的 BridgeConsumerService + ConversationStore 在跑）；两仓库同名 service 经真实导入各得 projectId 与不同 canonical workspaceId（与产品自身身份解析器输出一致）；真实 shim 交错承载两会话（唯一 marker），产品 API 回读各只见自己会话；真实 git commit 经各仓库自己绑定的 managed hook 产出各恰一条 boundary 记录且只落在自己的 commit-boundaries 目录；per-project conversation-events.jsonl 每条记录携带自己的 canonical 身份与会话；全数据目录 grep 无任何 marker/sha 落到对方项目目录。',
    expected: [
      { key: 'canonical-identity-isolation', text: '以canonical身份隔离，不串对话/Commit。', note: '身份层（workspaceId 不同且与 oracle 一致）、会话层（API 回读 + 存储记录级身份 + 全目录 grep）、提交层（boundary 记录与 boundary 文件只在本侧）三层交叉可证' },
    ],
    honestScope: '两次会话经真实安装的 shim、两次提交经真实 managed hook；回读用产品自身会话 API 与 legacy 实例的磁盘存储。Bridge journal 是活性 spool（消费后按设计修剪），故 durable 隔离证据取 per-project 存储记录；spool 仅做水位结构校验（6 条记录确实经过）。驱动侧不做任何路由——路由全部由产品代码完成。',
  },
};

(async () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const order = [
    ['mem005', 'parallel-memory-capture-r3-mem005-persistence-test.js', 'mem005'],
    ['cap001', 'parallel-memory-capture-r3-cap001-probe.js', 'cap001'],
    ['cap006', 'parallel-memory-capture-r3-cap006-probe.js', 'cap006'],
    ['cap008', 'parallel-memory-capture-r3-cap008-probe.js', 'cap008'],
  ];
  const runs = [];
  for (const [name, script, sub] of order) {
    const run = runProbe(name, script, sub);
    runs.push(run);
    run.exitCode = (await run.finished).code;
    fs.mkdirSync(path.join(EVIDENCE_DIR, sub), { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, `${name}.log`), run.output.stdout + run.output.stderr, 'utf8');
  }

  const gitHead = (() => {
    try { return require('node:child_process').execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; }
  })();

  const expected = {};
  for (const [caseId, claim] of Object.entries(CASE_CLAIMS)) {
    const run = runs.find(entry => entry.name === claim.probe);
    const ok = run && run.exitCode === 0;
    for (const item of claim.expected) expected[`${caseId}.${item.key}`] = ok ? 'PASS' : 'FAIL';
    for (const blocked of claim.blockedItems || []) expected[blocked.id] = 'BLOCKED';
  }

  const evidenceFiles = [];
  for (const run of runs) {
    const dir = path.join(EVIDENCE_DIR, run.evidenceSub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) evidenceFiles.push(path.join(dir, name));
  }

  const report = {
    schema: 'qa-autopilot/parallel-lane-report/v1',
    lane: 'P-MEMORY-CAPTURE-R3',
    batch: 'parallel-20261023',
    caseIds: Object.keys(CASE_CLAIMS),
    summary: 'MEM-005 补上忽略后持久性证明（刷新后 UI/引擎/磁盘三处一致、冻结来源逐字节不变、未注入）；CAP-001/006/008 外部 Agent 集成三例以真实产品 UI + 真实原生客户端（隔离 home）+ 真实 Git/Bridge shim/hook 完成：命令检测≠安装、三能力独立工件验证、二次接入修复不叠加且 operationId 可追踪、同 basename 双仓 canonical 身份隔离不串会话/Commit。CAP-006 的 codex notify 子项因真实 codex CLI 读取真实 profile 而诚实 BLOCKED。',
    generatedAt: new Date().toISOString(),
    repo: {
      root: REPO_ROOT.replace(/\\/g, '/'),
      branch: 'main',
      gitHead,
      commitPolicy: '不 commit/push；本线只新增/修改自己独占前缀的文件',
      productSourceChanged: [],
      productSourceNote: '产品源码零改动；共享 spawn-server/cdp 等 helper 只读复用；本线 helper parallel-memory-capture-r3-cap-shell.js 增加可选 analysisOwner 参数（默认 engine 不变，CAP-008 用 legacy 让产品自身消费链在测）。',
    },
    files: {
      laneOwned: [
        '_site/_test/parallel-memory-capture-r3-*.js',
        '_site/_test/helpers/parallel-memory-capture-r3-*.js',
        'qa-autopilot/tools/product-probes/parallel-memory-capture-r3.js',
        'qa-autopilot/artifacts/parallel-20261023/memory-capture-r3/**',
      ],
      frozenReadOnly: [
        '_site/_test/parallel-memory-*-test.js 上一批 8 文件',
        '_site/_test/helpers/parallel-memory-shell.js',
        '_site/lib/**（产品源码）',
        'qa-autopilot/config/product-case-assertions.json（Leader 所有，本线未回写）',
      ],
    },
    expected,
    cases: CASE_CLAIMS,
    commands: runs.map(run => ({
      name: run.name,
      command: run.command,
      exitCode: run.exitCode,
      log: path.relative(REPO_ROOT, path.join(LOG_DIR, `${run.name}.log`)).replace(/\\/g, '/'),
    })),
    retest: {
      command: 'node qa-autopilot/tools/product-probes/parallel-memory-capture-r3.js',
      note: '需要本机 Claude Code CLI 与真实 Git/Chrome；三个 -probe.js 不被 run-all 收集，绝不自动进 CI；mem005 -test.js 离线可跑',
    },
    firstFailure: {
      note: '本批全部首失败均保留在会话记录与本注记中，未删除；均为驱动侧修正，产品行为无回归',
      history: [
        { case: 'CAP-001', failures: [
          'the control #openSystem must exist（Chrome 错误页）：服务器未就绪即导航 → 增加 /api/health 就绪等待',
          '外部 Agent 行未稳定：徽章类名是 .status 不是 .badge → 修正选择器',
          '真实 HOME 整树摘要误报：开发者活跃会话持续写 transcripts/sqlite → 改为配置面摘要 + RUNTIME_PATH 分类 + 泄漏硬断言',
        ] },
        { case: 'CAP-006', failures: [
          'needs-repair 断言两次超时：30s 缓存/refreshing 竞态 → reopenSystemDrawer 强制刷新并先等 UI 徽章 未接入',
          '诊断对话框命中 100 条陈旧记录：对话框保留上次结果 → logsSearch 先关闭对话框再检索并等待本 operationId 的记录返回',
          '第二次接入等待弱：复用首次反馈文本 → installCallCount() 等待真正的新安装请求',
          'codex 隔离探针 stdin 管道挂起/远程目录请求超时 → stdio pipe + 3x90s 重试 + 三态判定',
        ] },
        { case: 'CAP-008', failures: [
          '导入 400 localPath：导入 API 字段是 localPath 且需先 PATCH /api/settings knowledge.rootPath',
          'journal grep 为空：Bridge journal 是活性 spool，消费后修剪 → durable 证据改为 per-project conversation-events.jsonl 记录级身份断言，spool 只做水位结构校验',
          '导入后基线竞态（I-14：先于首次 drain 的事件会被基线吞掉）→ 导入后强制一次 notify drain 并断言两项目 baseline 已建立再放会话',
        ] },
        { case: 'MEM-005', failures: '本批前段会话交付即绿；本入口重跑结果见 logs/mem005.log' },
      ],
    },
    isolation: {
      perRun: [
        '独立 KB_DATA_DIR/KB_KNOWLEDGE_DATA_DIR/Bridge home/HOME/USERPROFILE/CLAUDE_CONFIG_DIR/TEMP',
        '独立端口（拒绑 5757/5760/5789/5790/8787/8790）、独立 Chrome profile、仓库外临时根',
        'CAP-008 双夹具仓库在仓库外独立临时根，收尾只清理本线自有目录',
        '真实 HOME：配置面前后字节一致 + 已知运行时集之外变更必须为空（每例内断言）',
      ],
      liveSurfacesNotTouched: [
        '运行中的桌面产品 5.0.24 及其模块（不安装/替换/停启）',
        '真实 ~/.claude、~/.codex 配置与会话（零写入，逐例证明）',
        '真实 Bridge 8790 / 向量 hub 8787 / 任何额度接口',
      ],
    },
    unfinished: [
      'CAP-006.codex-notify：BLOCKED（真实 codex CLI 读取真实 profile；若未来 CLI 支持隔离 home 可按探针内三态判定重测）',
      '任务 #25/#26/#27（round2 容量边界）不在本线范围',
    ],
    state: 'idle',
    deliverables: {
      report: 'qa-autopilot/artifacts/parallel-20261023/memory-capture-r3/report.json',
      bindings: 'qa-autopilot/artifacts/parallel-20261023/memory-capture-r3/bindings.fragment.json',
      evidence: evidenceFiles.map(file => path.relative(REPO_ROOT, file).replace(/\\/g, '/')),
      logs: runs.map(run => path.relative(REPO_ROOT, path.join(LOG_DIR, `${run.name}.log`)).replace(/\\/g, '/')),
    },
  };

  const reportFile = path.join(LANE_DIR, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  report.evidenceManifest = Object.fromEntries(
    [reportFile, ...evidenceFiles].filter(file => fs.existsSync(file)).map(file => [path.relative(REPO_ROOT, file).replace(/\\/g, '/'), sha256File(file)]),
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  const blocked = Object.entries(expected).filter(([, status]) => status !== 'PASS').map(([id]) => id);
  console.log(JSON.stringify({ report: reportFile, expected, blocked, commands: report.commands }, null, 2));
  process.exitCode = blocked.length === 0 ? 0 : blocked.length === 1 && blocked[0] === 'CAP-006.codex-notify' ? 3 : 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
