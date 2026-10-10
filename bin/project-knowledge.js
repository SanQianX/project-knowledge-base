#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn, spawnSync, exec } = require('node:child_process');
const { resolveDataDirPath } = require('../_site/lib/data-dir');
const endpoint = require('../_site/lib/runtime-endpoint');
const instances = require('../_site/lib/cli-instances');
const pkg = require('../package.json');

function help() {
  console.log(`project-knowledge ${pkg.version}

Usage:
  project-knowledge [start]      Start in background and open the UI
  project-knowledge --fg         Start in foreground
  project-knowledge stop         Stop this data directory and its owned modules
  project-knowledge status       Show this data directory's instance
  project-knowledge status --all List controllable local knowledge instances
  project-knowledge stop --port 5804
                                Stop the verified instance on this port
  project-knowledge install|update|uninstall|integrations
                                Manage coding-agent integrations

Options:
  -p, --port <port>  Port (default: 5757, startup auto-fallback +19)
      --data <dir>   Select data directory (default: ~/.project-knowledge-v5)
      --host <host>  Bind host (default: 127.0.0.1)
      --no-open      Do not open browser
      --fg           Run in foreground
  -v, --version      Print version
  -h, --help         Show help

Commands are case-insensitive. Unknown commands never start a service.`);
}
function parse(args) {
  const commands = new Set(['start', 'stop', 'status', 'install', 'update', 'uninstall', 'integrations']);
  let command = 'start';
  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift().toLowerCase();
    if (!commands.has(command)) throw new Error(`Unknown command: ${command}. Run project-knowledge --help.`);
  }
  if (['install', 'update', 'uninstall', 'integrations'].includes(command)) return { command, forwarded: args };
  const options = { command, port: Number(process.env.KB_SITE_PORT || 5757), host: '127.0.0.1', open: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (['--port', '-p', '--host', '--data'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}.`);
      if (arg === '--port' || arg === '-p') { options.port = Number(value); options.portExplicit = true; }
      else if (arg === '--data') options.dataDir = value;
      else options.host = value;
    } else if (arg === '--no-open') options.open = false;
    else if (arg === '--fg') options.foreground = true;
    else if (arg === '--all') options.all = true;
    else throw new Error(`${arg.startsWith('-') ? 'Unknown option' : 'Unexpected argument'}: ${arg}.`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  if (options.all && (command !== 'status' || options.portExplicit)) throw new Error('--all is only supported by status, without --port.');
  if (command !== 'start' && (options.foreground || !options.open || options.host !== '127.0.0.1')) throw new Error('Startup options cannot be used with stop/status.');
  return options;
}
function openBrowser(url) {
  const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}
function notify(message) { if (process.connected) process.send(message, () => {}); }
function waitForStartup(child, log) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit');
      if (child.connected) child.disconnect();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`启动尚未完成，请运行 project-knowledge status 并查看 ${log}`)), 45000);
    child.on('message', message => {
      if (message?.type === 'kb:launcher-ready') finish(null, message);
      else if (message?.type === 'kb:launcher-failed') finish(new Error(message.message));
    });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`后台进程在启动完成前退出（${code}），请查看 ${log}`)));
  });
}
function portFree(port, host) {
  return new Promise(resolve => {
    const tester = net.createServer();
    let done = false;
    const timer = setTimeout(() => finish(false), 3000);
    function finish(free) {
      if (done) return; done = true; clearTimeout(timer); tester.close(() => resolve(free));
    }
    tester.once('error', () => finish(false)); tester.once('listening', () => finish(true)); tester.listen(port, host);
  });
}
async function freePort(port, host) {
  for (let offset = 0; offset < 20 && port + offset <= 65535; offset++) if (await portFree(port + offset, host)) return port + offset;
  throw new Error(`No free port found near ${port}.`);
}
function show(info) { console.log(`project-knowledge is ${info.status === 'stopping' ? 'stopping' : 'running'} (PID ${info.pid}) at ${instances.url(info)} [${info.version}]\nData dir: ${info.dataDir}`); }

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { help(); return; }
  if (options.version) { console.log(pkg.version); return; }
  if (options.forwarded) {
    const args = options.command === 'integrations' ? (options.forwarded.length ? options.forwarded : ['status']) : [options.command, ...options.forwarded];
    const result = spawnSync(process.execPath, [path.join(__dirname, 'project-knowledge-integrations.js'), ...args], { stdio: 'inherit', windowsHide: true });
    process.exitCode = result.status ?? 1; return;
  }
  const dataDir = resolveDataDirPath({ dataDir: options.dataDir });
  process.env.KB_DATA_DIR = dataDir;
  if (options.all) {
    const found = await instances.all();
    if (!found.length) console.log('No controllable project-knowledge instances found.');
    for (const info of found) show(info);
    return;
  }
  const existing = options.command !== 'start' && options.portExplicit ? await instances.atPort(options.port) : await instances.current(dataDir);
  const unverified = !existing && endpoint.readLiveEndpoint(dataDir, { removeStale: false });
  if (unverified) throw new Error(`数据目录已有实例记录（PID ${unverified.pid}，端口 ${unverified.port}），但控制通道不可用。请先确认该实例，不会重复启动、误停止或报告已停止。`);
  if (existing && options.dataDir && options.command !== 'start' && path.resolve(existing.dataDir).toLowerCase() !== dataDir.toLowerCase()) throw new Error('指定端口不属于指定数据目录，已拒绝控制。');
  if (options.command === 'status') {
    if (existing) show(existing);
    else console.log(`project-knowledge is not running for ${dataDir}.\nUse "project-knowledge status --all" to inspect other data directories.`);
    return;
  }
  if (options.command === 'stop') {
    if (!existing) { console.log(`No background process found for ${dataDir}.`); return; }
    await instances.stop(existing);
    console.log(`project-knowledge stopped (PID ${existing.pid}) at ${instances.url(existing)}.\nData dir: ${existing.dataDir}`);
    return;
  }
  if (existing) {
    if (existing.status === 'stopping') throw new Error('实例正在停止，请稍后再启动。');
    const url = instances.url(existing); console.log(`Already running (PID ${existing.pid}) at ${url}\nData dir: ${existing.dataDir}`);
    notify({ type: 'kb:launcher-ready', url }); if (options.open) openBrowser(url); return;
  }
  // A live claim with no control channel is starting, legacy, or unverified.
  // Never trust a reused/shared PID as proof or kill it to make room.
  if (!options.foreground) {
    fs.mkdirSync(dataDir, { recursive: true });
    const log = path.join(dataDir, 'launcher.log'), fd = fs.openSync(log, 'a');
    const child = spawn(process.execPath, [...process.argv.slice(1), '--fg'], { detached: true, stdio: ['ignore', fd, fd, 'ipc'], windowsHide: true });
    fs.closeSync(fd); child.unref();
    console.log(`project-knowledge starting in background\nDiagnostics: ${log}`);
    const ready = await waitForStartup(child, log);
    console.log(`project-knowledge is ready at ${ready.url}\nUse "project-knowledge status" to check, "project-knowledge stop" to stop.`);
    return;
  }
  const port = options.portExplicit ? options.port : await freePort(options.port, options.host);
  process.env.KB_SITE_HOST = options.host; process.env.KB_SITE_PORT = String(port);
  console.log(`project-knowledge ${pkg.version}\nData dir: ${dataDir}`);
  if (port !== options.port) console.log(`(Port ${options.port} was busy, using ${port} instead)`);
  const { startServer, installProcessHandlers } = require('../_site/lib/server-app');
  const promise = startServer(); installProcessHandlers(promise);
  const instance = await promise;
  if (process.platform === 'win32') process.once('SIGBREAK', () => instance.stop('SIGBREAK'));
  const url = instances.url({ host: options.host, port });
  console.log(`Listening at ${url}`); notify({ type: 'kb:launcher-ready', url });
  if (options.open) setTimeout(() => openBrowser(url), 500);
}
main().catch(error => {
  const control = ['stop', 'status'].includes(process.argv[2]?.toLowerCase());
  console.error(process.argv.includes('--fg') ? `[project-knowledge] startup failed: ${error.message}` : `${control ? '控制失败' : '启动失败'}：${error.message}`);
  notify({ type: 'kb:launcher-failed', message: error.message });
  process.exitCode = 1;
});
