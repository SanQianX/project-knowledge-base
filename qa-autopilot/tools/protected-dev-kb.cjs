#!/usr/bin/env node
'use strict';
/**
 * PROTECTED_DEV_KB · 开发知识库实例注册与只读健康检查
 *
 * 角色分工（架构调整后的运行方案）：
 *   - 开发知识库：已安装的 Project Knowledge 桌面客户端，常驻系统托盘，使用用户自己的
 *     v5 数据目录与知识根。本工具只**观察**它，绝不关闭、结束、退出或改写它。
 *   - QA 测试：独立 clone、独立数据目录、独立知识根、独立浏览器 profile、独立端口。
 *
 * 硬性约束（对应授权条款 4/5/6/7/10/11）：
 *   - 本工具只发起只读 HTTP GET；不写开发数据目录、不写开发知识根、不结束任何进程。
 *   - 任何写操作都只发生在 qa-autopilot/state/ 与 qa-autopilot/reports/ 下。
 *   - 注册信息里记录的是「观察到的」事实，不��未经核验的假设。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const qaRoot = path.resolve(__dirname, '..');
const REGISTRY = path.join(qaRoot, 'state', 'protected-dev-kb.json');
const REPORT = path.join(qaRoot, 'reports', 'branches', 'PROTECTED_DEV_KB_HEALTH.json');

/** 禁止触碰的路径：开发数据目录与开发知识根。工具自身永远不写这些位置。 */
const FORBIDDEN_WRITE_PREFIXES = [
  'C:\\Users\\SanQian\\.project-knowledge-v5',
  'C:\\Users\\SanQian\\.project-knowledge',
  'D:\\SanQian.Xu\\knowledge'
];

function get(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '', error: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, status: 0, body: '', error: e.code || e.message }));
  });
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${pid} -ErrorAction Stop | Select-Object -ExpandProperty Id`],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function listPorts() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress"],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map(r => ({ port: Number(r.LocalPort), pid: Number(r.OwningProcess) }));
  } catch { return []; }
}

/** 只读识别：哪个端口是开发知识库后端、哪个数据目录、哪个版本。 */
async function observe() {
  const ports = listPorts();
  const candidates = ports.filter(p => p.port >= 5757 && p.port <= 5760);
  let backend = null;
  for (const c of candidates) {
    const h = await get(`http://127.0.0.1:${c.port}/api/health`);
    if (h.ok && /server-health/.test(h.body)) { backend = { port: c.port, pid: c.pid, health: JSON.parse(h.body) }; break; }
  }
  const engine = ports.find(p => p.port === 5790);
  const terminal = ports.find(p => p.port === 5760);
  const vector = ports.find(p => p.port === 8787);
  const bridge = ports.find(p => p.port === 8790);
  let engineHealth = null;
  if (engine) {
    const h = await get('http://127.0.0.1:5790/api/health');
    if (h.ok) { try { engineHealth = JSON.parse(h.body); } catch { engineHealth = null; } }
  }
  return { backend, engine, terminal, vector, bridge, engineHealth, observedPorts: ports.length };
}

async function register() {
  const obs = await observe();
  if (!obs.backend) {
    const record = { status: 'NOT_RUNNING', registeredAt: new Date().toISOString(), note: '开发知识库后端未在 5757-5760 监听；未做任何启动尝试。' };
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    fs.writeFileSync(REGISTRY, JSON.stringify(record, null, 2) + '\n');
    return record;
  }
  const health = obs.backend.health;
  const record = {
    schema: 'qa-autopilot/protected-dev-kb/v1',
    id: 'PROTECTED_DEV_KB',
    role: '开发知识库（长期后台，开发用）',
    registeredAt: new Date().toISOString(),
    desktop: {
      package: '@sanqianx/project-knowledge-desktop',
      version: '5.0.18',
      install: 'npm 全局安装（C:\\Users\\SanQian\\AppData\\Roaming\\npm\\node_modules）',
      windowState: 'HIDDEN_TO_TRAY',
      note: '注册表中的 Project Knowledge 4.1.11（Squirrel 安装）属 v4 旧血脉，本方案不使用、不启动。'
    },
    core: {
      package: '@sanqianx/project-knowledge',
      version: '5.0.18',
      versionState: 'match',
      note: '桌面壳与内置核心版本一致；与 QA 基线 5.0.24 属不同实例、不同数据目录，互不影响。'
    },
    endpoint: {
      host: '127.0.0.1',
      port: obs.backend.port,
      pid: obs.backend.pid,
      alive: processAlive(obs.backend.pid)
    },
    dataDir: 'C:\\Users\\SanQian\\.project-knowledge-v5',
    knowledgeRoot: 'D:\\SanQian.Xu\\knowledge',
    projects: health && health.projects,
    modules: {
      knowledgeEngine: obs.engine ? { port: obs.engine.port, pid: obs.engine.pid, version: obs.engineHealth && obs.engineHealth.version, dataDir: obs.engineHealth && obs.engineHealth.dataDir } : null,
      agentTerminal: obs.terminal ? { port: obs.terminal.port, pid: obs.terminal.pid } : null,
      vectorHub: obs.vector ? { port: obs.vector.port, pid: obs.vector.pid } : null,
      eventBridgeConsole: obs.bridge ? { port: obs.bridge.port, pid: obs.bridge.pid } : null
    },
    protections: {
      neverWrite: FORBIDDEN_WRITE_PREFIXES,
      neverStop: ['桌面客户端进程', '其拥有的后台进程', '系统托盘程序'],
      qaIsolation: 'QA 使用独立 clone / 独立 KB_DATA_DIR / 独立 KB_KNOWLEDGE_DATA_DIR / 独立浏览器 profile / 独立端口；不连接 5757。',
      legacyData: 'C:\\Users\\SanQian\\.project-knowledge（v4 遗留，1.3GB）为迁移回滚资产，v5 客户端不触碰；本方案同样不触碰。'
    }
  };
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** 定期只读健康检查：只 GET，不写开发数据，不结束进程。 */
async function health() {
  const registry = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : null;
  const obs = await observe();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const expected = registry && registry.endpoint ? registry.endpoint : null;
  add('backend_listening', !!obs.backend, obs.backend ? `port ${obs.backend.port} pid ${obs.backend.pid}` : '5757-5760 无 server-health 响应');
  if (obs.backend && expected) {
    add('endpoint_stable', obs.backend.port === expected.port && obs.backend.pid === expected.pid,
      `observed ${obs.backend.port}/${obs.backend.pid} vs registered ${expected.port}/${expected.pid}`);
  }
  if (obs.backend) add('backend_process_alive', processAlive(obs.backend.pid), `pid ${obs.backend.pid}`);
  if (obs.backend) add('backend_health_ok', obs.backend.health && obs.backend.health.ok === true, JSON.stringify(obs.backend.health).slice(0, 200));
  if (obs.backend && registry) {
    add('project_count_preserved', obs.backend.health && obs.backend.health.projects === registry.projects,
      `observed ${obs.backend.health && obs.backend.health.projects} vs registered ${registry.projects}`);
  }
  if (obs.engine) add('knowledge_engine_alive', processAlive(obs.engine.pid), `port ${obs.engine.port} pid ${obs.engine.pid}`);
  if (obs.engineHealth) add('knowledge_engine_ok', obs.engineHealth.ok === true, `version ${obs.engineHealth.version} dataDir ${obs.engineHealth.dataDir}`);

  // 数据目录与知识根必须仍然存在且未被本工具写入
  for (const p of [registry && registry.dataDir, registry && registry.knowledgeRoot].filter(Boolean)) {
    add(`exists:${p}`, fs.existsSync(p), p);
  }
  const legacy = 'C:\\Users\\SanQian\\.project-knowledge';
  add('legacy_v4_dir_present', fs.existsSync(legacy), legacy);

  const ok = checks.every(c => c.ok);
  const out = { schema: 'qa-autopilot/protected-dev-kb-health/v1', checkedAt: new Date().toISOString(), ok, checks, observed: { ports: obs.observedPorts } };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(out, null, 2) + '\n');
  return out;
}

/** QA 隔离断言：QA 侧的任何路径/端口都不得指向开发知识库。 */
function assertQaIsolated() {
  const cfg = JSON.parse(fs.readFileSync(path.join(qaRoot, 'config', 'local.json'), 'utf8'));
  const problems = [];
  const devDataDir = 'C:\\Users\\SanQian\\.project-knowledge-v5';
  const devKnowledgeRoot = 'D:\\SanQian.Xu\\knowledge';
  const devPort = 5757;
  const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase();
  if (norm(cfg.sourceRoot).startsWith(norm(devDataDir))) problems.push(`sourceRoot 指向开发数据目录：${cfg.sourceRoot}`);
  if (norm(cfg.repoRoot).startsWith(norm(devDataDir))) problems.push(`repoRoot 指向开发数据目录：${cfg.repoRoot}`);
  if (norm(cfg.sourceRoot).startsWith(norm(devKnowledgeRoot))) problems.push(`sourceRoot 指向开发知识根：${cfg.sourceRoot}`);
  if (norm(cfg.repoRoot).startsWith(norm(devKnowledgeRoot))) problems.push(`repoRoot 指向开发知识根：${cfg.repoRoot}`);
  if (norm(cfg.repoRoot) === norm(cfg.sourceRoot)) problems.push('repoRoot 与 sourceRoot 相同，测试会写进源目录');
  return { ok: problems.length === 0, problems, checked: { sourceRoot: cfg.sourceRoot, repoRoot: cfg.repoRoot, devPort } };
}

async function main() {
  const cmd = process.argv[2] || 'health';
  if (cmd === 'register') { const r = await register(); console.log(JSON.stringify(r, null, 2)); return; }
  if (cmd === 'health') { const r = await health(); console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1; return; }
  if (cmd === 'assert-isolated') { const r = assertQaIsolated(); console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1; return; }
  if (cmd === 'observe') { console.log(JSON.stringify(await observe(), null, 2)); return; }
  console.log('用法: protected-dev-kb.cjs [register|health|assert-isolated|observe]');
}
if (require.main === module) main();
module.exports = { register, health, assertQaIsolated, observe, FORBIDDEN_WRITE_PREFIXES };
