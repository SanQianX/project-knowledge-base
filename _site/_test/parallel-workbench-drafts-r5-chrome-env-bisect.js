'use strict';
// P-WB-DRAFTS-R5 诊断（首失败归因，不接触产品/真实安装）：
// 第一次 R5 复测在 open-browser 阻塞——Chrome 以隔离 env 启动后拒绝开放
// remote debugging（stderr: "DevTools remote debugging requires a non-default
// data directory" / "Can't retrieve app data directory"），DevToolsActivePort
// 一直不出现。本脚本用与 cdp-browser 完全相同的 flag 逐组叠加隔离变量，
// 找出导致该拒绝的具体环境变量。每组一个全新临时 profile（位于共享 temp
// root 下），超时 25s，结束即杀进程树并清理 profile。
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { findChromeDetailed } = require('./helpers/find-chrome');

const chrome = findChromeDetailed().path;
const TEMP_ROOT = 'D:/SanQian.Xu/.project-knowledge-test-temp';
const baseDir = fs.mkdtempSync(path.join(TEMP_ROOT, 'r5-chrome-bisect-'));
const parsed = path.parse(baseDir);
const iso = {
  APPDATA: path.join(baseDir, 'appdata'),
  LOCALAPPDATA: path.join(baseDir, 'localappdata'),
  TEMP: path.join(baseDir, 'temp'),
  TMP: path.join(baseDir, 'temp'),
  TMPDIR: path.join(baseDir, 'temp'),
  HOME: path.join(baseDir, 'home'),
  USERPROFILE: path.join(baseDir, 'home'),
  HOMEDRIVE: parsed.root,
  HOMEPATH: baseDir.slice(parsed.root.length),
  CODEX_HOME: path.join(baseDir, 'codex-home'),
  CLAUDE_CONFIG_DIR: path.join(baseDir, 'claude-config'),
};
for (const dir of new Set(Object.values(iso))) {
  if (path.resolve(dir) !== path.parse(dir).root) fs.mkdirSync(dir, { recursive: true });
}

const GROUPS = {
  'S11-full-prefixed-appdata-elsewhere-datadir': Object.keys(iso),
};

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function tryScenario(name, keys, shapedDataDir = false) {
  // S11: 预先在隔离 home 里造出 %USERPROFILE%\AppData\Local\Google\Chrome\User Data
  // 目录结构（空），但把实际 --user-data-dir 放在别处 —— 检验 gate 是否只因
  // default 解析失败而拒绝。
  const defaultShaped = path.join(iso.USERPROFILE, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  fs.mkdirSync(defaultShaped, { recursive: true });
  let profileDir = path.join(baseDir, `profile-${name}`);
  if (shapedDataDir) {
    profileDir = defaultShaped;
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const env = { ...process.env };
  for (const key of keys) env[key] = iso[key];
  const stderr = [];
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-background-networking',
    '--disable-default-apps', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`, '--window-size=1360,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
  child.stderr.on('data', chunk => { stderr.push(String(chunk)); });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 25000;
  let port = null;
  while (Date.now() < deadline && child.exitCode === null && !port) {
    try {
      const text = fs.readFileSync(portFile, 'utf8');
      const parsedPort = Number.parseInt(String(text).split(/\r?\n/, 1)[0], 10);
      if (Number.isInteger(parsedPort) && parsedPort > 0) port = parsedPort;
    } catch { /* not yet */ }
    if (!port) await wait(250);
  }
  const tail = stderr.join('').split(/\r?\n/).filter(Boolean).slice(0, 6);
  const refused = tail.some(line => line.includes('requires a non-default data directory'));
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 }); } catch {}
  await wait(500);
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { scenario: name, isolated: keys, cdpUp: Boolean(port), port, refusalMessage: refused, exitCode: child.exitCode, stderrHead: tail };
}

(async () => {
  const out = [];
  for (const [name, keys] of Object.entries(GROUPS)) {
    out.push(await tryScenario(name, keys, name.endsWith('shaped-datadir')));
  }
  fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify(out, null, 2));
})();
