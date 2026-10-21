#!/usr/bin/env node
'use strict';
/**
 * T03-OVERNIGHT · 真实 ZCode Worker 适配器
 *
 * 把 QA 控制包既有的 pkb-qa-task/v1 协议桥接到本机真实的 ZCode CLI：
 *   node <ZCode>/resources/glm/zcode.cjs --prompt <text> --cwd <dir> --surface terminal
 *        --mode yolo --disallowed-tools <tools> --no-color --json [--resume <sessionId>]
 *
 * 关键安全属性：
 *   - 影子 HOME：只带 provider 配置，不带 UserPromptSubmit hook —— QA 合成对话绝不进入开发知识库
 *   - 订阅 Key：从 ZCode 自己的 provider 配置读取，只注入子进程环境，不落盘、不写日志
 *   - 默认禁用 Bash：Worker 只能读写文件，不能执行 shell/git
 *   - 额度耗尽由 ZCode 的 quota_exceeded / coding_plan_required 错误码识别，回报 PAUSED_QUOTA
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJSON, atomicJSON, redact, must } = require('../lib/safety.cjs');

const PROVIDER_CONFIG = 'C:/Users/SanQian/.zcode/v2/provider_config.json';
const ROLLOUT_DIR = 'C:/Users/SanQian/.zcode/cli/rollout';
const QUOTA_CODES = ['quota_exceeded', 'coding_plan_required', 'coding_plan_security_verification_required'];

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { data += d; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** 从 ZCode provider 配置取同一个 MiniMax 订阅 Key（绝不打印、绝不落盘）。 */
function subscriptionKey() {
  const j = readJSON(PROVIDER_CONFIG);
  const rule = (j.config.providerConfigRules.providerRules || []).find(r => r.providerId === 'minimax');
  must(rule && rule.config && rule.config.access && rule.config.access.apiKey, 'WORKER_CREDENTIAL_MISSING', 'ZCode MiniMax provider credential not found.', 20);
  const key = String(rule.config.access.apiKey);
  must(!key.startsWith('sk-api-'), 'WORKER_PAYG_FORBIDDEN', 'A pay-as-you-go key cannot drive the overnight worker; a subscription key is required.', 20);
  return { key, group: rule.config.group, models: rule.config.personalModelIds || [] };
}

/** 影子 HOME：provider 配置可见，hook 不可见。 */
function shadowHome(runtimeDir, cfg) {
  // 影子 HOME 只保留两样东西：
  //   1) v2/provider_config.json —— MiniMax provider（Worker 实际用的就是它）
  //   2) cli/config.json —— 剥离 hooks，保证 QA 合成对话不进入开发知识库
  // 不要创建 .zcode/v2：一旦存在，CLI 会转而解析内建 provider（zcode-builtin.json），
  // 在影子环境下必然失败（"无法定位 CLI ZCode Built-in Provider Config"）。
  // 也不要复制 Z.AI/BigModel 的 credentials.json / setting.json：同样会触发内建 provider 解析。
  const home = path.join(runtimeDir, 'worker-home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'v2'), { recursive: true });
  fs.mkdirSync(path.join(home, 'cli'), { recursive: true });
  fs.copyFileSync(PROVIDER_CONFIG, path.join(home, 'v2', 'provider_config.json'));
  // 内建 provider 的运行期解析结果也复制一份到影子，供 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向。
  const builtin = (cfg.worker && cfg.worker.zcodeEnv && cfg.worker.zcodeEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) || process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  if (builtin && fs.existsSync(builtin)) {
    fs.copyFileSync(builtin, path.join(home, 'v2', 'builtin-provider.json'));
  }
  fs.writeFileSync(path.join(home, 'cli', 'config.json'), JSON.stringify({
    hooks: { events: {} },
    note: 'QA overnight worker shadow HOME: MiniMax provider only, no UserPromptSubmit hook, so QA synthetic conversations never reach the development knowledge base.'
  }, null, 2));
  return home;
}

/** 合同 -> Worker 提示词。合同是唯一事实来源，模型不自行发明需求。 */
function buildPrompt(contract) {
  const lines = [];
  lines.push('你是一个在隔离 QA 工作副本中执行测试覆盖补齐任务的工程 Agent。');
  lines.push('');
  lines.push('任务编号：' + (contract.bugId || 'UNSPECIFIED'));
  lines.push('任务摘要：' + (contract.summary || ''));
  lines.push('');
  lines.push('期望行为（唯一验收依据）：');
  for (const e of contract.expectedBehaviorList || []) lines.push('  - ' + e);
  if (contract.sourceEvidence && contract.sourceEvidence.length) {
    lines.push('');
    lines.push('来源证据：');
    for (const s of contract.sourceEvidence) lines.push('  - ' + s);
  }
  if (contract.allowedFiles && contract.allowedFiles.length) {
    lines.push('');
    lines.push('只允许修改这些文件：');
    for (const f of contract.allowedFiles) lines.push('  - ' + f);
    lines.push('不得创建清单之外的新文件，不得修改清单之外的文件。');
  }
  lines.push('');
  lines.push('完成后必须实际运行相关测试并把结果写进你的回复。回复里必须包含：改了哪些文件、运行了哪些命令、退出码、测试输出摘要。');
  lines.push('不要执行任何 shell 命令（工具已禁用）。不要执行 git。不要访问工作目录之外的路径。');
  return lines.join('\n');
}

function runCli(opts) {
  return new Promise(resolve => {
    const child = spawn(opts.executable, opts.args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, signal: null, out, err: err + String(e.message) }); });
  });
}

(async () => {
  const raw = await readStdin();
  const request = raw.trim() ? JSON.parse(raw) : readJSON(process.env.QA_REQUEST_FILE);
  must(request && request.protocol === 'pkb-qa-task/v1', 'WORKER_PROTOCOL', 'Expected a pkb-qa-task/v1 request.', 20);
  const cfg = readJSON(process.env.QA_CONFIG || path.resolve(__dirname, '../config/local.json'));
  const contract = request.contract || {};
  const runtimeDir = process.env.QA_RUNTIME_DIR || path.join(cfg.qaRoot, '.runtime');
  const home = shadowHome(runtimeDir, cfg);
  const { key, group } = subscriptionKey();

  const zcodeCli = cfg.worker.zcodeCli || 'D:/Program Files (x86)/ZCode/resources/glm/zcode.cjs';
  must(fs.existsSync(zcodeCli), 'WORKER_CLI_MISSING', 'ZCode CLI not found at the configured path.', 20);
  const nodeExe = cfg.tools.node || process.execPath;
  const disallowed = (cfg.worker.disallowedTools || ['Bash']).join(' ');

  const args = [zcodeCli, '--prompt', buildPrompt(contract),
    '--cwd', String(request.sourceRoot || cfg.repoRoot),
    '--surface', 'terminal',
    '--mode', cfg.worker.mode || 'yolo',
    '--disallowed-tools', disallowed,
    '--no-color', '--json'];
  if (request.resume && request.resume.sessionId) args.push('--resume', request.resume.sessionId);

  // ZCode CLI 用 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE / ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  // 定位 provider 配置；isolatedEnv 会丢掉这些变量，必须显式指向影子副本，
  // 否则 CLI 会回退去安装目录里找并直接失败。
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, MINIMAX_API_KEY: key, CI: '1', FORCE_COLOR: '0' };
  const zcodeEnv = (cfg.worker && cfg.worker.zcodeEnv) || {};
  for (const [k, v] of Object.entries(zcodeEnv)) {
    if (typeof v === 'string' && v) env[k] = v;
  }
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(home, 'v2', 'provider_config.json');
  const shadowBuiltin = path.join(home, 'v2', 'builtin-provider.json');
  if (fs.existsSync(shadowBuiltin)) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = shadowBuiltin;
  // 无头 Worker 不要注入桌面上下文提示（另一条潜在的开发库耦合）。
  env.ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED = '0';

  const started = Date.now();
  const r = await runCli({ executable: nodeExe, args, cwd: String(request.sourceRoot || cfg.repoRoot), env, timeoutMs: cfg.worker.taskTimeoutMs || 900000 });
  const durationMs = Date.now() - started;

  // 额度耗尽：ZCode 把 quota_exceeded / coding_plan_required 暴露为已知错误码
  const combined = r.out + '\n' + r.err;
  const quotaHit = QUOTA_CODES.find(code => combined.includes(code));

  let parsed = null;
  try { parsed = JSON.parse(r.out.trim().split(/\n(?=\{)/).filter(Boolean).pop() || ''); } catch { parsed = null; }

  const response = {
    protocol: 'pkb-qa-task/v1',
    taskId: request.id,
    status: 'DONE',
    safeBoundary: false,
    checkpoint: null,
    worker: {
      kind: 'zcode-cli',
      version: '0.16.9',
      surface: 'terminal',
      mode: cfg.worker.mode || 'yolo',
      disallowedTools: cfg.worker.disallowedTools || ['Bash'],
      shadowHome: path.relative(cfg.qaRoot, home).replace(/\\/g, '/'),
      subscriptionGroup: group
    },
    exitCode: r.code,
    signal: r.signal,
    durationMs
  };

  if (quotaHit) {
    response.status = 'PAUSED_QUOTA';
    response.safeBoundary = true;
    response.quota = { reason: 'PROVIDER_QUOTA_SIGNAL', code: quotaHit };
  } else if (r.code !== 0) {
    response.status = 'FAILED';
    response.error = { code: 'WORKER_EXIT', exitCode: r.code, signal: r.signal, stderrTail: redact(r.err.slice(-1200)) };
    response.diagnostics = {
      cwd: String(request.sourceRoot || cfg.repoRoot),
      home,
      homeExists: fs.existsSync(home),
      homeV2: fs.existsSync(path.join(home, 'v2')) ? fs.readdirSync(path.join(home, 'v2')) : null,
      homeDotZcode: fs.existsSync(path.join(home, '.zcode')),
      cliPath: zcodeCli,
      nodeExe,
      argsShape: args.map((a, i) => i === 1 ? '<prompt>' : (a.length > 60 ? a.slice(0, 60) + '…' : a)),
      envKeys: Object.keys(env).filter(k => !/KEY|TOKEN|SECRET|AUTH/i.test(k)).sort()
    };
  }

  if (parsed && parsed.sessionId) {
    response.sessionId = parsed.sessionId;
    response.traceId = parsed.traceId;
    response.turnId = parsed.turnId;
    response.usage = parsed.usage;
    response.projection = parsed.projection;
    response.text = parsed.response;
    // 模型身份：以 provider 流量为准，不采信模型自述
    // 影子 HOME 会把 rollout 写进影子目录；两处都查。
    const rolloutCandidates = [path.join(home, '.zcode', 'cli', 'rollout', 'model-io-' + parsed.sessionId + '.jsonl'), path.join(home, 'cli', 'rollout', 'model-io-' + parsed.sessionId + '.jsonl'), path.join(ROLLOUT_DIR, 'model-io-' + parsed.sessionId + '.jsonl')];
    const rollout = rolloutCandidates.find(f => fs.existsSync(f));
    if (rollout) {
      try {
        const models = new Set();
        for (const line of fs.readFileSync(rollout, 'utf8').split(/\r?\n/).filter(Boolean)) {
          for (const m of line.matchAll(/"model"\s*:\s*"([^"]+)"/g)) models.add(m[1]);
        }
        response.modelObserved = [...models];
      } catch { /* 证据缺失不猜测 */ }
    }
  } else if (response.status === 'DONE') {
    response.status = 'FAILED';
    response.error = { code: 'WORKER_NO_RESULT', stderrTail: redact(r.err.slice(-1200)) };
  }

  const outFile = process.env.QA_RESULT_FILE;
  must(outFile, 'WORKER_RESULT_PATH', 'QA_RESULT_FILE is required.', 20);
  atomicJSON(outFile, response);
  process.exitCode = response.status === 'DONE' ? 0 : (response.status === 'PAUSED_QUOTA' ? 75 : 1);
})().catch(e => {
  const outFile = process.env.QA_RESULT_FILE;
  const body = { protocol: 'pkb-qa-task/v1', taskId: 'unknown', status: 'FAILED', safeBoundary: false, error: { code: e.code || 'WORKER_ERROR', message: redact(e.message) } };
  if (outFile) { try { atomicJSON(outFile, body); } catch { } }
  console.error(redact(e.message));
  process.exitCode = 1;
});
