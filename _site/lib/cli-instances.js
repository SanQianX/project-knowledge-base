'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const control = require('./runtime-control');

function url(info) { return `http://${info.host === '::1' ? '[::1]' : info.host}:${info.port}`; }
async function current(dataDir) {
  try { const response = await control.request(dataDir, { action: 'status' }, 1500); return { ...response.instance, status: response.status }; }
  catch (error) { if (['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) return null; throw error; }
}
async function atPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime/identity`, { signal: AbortSignal.timeout(1200), headers: { Connection: 'close' } });
  if (!response.ok) throw new Error(`端口 ${port} 不是可控制的知识库实例（HTTP ${response.status}）。`);
  const info = await response.json();
  if (info.schema !== control.SCHEMA || info.name !== 'project-knowledge' || info.port !== port || !path.isAbsolute(info.dataDir || '')) throw new Error(`端口 ${port} 的实例身份无效，已拒绝控制。`);
  const verified = await current(info.dataDir);
  if (!verified || verified.pid !== info.pid || verified.port !== port || verified.startedAt !== info.startedAt) throw new Error(`端口 ${port} 的实例已变化，已拒绝控制。`);
  return verified;
}
function listeningPorts() {
  let output;
  if (process.platform === 'win32') {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } | Select-Object -ExpandProperty LocalPort -Unique"], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return [...new Set(output.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 65535))];
  }
  if (process.platform === 'darwin') output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 5000 });
  else output = execFileSync('ss', ['-tlnH'], { encoding: 'utf8', timeout: 5000 });
  return [...new Set([...output.matchAll(/:(\d+)(?:\s|$)/gm)].map(match => Number(match[1])))];
}
async function all() {
  const ports = listeningPorts(), instances = [], seen = new Set();
  // Bounded read-only probes; no PID is ever killed by inventory discovery.
  for (let i = 0; i < ports.length; i += 8) {
    const found = await Promise.all(ports.slice(i, i + 8).map(port => atPort(port).catch(() => null)));
    for (const info of found) if (info && !seen.has(info.pid + ':' + info.port)) { seen.add(info.pid + ':' + info.port); instances.push(info); }
  }
  return instances.sort((a, b) => a.port - b.port);
}
async function stop(info) {
  const result = await control.request(info.dataDir, { action: 'stop', pid: info.pid, port: info.port, startedAt: info.startedAt });
  if (result.status !== 'stopped') throw new Error('停止尚未确认。');
}
module.exports = { current, atPort, all, stop, url };
