'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 'project-knowledge/runtime-control/v1';
function normalizeDataDir(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function controlPath(dataDir) {
  const hash = crypto.createHash('sha256').update(normalizeDataDir(dataDir)).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\project-knowledge-${hash}` : path.join(dataDir, 'runtime-control.sock');
}
function identity(dataDir, endpoint = {}) {
  return { schema: SCHEMA, name: 'project-knowledge', pid: process.pid, dataDir: path.resolve(dataDir), ...endpoint };
}
function request(dataDir, message, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPath(dataDir));
    let buffer = '', done = false;
    const timer = setTimeout(() => socket.destroy(new Error('知识库控制请求超时，停止尚未确认。')), timeoutMs);
    const finish = (error, result) => {
      if (done) return; done = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.once('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) return finish(new Error('无效的实例响应。'));
      if (!buffer.includes('\n')) return;
      try {
        const value = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (!value.ok) return finish(new Error(value.message || '实例控制失败。'));
        if (value.instance?.schema !== SCHEMA || normalizeDataDir(value.instance.dataDir) !== normalizeDataDir(dataDir)) return finish(new Error('实例身份不匹配，已拒绝控制。'));
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.once('error', error => finish(error));
    socket.once('end', () => { if (!buffer.includes('\n')) finish(new Error('实例断开连接，停止尚未确认。')); });
  });
}

async function listen(dataDir, info, stop) {
  const address = controlPath(dataDir);
  if (process.platform !== 'win32' && fs.existsSync(address)) {
    try { await request(dataDir, { action: 'status' }, 1000); throw new Error('另一个知识库实例已占用控制通道。'); }
    catch (error) {
      if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error;
      fs.unlinkSync(address);
    }
  }
  const sockets = new Set();
  let stopping = false, stoppingSocket;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(45000, () => socket.destroy());
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 16384) return socket.destroy();
      if (!buffer.includes('\n')) return;
      socket.removeAllListeners('data');
      const respond = value => { if (!socket.destroyed) socket.end(JSON.stringify({ ...value, instance: info }) + '\n'); };
      let message;
      try { message = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); }
      catch { return respond({ ok: false, message: '无效的控制请求。' }); }
      if (message.action === 'status') return respond({ ok: true, status: stopping ? 'stopping' : 'running' });
      // A stale endpoint/port must never become a signal to an unrelated PID.
      if (message.action !== 'stop' || message.pid !== info.pid || message.port !== info.port || message.startedAt !== info.startedAt) return respond({ ok: false, message: '实例身份已变化，已拒绝停止。' });
      if (stopping) return respond({ ok: false, message: '实例正在停止，请稍后查询状态。' });
      stopping = true; stoppingSocket = socket;
      Promise.resolve().then(stop).then(() => respond({ ok: true, status: 'stopped' })).catch(error => respond({ ok: false, message: error.message }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
  return {
    close() {
      // Keep only the requesting socket for the final shutdown acknowledgement.
      return new Promise(resolve => { server.close(resolve); for (const socket of sockets) if (socket !== stoppingSocket) socket.destroy(); if (stopping) resolve(); });
    },
  };
}

module.exports = { SCHEMA, normalizeDataDir, identity, controlPath, request, listen };
