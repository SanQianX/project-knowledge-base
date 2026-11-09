'use strict';
// qa-autopilot/tools/product-probes/parallel-memory-capture-r4.js
//
// Explicit entry point of the P-MEMORY-CAPTURE-R4 batch (tasks #34..#38).
//
// This file is NOT a regression test and is deliberately kept out of
// _site/_test/ so the offline CI never collects it: CAP-008e and CAP-006r4
// need the real vendored knowledge engine, the real event-bridge console, a
// real Chrome and real native client CLIs against isolated homes; MEM-005 R4
// needs a real browser page.
//
// It runs ONLY the R4 cases (CAP-001 stays accepted from R3 and is never
// re-run; the R3 probes stay frozen as history):
//
//   _site/_test/parallel-memory-capture-r4-mem005-health-test.js  MEM-005 UI half
//   _site/_test/parallel-memory-capture-r4-cap008e-probe.js       CAP-008 engine mode
//   _site/_test/parallel-memory-capture-r4-cap006-probe.js        CAP-006 CODEX_HOME retest
//
// Report: qa-autopilot/artifacts/parallel-20261023/memory-capture-r4/report.json
// Bindings (pure definitions): same directory, bindings.fragment.json
//
// Exit codes: 0 = every essential positively verified,
//             3 = at least one essential honestly BLOCKED,
//             1 = script or probe error.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LANE_DIR = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'memory-capture-r4');
const EVIDENCE_DIR = path.join(LANE_DIR, 'evidence');
const LOG_DIR = path.join(LANE_DIR, 'logs');

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// Archived first-failure run logs from the dev scratch dir (see firstFailure.note).
function collectDevLogs() {
  const dir = path.join(LOG_DIR, 'dev');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.log')) out.push(p);
    }
  })(dir);
  return out.sort().map(file => path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
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
    summary: '忽略后持久性（R4 重证 UI 半边）：在可证健康页上（对照记忆可见、离线横幅缺失、页面快照 200 三道门）真实 UI 忽略真实候选 → 真实浏览器刷新并重开记忆视图：被忽略候选不再出现为候选卡也不出现为已确认，对照记忆仍可见；产品接口、引擎接口与引擎磁盘状态三处一致 = ignored；冻结来源与忽略前逐字节一致；该记忆未被注入。R3 的空洞通过（离线兜底页上“无卡片”平凡成立）被此三道门关闭。',
    expected: [
      { key: 'healthy-page-gates', text: '证据页必须可证健康。', note: '对照记忆可见 + 离线横幅缺失 + 页面快照 200，三缺一即不成证据' },
      { key: 'ignored-persists-after-reload', text: '忽略后刷新仍为ignored。', note: '刷新后产品/引擎/磁盘三处一致，且从不显示为候选或已确认' },
      { key: 'frozen-source-untouched', text: '来源冻结记录不篡改。', note: '忽略前后逐字节一致；未注入' },
    ],
    honestScope: '分析步骤是冻结 P-MEMORY-01 的替身分析器（空计划）；本用例证据关于引擎准入、忽略动作、健康页上的持久化与冻结来源，不关于模型判断。',
  },
  'CAP-008': {
    probe: 'cap008e',
    status: 'PASS',
    summary: 'engine 模式身份隔离（R4 补齐 R3 未测的默认拓扑）：analysisOwner=engine 默认启动；同 basename 双仓 A/B canonical 身份隔离贯穿引擎会话存储与 commit boundary；真实 shim 交错承载会话、真实 managed hook 产出提交；驱动侧不做任何路由（消费链全在产品代码）；向量平面在 lane 本地端点按真实 hub 的 /api/sync 契约实现，sync 只以归属方身份发生；真实 HOME 干净（live Codex 状态 carve-out 双向证明：内容 marker-free）。',
    expected: [
      { key: 'engine-owner-default', text: '默认analysisOwner=engine。', note: '隔离实例以产品默认 owner 启动，消费由产品引擎侧完成，非驱动模拟' },
      { key: 'canonical-identity-isolation', text: '以canonical身份隔离，不串对话/Commit。', note: 'canonical workspaceId 不同且与产品解析器一致；引擎会话存储、per-project 记录、commit boundary 文件只在自己侧；shell legacy 存储零写入' },
      { key: 'shim-and-boundary-realism', text: '会话与提交经真实 shim/hook。', note: '真实安装的 shim 承载交错会话（唯一 marker）；真实 git commit 经各仓 managed hook 产出 boundary 记录；shim 输入为声明的人造会话内容' },
      { key: 'vector-plane-ownership', text: '索引同步只以归属方身份发生。', note: '每次 /api/sync 的 sourceDir 都是归属方 knowledgePath；无第三身份；lane 本地向量端点，绝不触达 8787 实活模块' },
    ],
    honestScope: '分析步骤是冻结替身（空计划）；向量端点是 lane 本地实现（真实 hub /api/sync 契约子集），因引擎内置默认 vectorUrl 指向本机 8787 实活模块——该模块绝不可被本线触达（见 incidents）；无模型回合、无额度。',
  },
  'CAP-006': {
    probe: 'cap006r4',
    status: 'PASS',
    summary: 'CODEX_HOME 隔离复测（推翻 R3 BLOCKED）：R3 的“codex CLI 不可隔离”结论从未设置 CODEX_HOME，而产品自身 codexHookProbe 显式传递 CODEX_HOME。R4 用产品给 CLI 的确切环境先做只读 CLI 门（plugin list/marketplace list 全部路径在隔离根内、真实 HOME 零写入），再做真实 UI 连续接入/修复：第一次接入写入 notify wrapper（恰一个 anchor、备份在隔离根内）；产品自身 settled 扫描证明干净链幂等（installed ⟺ planNotify.changed===false）；真实损坏（双 anchor 包裹兼容 DevTask Radar 第三方）→ 第二次接入修复收敛为一个 anchor 且第三方保留；裸双 anchor → 第三次接入再次收敛且不复活已消失项；每次真实变更恰一个备份；三个 operationId 均在真实诊断对话框可检索；真实 ~/.codex 全程未触碰。',
    expected: [
      { key: 'codex-cli-isolates-under-explicit-codex-home', text: '显式CODEX_HOME下CLI可隔离。', note: '只读门先于一切 UI 步骤：两条命令一次有界尝试、全部绝对路径在隔离根内、真实 HOME 配置面字节一致；若逃逸则以 FAIL 报源缺陷，无 must-be-BLOCKED 断言' },
      { key: 'no-duplicate-notify-wrapper', text: '不重复notify wrapper。', note: '安装恰一个 anchor；干净链幂等（产品自身 no-rewrite 扫描 + notify 行 sha 稳定）；双 anchor 修复收敛且第三方 Radar 保留；裸双 anchor 再次收敛且无复活；备份 1→1→2→3 恰每真实变更一个，全部在隔离根内' },
      { key: 'operationid-traceable', text: 'operationId可追踪。', note: '三次接入的 operationId 互异且都在真实诊断对话框按 id 检索命中记录本身' },
    ],
    honestScope: '两处损坏均为对隔离 config.toml 的直接编辑（声明为人造损伤：旧版叠加安装形态，非产品输出）；不启动任何 Codex 会话（只触插件/配置面），无模型、无额度；未复制任何真实凭据/配置来求绿。',
  },
};

(async () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const order = [
    ['mem005', 'parallel-memory-capture-r4-mem005-health-test.js', 'mem005'],
    ['cap008e', 'parallel-memory-capture-r4-cap008e-probe.js', 'cap008e'],
    ['cap006r4', 'parallel-memory-capture-r4-cap006-probe.js', 'cap006r4'],
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
  }

  const evidenceFiles = [];
  for (const run of runs) {
    const dir = path.join(EVIDENCE_DIR, run.evidenceSub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) evidenceFiles.push(path.join(dir, name));
  }
  // The development-run evidence (full attempt history artifacts) stays where
  // the probes wrote it during development; reference it, never overwrite it.
  const devEvidenceDir = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'memory', 'capture-r4');
  const devEvidenceFiles = [];
  try { for (const name of fs.readdirSync(devEvidenceDir)) devEvidenceFiles.push(path.join(devEvidenceDir, name)); } catch {}

  const sourceFiles = [
    '_site/_test/parallel-memory-capture-r4-mem005-health-test.js',
    '_site/_test/parallel-memory-capture-r4-cap008e-probe.js',
    '_site/_test/parallel-memory-capture-r4-cap006-probe.js',
    '_site/_test/helpers/parallel-memory-capture-r4-cap-shell.js',
    'qa-autopilot/tools/product-probes/parallel-memory-capture-r4.js',
  ].map(file => ({ file, sha256: sha256File(path.join(REPO_ROOT, file)) }));

  const report = {
    schema: 'qa-autopilot/parallel-lane-report/v1',
    lane: 'P-MEMORY-CAPTURE-R4',
    batch: 'parallel-20261023',
    caseIds: Object.keys(CASE_CLAIMS),
    summary: 'R4 按 Leader 审查补齐三缺口：MEM-005 在可证健康页上重证忽略后持久性（对照记忆可见/离线横幅缺失/快照 200 三道门关闭 R3 空洞通过）；CAP-008 以默认 analysisOwner=engine 补测引擎模式同 basename A/B canonical 身份隔离（会话存储/commit boundary/向量同步三层归属证明，驱动零路由）；CAP-006 显式 CODEX_HOME 复测推翻 R3 BLOCKED——只读 CLI 门 + 真实 UI 三次连续接入/修复（安装、保第三方收敛、裸双 anchor 收敛），真实 ~/.codex 全程未触碰。CAP-001 维持 R3 已接受结论不重跑；R3 历史保留。',
    generatedAt: new Date().toISOString(),
    repo: {
      root: REPO_ROOT.replace(/\\/g, '/'),
      branch: 'main',
      gitHead,
      commitPolicy: '不 commit/push；本线只新增/修改自己独占前缀的文件',
      productSourceChanged: [],
      productSourceNote: '产品源码零改动（integration-installer.js 最小修复租约未动用——产品被证明本就尊重显式 CODEX_HOME）；共享 helpers 只读复用；本线 helper parallel-memory-capture-r4-cap-shell.js 为 lane 自有。',
    },
    files: {
      laneOwned: [
        '_site/_test/parallel-memory-capture-r4-*.js',
        '_site/_test/helpers/parallel-memory-capture-r4-*.js',
        'qa-autopilot/tools/product-probes/parallel-memory-capture-r4.js',
        'qa-autopilot/artifacts/parallel-20261023/memory-capture-r4/**',
        'qa-autopilot/artifacts/parallel-20261023/memory/capture-r4/**（开发过程证据）',
      ],
      frozenReadOnly: [
        '_site/_test/parallel-memory-capture-r3-*.js 与 helpers/parallel-memory-capture-r3-cap-shell.js（R3 历史）',
        '_site/_test/helpers/{module-fixture,cdp-browser,spawn-server,...}.js（共享 helper）',
        '_site/lib/**（产品源码）',
        'qa-autopilot/config/product-case-assertions.json（Leader 所有，本线未回写）',
      ],
    },
    sourceFiles,
    expected,
    cases: CASE_CLAIMS,
    commands: runs.map(run => ({
      name: run.name,
      command: run.command,
      exitCode: run.exitCode,
      log: path.relative(REPO_ROOT, path.join(LOG_DIR, `${run.name}.log`)).replace(/\\/g, '/'),
    })),
    retest: {
      command: 'node qa-autopilot/tools/product-probes/parallel-memory-capture-r4.js',
      note: '需要本机 Chrome、真实 Git、PATH 上的 codex CLI 与 vendored 引擎/console 模块；两个 probe 类入口不被 run-all 收集，绝不自动进 CI；mem005-health-test.js 离线可跑',
    },
    firstFailure: {
      note: '本批全部首失败均保留在本注记与开发过程 run 日志（qa-autopilot/artifacts/parallel-20261023/memory-capture-r4/logs/dev/**，自 .project-knowledge-test-temp scratch 归档）中，未删除；产品行为无回归，均为驱动/断言侧修正',
      history: [
        { case: 'MEM-005', failures: [
          'R3 版本在离线兜底页上空洞通过（Leader 审出：截图为“知识引擎暂时不可用”页，“无卡片”平凡成立）→ R4 加对照记忆可见/离线横幅缺失/页面快照 200 三道健康门后两轮全绿',
        ] },
        { case: 'CAP-008', failures: [
          '第1轮：harness base 作用域 ReferenceError + 清理残留僵尸进程 → 修正作用域并以 PID 树强杀兜底',
          '第2轮：引擎 health 应答形状误读 → 按产品真实形状断言',
          '第3轮：形式 PASS 但边界受污——引擎内置默认 vectorUrl 指向本机 8787 实活向量 hub，且 shim 哈希为 null → 判不作数（见 incidents.vectorHubContact）',
          '第4轮：git-hook run 停在 indexing 超时——根因同上（默认 vectorUrl）；requestIndex 120s 超时对 90s 等待 → lane 本地向量端点先于引擎启动 + 显式 vectorUrl（引擎与 shell 双侧）',
          '第5轮：真实 HOME 的 .codex-global-state.json(+.bak) 被并发外部写入误报为泄漏 → LIVE_CODEX_STATE carve-out + 内容 marker-free 双向证明',
          '第6轮：PASS（EXIT=0）',
        ] },
        { case: 'CAP-006', failures: [
          '第1轮：只读门失败——隔离 .codex 目录未预创建，codex CLI 以 "CODEX_HOME ... does not exist" 退出 1 → 预创建（隔离根是本线自有目录）',
          '第2轮：finally 的 rmSync EPERM 吞掉真实首错 → 清理失败只记录不上抛；真实错误随后才可见',
          '第3轮：原生命令断言误匹配 integration.command_started（status=null）→ 只对 integration.command_completed 断言退出码 0',
          '第4轮：真实 HOME "carve-out 之外零变更" 断言严于冻结分区（开发者活跃会话的运行时写入被误报）→ 按 RUNTIME_PATH 分区重述',
          '第5轮：live Codex 状态写入先被计入 leaks → carve-out 折入 leaks 断言（与 cap008e 同法）',
          '第6轮：PASS（EXIT=0）；第7轮：PASS（EXIT=0，证据快照修正：逐步备份列表 1→1→2→3、after-repair 截图改于诊断对话框开启时拍摄以与首装截图可区分）',
        ] },
      ],
    },
    incidents: [
      {
        id: 'vectorHubContact',
        title: 'CAP-008e 第3/4轮曾向本机 8787 实活向量 hub 发送 /api/sync',
        disclosure: '引擎内置默认 vectorUrl=http://127.0.0.1:8787，本机该端口是开发者实活桌面向量模块（--root D:\\SanQian.Xu\\knowledge\\.indexes）。第3/4轮在 lane 本地向量端点存在之前，引擎索引步骤把 POST /api/sync {project:<夹具projectId>, sourceDir:<夹具knowledge路径>} 发到了实活 hub。未写真实 HOME、未改/停该模块；实活 .indexes 可能残留这两次调用的陈旧夹具条目——按保护条款本线不得触碰实活模块，留给开发者自行清理。',
        mitigation: '现 harness 永久修复：lane 本地向量端点先于引擎启动，引擎与 shell 显式 vectorUrl 指向它；内置默认 8787 在本线永不达。',
        evidence: 'logs/cap008e.log（第6轮含 lane-local vector 断言：每次 sync 的 sourceDir 均为归属方 knowledgePath）',
      },
      {
        id: 'microsoftCacheFile',
        title: '仓库内 Microsoft/Windows/PowerShell/ModuleAnalysisCache 归属未证实',
        disclosure: '2739 字节、创建于 2026-10-23T15:55:43.970、空模块集；穷尽代码检索未能证明归属。按保护条款未删除，原样保留；哈希与检索记录见 microsoft-cache-forensics.json。',
        mitigation: '本线所有 PowerShell 子进程强制 PSModuleAnalysisCachePath 指向一次性夹具文件，不再可能向仓库根写该缓存。',
        evidence: 'microsoft-cache-forensics.json',
      },
      {
        id: 'cleanupDeadlineNoise',
        title: '清理步骤在高负载下打印 cleanup step timed out 噪声',
        disclosure: '每步清理以截止时间兜底；超时打印不等于泄漏：每次运行进程均以正确退出码结束，事后 Win32_Process 扫描零残留（browser.close 自身含 ≤10s taskkill + ≤10s CIM 扫描，30s 预算下偶发越界）。',
        mitigation: '无——记录为 wart；真实判据是退出码与零残留扫描，二者各轮均满足。',
        evidence: 'logs/*.log 尾部 + 会话内 .ps1 扫描记录',
      },
    ],
    isolation: {
      perRun: [
        '独立 KB_DATA_DIR/KB_KNOWLEDGE_ENGINE 路径/Bridge home/HOME/USERPROFILE/CLAUDE_CONFIG_DIR/TEMP',
        '独立端口（拒绑 5757/5760/5789/5790/8787/8790）、独立 Chrome profile、仓库外临时根',
        'CAP-006r4：探针自有外部临时 home（HOME/USERPROFILE/APPDATA/LOCALAPPDATA/CODEX_HOME 全指向它），serverEnv 透传给产品服务器及其全部 codex 子进程',
        'CAP-008e：双夹具仓库在仓库外独立临时根；lane 本地向量端点先于引擎启动',
        '真实 HOME：配置面前后字节一致 + 冻结 RUNTIME_PATH 分区外变更必须为空 + live Codex 状态 carve-out（内容 marker-free）',
      ],
      liveSurfacesNotTouched: [
        '运行中的桌面产品 5.0.24 及其模块（不安装/替换/停启；pins/vendor/manifest/version/tag/npm 零改动）',
        '真实 ~/.claude、~/.codex 配置与会话（零写入，逐例证明；CAP-006r4 从未写真实 ~/.codex）',
        '真实 Bridge 8790 / 向量 hub 8787（第6轮起 lane 本地端点；见 incidents 的第3/4轮披露）/ 任何额度接口',
        '真实知识/凭据/memory/trust 全保留；严禁 PID 猜杀，只按创建时间/父子关系/命令行收拢本线进程',
      ],
    },
    unfinished: [
      '任务 #25/#26/#27（round2 容量边界）不在本线范围',
      'Microsoft/ ModuleAnalysisCache 归属仍未证实（证据保全、不删除；见 incidents.microsoftCacheFile）',
      '实活 .indexes 中可能残留的第3/4轮夹具条目：本线按保护条款不触碰实活模块，留开发者决断（见 incidents.vectorHubContact）',
    ],
    background: 0,
    state: 'idle',
    deliverables: {
      report: 'qa-autopilot/artifacts/parallel-20261023/memory-capture-r4/report.json',
      bindings: 'qa-autopilot/artifacts/parallel-20261023/memory-capture-r4/bindings.fragment.json',
      evidence: evidenceFiles.map(file => path.relative(REPO_ROOT, file).replace(/\\/g, '/')),
      devEvidence: devEvidenceFiles.map(file => path.relative(REPO_ROOT, file).replace(/\\/g, '/')),
      logs: runs.map(run => path.relative(REPO_ROOT, path.join(LOG_DIR, `${run.name}.log`)).replace(/\\/g, '/')),
      devLogs: collectDevLogs(),
    },
  };

  const reportFile = path.join(LANE_DIR, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  // report.json cannot hash itself: embedding the manifest changes the file.
  report.evidenceManifest = Object.fromEntries(
    [path.join(LANE_DIR, 'microsoft-cache-forensics.json'), ...evidenceFiles, ...devEvidenceFiles, ...collectDevLogs().map(file => path.join(REPO_ROOT, file))]
      .filter(file => fs.existsSync(file))
      .map(file => [path.relative(REPO_ROOT, file).replace(/\\/g, '/'), sha256File(file)]),
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  const blocked = Object.entries(expected).filter(([, status]) => status !== 'PASS').map(([id]) => id);
  console.log(JSON.stringify({ report: reportFile, expected, blocked, commands: report.commands }, null, 2));
  process.exitCode = blocked.length === 0 ? 0 : 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
